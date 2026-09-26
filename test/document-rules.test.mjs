/**
 * The rules that are about the two documents rather than about one column:
 * source format, dataset identity, units, and the add/remove verdict matrix.
 *
 * Severity is pinned BEHAVIOURALLY throughout -- status and exit code, not a
 * hand-written expected-value map. Three declarations agreeing with each other
 * survive a coordinated edit; an exit code does not.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { RULE_CATALOG, diffSchemas, exitCodeFor } from '../src/index.mjs'
import { column, manifestDoc, twoManifests } from './support.mjs'

async function compare(beforeOverrides, afterOverrides, options = {}) {
  const documents = await twoManifests(manifestDoc(beforeOverrides), manifestDoc(afterOverrides))
  return diffSchemas({ ...documents, ...options })
}

test('a changed source format breaks under every compatibility mode', async () => {
  for (const compatibility of ['backward', 'forward', 'full']) {
    const report = await compare({ sourceFormat: 'csv' }, { sourceFormat: 'json' }, { policy: { compatibility } })
    assert.ok(report.findings.some((item) => item.ruleId === 'source-format-changed-breaking'), compatibility)
    assert.equal(report.status, 'fail')
    assert.equal(exitCodeFor(report), 1)
  }
})

test('two manifests naming different datasets are flagged but still compared', async () => {
  const report = await compare(
    { dataset: 'orders', columns: [column({ type: 'int64' })] },
    { dataset: 'invoices', columns: [column({ type: 'int32' })] },
  )
  const ruleIds = report.findings.map((item) => item.ruleId)

  assert.ok(ruleIds.includes('dataset-mismatch'))
  // A warning, because comparing a renamed dataset is a real thing to want.
  assert.equal(report.findings.find((item) => item.ruleId === 'dataset-mismatch').severity, 'warning')
  assert.ok(ruleIds.includes('type-narrowed-breaking'), 'the comparison still happened')
})

test('the same dataset name on both sides says nothing', async () => {
  const report = await compare({ dataset: 'orders' }, { dataset: 'orders' })
  assert.deepEqual(report.findings, [])
})

test('a changed unit breaks under every compatibility mode', async () => {
  for (const compatibility of ['backward', 'forward', 'full']) {
    const report = await compare(
      { columns: [column({ name: 'energy', unit: 'kWh' })] },
      { columns: [column({ name: 'energy', unit: 'MWh' })] },
      { policy: { compatibility } },
    )
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['unit-changed-breaking'], compatibility)
    assert.equal(exitCodeFor(report), 1)
  }
})

test('a unit that appears, and one that disappears, are reported differently', async () => {
  const declared = await compare(
    { columns: [column({ name: 'energy' })] },
    { columns: [column({ name: 'energy', unit: 'kWh' })] },
  )
  assert.deepEqual(declared.findings.map((item) => item.ruleId), ['unit-declared'])
  assert.match(declared.findings[0].message, /cannot tell whether the values changed/)
  assert.equal(declared.status, 'pass')

  const undeclared = await compare(
    { columns: [column({ name: 'energy', unit: 'kWh' })] },
    { columns: [column({ name: 'energy' })] },
  )
  assert.deepEqual(undeclared.findings.map((item) => item.ruleId), ['unit-undeclared'])
  assert.equal(undeclared.findings[0].severity, 'warning')
  assert.equal(undeclared.status, 'pass', 'losing a unit declaration is worth saying, not worth failing')
})

test('the summary counts columns with no declared unit, so silence is not read as verification', async () => {
  const report = await compare(
    { columns: [column({ name: 'a' }), column({ name: 'b', unit: 'kWh' })] },
    { columns: [column({ name: 'a' }), column({ name: 'b', unit: 'kWh' })] },
  )
  assert.equal(report.summary.columnsWithoutDeclaredUnit, 1)
  assert.deepEqual(report.findings, [])
})

test('the add and remove verdict matrix', async () => {
  const cases = [
    // [added column, mode, expected rule]
    [{ nullable: true }, 'backward', 'column-added-compatible'],
    [{ nullable: false, hasDefault: true }, 'backward', 'column-added-compatible'],
    [{ nullable: false, hasDefault: false }, 'backward', 'column-added-breaking'],
    [{ nullable: false, hasDefault: false }, 'forward', 'column-added-compatible'],
    [{ nullable: false, hasDefault: false }, 'full', 'column-added-breaking'],
  ]
  for (const [extra, compatibility, expected] of cases) {
    const report = await compare(
      { columns: [column({ name: 'a' })] },
      { columns: [column({ name: 'a' }), column({ name: 'b', ...extra })] },
      { policy: { compatibility } },
    )
    assert.deepEqual(report.findings.map((item) => item.ruleId), [expected], `${JSON.stringify(extra)} under ${compatibility}`)
  }

  const removals = [
    [{ nullable: true }, 'forward', 'column-removed-compatible'],
    [{ nullable: false, hasDefault: true }, 'forward', 'column-removed-compatible'],
    [{ nullable: false, hasDefault: false }, 'forward', 'column-removed-breaking'],
    [{ nullable: false, hasDefault: false }, 'backward', 'column-removed-compatible'],
    [{ nullable: false, hasDefault: false }, 'full', 'column-removed-breaking'],
  ]
  for (const [extra, compatibility, expected] of removals) {
    const report = await compare(
      { columns: [column({ name: 'a' }), column({ name: 'b', ...extra })] },
      { columns: [column({ name: 'a' })] },
      { policy: { compatibility } },
    )
    assert.deepEqual(report.findings.map((item) => item.ruleId), [expected], `${JSON.stringify(extra)} under ${compatibility}`)
  }
})

test('a removal is reported against the older manifest, where the evidence is', async () => {
  const report = await compare(
    { columns: [column({ name: 'a' }), column({ name: 'b', nullable: true })] },
    { columns: [column({ name: 'a' })] },
  )
  assert.equal(report.findings[0].location.file, 'before.json')
  assert.equal(report.findings[0].location.pointer, '/columns/1')
})

test('a rename is reported as a removal and an addition, never guessed at', async () => {
  // Nothing in two manifests says that `note` became `comment`. Inferring it
  // would be inventing a fact about the data.
  const report = await compare(
    { columns: [column({ name: 'note', nullable: true })] },
    { columns: [column({ name: 'comment', nullable: true })] },
  )
  assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), ['column-added-compatible', 'column-removed-compatible'])
  assert.equal(report.summary.columnsAdded, 1)
  assert.equal(report.summary.columnsRemoved, 1)
})

test('every rule in the catalogue has a severity and a declared incomplete flag', () => {
  assert.ok(RULE_CATALOG.length > 0)
  for (const entry of RULE_CATALOG) {
    assert.match(entry.ruleId, /^[a-z0-9]+(-[a-z0-9]+)*$/)
    assert.ok(['error', 'warning', 'info'].includes(entry.severity))
    assert.equal(typeof entry.incomplete, 'boolean')
    if (entry.incomplete) assert.equal(entry.severity, 'error', `${entry.ruleId} drives an incomplete run, so it cannot be advisory`)
  }
})

test('every id that ends in -compatible is advisory and every -breaking id fails the build', async () => {
  for (const entry of RULE_CATALOG) {
    if (entry.ruleId.endsWith('-compatible')) assert.equal(entry.severity, 'info', entry.ruleId)
    if (entry.ruleId.endsWith('-breaking')) assert.equal(entry.severity, 'error', entry.ruleId)
  }
})
