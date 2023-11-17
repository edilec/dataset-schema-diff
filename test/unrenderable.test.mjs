/**
 * `String(value)` throws for an object carrying a non-callable own `toString`,
 * and `{"toString": {}}` in a document is enough to reach it. Uncaught, one
 * malformed manifest costs the whole report: stdout empty on exit 2, which is
 * the shape reserved for a configuration error.
 *
 * Each field below is a field the tool renders into a message before, or
 * instead of, any schema check.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { diffSchemas, renderable } from '../src/index.mjs'
import { makeRoot, manifestDoc, runCli, writeDocument } from './support.mjs'

const UNRENDERABLE = '{"toString": {}}'

test('String() really does throw for this shape, so the guard is not theoretical', () => {
  assert.throws(() => String(JSON.parse(UNRENDERABLE)), TypeError)
  assert.equal(renderable(JSON.parse(UNRENDERABLE)), '[object]')
  assert.equal(renderable([1, 2]), '1,2')
  assert.equal(renderable(null), 'null')
})

for (const [label, document] of [
  ['manifestVersion', `{"manifestVersion": ${UNRENDERABLE}, "dataset": "d", "version": "1", "sourceFormat": "csv", "columns": []}`],
  ['sourceFormat', `{"manifestVersion": "1", "dataset": "d", "version": "1", "sourceFormat": ${UNRENDERABLE}, "columns": []}`],
  ['dataset', `{"manifestVersion": "1", "dataset": ${UNRENDERABLE}, "version": "1", "sourceFormat": "csv", "columns": []}`],
  ['a column name', `{"manifestVersion": "1", "dataset": "d", "version": "1", "sourceFormat": "csv", "columns": [{"name": ${UNRENDERABLE}, "type": "int32", "nullable": false}]}`],
  ['a column type', `{"manifestVersion": "1", "dataset": "d", "version": "1", "sourceFormat": "csv", "columns": [{"name": "a", "type": ${UNRENDERABLE}, "nullable": false}]}`],
]) {
  test(`an unrenderable ${label} is described, and the report still arrives`, async () => {
    const root = await makeRoot()
    await writeDocument(root, 'before.json', document)
    await writeDocument(root, 'after.json', manifestDoc())

    const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })

    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.length > 0)
    // The description carries nothing of the document, so a neighbouring field
    // cannot leak out through it.
    for (const item of report.findings) assert.ok(!item.message.includes('toString'))
  })
}

test('the CLI still writes a report on stdout for an unrenderable field', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', `{"manifestVersion": ${UNRENDERABLE}, "dataset": "d", "version": "1", "sourceFormat": "csv", "columns": []}`)
  await writeDocument(root, 'after.json', manifestDoc())

  const run = await runCli(['--root', root, '--before', 'before.json', '--after', 'after.json', '--json'])

  assert.equal(run.code, 2)
  assert.notEqual(run.stdout, '', 'an empty stdout here would be the configuration-error shape')
  assert.equal(JSON.parse(run.stdout).status, 'incomplete')
})
