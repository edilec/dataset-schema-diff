/**
 * Two values that this report renders identically.
 *
 * The defect these pin: the comparison read the raw strings and the message and
 * the evidence read the rendered ones, so a plain trailing space produced
 *
 *   ERROR unit-changed-breaking  column "energy" changed unit from kWh to kWh
 *   evidence: "kWh -> kWh"                                              exit 1
 *
 * -- an error-severity finding contradicted by its own evidence, on manifests a
 * reader sees as describing the same column. Every test here drives the real
 * entry point and pins BOTH sides: the sentence the tool must not write, and
 * the finding it must write instead. A guard that refuses every pair would pass
 * a "does not say X" test while making the tool useless, so each case has a
 * companion where the two values differ in characters the report KEEPS and the
 * ordinary classification still happens.
 *
 * `\u0085` is NEL. It is not ECMAScript whitespace, so `trim()` and
 * `normaliseType` both keep it, and `excerpt` removes it -- which is what makes
 * it the type-path equivalent of a trailing space.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { diffSchemas, exitCodeFor } from '../src/index.mjs'
import { column, manifestDoc, runCli, twoManifests } from './support.mjs'

/** The one finding of a rule, asserted to be the only one in the report. */
function onlyFinding(report, ruleId) {
  assert.deepEqual(report.findings.map((item) => item.ruleId), [ruleId])
  return report.findings[0]
}

test('a unit that differs only by a trailing space is not reported as a changed unit', async () => {
  const before = manifestDoc({ columns: [column({ name: 'energy', unit: 'kWh' })] })
  const after = manifestDoc({ version: '2026-04', columns: [column({ name: 'energy', unit: 'kWh ' })] })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  // The sentence the defect produced, absent -- and its companion, pinning what
  // IS there, so the absence cannot be satisfied by a run that said nothing.
  assert.ok(!JSON.stringify(report).includes('changed unit from'))
  const found = onlyFinding(report, 'stripped-character-difference')
  assert.equal(found.severity, 'error')
  assert.deepEqual(found.location, { file: 'after.json', pointer: '/columns/0/unit' })
  assert.equal(found.evidence, 'at character 4: before the end of the value, after U+0020')
  assert.match(found.message, /the column unit reads "kWh" in both manifests/)

  // The difference is still counted: it was not dropped, it was not classified.
  assert.equal(report.summary.unitChanges, 1)
  assert.equal(report.summary.columnsMatched, 1)
  assert.equal(report.summary.diffAttempted, true)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('the CLI exits 2 for that pair and carries the report on stdout', async () => {
  const before = manifestDoc({ columns: [column({ name: 'energy', unit: 'kWh' })] })
  const after = manifestDoc({ version: '2026-04', columns: [column({ name: 'energy', unit: 'kWh ' })] })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const run = await runCli(['--root', root, '--before', beforeName, '--after', afterName])

  assert.equal(run.code, 2)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'stripped-character-difference')
})

test('a unit change the report can show is still a breaking unit change', async () => {
  // The companion. Without it, a guard that answered "renders the same" for
  // every pair would pass the test above.
  const before = manifestDoc({ columns: [column({ name: 'energy', unit: 'kWh' })] })
  const after = manifestDoc({ version: '2026-04', columns: [column({ name: 'energy', unit: 'MWh' })] })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  const found = onlyFinding(report, 'unit-changed-breaking')
  assert.equal(found.evidence, 'kWh -> MWh')
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('a unit carrying the same trailing space in both manifests is not a difference at all', async () => {
  const document = manifestDoc({ columns: [column({ name: 'energy', unit: 'kWh ' })] })
  const { root, before, after } = await twoManifests(document, { ...document, version: '2026-04' })
  const report = await diffSchemas({ root, before, after })

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.unitChanges, 0)
  assert.equal(report.summary.columnsMatched, 1)
  assert.equal(report.status, 'pass')
})

test('a column name that differs only by a trailing space is one column, not an addition and a removal', async () => {
  const before = manifestDoc({ columns: [column({ name: 'energy' })] })
  const after = manifestDoc({ version: '2026-04', columns: [column({ name: 'energy ' })] })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  // The pair the defect produced: "column \"energy\" was added" beside
  // "column \"energy\" was removed", contradicting each other on the page.
  assert.ok(!JSON.stringify(report).includes('was added'))
  assert.ok(!JSON.stringify(report).includes('was removed'))
  const found = onlyFinding(report, 'stripped-character-difference')
  assert.deepEqual(found.location, { file: 'after.json', pointer: '/columns/0/name' })
  assert.equal(found.evidence, 'at character 7: before the end of the value, after U+0020')

  assert.equal(report.summary.columnsMatched, 1)
  assert.equal(report.summary.columnsAdded, 0)
  assert.equal(report.summary.columnsRemoved, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('a column name that differs in a character the report keeps is still an addition and a removal', async () => {
  const before = manifestDoc({ columns: [column({ name: 'energy' })] })
  const after = manifestDoc({ version: '2026-04', columns: [column({ name: 'energy_total' })] })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), [
    // Required, and `hasDefault: false`, so a new reader has nothing to put in
    // it for older data: breaking under the default backward mode.
    'column-added-breaking',
    'column-removed-compatible',
  ])
  assert.equal(report.summary.columnsAdded, 1)
  assert.equal(report.summary.columnsRemoved, 1)
  assert.equal(report.summary.columnsMatched, 0)
})

test('a dataset name that differs only by a trailing space is not two different datasets', async () => {
  const before = manifestDoc({ dataset: 'energy' })
  const after = manifestDoc({ dataset: 'energy ', version: '2026-04' })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  assert.ok(!JSON.stringify(report).includes('name different datasets'))
  const found = onlyFinding(report, 'stripped-character-difference')
  assert.deepEqual(found.location, { file: 'after.json', pointer: '/dataset' })
  assert.match(found.message, /the dataset name reads "energy" in both manifests/)
  // The defect here was quieter than the others: a warning, status pass, exit 0.
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('a dataset rename the report can show is still a mismatch', async () => {
  const before = manifestDoc({ dataset: 'energy' })
  const after = manifestDoc({ dataset: 'energy_v2', version: '2026-04' })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  const found = onlyFinding(report, 'dataset-mismatch')
  assert.equal(found.severity, 'warning')
  assert.match(found.message, /"energy" and "energy_v2"/)
  assert.equal(report.status, 'pass')
})

test('a column type that differs only in a stripped character is not an unclassified change between two identical type names', async () => {
  const before = manifestDoc({ columns: [column({ name: 'energy', type: 'int32' })] })
  const after = manifestDoc({ version: '2026-04', columns: [column({ name: 'energy', type: 'int32\u0085' })] })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  // Without the rendered comparison this reads "changed type from int32 to
  // int32, and this tool's declared lattice relates neither to the other".
  assert.ok(!JSON.stringify(report).includes('changed type from'))
  const found = onlyFinding(report, 'stripped-character-difference')
  assert.deepEqual(found.location, { file: 'after.json', pointer: '/columns/0/type' })
  assert.equal(found.evidence, 'at character 6: before the end of the value, after U+0085')
  assert.equal(report.summary.typeChanges, 1)
  assert.equal(exitCodeFor(report), 2)
})

test('a type change the report can show is still classified', async () => {
  const before = manifestDoc({ columns: [column({ name: 'energy', type: 'int64' })] })
  const after = manifestDoc({ version: '2026-04', columns: [column({ name: 'energy', type: 'int32' })] })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  const found = onlyFinding(report, 'type-narrowed-breaking')
  assert.equal(found.evidence, 'int64 -> int32')
  assert.equal(exitCodeFor(report), 1)
})

test('two column names in ONE manifest that render identically make the comparison ambiguous', async () => {
  // Matching on the rendered name is what lets the pair above be one column.
  // In a single manifest the same collision is the ambiguity the duplicate rule
  // exists for: no finding could say which of the two it is about.
  const before = manifestDoc({ columns: [column({ name: 'energy' })] })
  const after = manifestDoc({
    version: '2026-04',
    columns: [column({ name: 'energy' }), column({ name: 'energy ', type: 'int64' })],
  })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  const found = onlyFinding(report, 'column-name-duplicate')
  assert.deepEqual(found.location, { file: 'after.json', pointer: '/columns/1' })
  // And it says WHICH kind of duplicate this is. "Declared twice, or declared
  // twice in forms that render identically" would hand the reader the question.
  assert.match(found.message, /declared at \/columns\/0 in text that is not the same and that this report renders identically/)
  assert.equal(found.evidence, 'at character 7: before the end of the value, after U+0020')
  // Nothing is asserted about the columns of a manifest that could not be read.
  assert.equal(report.summary.diffAttempted, false)
  assert.equal(report.summary.columnsAdded, 0)
  assert.equal(report.summary.columnsMatched, 0)
  assert.equal(exitCodeFor(report), 2)
})

test('a column name differing by a bidi control is one column, not an addition and a removal', async () => {
  // `trim()` keeps U+200E and `excerpt` removes it, so a comparison that trims
  // instead of rendering matches the trailing-space cases above and misses this
  // one. That is the contract's trim()-versus-sanitize() row, and it is why the
  // name index is keyed by the rendered form rather than by a trimmed string.
  const before = manifestDoc({ columns: [column({ name: 'energy' })] })
  const after = manifestDoc({ version: '2026-04', columns: [column({ name: 'energy\u200e' })] })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  assert.ok(!JSON.stringify(report).includes('was added'))
  const found = onlyFinding(report, 'stripped-character-difference')
  assert.deepEqual(found.location, { file: 'after.json', pointer: '/columns/0/name' })
  assert.equal(found.evidence, 'at character 7: before the end of the value, after U+200E')
  assert.equal(report.summary.columnsMatched, 1)
  assert.equal(report.summary.columnsAdded, 0)
  assert.equal(exitCodeFor(report), 2)
})

test('a unit differing by a bidi control is not reported as a changed unit', async () => {
  const before = manifestDoc({ columns: [column({ name: 'energy', unit: 'kWh' })] })
  const after = manifestDoc({ version: '2026-04', columns: [column({ name: 'energy', unit: 'kWh\u200e' })] })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  assert.ok(!JSON.stringify(report).includes('changed unit from'))
  const found = onlyFinding(report, 'stripped-character-difference')
  assert.deepEqual(found.location, { file: 'after.json', pointer: '/columns/0/unit' })
  assert.equal(found.evidence, 'at character 4: before the end of the value, after U+200E')
  assert.equal(exitCodeFor(report), 2)
})

test('a dataset name differing by a C1 control is not two different datasets', async () => {
  // U+0085 is NEL. `trim()` keeps it too, so this pins the dataset comparison
  // against the same substitution.
  const before = manifestDoc({ dataset: 'energy' })
  const after = manifestDoc({ dataset: 'energy\u0085', version: '2026-04' })
  const { root, before: beforeName, after: afterName } = await twoManifests(before, after)
  const report = await diffSchemas({ root, before: beforeName, after: afterName })

  assert.ok(!JSON.stringify(report).includes('name different datasets'))
  const found = onlyFinding(report, 'stripped-character-difference')
  assert.deepEqual(found.location, { file: 'after.json', pointer: '/dataset' })
  assert.equal(found.evidence, 'at character 7: before the end of the value, after U+0085')
  assert.equal(exitCodeFor(report), 2)
})
