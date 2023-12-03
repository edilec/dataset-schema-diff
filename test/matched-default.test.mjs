/**
 * `hasDefault` on a column that is present in BOTH manifests.
 *
 * The defect these pin: the field was read only in the added and the removed
 * branches, so a change to it on a matched column produced no finding and no
 * counter -- `status: "pass"`, `findings: []`, exit 0 -- while the README, the
 * CHANGELOG and the package description all say this tool classifies every
 * difference, and the field table marks only `description` as ignored.
 *
 * The silence is not a cosmetic omission, which is what the second test is for:
 * the same removal of the same column is `compatible` before the change and
 * `breaking` after it. The only difference between those two runs is the field
 * that was dropped.
 *
 * It stays a warning. A reader in either direction still sees a column that is
 * in both manifests, so nothing about THIS pair is breaking, and failing the
 * build over it would be a finding raised on correct input.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { diffSchemas, exitCodeFor } from '../src/index.mjs'
import { column, manifestDoc, runCli, twoManifests } from './support.mjs'

const withDefault = (hasDefault) => manifestDoc({
  version: '2026-01',
  columns: [column({ name: 'a' }), column({ name: 'b', hasDefault })],
})

/** The same manifest with column `b` removed: the later change the field decides. */
const withoutB = manifestDoc({ version: '2026-07', columns: [column({ name: 'a' })] })

test('a hasDefault change on a column present in both manifests is reported', async () => {
  const { root, before, after } = await twoManifests(withDefault(true), { ...withDefault(false), version: '2026-04' })
  const report = await diffSchemas({ root, before, after })

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['column-default-changed'])
  const found = report.findings[0]
  assert.equal(found.severity, 'warning')
  assert.deepEqual(found.location, { file: 'after.json', pointer: '/columns/1' })
  assert.equal(found.evidence, 'hasDefault true -> false')
  assert.match(found.message, /removing this column later is compatible only while a default is declared/)

  assert.equal(report.summary.defaultChanges, 1)
  assert.equal(report.summary.columnsMatched, 2)
  // A warning, not an error: nothing about THIS pair is breaking in either
  // direction, so the build does not fail over it.
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
})

test('the removal it decides is compatible before the change and breaking after it', async () => {
  // This is why the silence mattered. Two runs, the same removal of the same
  // column, opposite verdicts -- and the report on the pair in between said
  // nothing had changed.
  const declared = await twoManifests(withDefault(true), withoutB)
  const withDeclaredDefault = await diffSchemas({
    root: declared.root, before: declared.before, after: declared.after, policy: { compatibility: 'forward' },
  })
  assert.deepEqual(withDeclaredDefault.findings.map((item) => item.ruleId), ['column-removed-compatible'])
  assert.equal(exitCodeFor(withDeclaredDefault), 0)

  const dropped = await twoManifests(withDefault(false), withoutB)
  const withoutDeclaredDefault = await diffSchemas({
    root: dropped.root, before: dropped.before, after: dropped.after, policy: { compatibility: 'forward' },
  })
  assert.deepEqual(withoutDeclaredDefault.findings.map((item) => item.ruleId), ['column-removed-breaking'])
  assert.equal(exitCodeFor(withoutDeclaredDefault), 1)
})

test('a default declared where none was declared reads as "not declared" on the older side', async () => {
  const before = manifestDoc({ columns: [{ name: 'b', type: 'int32', nullable: false }] })
  const after = manifestDoc({ version: '2026-04', columns: [column({ name: 'b', hasDefault: true })] })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['column-default-changed'])
  assert.equal(report.findings[0].evidence, 'hasDefault not declared -> true')
  assert.equal(report.summary.defaultChanges, 1)
})

test('a matched column whose hasDefault did not change produces nothing', async () => {
  // The good case, both ways: declared and equal, and absent on both sides.
  for (const document of [withDefault(true), manifestDoc({ columns: [{ name: 'b', type: 'int32', nullable: false }] })]) {
    const { root, before, after } = await twoManifests(document, { ...document, version: '2026-04' })
    const report = await diffSchemas({ root, before, after })

    assert.deepEqual(report.findings, [])
    assert.equal(report.summary.defaultChanges, 0)
    assert.equal(report.summary.diffAttempted, true)
    assert.equal(report.status, 'pass')
  }
})

test('the CLI counts the change in its human summary and still exits 0', async () => {
  const { root, before, after } = await twoManifests(withDefault(true), { ...withDefault(false), version: '2026-04' })
  const run = await runCli(['--root', root, '--before', before, '--after', after])

  assert.equal(run.code, 0)
  assert.match(run.stderr, /1 default change\(s\)/)
  assert.equal(JSON.parse(run.stdout).summary.defaultChanges, 1)
})
