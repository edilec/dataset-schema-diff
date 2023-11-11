/**
 * Decoding, ordering, sanitising and parse-failure primitives.
 *
 * Nothing in this module reads the filesystem, the clock, the locale, the
 * environment or the network, so every function is a pure function of its
 * arguments. That is what lets two runs over the same two manifests produce
 * byte-identical stdout.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` and `Intl.Collator` both consult ICU data that differs
 * between Node builds and platforms, so two correct machines can disagree
 * about the order of the same report. A schema diff is diffed again in review
 * and compared between a developer's machine and CI; its order is part of the
 * output contract and may never depend on a collation table. The difference is
 * not theoretical: by code unit `Z` precedes `a`, `a-b` precedes `a_b`, and
 * `/columns/10` precedes `/columns/2`. Collation reverses all three.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then looking for
 * U+FFFD in the result cannot tell undecodable bytes apart from a document
 * that legitimately contains a replacement character, and that confusion has
 * already let an unreadable input report a pass in this catalog. The decoder
 * decides; the decoded text never gets a vote.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * Characters removed before any manifest-derived string reaches output.
 *
 * Built from code points rather than written literally, because a literal
 * U+2028 inside a module is a syntax hazard and the whole point of the class
 * is that these characters never reach a line somebody reads. Each class
 * forges or hides something:
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F): a bare newline forges a whole
 *   line in the human summary; the rest drive a terminal.
 * - **C1** (U+0080-U+009F): U+0085 is NEL, which starts a new line on a
 *   terminal exactly as a line feed does, and U+009B is the 8-bit CSI, which
 *   opens an escape sequence. Neither is ECMAScript whitespace and neither is
 *   escaped by `JSON.stringify`, so a sanitiser that stops at C0 lets both
 *   through to stdout intact.
 * - **U+2028 / U+2029**: they terminate a line for a JavaScript consumer.
 * - **Bidi controls** (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069): U+202E
 *   reverses everything displayed after it, so a column named one thing reads
 *   as another; the isolates hide what they wrap.
 *
 * This applies to column names, type names, unit strings, dataset names, file
 * paths and pointers alike -- not only to an excerpt field. A column name
 * arrives from the same untrusted export a unit string does, and a name
 * carrying a newline forges whole lines in a human summary just as well.
 */
const CONTROL = new RegExp(
  '['
  + `${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}`
  + `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
  + `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}`
  + `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}`
  + `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`
  + `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
  + ']',
  'g',
)

/** The classes above, exported so a test can name each one it exercises. */
export const CONTROL_CLASSES = Object.freeze({
  c0: Object.freeze([0x00, 0x09, 0x0a, 0x0d, 0x1f]),
  del: Object.freeze([0x7f]),
  c1: Object.freeze([0x80, 0x85, 0x9b, 0x9f]),
  lineSeparators: Object.freeze([0x2028, 0x2029]),
  bidi: Object.freeze([0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]),
})

export const EXCERPT_LIMIT = 160

/**
 * Render a value as text without trusting it to be renderable.
 *
 * `String(value)` throws `Cannot convert object to primitive value` for an
 * object carrying a non-callable own `toString`, and `{"toString": {}}` in a
 * manifest is enough to reach it -- as a column name, a type, or
 * `manifestVersion`, which is read before any other check and so on any
 * document at all. Uncaught, that costs the whole report: stdout is empty on
 * exit 2, which is the shape this contract reserves for a configuration error,
 * and one malformed manifest suppresses the findings about the other.
 *
 * A value that cannot be rendered is described by its shape instead, which is
 * what the rest of this module does with untrusted content anyway: described,
 * never reproduced. The description carries nothing of the document, so a
 * neighbouring field cannot leak out through it.
 */
export function renderable(value) {
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    if (Array.isArray(value)) return '[array]'
    return `[${value === null ? 'null' : typeof value}]`
  }
}

/**
 * A bounded, single-line, control-free rendering of an untrusted value.
 *
 * Everything that came out of a manifest passes through here on its way to the
 * report: column names, type names, units, dataset names, pointer segments and
 * excerpts alike.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Excerpt limit must be a positive integer')
  const flattened = renderable(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/** True when a string carries any character the report may not reproduce. */
export function hasForbiddenCharacter(value) {
  CONTROL.lastIndex = 0
  return CONTROL.test(renderable(value))
}

/**
 * True when a value is a string that will still be there after sanitising.
 *
 * `value.trim().length > 0` is the check this replaces, and it is wrong:
 * `trim` removes ECMAScript whitespace only, so a column name of U+0001 or
 * U+200E passes it and then renders as the empty string -- a required field
 * that renders empty, which is "unknown reported as a pass" arriving through
 * the back door. Validate what will be RENDERED, which is what `excerpt`
 * produces, not what the raw string looks like.
 */
export function isUsableText(value, limit) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > limit) return false
  return excerpt(value, limit).length > 0
}

/** A value that is an object and not an array and not null. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. An offset says nothing about content, so it is safe. */
const PARSE_POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input back. Recognised FIRST: a document whose own
 * text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so looking for
 * the offset first finds that phrase INSIDE the quoted span and slices the
 * document straight back out. The `s` flag matters too: the quoted span can
 * contain a newline, and a non-dotAll pattern silently fails to recognise the
 * shape it exists to catch.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = PARSE_POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Describe a JSON parse failure without reproducing the document.
 *
 * V8 reports a parse failure two ways and one of them quotes the input it
 * choked on: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`,
 * or a ten-character prefix followed by `"..."`. A document short enough to be
 * only a credential is therefore reproduced in full by its own error message,
 * and truncating the front does not help: the quoted window is taken from
 * wherever the offence is, not from the start.
 *
 * The closing guard is deliberate belt and braces, and it is the reason this
 * function is safe against wordings it has never seen: across the measured
 * corpus of distinct V8 parse messages, every message carrying no quoted
 * snippet also carried no double quote at all -- V8 quotes JSON punctuation
 * with apostrophes. So a surviving double quote means a snippet survived,
 * whatever the branches above concluded, and the generic sentence is used
 * instead.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}
