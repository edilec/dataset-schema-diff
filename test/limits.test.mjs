/**
 * A bound has two sides.
 *
 * Every limit below is driven from BOTH: that it fires at N+1, and that it
 * stays SILENT at exactly N. The second assertion is the one users notice --
 * widening a comparison by one (`>` to `>=`) starts refusing documents sitting
 * exactly on a limit the documentation calls legal, and a suite that only tests
 * the N+1 side stays green through it.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, ConfigError, diffSchemas, exitCodeFor } from '../src/index.mjs'
import { column, makeRoot, manifestDoc, runCli, writeDocument } from './support.mjs'

/** A manifest serialised to exactly `bytes` bytes, padded with trailing spaces. */
function manifestOfExactBytes(bytes) {
  const text = JSON.stringify(manifestDoc())
  assert.ok(text.length <= bytes, `cannot pad down to ${bytes} bytes`)
  return text + ' '.repeat(bytes - text.length)
}

function columns(count) {
  return Array.from({ length: count }, (unused, index) => column({ name: `c${String(index).padStart(4, '0')}` }))
}

test('maxDocumentBytes: a manifest of exactly the limit is read', async () => {
  const limit = 400
  const root = await makeRoot()
  const text = manifestOfExactBytes(limit)
  assert.equal(Buffer.byteLength(text), limit)
  await writeDocument(root, 'before.json', text)
  await writeDocument(root, 'after.json', text)

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json', limits: { maxDocumentBytes: limit } })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.diffAttempted, true)
  assert.equal(report.findings.filter((item) => item.ruleId === 'input-too-large').length, 0)
})

test('maxDocumentBytes: one byte over the limit is refused, and nothing is compared', async () => {
  const limit = 400
  const root = await makeRoot()
  await writeDocument(root, 'before.json', manifestOfExactBytes(limit + 1))
  await writeDocument(root, 'after.json', manifestOfExactBytes(limit))

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json', limits: { maxDocumentBytes: limit } })

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['input-too-large'])
  // The exact sentence matters: "so it was not read" is the one the size check
  // BEFORE the read produces. The check after the read has its own wording, and
  // asserting a substring common to both would let either guard be removed
  // while the other silently covered for it.
  assert.equal(
    report.findings[0].message,
    'the manifest is 401 bytes, over the 400 byte limit, so it was not read',
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.diffAttempted, false)
})

test('maxDocumentBytes: the check after the read catches what stat could not report', async () => {
  // The two size checks cover for each other at N+1, so neither is defended by
  // a plain over-limit file. A FIFO separates them: `stat` reports size 0, so
  // the check before the read passes, and only the check after it sees the 401
  // bytes that actually arrived. That is the case the second check exists for
  // -- a file whose size when it was measured is not the size that was read.
  const root = await makeRoot()
  const fifo = join(root, 'before.json')
  execFileSync('mkfifo', [fifo])
  assert.equal((await stat(fifo)).size, 0, 'stat must under-report, or this test proves nothing')

  await writeDocument(root, 'after.json', manifestDoc())
  const writer = spawn('sh', ['-c', `printf '%s' '${'x'.repeat(401)}' > ${JSON.stringify(fifo)}`], { stdio: 'ignore' })
  try {
    const report = await diffSchemas({ root, before: 'before.json', after: 'after.json', limits: { maxDocumentBytes: 400 } })

    assert.deepEqual(report.findings.map((item) => item.ruleId), ['input-too-large'])
    assert.equal(report.findings[0].message, 'the manifest is 401 bytes, over the 400 byte limit')
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.diffAttempted, false)
  } finally {
    writer.kill()
  }
})

test('maxColumns: a manifest of exactly the limit is compared', async () => {
  const root = await makeRoot()
  const document = manifestDoc({ columns: columns(8) })
  await writeDocument(root, 'before.json', document)
  await writeDocument(root, 'after.json', document)

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json', limits: { maxColumns: 8 } })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.columnsBefore, 8)
  assert.equal(report.findings.filter((item) => item.ruleId === 'too-many-columns').length, 0)
})

test('maxColumns: one column over the limit refuses the manifest without examining any column', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', manifestDoc({ columns: columns(9) }))
  await writeDocument(root, 'after.json', manifestDoc({ columns: columns(8) }))

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json', limits: { maxColumns: 8 } })

  assert.deepEqual(report.findings.map((item) => item.ruleId), ['too-many-columns'])
  assert.match(report.findings[0].message, /declares 9 columns, over the 8 column limit/)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.diffAttempted, false)
})

test('maxFieldLength: a name of exactly the limit is accepted', async () => {
  const name = 'n'.repeat(12)
  const document = manifestDoc({ columns: [column({ name })] })
  const root = await makeRoot()
  await writeDocument(root, 'before.json', document)
  await writeDocument(root, 'after.json', document)

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json', limits: { maxFieldLength: 12 } })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
})

test('maxFieldLength: a name one character over the limit is refused', async () => {
  const document = manifestDoc({ columns: [column({ name: 'n'.repeat(13) })] })
  const root = await makeRoot()
  await writeDocument(root, 'before.json', document)
  await writeDocument(root, 'after.json', document)

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json', limits: { maxFieldLength: 12 } })

  assert.ok(report.findings.some((item) => item.ruleId === 'column-invalid' && item.location.pointer === '/columns/0/name'))
  assert.equal(report.status, 'incomplete')
})

test('maxFindings: exactly the limit is reported in full', async () => {
  // Six added nullable columns produce six findings.
  const root = await makeRoot()
  await writeDocument(root, 'before.json', manifestDoc({ columns: columns(1) }))
  await writeDocument(root, 'after.json', manifestDoc({ columns: [...columns(1), ...columns(7).slice(1).map((entry) => ({ ...entry, nullable: true }))] }))

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json', limits: { maxFindings: 6 } })

  assert.equal(report.findings.length, 6)
  assert.equal(report.findings.filter((item) => item.ruleId === 'too-many-findings').length, 0)
  assert.equal(report.status, 'pass')
})

test('maxFindings: one finding over the limit truncates the list and says so', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', manifestDoc({ columns: columns(1) }))
  await writeDocument(root, 'after.json', manifestDoc({ columns: [...columns(1), ...columns(7).slice(1).map((entry) => ({ ...entry, nullable: true }))] }))

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json', limits: { maxFindings: 5 } })

  assert.equal(report.findings.length, 5)
  assert.equal(report.findings.at(-1).ruleId, 'too-many-findings')
  assert.match(report.findings.at(-1).message, /6 findings were produced, over the 5 finding limit/)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('a limit name this tool does not have is a configuration error, not a silent default', async () => {
  const root = await makeRoot()
  await assert.rejects(
    () => diffSchemas({ root, before: 'a.json', after: 'b.json', limits: { maxColumn: 5 } }),
    (error) => error instanceof ConfigError && /Unknown limit "maxColumn"/.test(error.message),
  )
})

test('a limit that is not a positive integer is a configuration error', async () => {
  const root = await makeRoot()
  for (const value of [0, -1, 1.5, '10', null]) {
    await assert.rejects(
      () => diffSchemas({ root, before: 'a.json', after: 'b.json', limits: { maxColumns: value } }),
      (error) => error instanceof ConfigError,
    )
  }
})

test('the documented defaults are the values the code uses', async () => {
  assert.deepEqual({ ...DEFAULT_LIMITS }, {
    maxDocumentBytes: 1048576,
    maxColumns: 2000,
    maxFieldLength: 200,
    maxFindings: 1000,
  })
})

test('the CLI wires every limit flag through to the engine', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', manifestDoc({ columns: columns(9) }))
  await writeDocument(root, 'after.json', manifestDoc({ columns: columns(8) }))

  const silent = await runCli(['--root', root, '--before', 'before.json', '--after', 'after.json', '--max-columns', '9', '--json'])
  assert.equal(silent.code, 0)

  const fires = await runCli(['--root', root, '--before', 'before.json', '--after', 'after.json', '--max-columns', '8', '--json'])
  assert.equal(fires.code, 2)
  assert.equal(JSON.parse(fires.stdout).findings[0].ruleId, 'too-many-columns')
})
