/**
 * Every untrusted string that reaches output passes through the sanitiser --
 * column names, type names, units, dataset names and paths, not only an
 * excerpt field. One tool in this catalog sanitised its evidence carefully and
 * let a page id carrying a newline forge whole lines in the report.
 *
 * Each class in the table is tested, and each is tested arriving through an
 * IDENTIFIER (a column name), not only through an excerpt.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTROL_CLASSES, compareAsRendered, describeCharacterDifference, excerpt, isUsableText } from '../src/text.mjs'
import { diffSchemas, formatReport } from '../src/index.mjs'
import { column, makeRoot, manifestDoc, runCli, writeDocument } from './support.mjs'

/**
 * Every string the report carries, walked out of the object itself.
 *
 * Asserting against `JSON.stringify` output would be the wrong check twice
 * over: it escapes control characters on the way out, hiding a character that
 * IS in the field, and it adds newlines of its own from pretty-printing. The
 * field values are what a consumer reads.
 */
function stringsIn(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringsIn(entry, found)
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) stringsIn(entry, found)
  return found
}

const CLASS_NAMES = ['c0', 'del', 'c1', 'lineSeparators', 'bidi']

test('the sanitiser knows about every class the contract names', () => {
  assert.deepEqual(Object.keys(CONTROL_CLASSES), CLASS_NAMES)
  assert.ok(CONTROL_CLASSES.c1.includes(0x85), 'NEL forges a line on a terminal')
  assert.ok(CONTROL_CLASSES.c1.includes(0x9b), 'the 8-bit CSI opens an escape sequence')
  assert.ok(CONTROL_CLASSES.bidi.includes(0x202e), 'RIGHT-TO-LEFT OVERRIDE reverses displayed text')
  assert.ok(CONTROL_CLASSES.lineSeparators.includes(0x2028))
})

/** The human summary for the same comparison with a name carrying nothing odd. */
async function cleanSummaryLineCount() {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', manifestDoc({ columns: [column({ name: 'ok name', type: 'int64' })] }))
  await writeDocument(root, 'after.json', manifestDoc({ columns: [column({ name: 'ok name', type: 'int32' })] }))
  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })
  return formatReport(report).split('\n').length
}

for (const className of CLASS_NAMES) {
  test(`a column name carrying a ${className} character is sanitised out of the report`, async () => {
    const expectedLines = await cleanSummaryLineCount()
    for (const codePoint of CONTROL_CLASSES[className]) {
      const forged = `ok${String.fromCharCode(codePoint)}name`
      const root = await makeRoot()
      await writeDocument(root, 'before.json', manifestDoc({ columns: [column({ name: forged, type: 'int64' })] }))
      await writeDocument(root, 'after.json', manifestDoc({ columns: [column({ name: forged, type: 'int32' })] }))

      const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })

      // What IS there, beside what is not: the finding was raised, and the
      // name reached the message with the character removed.
      assert.equal(report.findings[0].ruleId, 'type-narrowed-breaking')
      assert.match(report.findings[0].message, /ok name/)
      for (const text of stringsIn(report)) {
        assert.ok(
          !text.includes(String.fromCharCode(codePoint)),
          `U+${codePoint.toString(16).padStart(4, '0')} survived into a report field`,
        )
      }
      // The human summary is line-oriented, so the guarantee there is
      // structural: a forged character must not add a line to it.
      assert.equal(
        formatReport(report).split('\n').length,
        expectedLines,
        'a control character changed the shape of the human summary',
      )
    }
  })
}

test('a unit string carrying a control character is sanitised', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', manifestDoc({ columns: [column({ name: 'v', unit: 'kWh' })] }))
  await writeDocument(root, 'after.json', manifestDoc({ columns: [column({ name: 'v', unit: `M${String.fromCharCode(0x2028)}Wh` })] }))

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })

  assert.equal(report.findings[0].ruleId, 'unit-changed-breaking')
  assert.ok(stringsIn(report).every((text) => !text.includes(String.fromCharCode(0x2028))))
  assert.match(report.findings[0].evidence, /kWh -> M Wh/)
})

test('a newline in a column name cannot forge a line in the human summary', async () => {
  const forged = `a\nERROR  forged-rule  everything is fine`
  const root = await makeRoot()
  await writeDocument(root, 'before.json', manifestDoc({ columns: [column({ name: forged, type: 'int64' })] }))
  await writeDocument(root, 'after.json', manifestDoc({ columns: [column({ name: forged, type: 'int32' })] }))

  const run = await runCli(['--root', root, '--before', 'before.json', '--after', 'after.json'])

  assert.equal(run.code, 1)
  const forgedLines = run.stderr.split('\n').filter((line) => line.startsWith('ERROR'))
  assert.deepEqual(forgedLines, [], 'a finding line must start with the tool\'s own indentation')
  assert.match(run.stderr, /ERROR  type-narrowed-breaking/)
})

test('a name that renders empty is refused, not accepted as present', () => {
  // `value.trim().length > 0` passes for both of these and then renders as the
  // empty string -- a required field that says nothing.
  assert.equal(isUsableText(String.fromCharCode(0x0001), 200), false)
  assert.equal(isUsableText(String.fromCharCode(0x200e), 200), false)
  assert.equal(isUsableText('   ', 200), false)
  assert.equal(isUsableText('name', 200), true)
  assert.equal(String.fromCharCode(0x0001).trim().length > 0, true, 'trim alone would have accepted it')
})

test('a column whose name renders empty makes the run incomplete', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', manifestDoc({ columns: [column({ name: String.fromCharCode(0x200e) })] }))
  await writeDocument(root, 'after.json', manifestDoc())

  const report = await diffSchemas({ root, before: 'before.json', after: 'after.json' })

  assert.equal(report.findings[0].ruleId, 'column-invalid')
  assert.equal(report.findings[0].location.pointer, '/columns/0/name')
  assert.equal(report.status, 'incomplete')
})

test('excerpt bounds what it renders and reports the truncation', () => {
  assert.equal(excerpt('x'.repeat(10), 5), 'xxxxx...')
  assert.equal(excerpt('x'.repeat(5), 5), 'xxxxx')
  // Both sides of the truncation comparison. Ten characters is well over the
  // limit and five is well under it; the value that decides `<=` from `<` is
  // the one exactly one over, and nothing drove it.
  assert.equal(excerpt('x'.repeat(6), 5), 'xxxxx...')
  // And both sides of the limit's own bound: 1 is a positive integer.
  assert.equal(excerpt('xy', 1), 'x...')
  assert.equal(excerpt('x', 1), 'x')
  assert.throws(() => excerpt('x', 0), TypeError)
  assert.throws(() => excerpt('x', 1.5), TypeError)
})

test('compareAsRendered separates a real change from one the report cannot show', () => {
  assert.equal(compareAsRendered('kWh', 'kWh', 40), 'same')
  assert.equal(compareAsRendered('kWh', 'MWh', 40), 'different')
  // The emblem of the class: a plain trailing space, no control character.
  assert.equal(compareAsRendered('kWh', 'kWh ', 40), 'stripped-only')
  assert.equal(compareAsRendered('kWh', `kWh${String.fromCharCode(0x0085)}`, 40), 'stripped-only')
  assert.equal(compareAsRendered('kWh', `kWh${String.fromCharCode(0x202e)}`, 40), 'stripped-only')
})

test('describeCharacterDifference names the position and the code point on each side', () => {
  assert.equal(describeCharacterDifference('kWh', 'kWh '), 'at character 4: before the end of the value, after U+0020')
  assert.equal(describeCharacterDifference('kWh ', 'kWh'), 'at character 4: before U+0020, after the end of the value')
  assert.equal(describeCharacterDifference('a b', 'a  b'), 'at character 3: before U+0062, after U+0020')
  // By code point, so an astral character counts once rather than twice.
  assert.equal(describeCharacterDifference('\u{1f600}a', '\u{1f600}b'), 'at character 2: before U+0061, after U+0062')
})
