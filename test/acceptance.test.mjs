/**
 * The acceptance criterion for this tool, item by item:
 *
 *   "Widening versus narrowing and nullable versus required transitions are
 *    classified; reordered columns can be ignored by policy."
 *
 * Each item below drives the real entry point and asserts the observable
 * outcome -- rule id, severity, status and CLI exit code -- because a verdict
 * that is only a string in a report is a verdict a demotion can erase.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { diffSchemas, exitCodeFor } from '../src/index.mjs'
import { column, manifestDoc, runCli, twoManifests } from './support.mjs'

async function compare(beforeColumns, afterColumns, options = {}) {
  const documents = await twoManifests(
    manifestDoc({ columns: beforeColumns }),
    manifestDoc({ columns: afterColumns }),
  )
  const report = await diffSchemas({ ...documents, ...options })
  return { report, documents }
}

test('acceptance: a widening type change is classified as widening', async () => {
  const { report } = await compare([column({ type: 'int32' })], [column({ type: 'int64' })])
  const [item] = report.findings

  assert.equal(report.findings.length, 1)
  assert.equal(item.ruleId, 'type-widened-compatible')
  assert.equal(item.severity, 'info')
  assert.match(item.message, /widened from int32 to int64/)
  assert.equal(item.evidence, 'int32 -> int64')
  assert.equal(report.summary.typeChanges, 1)
  // Widening is what a backward-compatible reader can absorb, so it passes.
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
})

test('acceptance: a narrowing type change is classified as narrowing and fails a backward policy', async () => {
  const { report } = await compare([column({ type: 'int64' })], [column({ type: 'int32' })])
  const [item] = report.findings

  assert.equal(report.findings.length, 1)
  assert.equal(item.ruleId, 'type-narrowed-breaking')
  assert.equal(item.severity, 'error')
  assert.match(item.message, /narrowed from int64 to int32/)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('acceptance: widening and narrowing swap verdicts under a forward policy', async () => {
  // The classification is a fact about the types; the verdict is a fact about
  // the policy. Both are in the rule id, so neither can be quietly reinterpreted.
  const widened = await compare([column({ type: 'int32' })], [column({ type: 'int64' })], { policy: { compatibility: 'forward' } })
  assert.equal(widened.report.findings[0].ruleId, 'type-widened-breaking')
  assert.equal(widened.report.status, 'fail')

  const narrowed = await compare([column({ type: 'int64' })], [column({ type: 'int32' })], { policy: { compatibility: 'forward' } })
  assert.equal(narrowed.report.findings[0].ruleId, 'type-narrowed-compatible')
  assert.equal(narrowed.report.status, 'pass')
})

test('acceptance: required to nullable is classified as a relaxation', async () => {
  const { report } = await compare(
    [column({ name: 'note', nullable: false })],
    [column({ name: 'note', nullable: true })],
  )
  const [item] = report.findings

  assert.equal(report.findings.length, 1)
  assert.equal(item.ruleId, 'nullability-relaxed-compatible')
  assert.equal(item.evidence, 'nullable false -> true')
  assert.match(item.message, /required to nullable/)
  assert.equal(report.summary.nullabilityChanges, 1)
  assert.equal(report.status, 'pass')
})

test('acceptance: nullable to required is classified as a tightening and fails a backward policy', async () => {
  const { report } = await compare(
    [column({ name: 'note', nullable: true })],
    [column({ name: 'note', nullable: false })],
  )
  const [item] = report.findings

  assert.equal(item.ruleId, 'nullability-tightened-breaking')
  assert.equal(item.severity, 'error')
  assert.equal(item.evidence, 'nullable true -> false')
  assert.match(item.message, /nullable to required/)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('acceptance: nullability transitions swap verdicts under a forward policy', async () => {
  const relaxed = await compare(
    [column({ name: 'note', nullable: false })],
    [column({ name: 'note', nullable: true })],
    { policy: { compatibility: 'forward' } },
  )
  assert.equal(relaxed.report.findings[0].ruleId, 'nullability-relaxed-breaking')
  assert.equal(relaxed.report.status, 'fail')

  const tightened = await compare(
    [column({ name: 'note', nullable: true })],
    [column({ name: 'note', nullable: false })],
    { policy: { compatibility: 'forward' } },
  )
  assert.equal(tightened.report.findings[0].ruleId, 'nullability-tightened-compatible')
  assert.equal(tightened.report.status, 'pass')
})

test('acceptance: under full compatibility both directions of every transition break', async () => {
  for (const [beforeColumn, afterColumn] of [
    [column({ type: 'int32' }), column({ type: 'int64' })],
    [column({ type: 'int64' }), column({ type: 'int32' })],
    [column({ nullable: false }), column({ nullable: true })],
    [column({ nullable: true }), column({ nullable: false })],
  ]) {
    const { report } = await compare([beforeColumn], [afterColumn], { policy: { compatibility: 'full' } })
    assert.equal(report.status, 'fail', `${beforeColumn.type}/${beforeColumn.nullable} -> ${afterColumn.type}/${afterColumn.nullable}`)
    assert.match(report.findings[0].ruleId, /-breaking$/)
  }
})

test('acceptance: reordered columns are reported by default and ignored by policy', async () => {
  const before = [column({ name: 'a' }), column({ name: 'b' })]
  const after = [column({ name: 'b' }), column({ name: 'a' })]

  const noted = await compare(before, after)
  assert.equal(noted.report.findings.length, 1)
  assert.equal(noted.report.findings[0].ruleId, 'column-order-changed-noted')
  assert.equal(noted.report.findings[0].severity, 'warning')
  assert.equal(noted.report.findings[0].evidence, 'a,b -> b,a')
  assert.equal(noted.report.status, 'pass')

  const breaking = await compare(before, after, { policy: { columnOrder: 'breaking' } })
  assert.equal(breaking.report.findings[0].ruleId, 'column-order-changed-breaking')
  assert.equal(breaking.report.findings[0].severity, 'error')
  assert.equal(breaking.report.status, 'fail')
  assert.equal(exitCodeFor(breaking.report), 1)

  const ignored = await compare(before, after, { policy: { columnOrder: 'ignore' } })
  assert.deepEqual(ignored.report.findings, [])
  assert.equal(ignored.report.status, 'pass')
  // The policy suppresses the FINDING, never the FACT: a reader of the summary
  // can still see that the order moved.
  assert.equal(ignored.report.summary.columnOrderChanged, true)
})

test('acceptance: ignoring column order does not suppress any other difference', async () => {
  // A policy switch that quietly widened into "compare less" would be the
  // dangerous version of this feature.
  const { report } = await compare(
    [column({ name: 'a', type: 'int64' }), column({ name: 'b' })],
    [column({ name: 'b' }), column({ name: 'a', type: 'int32' })],
    { policy: { columnOrder: 'ignore' } },
  )

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['type-narrowed-breaking'])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.columnOrderChanged, true)
})

test('acceptance: the CLI classifies a reordering as breaking when the policy says so', async () => {
  const documents = await twoManifests(
    manifestDoc({ columns: [column({ name: 'a' }), column({ name: 'b' })] }),
    manifestDoc({ columns: [column({ name: 'b' }), column({ name: 'a' })] }),
  )
  const run = await runCli([
    '--root', documents.root, '--before', documents.before, '--after', documents.after,
    '--column-order', 'breaking', '--json',
  ])

  assert.equal(run.code, 1)
  assert.equal(run.stderr, '')
  const report = JSON.parse(run.stdout)
  assert.equal(report.findings[0].ruleId, 'column-order-changed-breaking')
})
