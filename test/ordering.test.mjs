/**
 * Ordering is observable, and a source grep for `.localeCompare(` is not a test
 * for it: substituting `Intl.Collator` produces identical collation drift with
 * different source text, so the grep passes while the order becomes
 * machine-dependent.
 *
 * These tests are behavioural. Each one uses inputs whose order genuinely
 * differs between code-unit ordering and collation, pushes them through the
 * real report path, and asserts the exact emitted sequence. Replacing
 * `byCodeUnit` with a collator fails them.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { byCodeUnit, diffSchemas } from '../src/index.mjs'
import { column, makeRoot, manifestDoc, writeDocument } from './support.mjs'

test('findings sort by file first, by UTF-16 code unit', async () => {
  // 'Z' is 0x5A and 'a' is 0x61, so Z.json comes first by code unit. Every
  // default collator puts a.json first, which is the drift this pins.
  const root = await makeRoot()
  await writeDocument(root, 'a.json', manifestDoc({
    columns: [column({ name: 'kept', type: 'int64' }), column({ name: 'gone', hasDefault: true })],
  }))
  await writeDocument(root, 'Z.json', manifestDoc({ columns: [column({ name: 'kept', type: 'int32' })] }))

  const report = await diffSchemas({ root, before: 'a.json', after: 'Z.json' })

  assert.deepEqual(report.findings.map((item) => item.location.file), ['Z.json', 'a.json'])
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['type-narrowed-breaking', 'column-removed-compatible'])
  assert.deepEqual(['Z.json', 'a.json'].sort(new Intl.Collator().compare), ['a.json', 'Z.json'], 'this test is only meaningful while collation disagrees')
})

test('within one file, findings sort by pointer by code unit, not numerically', async () => {
  // /columns/10 precedes /columns/2 by code unit. A numeric collator reverses
  // it, which is exactly the kind of "nicer" ordering that makes two machines
  // disagree about the same report.
  const before = manifestDoc({
    columns: Array.from({ length: 11 }, (unused, index) => column({ name: `c${index}`, type: 'int64' })),
  })
  const after = manifestDoc({
    columns: Array.from({ length: 11 }, (unused, index) => column({
      name: `c${index}`,
      type: index === 2 || index === 10 ? 'int32' : 'int64',
    })),
  })
  const root = await makeRoot()
  await writeDocument(root, 'before.json', before)
  await writeDocument(root, 'after.json', after)

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })

  assert.deepEqual(report.findings.map((item) => item.location.pointer), ['/columns/10', '/columns/2'])
})

test('two findings on the same column sort by rule id by code unit', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', manifestDoc({ columns: [column({ name: 'v', type: 'int64', nullable: true, unit: 'kWh' })] }))
  await writeDocument(root, 'after.json', manifestDoc({ columns: [column({ name: 'v', type: 'int32', nullable: false, unit: 'MWh' })] }))

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })

  assert.deepEqual(report.findings.map((item) => item.ruleId), [
    'nullability-tightened-breaking',
    'type-narrowed-breaking',
    'unit-changed-breaking',
  ])
})

test('byCodeUnit orders the pairs a collator reorders', () => {
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  assert.equal(byCodeUnit('README', 'assets'), -1)
  assert.equal(byCodeUnit('same', 'same'), 0)
})
