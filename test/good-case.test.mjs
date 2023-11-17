/**
 * The first verification of a checker is not "does it catch the bad case". It
 * is "does it stay silent on the good one". A finding raised on correct input
 * sends somebody to fix what was already right, and after that nobody reads the
 * output.
 *
 * Every test here constructs input a data engineer would call correct and
 * asserts the tool says nothing about it -- and asserts the run really happened,
 * so silence cannot come from a run that never compared anything.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { diffSchemas } from '../src/index.mjs'
import { column, manifestDoc, runCli, twoManifests, writeDocument } from './support.mjs'

test('two identical manifests produce a pass with no findings at all', async () => {
  const document = manifestDoc({
    columns: [
      column({ name: 'order_id', type: 'int64' }),
      column({ name: 'net_amount', type: 'decimal(12,2)', unit: 'EUR' }),
      column({ name: 'note', type: 'varchar(120)', nullable: true, hasDefault: true, description: 'free text' }),
    ],
  })
  const { root, before, after } = await twoManifests(document, document)
  const report = await diffSchemas({ root, before, after })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  // Silence has to come from a comparison that happened.
  assert.equal(report.summary.diffAttempted, true)
  assert.equal(report.summary.columnsMatched, 3)
  assert.equal(report.summary.checked, 6)
})

test('the CLI exits 0 and writes a parseable pass report for identical manifests', async () => {
  const document = manifestDoc()
  const { root, before, after } = await twoManifests(document, document)
  const run = await runCli(['--root', root, '--before', before, '--after', after])

  assert.equal(run.code, 0)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.findings.length, 0)
})

test('a column inserted at the front is not reported as a reordering', async () => {
  // Comparing raw positions would call this a reorder, which is a finding on
  // correct input: inserting a column shifts every position after it.
  const before = manifestDoc({ columns: [column({ name: 'b' }), column({ name: 'c' })] })
  const after = manifestDoc({ columns: [column({ name: 'a', nullable: true }), column({ name: 'b' }), column({ name: 'c' })] })
  const documents = await twoManifests(before, after)

  for (const columnOrder of ['warn', 'breaking']) {
    const report = await diffSchemas({ ...documents, policy: { columnOrder } })
    const ruleIds = report.findings.map((item) => item.ruleId)
    assert.deepEqual(ruleIds, ['column-added-compatible'])
    assert.equal(report.summary.columnOrderChanged, false)
    assert.equal(report.status, 'pass')
  }
})

test('a type outside the vocabulary that did not change says nothing', async () => {
  // geography(point) is not in the lattice. It did not change, so there is
  // nothing to classify and nothing to report.
  const document = manifestDoc({ columns: [column({ name: 'site', type: 'geography(point)' })] })
  const { root, before, after } = await twoManifests(document, document)
  const report = await diffSchemas({ root, before, after })

  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.typeChanges, 0)
})

test('a type spelled differently but normalising identically is not a change', async () => {
  const before = manifestDoc({ columns: [column({ name: 'total', type: 'DECIMAL(12, 2)' })] })
  const after = manifestDoc({ columns: [column({ name: 'total', type: 'decimal(12,2)' })] })
  const { root, ...names } = await twoManifests(before, after)
  const report = await diffSchemas({ root, ...names })

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.typeChanges, 0)
})

test('a manifest whose every optional field is present is accepted', async () => {
  const document = manifestDoc({
    columns: [column({ name: 'kwh', type: 'float64', unit: 'kWh', hasDefault: true, description: 'metered energy' })],
  })
  const { root, before, after } = await twoManifests(document, document)
  const report = await diffSchemas({ root, before, after })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
})

test('an unchanged manifest read through a policy document is still a pass', async () => {
  const document = manifestDoc()
  const { root, before, after } = await twoManifests(document, document)
  await writeDocument(root, 'policy.json', { policyVersion: '1', compatibility: 'full', columnOrder: 'breaking' })
  const run = await runCli(['--root', root, '--before', before, '--after', after, '--policy', `${root}/policy.json`])

  assert.equal(run.code, 0)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.summary.policy, { compatibility: 'full', columnOrder: 'breaking' })
})
