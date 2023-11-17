/**
 * Unknown is never a pass -- and never a pass on either side of the comparison.
 *
 * Every rule in the tool's incomplete set is driven through the real entry
 * point here and asserted to produce status "incomplete" and exit code 2. The
 * status is derived from that set rather than assigned at a call site, so the
 * mutation these tests exist to catch is removing an id from the set; each id
 * below fails this file when it is removed.
 *
 * The tests that matter most are the last few: they assert that evidence
 * dropped while building the column index makes the COMPARISON incomplete
 * rather than making it clean. A dropped column that then reads as "the column
 * is not there" is how a report comes to assert an addition nobody exported.
 */

import assert from 'node:assert/strict'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { diffSchemas, exitCodeFor } from '../src/index.mjs'
import { column, makeRoot, manifestDoc, runCli, twoManifests, writeDocument } from './support.mjs'

/** Assert the report is incomplete, exits 2, and carries the named rule. */
function assertIncomplete(report, ruleId) {
  const ruleIds = report.findings.map((item) => item.ruleId)
  assert.ok(ruleIds.includes(ruleId), `expected ${ruleId}, got ${ruleIds.join(', ')}`)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
}

test('a type change the lattice cannot relate is unclassified, not compatible', async () => {
  // int64 -> float64 is lossy above 2^53 and the lattice does not declare it,
  // so the tool refuses to call it either widening or narrowing.
  const documents = await twoManifests(
    manifestDoc({ columns: [column({ type: 'int64' })] }),
    manifestDoc({ columns: [column({ type: 'float64' })] }),
  )
  const report = await diffSchemas(documents)

  assertIncomplete(report, 'type-change-unclassified')
  const [item] = report.findings
  assert.equal(item.severity, 'error')
  assert.equal(item.evidence, 'int64 -> float64')
  // What is NOT there matters as much: no verdict was invented for it.
  assert.equal(report.findings.filter((entry) => /-compatible$/.test(entry.ruleId)).length, 0)
  assert.equal(report.findings.filter((entry) => /-breaking$/.test(entry.ruleId)).length, 0)
  // And it is still counted as a change, so the summary is not quietly clean.
  assert.equal(report.summary.typeChanges, 1)
})

test('two unknown types that differ textually are unclassified rather than equal', async () => {
  const documents = await twoManifests(
    manifestDoc({ columns: [column({ type: 'geography(point)' })] }),
    manifestDoc({ columns: [column({ type: 'geography(polygon)' })] }),
  )
  const report = await diffSchemas(documents)
  assertIncomplete(report, 'type-change-unclassified')
})

test('an added required column with no declared default is unknown, not breaking and not compatible', async () => {
  const documents = await twoManifests(
    manifestDoc({ columns: [column({ name: 'a' })] }),
    manifestDoc({ columns: [column({ name: 'a' }), { name: 'b', type: 'int32', nullable: false }] }),
  )
  const report = await diffSchemas(documents)

  assertIncomplete(report, 'column-added-default-unknown')
  const item = report.findings.find((entry) => entry.ruleId === 'column-added-default-unknown')
  assert.match(item.message, /does not declare whether it has a default/)
  assert.equal(item.suggestion, 'declare "hasDefault": true or false on the added column')
  assert.equal(report.summary.columnsAdded, 1)
})

test('the same added column is answered, not guessed, when the policy only needs the other direction', async () => {
  // Under forward compatibility the missing fact is not needed: an old reader
  // ignores a column it never knew, whatever its default. Reporting "unknown"
  // here would be a finding on correct input.
  const documents = await twoManifests(
    manifestDoc({ columns: [column({ name: 'a' })] }),
    manifestDoc({ columns: [column({ name: 'a' }), { name: 'b', type: 'int32', nullable: false }] }),
  )
  const report = await diffSchemas({ ...documents, policy: { compatibility: 'forward' } })

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['column-added-compatible'])
  assert.equal(report.status, 'pass')
})

test('a removed required column with no declared default is unknown under a forward policy', async () => {
  const documents = await twoManifests(
    manifestDoc({ columns: [column({ name: 'a' }), { name: 'b', type: 'int32', nullable: false }] }),
    manifestDoc({ columns: [column({ name: 'a' })] }),
  )
  const report = await diffSchemas({ ...documents, policy: { compatibility: 'forward' } })

  assertIncomplete(report, 'column-removed-default-unknown')
  assert.equal(report.summary.columnsRemoved, 1)
})

test('an undeclared nullable flag is unknown, and no nullability verdict is invented', async () => {
  const documents = await twoManifests(
    manifestDoc({ columns: [{ name: 'a', type: 'int32' }] }),
    manifestDoc({ columns: [column({ name: 'a', nullable: true })] }),
  )
  const report = await diffSchemas(documents)

  assertIncomplete(report, 'column-nullability-undeclared')
  assert.equal(report.summary.diffAttempted, false)
  assert.equal(report.findings.filter((item) => item.ruleId.startsWith('nullability-')).length, 0)
})

test('a duplicate column name makes the comparison ambiguous, and no addition is asserted', async () => {
  // The by-name index cannot hold both entries. Keeping the last would silently
  // drop the first and then compare against a schema the manifest never
  // described -- the index-dropping failure this catalog has paid for.
  const documents = await twoManifests(
    manifestDoc({ columns: [column({ name: 'a', type: 'int32' }), column({ name: 'a', type: 'int64' })] }),
    manifestDoc({ columns: [column({ name: 'a', type: 'int32' }), column({ name: 'b' })] }),
  )
  const report = await diffSchemas(documents)

  assertIncomplete(report, 'column-name-duplicate')
  assert.equal(report.summary.diffAttempted, false)
  assert.equal(report.summary.columnsAdded, 0)
  assert.equal(report.findings.filter((item) => item.ruleId.startsWith('column-added')).length, 0)
})

test('a manifest that could not be read produces no claim about the other manifest', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'after.json', manifestDoc({ columns: [column({ name: 'a' }), column({ name: 'b' })] }))
  const report = await diffSchemas({ root, before: 'missing.json', after: 'after.json' })

  assertIncomplete(report, 'input-unreadable')
  assert.equal(report.summary.diffAttempted, false)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.columnsAdded, 0)
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['input-unreadable'])
})

test('a manifest that is not valid UTF-8 is incomplete', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))
  await writeDocument(root, 'after.json', manifestDoc())
  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })

  assertIncomplete(report, 'input-not-utf8')
  assert.equal(report.summary.diffAttempted, false)
})

test('a manifest that is not valid JSON is incomplete', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', '{ "manifestVersion": ')
  await writeDocument(root, 'after.json', manifestDoc())
  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })

  assertIncomplete(report, 'input-not-json')
})

test('a manifest that is not a JSON object is incomplete', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', '[]')
  await writeDocument(root, 'after.json', manifestDoc())
  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })

  assertIncomplete(report, 'manifest-invalid')
})

test('an unsupported manifest version is incomplete rather than read anyway', async () => {
  const documents = await twoManifests(manifestDoc({ manifestVersion: '2' }), manifestDoc())
  const report = await diffSchemas(documents)

  assertIncomplete(report, 'manifest-version-unsupported')
  assert.equal(report.summary.diffAttempted, false)
})

test('an unsupported source format is incomplete rather than guessed at', async () => {
  const documents = await twoManifests(manifestDoc({ sourceFormat: 'parquet' }), manifestDoc())
  const report = await diffSchemas(documents)

  assertIncomplete(report, 'source-format-unsupported')
  const item = report.findings.find((entry) => entry.ruleId === 'source-format-unsupported')
  assert.match(item.message, /does not guess/)
})

test('an unknown manifest field is incomplete, because the tool cannot claim it read the document', async () => {
  const documents = await twoManifests(manifestDoc({ partitioning: 'by day' }), manifestDoc())
  const report = await diffSchemas(documents)

  assertIncomplete(report, 'manifest-unknown-field')
  assert.equal(report.findings[0].location.pointer, '/partitioning')
})

test('an unknown column field is incomplete', async () => {
  const documents = await twoManifests(
    manifestDoc({ columns: [{ ...column(), primaryKey: true }] }),
    manifestDoc(),
  )
  const report = await diffSchemas(documents)

  assertIncomplete(report, 'column-unknown-field')
  assert.equal(report.findings[0].location.pointer, '/columns/0/primaryKey')
})

test('an invalid column entry is incomplete', async () => {
  const documents = await twoManifests(manifestDoc({ columns: ['order_id'] }), manifestDoc())
  const report = await diffSchemas(documents)
  assertIncomplete(report, 'column-invalid')
})

test('a manifest declaring no columns is incomplete, not a clean pass over nothing', async () => {
  const documents = await twoManifests(manifestDoc({ columns: [] }), manifestDoc({ columns: [] }))
  const report = await diffSchemas(documents)

  assertIncomplete(report, 'no-columns-declared')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.diffAttempted, false)
})

test('a path leaving the root through a symbolic link is refused, not followed', async () => {
  const outside = await makeRoot()
  await writeDocument(outside, 'secret.json', manifestDoc({ dataset: 'not-yours' }))
  const root = await makeRoot()
  await writeDocument(root, 'after.json', manifestDoc())
  await symlink(join(outside, 'secret.json'), join(root, 'link.json'))

  const report = await diffSchemas({ root, before: 'link.json', after: 'after.json' })

  assertIncomplete(report, 'path-escapes-root')
  assert.equal(report.summary.diffAttempted, false)
  // The refusal must not have echoed anything from outside the root.
  assert.ok(!JSON.stringify(report).includes('not-yours'))
})

test('a lexically escaping path is refused before anything is opened', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'after.json', manifestDoc())
  const report = await diffSchemas({ root, before: '../after.json', after: 'after.json' })
  assertIncomplete(report, 'path-escapes-root')
})

test('the CLI exits 2 and still writes an incomplete report on stdout', async () => {
  const documents = await twoManifests(
    manifestDoc({ columns: [column({ type: 'int64' })] }),
    manifestDoc({ columns: [column({ type: 'float64' })] }),
  )
  const run = await runCli(['--root', documents.root, '--before', documents.before, '--after', documents.after])

  assert.equal(run.code, 2)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'incomplete')
  assert.match(run.stderr, /incomplete: this run is not a pass/)
})

test('the human summary never claims a comparison that did not happen', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'after.json', manifestDoc())
  const run = await runCli(['--root', root, '--before', 'missing.json', '--after', 'after.json'])

  assert.equal(run.code, 2)
  assert.match(run.stderr, /no comparison was made/)
  assert.ok(!/column\(s\) before/.test(run.stderr))
})
