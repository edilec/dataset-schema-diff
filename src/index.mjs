/**
 * dataset-schema-diff -- compare two versioned schema manifests and classify
 * every difference under a declared compatibility policy.
 *
 * What this tool sees is two JSON documents somebody exported. It connects to
 * no warehouse, resolves no host, runs no query and reads no clock. Every
 * sentence in the report is a sentence about those two documents.
 *
 * The rule the whole design turns on: a difference this tool cannot classify is
 * reported as unclassified and makes the run `incomplete`. It is never folded
 * into "no breaking changes found", because a consumer reads that sentence as
 * evidence and it would not be evidence.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

import {
  byCodeUnit, decodeUtf8, excerpt, isPlainObject, isUsableText, parseFailureDetail,
} from './text.mjs'
import { classifyTypeChange, normaliseType } from './types.mjs'

export { byCodeUnit, excerpt, isUsableText, parseFailureDetail, renderable } from './text.mjs'
export { KNOWN_TYPE_BASES, DECLARED_WIDENING_EDGES, classifyTypeChange, normaliseType, parseType } from './types.mjs'

/** Equal to the directory and package name. A test asserts that, in both directions. */
export const TOOL_ID = 'dataset-schema-diff'

/** The report envelope version from the Edilec tool report contract. */
export const SCHEMA_VERSION = '1'

/** Manifest document versions this tool understands. Anything else is unknown, not assumed. */
export const SUPPORTED_MANIFEST_VERSIONS = Object.freeze(['1'])

/**
 * Source formats this tool understands.
 *
 * A manifest naming any other format is refused rather than compared: the
 * meaning of "nullable" and of column order is a property of the format, and
 * guessing at a format this tool has never been taught would be guessing about
 * the data.
 */
export const SUPPORTED_SOURCE_FORMATS = Object.freeze(['csv', 'json', 'sql'])

/** Compatibility modes, in the Avro/Confluent sense documented in the README. */
export const COMPATIBILITY_MODES = Object.freeze(['backward', 'forward', 'full'])

/** What a reordering of the shared columns does. `ignore` suppresses the finding, never the fact. */
export const COLUMN_ORDER_MODES = Object.freeze(['ignore', 'warn', 'breaking'])

export const DEFAULT_POLICY = Object.freeze({ compatibility: 'backward', columnOrder: 'warn' })

/**
 * Limits, enforced BEFORE the work they bound rather than after it.
 *
 * `maxDocumentBytes` is checked against the file size from `stat` before a byte
 * is read, and against the buffer after, so a file that grows between the two
 * cannot slip past. `maxColumns` is checked against the declared array length
 * before any column is examined. A legal-sized input therefore cannot exhaust
 * memory, which is the failure this section exists to prevent: a heap death is
 * exit 134 with empty stdout, outside the exit contract entirely.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxDocumentBytes: 1048576,
  maxColumns: 2000,
  maxFieldLength: 200,
  maxFindings: 1000,
})

/**
 * One frozen ruleId -> severity table. Severity decides the exit code, so it is
 * never written at a construction site: `finding()` reads it here and throws on
 * an id that is not in the table.
 *
 * Note the shape of the change ids: the verdict is part of the id, because a
 * verdict depends on the declared policy and a severity may not. Under
 * `forward`, a narrowing is genuinely compatible, and it gets an id that says
 * so rather than a severity quietly demoted at the call site.
 */
const RULE_SEVERITY = Object.freeze({
  'column-added-breaking': 'error',
  'column-added-compatible': 'info',
  'column-added-default-unknown': 'error',
  'column-invalid': 'error',
  'column-name-duplicate': 'error',
  'column-nullability-undeclared': 'error',
  'column-order-changed-breaking': 'error',
  'column-order-changed-noted': 'warning',
  'column-removed-breaking': 'error',
  'column-removed-compatible': 'info',
  'column-removed-default-unknown': 'error',
  'column-unknown-field': 'error',
  'dataset-mismatch': 'warning',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'manifest-invalid': 'error',
  'manifest-unknown-field': 'error',
  'manifest-version-unsupported': 'error',
  'no-columns-declared': 'error',
  'nullability-relaxed-breaking': 'error',
  'nullability-relaxed-compatible': 'info',
  'nullability-tightened-breaking': 'error',
  'nullability-tightened-compatible': 'info',
  'path-escapes-root': 'error',
  'source-format-changed-breaking': 'error',
  'source-format-unsupported': 'error',
  'too-many-columns': 'error',
  'too-many-findings': 'error',
  'type-change-unclassified': 'error',
  'type-narrowed-breaking': 'error',
  'type-narrowed-compatible': 'info',
  'type-widened-breaking': 'error',
  'type-widened-compatible': 'info',
  'unit-changed-breaking': 'error',
  'unit-declared': 'info',
  'unit-undeclared': 'warning',
})

/**
 * The rules that mean evidence was missing, unreadable or unclassifiable.
 *
 * Any one of them makes the report `incomplete`, which exits 2. Status is
 * derived from this set rather than assigned at each site, so there is no
 * `incomplete = true` line to delete: removing an id from this freeze is the
 * mutation, and every id here has a test that drives it through the real entry
 * point and asserts exit 2.
 */
const INCOMPLETE_RULES = Object.freeze(new Set([
  'column-added-default-unknown',
  'column-invalid',
  'column-name-duplicate',
  'column-nullability-undeclared',
  'column-removed-default-unknown',
  'column-unknown-field',
  'input-not-json',
  'input-not-utf8',
  'input-too-large',
  'input-unreadable',
  'manifest-invalid',
  'manifest-unknown-field',
  'manifest-version-unsupported',
  'no-columns-declared',
  'path-escapes-root',
  'source-format-unsupported',
  'too-many-columns',
  'too-many-findings',
  'type-change-unclassified',
]))

/** The catalogue, exported so docs and tests can be checked against it in both directions. */
export const RULE_CATALOG = Object.freeze(
  Object.keys(RULE_SEVERITY).sort(byCodeUnit).map((ruleId) => Object.freeze({
    ruleId,
    severity: RULE_SEVERITY[ruleId],
    incomplete: INCOMPLETE_RULES.has(ruleId),
  })),
)

const MESSAGE_LIMIT = 400
const LOCATION_LIMIT = 200
const EVIDENCE_LIMIT = 160
const SUGGESTION_LIMIT = 300

/** A configuration error: the run never had a subject, so stdout stays empty. */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function finding({ ruleId, file, pointer = '', message, evidence, suggestion }) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`No severity is declared for rule "${ruleId}"`)
  const built = {
    ruleId,
    severity,
    message: excerpt(message, MESSAGE_LIMIT),
    location: { file: excerpt(file, LOCATION_LIMIT), pointer: excerpt(pointer, LOCATION_LIMIT) },
  }
  if (evidence !== undefined) built.evidence = excerpt(evidence, EVIDENCE_LIMIT)
  if (suggestion !== undefined) built.suggestion = excerpt(suggestion, SUGGESTION_LIMIT)
  return built
}

function normaliseLimits(given) {
  if (!isPlainObject(given)) throw new ConfigError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(given)) {
    // A typo in a limit name must not silently restore the default: that is how
    // a documented limit becomes a limit nobody enforces.
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new ConfigError(`Unknown limit "${excerpt(key, 60)}"`)
    if (!Number.isInteger(value) || value < 1) throw new ConfigError(`Limit "${key}" must be a positive integer`)
    limits[key] = value
  }
  return Object.freeze(limits)
}

function normalisePolicy(given) {
  if (!isPlainObject(given)) throw new ConfigError('policy must be an object')
  const policy = { ...DEFAULT_POLICY }
  for (const [key, value] of Object.entries(given)) {
    if (!Object.hasOwn(DEFAULT_POLICY, key)) throw new ConfigError(`Unknown policy key "${excerpt(key, 60)}"`)
    policy[key] = value
  }
  if (!COMPATIBILITY_MODES.includes(policy.compatibility)) {
    throw new ConfigError(`policy.compatibility must be one of ${COMPATIBILITY_MODES.join(', ')}`)
  }
  if (!COLUMN_ORDER_MODES.includes(policy.columnOrder)) {
    throw new ConfigError(`policy.columnOrder must be one of ${COLUMN_ORDER_MODES.join(', ')}`)
  }
  return Object.freeze(policy)
}

/**
 * Read a policy document.
 *
 * A policy is configuration, not subject matter, so a policy this tool cannot
 * read is a ConfigError -- empty stdout, exit 2 -- and not an `incomplete`
 * report. The run never had a policy to judge anything against.
 */
export async function readPolicyDocument(path) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new ConfigError(`--policy could not be read: ${error.code ?? 'unknown error'}`)
  }
  if (bytes.byteLength > DEFAULT_LIMITS.maxDocumentBytes) throw new ConfigError('--policy is larger than 1048576 bytes')
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) throw new ConfigError('--policy is not valid UTF-8')
  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    throw new ConfigError(`--policy is not valid JSON: ${parseFailureDetail(error)}`)
  }
  if (!isPlainObject(parsed)) throw new ConfigError('--policy must contain a JSON object')
  const { policyVersion, ...rest } = parsed
  if (policyVersion !== '1') throw new ConfigError('--policy must declare "policyVersion": "1"')
  return normalisePolicy(rest)
}

/**
 * Resolve one input path inside the declared root.
 *
 * Two checks, because neither covers the other. The lexical one refuses an
 * absolute path and a `..` segment, which keeps an obvious escape out of the
 * report's `location.file`. The real one resolves symbolic links and asserts
 * the result is inside the resolved root, because a symlink planted inside a
 * root is not refused by any amount of string inspection -- that hole has
 * already echoed out-of-root content into a report in this catalog.
 */
async function resolveInside(realRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { ok: false, reason: 'not-a-path' }
  }
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    return { ok: false, reason: 'escapes-root' }
  }
  const candidate = resolve(realRoot, relativePath)
  let real
  try {
    real = await realpath(candidate)
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, reason: 'missing' }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ok: false, reason: 'escapes-root' }
  return { ok: true, path: real }
}

/** Read, decode and parse one manifest document. Never throws for a bad input. */
async function loadManifest(realRoot, relativePath, limits) {
  const located = await resolveInside(realRoot, relativePath)
  if (!located.ok) {
    if (located.reason === 'escapes-root') {
      return {
        ok: false,
        problem: finding({
          ruleId: 'path-escapes-root',
          file: relativePath,
          message: 'the path resolves outside the declared root, so it was not read',
          suggestion: 'name a manifest inside --root; a symbolic link out of the root does not widen it',
        }),
      }
    }
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-unreadable',
        file: relativePath,
        message: `the manifest could not be opened (${located.reason === 'missing' ? 'ENOENT' : located.code ?? 'unknown error'})`,
      }),
    }
  }

  // The size bound is checked before a byte is read, and again after, because a
  // file can grow between the two calls.
  let size
  try {
    size = (await stat(located.path)).size
  } catch (error) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-unreadable',
        file: relativePath,
        message: `the manifest could not be inspected (${error.code ?? 'unknown error'})`,
      }),
    }
  }
  if (size > limits.maxDocumentBytes) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-too-large',
        file: relativePath,
        message: `the manifest is ${size} bytes, over the ${limits.maxDocumentBytes} byte limit, so it was not read`,
        suggestion: 'raise --max-document-bytes deliberately, or split the manifest',
      }),
    }
  }

  let bytes
  try {
    bytes = await readFile(located.path)
  } catch (error) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-unreadable',
        file: relativePath,
        message: `the manifest could not be read (${error.code ?? 'unknown error'})`,
      }),
    }
  }
  if (bytes.byteLength > limits.maxDocumentBytes) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-too-large',
        file: relativePath,
        message: `the manifest is ${bytes.byteLength} bytes, over the ${limits.maxDocumentBytes} byte limit`,
      }),
    }
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-not-utf8',
        file: relativePath,
        message: 'the manifest is not valid UTF-8, so it was not decoded',
      }),
    }
  }

  try {
    return { ok: true, document: JSON.parse(decoded.text) }
  } catch (error) {
    return {
      ok: false,
      problem: finding({
        ruleId: 'input-not-json',
        file: relativePath,
        // parseFailureDetail describes the failure without quoting the
        // document: V8's own message embeds the offending input.
        message: `the manifest is not valid JSON: ${parseFailureDetail(error)}`,
      }),
    }
  }
}

const MANIFEST_FIELDS = Object.freeze(['manifestVersion', 'dataset', 'version', 'sourceFormat', 'columns'])
const COLUMN_FIELDS = Object.freeze(['name', 'type', 'nullable', 'unit', 'hasDefault', 'description'])

/**
 * Validate one manifest and build its column index.
 *
 * Returns the index only when NOTHING was dropped. A column entry this function
 * could not read is not skipped over: the manifest is reported unusable and no
 * diff is attempted against it. The alternative -- indexing what parsed and
 * comparing against that -- is the failure this catalog has paid for twice: the
 * missing entry then reads as "the column is not there", and the report asserts
 * an addition or a removal that the evidence never supported.
 */
function validateManifest(document, file, limits) {
  const problems = []
  const add = (options) => problems.push(finding({ file, ...options }))

  if (!isPlainObject(document)) {
    add({ ruleId: 'manifest-invalid', message: 'the manifest must be a JSON object' })
    return { ok: false, problems }
  }

  for (const key of Object.keys(document)) {
    if (!MANIFEST_FIELDS.includes(key)) {
      add({
        ruleId: 'manifest-unknown-field',
        pointer: `/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        message: `the manifest declares "${excerpt(key, 60)}", which this tool does not understand, so it cannot claim to have read the manifest completely`,
        suggestion: `manifest fields are ${MANIFEST_FIELDS.join(', ')}`,
      })
    }
  }

  if (!SUPPORTED_MANIFEST_VERSIONS.includes(document.manifestVersion)) {
    add({
      ruleId: 'manifest-version-unsupported',
      pointer: '/manifestVersion',
      message: `manifestVersion must be one of ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}; this document declares ${JSON.stringify(excerpt(document.manifestVersion, 40))}`,
    })
  }
  for (const key of ['dataset', 'version']) {
    if (!isUsableText(document[key], limits.maxFieldLength)) {
      add({
        ruleId: 'manifest-invalid',
        pointer: `/${key}`,
        message: `${key} must be a non-empty string of at most ${limits.maxFieldLength} characters that is still non-empty once control characters are removed`,
      })
    }
  }
  if (!SUPPORTED_SOURCE_FORMATS.includes(document.sourceFormat)) {
    add({
      ruleId: 'source-format-unsupported',
      pointer: '/sourceFormat',
      message: `sourceFormat ${JSON.stringify(excerpt(document.sourceFormat, 40))} is not one of ${SUPPORTED_SOURCE_FORMATS.join(', ')}; this tool does not guess what a format it has not been taught means for nullability or column order`,
    })
  }

  if (!Array.isArray(document.columns)) {
    add({ ruleId: 'manifest-invalid', pointer: '/columns', message: 'columns must be an array' })
    return { ok: false, problems }
  }
  // Bound checked against the declared length before any column is examined.
  if (document.columns.length > limits.maxColumns) {
    add({
      ruleId: 'too-many-columns',
      pointer: '/columns',
      message: `the manifest declares ${document.columns.length} columns, over the ${limits.maxColumns} column limit, so none of them were compared`,
      suggestion: 'raise --max-columns deliberately',
    })
    return { ok: false, problems }
  }
  if (document.columns.length === 0) {
    add({
      ruleId: 'no-columns-declared',
      pointer: '/columns',
      message: 'the manifest declares no columns, so there is nothing to compare and a clean result would mean nothing',
    })
  }

  const index = new Map()
  for (const [position, raw] of document.columns.entries()) {
    const pointer = `/columns/${position}`
    if (!isPlainObject(raw)) {
      add({ ruleId: 'column-invalid', pointer, message: 'a column entry must be a JSON object' })
      continue
    }
    for (const key of Object.keys(raw)) {
      if (!COLUMN_FIELDS.includes(key)) {
        add({
          ruleId: 'column-unknown-field',
          pointer: `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
          message: `the column declares "${excerpt(key, 60)}", which this tool does not understand`,
          suggestion: `column fields are ${COLUMN_FIELDS.join(', ')}`,
        })
      }
    }
    // Any problem at all means this column is not indexed. The flag this
    // replaces had to be set at six separate sites, and forgetting one would
    // put a column the tool could not read into the index under a name it is
    // not sure of -- where a later duplicate of that name would then be
    // reported twice over.
    const problemsBefore = problems.length
    if (!isUsableText(raw.name, limits.maxFieldLength)) {
      add({
        ruleId: 'column-invalid',
        pointer: `${pointer}/name`,
        message: `a column name must be a non-empty string of at most ${limits.maxFieldLength} characters that is still non-empty once control characters are removed`,
      })
    }
    if (!isUsableText(raw.type, limits.maxFieldLength)) {
      add({
        ruleId: 'column-invalid',
        pointer: `${pointer}/type`,
        message: `a column type must be a non-empty string of at most ${limits.maxFieldLength} characters that is still non-empty once control characters are removed`,
      })
    }
    if (typeof raw.nullable !== 'boolean') {
      // Nullability is half of what this tool classifies. Defaulting an absent
      // flag to either value would invent the answer to the question the caller
      // asked, so it is declared or it is unknown.
      add({
        ruleId: 'column-nullability-undeclared',
        pointer: `${pointer}/nullable`,
        message: 'nullable must be declared as true or false; this tool does not assume one',
      })
    }
    if (raw.unit !== undefined && !isUsableText(raw.unit, limits.maxFieldLength)) {
      add({
        ruleId: 'column-invalid',
        pointer: `${pointer}/unit`,
        message: `unit, when present, must be a non-empty string of at most ${limits.maxFieldLength} characters that survives sanitising`,
      })
    }
    if (raw.hasDefault !== undefined && typeof raw.hasDefault !== 'boolean') {
      add({ ruleId: 'column-invalid', pointer: `${pointer}/hasDefault`, message: 'hasDefault, when present, must be true or false' })
    }
    if (raw.description !== undefined && !isUsableText(raw.description, limits.maxFieldLength)) {
      add({ ruleId: 'column-invalid', pointer: `${pointer}/description`, message: `description, when present, must be a string of at most ${limits.maxFieldLength} characters that survives sanitising` })
    }
    if (problems.length > problemsBefore) continue

    if (index.has(raw.name)) {
      // A duplicate name makes the by-name index ambiguous. Keeping the last
      // entry would silently drop the first and then compare against a schema
      // this manifest does not describe.
      add({
        ruleId: 'column-name-duplicate',
        pointer,
        message: `the column name ${JSON.stringify(excerpt(raw.name, 60))} is declared more than once, so a comparison by name is ambiguous`,
      })
      continue
    }
    index.set(raw.name, {
      name: raw.name,
      type: raw.type,
      nullable: raw.nullable,
      unit: raw.unit,
      hasDefault: raw.hasDefault,
      position,
    })
  }

  const ok = problems.length === 0
  return ok ? { ok, problems, index, order: [...index.keys()], document } : { ok, problems }
}

/**
 * Decide a verdict from the two directional answers and the declared mode.
 *
 * `backwardSafe` asks: can the NEW schema read data written under the old one?
 * `forwardSafe` asks: can the OLD schema read data written under the new one?
 * Either may be `null`, meaning this tool does not know -- and a null answer in
 * the direction the mode actually needs is `unknown`, never a pass.
 */
function verdictFor(mode, backwardSafe, forwardSafe) {
  const needed = mode === 'backward' ? [backwardSafe] : mode === 'forward' ? [forwardSafe] : [backwardSafe, forwardSafe]
  if (needed.includes(null)) return 'unknown'
  return needed.every(Boolean) ? 'compatible' : 'breaking'
}

function describeColumn(column) {
  const unit = column.unit === undefined ? '' : `, unit ${excerpt(column.unit, 40)}`
  return `${excerpt(column.type, 60)}, ${column.nullable ? 'nullable' : 'required'}${unit}`
}

/**
 * Compare two validated manifests.
 *
 * Both sides are complete indexes by construction: `validateManifest` returned
 * `ok` only because nothing was dropped from either. That is what lets an
 * addition or a removal be asserted positively here.
 */
function compareManifests(before, after, files, policy) {
  const findings = []
  const counts = {
    columnsAdded: 0, columnsRemoved: 0, columnsMatched: 0,
    typeChanges: 0, nullabilityChanges: 0, unitChanges: 0,
  }
  const mode = policy.compatibility

  if (before.document.dataset !== after.document.dataset) {
    findings.push(finding({
      ruleId: 'dataset-mismatch',
      file: files.after,
      pointer: '/dataset',
      message: `the two manifests name different datasets (${JSON.stringify(excerpt(before.document.dataset, 60))} and ${JSON.stringify(excerpt(after.document.dataset, 60))}); they were compared anyway, which is only meaningful if that rename was intended`,
    }))
  }
  if (before.document.sourceFormat !== after.document.sourceFormat) {
    findings.push(finding({
      ruleId: 'source-format-changed-breaking',
      file: files.after,
      pointer: '/sourceFormat',
      message: `the source format changed from ${excerpt(before.document.sourceFormat, 20)} to ${excerpt(after.document.sourceFormat, 20)}; every reader of this dataset has to change, whatever the columns do`,
    }))
  }

  const names = [...new Set([...before.order, ...after.order])].sort(byCodeUnit)
  for (const name of names) {
    const old = before.index.get(name)
    const now = after.index.get(name)

    if (old === undefined) {
      counts.columnsAdded += 1
      // A new reader meeting old data without this column needs a value for it:
      // safe when the column is nullable or carries a default, unknown when the
      // manifest does not say whether it has one.
      const backwardSafe = now.nullable ? true : now.hasDefault === undefined ? null : now.hasDefault
      // An old reader meeting new data just ignores a column it never knew.
      const verdict = verdictFor(mode, backwardSafe, true)
      findings.push(finding({
        ruleId: verdict === 'unknown' ? 'column-added-default-unknown' : `column-added-${verdict}`,
        file: files.after,
        pointer: `/columns/${now.position}`,
        message: verdict === 'unknown'
          ? `column ${JSON.stringify(excerpt(name, 60))} was added as required, and the manifest does not declare whether it has a default, so whether a ${mode}-compatible reader can read older data is unknown`
          : `column ${JSON.stringify(excerpt(name, 60))} was added (${describeColumn(now)}); under ${mode} compatibility this is ${verdict}`,
        evidence: describeColumn(now),
        suggestion: verdict === 'unknown' ? 'declare "hasDefault": true or false on the added column' : undefined,
      }))
      continue
    }

    if (now === undefined) {
      counts.columnsRemoved += 1
      // An old reader meeting new data finds the column gone: safe when the old
      // schema allowed it to be absent or defaulted, unknown when unsaid.
      const forwardSafe = old.nullable ? true : old.hasDefault === undefined ? null : old.hasDefault
      const verdict = verdictFor(mode, true, forwardSafe)
      findings.push(finding({
        ruleId: verdict === 'unknown' ? 'column-removed-default-unknown' : `column-removed-${verdict}`,
        file: files.before,
        pointer: `/columns/${old.position}`,
        message: verdict === 'unknown'
          ? `column ${JSON.stringify(excerpt(name, 60))} was required and is now gone, and the old manifest does not declare whether it had a default, so whether a ${mode}-compatible reader of the old schema can read new data is unknown`
          : `column ${JSON.stringify(excerpt(name, 60))} was removed (was ${describeColumn(old)}); under ${mode} compatibility this is ${verdict}`,
        evidence: describeColumn(old),
        suggestion: verdict === 'unknown' ? 'declare "hasDefault" on the column in the older manifest' : undefined,
      }))
      continue
    }

    counts.columnsMatched += 1
    const pointer = `/columns/${now.position}`

    const typeChange = classifyTypeChange(old.type, now.type)
    if (typeChange !== 'same') {
      counts.typeChanges += 1
      if (typeChange === 'unclassified') {
        findings.push(finding({
          ruleId: 'type-change-unclassified',
          file: files.after,
          pointer,
          message: `column ${JSON.stringify(excerpt(name, 60))} changed type from ${excerpt(normaliseType(old.type), 40)} to ${excerpt(normaliseType(now.type), 40)}, and this tool's declared lattice relates neither to the other, so the change is neither widening nor narrowing as far as it can tell`,
          evidence: `${excerpt(normaliseType(old.type), 60)} -> ${excerpt(normaliseType(now.type), 60)}`,
          suggestion: 'classify this change by hand, or express both types in the documented vocabulary',
        }))
      } else {
        // A wider type holds every old value, so the new schema can read old
        // data; the old schema cannot necessarily read the new.
        const verdict = typeChange === 'widened' ? verdictFor(mode, true, false) : verdictFor(mode, false, true)
        findings.push(finding({
          ruleId: `type-${typeChange}-${verdict}`,
          file: files.after,
          pointer,
          message: `column ${JSON.stringify(excerpt(name, 60))} ${typeChange} from ${excerpt(normaliseType(old.type), 40)} to ${excerpt(normaliseType(now.type), 40)}; under ${mode} compatibility this is ${verdict}`,
          evidence: `${excerpt(normaliseType(old.type), 60)} -> ${excerpt(normaliseType(now.type), 60)}`,
        }))
      }
    }

    if (old.nullable !== now.nullable) {
      counts.nullabilityChanges += 1
      const relaxed = now.nullable
      // required -> nullable: new data may carry nulls the old reader forbids.
      // nullable -> required: old data may carry nulls the new reader forbids.
      const verdict = relaxed ? verdictFor(mode, true, false) : verdictFor(mode, false, true)
      findings.push(finding({
        ruleId: `nullability-${relaxed ? 'relaxed' : 'tightened'}-${verdict}`,
        file: files.after,
        pointer,
        message: `column ${JSON.stringify(excerpt(name, 60))} went from ${relaxed ? 'required to nullable' : 'nullable to required'}; under ${mode} compatibility this is ${verdict}`,
        evidence: `nullable ${String(old.nullable)} -> ${String(now.nullable)}`,
      }))
    }

    if (old.unit !== now.unit) {
      counts.unitChanges += 1
      if (old.unit !== undefined && now.unit !== undefined) {
        findings.push(finding({
          ruleId: 'unit-changed-breaking',
          file: files.after,
          pointer,
          message: `column ${JSON.stringify(excerpt(name, 60))} changed unit from ${excerpt(old.unit, 40)} to ${excerpt(now.unit, 40)}; the numbers mean something else now, which no compatibility mode absorbs`,
          evidence: `${excerpt(old.unit, 60)} -> ${excerpt(now.unit, 60)}`,
        }))
      } else if (now.unit === undefined) {
        findings.push(finding({
          ruleId: 'unit-undeclared',
          file: files.after,
          pointer,
          message: `column ${JSON.stringify(excerpt(name, 60))} declared unit ${excerpt(old.unit, 40)} and now declares none, so the values carry no declared unit; this tool cannot tell whether they changed`,
        }))
      } else {
        findings.push(finding({
          ruleId: 'unit-declared',
          file: files.after,
          pointer,
          message: `column ${JSON.stringify(excerpt(name, 60))} now declares unit ${excerpt(now.unit, 40)}, where the older manifest declared none; this tool cannot tell whether the values changed with it`,
        }))
      }
    }
  }

  // Order is compared over the columns present in BOTH manifests, in the order
  // each manifest lists them. Comparing raw positions instead would report a
  // reordering every time a column is inserted at the front, which is a finding
  // on correct input -- the worst thing a checker can do.
  const shared = new Set(names.filter((name) => before.index.has(name) && after.index.has(name)))
  const beforeShared = before.order.filter((name) => shared.has(name))
  const afterShared = after.order.filter((name) => shared.has(name))
  const orderChanged = beforeShared.some((name, at) => afterShared[at] !== name)
  if (orderChanged && policy.columnOrder !== 'ignore') {
    findings.push(finding({
      ruleId: policy.columnOrder === 'breaking' ? 'column-order-changed-breaking' : 'column-order-changed-noted',
      file: files.after,
      pointer: '/columns',
      message: `the shared columns are listed in a different order; for a positional reader (a headerless CSV, an INSERT without a column list) that changes which value lands where. Policy columnOrder is "${policy.columnOrder}"`,
      evidence: `${excerpt(beforeShared.join(','), 60)} -> ${excerpt(afterShared.join(','), 60)}`,
    }))
  }

  return { findings, counts, orderChanged }
}

/**
 * Compare two schema manifests.
 *
 * Throws `ConfigError` for a bad configuration -- the caller writes nothing to
 * stdout and exits 2. Everything else comes back as a report.
 */
export async function diffSchemas(options = {}) {
  if (!isPlainObject(options)) throw new ConfigError('options must be an object')
  const { root, before, after, policy: givenPolicy = {}, limits: givenLimits = {}, ...unknown } = options
  const unknownKeys = Object.keys(unknown)
  if (unknownKeys.length > 0) throw new ConfigError(`Unknown option "${excerpt(unknownKeys[0], 60)}"`)

  const limits = normaliseLimits(givenLimits)
  // A policy that came from a document has already been through here once;
  // running it through again is idempotent and keeps one validation path.
  const policy = normalisePolicy(givenPolicy)
  if (typeof root !== 'string' || root.length === 0) throw new ConfigError('root is required')
  for (const [name, value] of [['before', before], ['after', after]]) {
    if (typeof value !== 'string' || value.length === 0) throw new ConfigError(`${name} is required`)
  }

  let realRoot
  try {
    realRoot = await realpath(resolve(root))
  } catch (error) {
    throw new ConfigError(`root could not be resolved: ${error.code ?? 'unknown error'}`)
  }

  const files = { before: excerpt(before, LOCATION_LIMIT), after: excerpt(after, LOCATION_LIMIT) }
  const findings = []
  let diffAttempted = false
  let counts = { columnsAdded: 0, columnsRemoved: 0, columnsMatched: 0, typeChanges: 0, nullabilityChanges: 0, unitChanges: 0 }
  let orderChanged = false
  let columnsBefore = 0
  let columnsAfter = 0
  let checked = 0
  let columnsWithoutDeclaredUnit = 0

  const loaded = { before: await loadManifest(realRoot, before, limits), after: await loadManifest(realRoot, after, limits) }
  const validated = {}
  for (const side of ['before', 'after']) {
    if (!loaded[side].ok) {
      findings.push({ ...loaded[side].problem, location: { ...loaded[side].problem.location, file: files[side] } })
      continue
    }
    const result = validateManifest(loaded[side].document, files[side], limits)
    findings.push(...result.problems)
    if (result.ok) validated[side] = result
  }

  if (validated.before !== undefined && validated.after !== undefined) {
    diffAttempted = true
    columnsBefore = validated.before.order.length
    columnsAfter = validated.after.order.length
    const comparison = compareManifests(validated.before, validated.after, files, policy)
    findings.push(...comparison.findings)
    counts = comparison.counts
    orderChanged = comparison.orderChanged
    // checked = one unit per column name in the union, plus the three
    // document-level comparisons (dataset identity, source format, column
    // order). Documented in the README so the number means something.
    checked = new Set([...validated.before.order, ...validated.after.order]).size + 3
    columnsWithoutDeclaredUnit = [...validated.after.index.values()].filter((column) => column.unit === undefined).length
  }

  findings.sort((left, right) => byCodeUnit(left.location.file, right.location.file)
    || byCodeUnit(left.location.pointer, right.location.pointer)
    || byCodeUnit(left.ruleId, right.ruleId))

  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length

  let emitted = findings
  if (findings.length > limits.maxFindings) {
    emitted = findings.slice(0, limits.maxFindings - 1)
    emitted.push(finding({
      ruleId: 'too-many-findings',
      file: files.after,
      message: `${findings.length} findings were produced, over the ${limits.maxFindings} finding limit, so this report lists only the first ${limits.maxFindings - 1}`,
      suggestion: 'raise --max-findings deliberately',
    }))
  }

  // Status is derived from the rule ids, over every finding detected and every
  // finding emitted -- there is no `incomplete = true` line to delete.
  const incomplete = [...findings, ...emitted].some((item) => INCOMPLETE_RULES.has(item.ruleId))
  const failed = errors > 0

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    status: incomplete ? 'incomplete' : failed ? 'fail' : 'pass',
    summary: {
      checked,
      errors,
      warnings,
      // False means no comparison happened at all. A consumer that reads an
      // empty findings list as "no changes" needs this flag to know better.
      diffAttempted,
      policy: { compatibility: policy.compatibility, columnOrder: policy.columnOrder },
      columnsBefore,
      columnsAfter,
      columnsMatched: counts.columnsMatched,
      columnsAdded: counts.columnsAdded,
      columnsRemoved: counts.columnsRemoved,
      typeChanges: counts.typeChanges,
      nullabilityChanges: counts.nullabilityChanges,
      unitChanges: counts.unitChanges,
      // Reported whatever the policy says, so that "columnOrder": "ignore"
      // suppresses the finding and never the fact.
      columnOrderChanged: orderChanged,
      // Nothing here has checked a unit against anything. This count is how
      // many columns in the newer manifest carry no declared unit at all, so
      // "no unit finding" is not read as "the units were verified".
      columnsWithoutDeclaredUnit,
    },
    findings: emitted,
  }
}

export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 pass, 1 fail, 2 incomplete. An incomplete run is never a pass. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_MARK = Object.freeze({ error: 'ERROR  ', warning: 'WARN   ', info: 'INFO   ' })

/**
 * The human summary. It goes to stderr; stdout carries the JSON and nothing
 * else.
 *
 * Note what this never says: when `diffAttempted` is false there is no line
 * claiming anything about changes, because no comparison happened.
 */
export function formatReport(report) {
  const summary = report.summary
  const lines = [`${TOOL_ID}: ${report.status}`]
  lines.push(`  ${summary.checked} comparison(s), ${summary.errors} error(s), ${summary.warnings} warning(s)`)
  lines.push(`  policy: ${summary.policy.compatibility} compatibility, column order ${summary.policy.columnOrder}`)
  if (summary.diffAttempted) {
    lines.push(
      `  ${summary.columnsBefore} column(s) before, ${summary.columnsAfter} after: `
      + `${summary.columnsMatched} matched, ${summary.columnsAdded} added, ${summary.columnsRemoved} removed`,
    )
    lines.push(
      `  ${summary.typeChanges} type change(s), ${summary.nullabilityChanges} nullability change(s), `
      + `${summary.unitChanges} unit change(s); shared column order ${summary.columnOrderChanged ? 'changed' : 'unchanged'}`,
    )
    lines.push(`  ${summary.columnsWithoutDeclaredUnit} column(s) in the newer manifest declare no unit, so nothing is known about their units`)
  } else {
    lines.push('  no comparison was made: at least one manifest could not be read completely')
  }
  for (const item of report.findings) {
    const where = item.location.pointer === '' ? item.location.file : `${item.location.file}${item.location.pointer}`
    lines.push(`  ${SEVERITY_MARK[item.severity]}${item.ruleId}  ${where}`)
    lines.push(`         ${item.message}`)
  }
  return `${lines.join('\n')}\n`
}
