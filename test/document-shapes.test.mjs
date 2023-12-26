/**
 * Document shapes that are not what they must be, each refused for its OWN
 * reason.
 *
 * A mutation sweep found every guard here silent. Not because the refusal
 * disappeared -- a later guard still refused the same document -- but because
 * the suite only asked whether SOME finding arrived. `manifest-invalid` is
 * produced by six sites, so "the list includes manifest-invalid" is satisfied
 * by five of them being wrong. Every test below asserts the exact set of rule
 * ids and the pointer, which is what makes the guard that produced it the one
 * under test.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { diffSchemas, exitCodeFor } from '../src/index.mjs'
import { column, makeRoot, manifestDoc, twoManifests, writeDocument } from './support.mjs'

/** Drive one broken `before` against a valid `after` and return the report. */
async function report(before) {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', before)
  await writeDocument(root, 'after.json', manifestDoc())
  return diffSchemas({ root, before: 'before.json', after: 'after.json' })
}

const idsOf = (found) => found.findings.map((item) => item.ruleId)
const at = (found, ruleId) => found.findings.find((item) => item.ruleId === ruleId).location.pointer

test('a manifest that is a JSON array is refused as a manifest, and nothing else is said about it', async () => {
  // Without the shape guard the array is walked as an object: its indices
  // become unknown fields, its absent dataset and version become two more
  // findings, and the document is refused for five reasons instead of one.
  const found = await report('[1, 2]')

  assert.deepEqual(idsOf(found), ['manifest-invalid'])
  assert.equal(at(found, 'manifest-invalid'), '')
  assert.equal(found.findings[0].message, 'the manifest must be a JSON object')
  assert.equal(exitCodeFor(found), 2)
})

test('a manifest whose dataset or version is missing or unusable is refused at that field', async () => {
  for (const [key, pointer] of [['dataset', '/dataset'], ['version', '/version']]) {
    for (const value of [undefined, '', 42, ' ']) {
      const document = manifestDoc()
      if (value === undefined) delete document[key]
      else document[key] = value
      const found = await report(document)

      assert.deepEqual(idsOf(found), ['manifest-invalid'], `${key} = ${JSON.stringify(value)}`)
      assert.equal(at(found, 'manifest-invalid'), pointer)
      assert.equal(found.summary.diffAttempted, false)
    }
  }
})

test('columns that is not an array is refused before any column is looked at', async () => {
  for (const columns of [undefined, {}, 'a,b', 7]) {
    const document = manifestDoc()
    if (columns === undefined) delete document.columns
    else document.columns = columns
    const found = await report(document)

    assert.deepEqual(idsOf(found), ['manifest-invalid'], `columns = ${JSON.stringify(columns)}`)
    assert.equal(at(found, 'manifest-invalid'), '/columns')
    assert.equal(found.findings[0].message, 'columns must be an array')
  }
})

test('a column entry that is not an object is one finding about that entry', async () => {
  for (const entry of ['order_id', 7, null, ['order_id']]) {
    const found = await report(manifestDoc({ columns: [column({ name: 'a' }), entry] }))

    assert.deepEqual(idsOf(found), ['column-invalid'], `entry = ${JSON.stringify(entry)}`)
    assert.equal(at(found, 'column-invalid'), '/columns/1')
    assert.equal(found.findings[0].message, 'a column entry must be a JSON object')
  }
})

test('an optional column field that is present and unusable is refused at that field', async () => {
  // unit, hasDefault and description are optional. Absent is legal; present
  // and unusable is not, and each has its own pointer and sentence.
  const cases = [
    ['unit', 7, '/columns/0/unit'],
    ['unit', '', '/columns/0/unit'],
    ['unit', ' ', '/columns/0/unit'],
    ['unit', 'k'.repeat(201), '/columns/0/unit'],
    ['hasDefault', 'yes', '/columns/0/hasDefault'],
    ['hasDefault', 1, '/columns/0/hasDefault'],
    ['hasDefault', null, '/columns/0/hasDefault'],
    ['description', 7, '/columns/0/description'],
    ['description', ' ', '/columns/0/description'],
    ['description', 'd'.repeat(201), '/columns/0/description'],
  ]
  for (const [field, value, pointer] of cases) {
    const entry = { name: 'a', type: 'int32', nullable: false, [field]: value }
    const found = await report(manifestDoc({ columns: [entry] }))

    assert.deepEqual(idsOf(found), ['column-invalid'], `${field} = ${JSON.stringify(value)}`)
    assert.equal(at(found, 'column-invalid'), pointer)
    assert.equal(found.summary.diffAttempted, false)
  }
})

test('the same three fields, absent, are legal and say nothing', async () => {
  // The other side of the bound: refusing an absent optional field would be a
  // finding raised on correct input.
  const bare = { name: 'a', type: 'int32', nullable: false }
  const { root, before, after } = await twoManifests(
    manifestDoc({ columns: [bare] }),
    manifestDoc({ version: '2026-04', columns: [bare] }),
  )
  const found = await diffSchemas({ root, before, after })

  assert.deepEqual(found.findings, [])
  assert.equal(found.summary.diffAttempted, true)
  assert.equal(found.status, 'pass')
})
