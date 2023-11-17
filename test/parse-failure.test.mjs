/**
 * V8 embeds the input in its own parse error message, so the message cannot be
 * passed on. `parseFailureDetail` is the guard, and the branch ORDER is the
 * whole guard: nineteen of thirty-eight tools in this catalog shipped a helper
 * that looked for `at position N` first, and a document whose text reads
 * `at position 1` then matched inside the quoted span and was sliced back out.
 *
 * Every case below is one of those shapes, asserted twice: against the helper,
 * and through the real report path, because the helper is only useful where it
 * is actually called.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { diffSchemas, parseFailureDetail } from '../src/index.mjs'
import { makeRoot, manifestDoc, writeDocument } from './support.mjs'

/** The detail V8 would give for this document, as the tool renders it. */
function detailFor(documentText) {
  try {
    JSON.parse(documentText)
  } catch (error) {
    return { raw: error.message, safe: parseFailureDetail(error) }
  }
  throw new Error('that document parsed, so there is nothing to describe')
}

/** Run the real entry point over a document and return its input-not-json finding. */
async function findingFor(documentText) {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', documentText)
  await writeDocument(root, 'after.json', manifestDoc())
  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })
  const item = report.findings.find((entry) => entry.ruleId === 'input-not-json')
  assert.ok(item !== undefined, 'expected an input-not-json finding')
  assert.equal(report.status, 'incomplete')
  return item
}

test('a document reading "at position 1" is not sliced back out of its own error', async () => {
  const document = 'at position 1'
  const { raw, safe } = detailFor(document)

  // V8 really does quote the document here; this is the case the ordering bug
  // was measured on.
  assert.match(raw, /"at position 1"/)
  assert.ok(!safe.includes('at position 1'), `leaked: ${safe}`)
  assert.equal(safe, "unexpected token 'a' at the start of the document")

  const item = await findingFor(document)
  assert.ok(!item.message.includes('at position 1'))
  assert.match(item.message, /the manifest is not valid JSON/)
})

test('a document that is only a credential is not reproduced by its own error message', async () => {
  // Invented, obviously synthetic, and not a credential for anything.
  const secret = 'NOT_A_REAL_KEY_00'
  const { raw, safe } = detailFor(secret)

  // Short enough that V8 quotes the whole document, which is the point: a
  // document that is only a credential is reproduced in full by its own error.
  assert.ok(raw.includes(secret), 'the raw V8 message is expected to carry the document')
  assert.ok(!safe.includes(secret), `leaked: ${safe}`)
  assert.equal(safe, "unexpected token 'N' at the start of the document")

  const item = await findingFor(secret)
  assert.ok(!item.message.includes(secret))
  assert.ok(!item.message.includes('NOT_A_REAL'))
})

test('a long document with a sensitive prefix leaks neither its prefix nor its middle', async () => {
  const secret = 'NOT_A_REAL_TOKEN_1234567890'
  const document = `{"note": "${secret}", "columns": [${'0,'.repeat(200)}] ZZZ}`
  const { raw, safe } = detailFor(document)

  // The quoted window V8 chooses comes from the offence, not from the start.
  assert.match(raw, /"/)
  assert.ok(!safe.includes(secret), `leaked: ${safe}`)
  assert.ok(!safe.includes('"'), `a quoted span survived: ${safe}`)

  const item = await findingFor(document)
  assert.ok(!item.message.includes(secret))
})

test('a quoted span containing a newline is still recognised as a quoted span', async () => {
  // Without the `s` flag the pattern silently fails to match here, and the
  // helper falls through to the position branch -- which is how the document
  // gets out.
  const secret = 'NOT_A_REAL_SECRET_LINE_TWO'
  const document = `x\n${secret}`
  const { raw, safe } = detailFor(document)

  // V8 quotes a ten-character window, so what leaks here is the start of the
  // secret with the newline still inside the quoted span.
  assert.match(raw, /"x\nNOT_A_RE"/)
  assert.ok(!safe.includes('NOT_A_RE'), `leaked: ${safe}`)
  assert.ok(!safe.includes('"'))
  assert.equal(safe, "unexpected token 'x' at the start of the document")

  const item = await findingFor(document)
  assert.ok(!item.message.includes('NOT_A_RE'))
  // And the sanitiser has flattened what remains onto one line.
  assert.ok(!item.message.includes('\n'))
})

test('the safe positional form still yields the position, which is the useful half', async () => {
  const document = '{"manifestVersion": "1", "dataset": "orders" "version": "1"}'
  const { raw, safe } = detailFor(document)

  assert.match(raw, /at position \d+/)
  assert.match(safe, /at position \d+/)
  assert.ok(!safe.includes('"'))

  const item = await findingFor(document)
  assert.match(item.message, /at position \d+/)
})

test('a message carrying a double quote never reaches the report, whatever the branches concluded', async () => {
  // The backstop, exercised directly: a wording this helper has never been
  // taught still cannot carry a snippet out.
  const invented = parseFailureDetail(new Error('Some future wording, "PAYLOAD" was not expected'))
  assert.equal(invented, 'the document could not be parsed as JSON')

  assert.equal(parseFailureDetail(new Error('Unexpected end of JSON input')), 'Unexpected end of JSON input')
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})

test('a truncated document is described without being quoted', async () => {
  const item = await findingFor('{ "manifestVersion": ')
  assert.match(item.message, /Unexpected end of JSON input/)
  assert.ok(!item.message.includes('manifestVersion'))
})
