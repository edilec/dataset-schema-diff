/**
 * The declared type lattice, and the only place a type change is classified.
 *
 * The vocabulary below is this tool's own, not a dialect's. A manifest is an
 * export somebody wrote; nothing here has connected to a warehouse, so there is
 * no dialect to consult and no catalogue to ask. That has one consequence worth
 * stating plainly: `int` is NOT an alias for `int32` here, and `number` is not
 * an alias for anything. Aliasing across dialects would be a guess about a
 * system this tool has never seen, and a wrong guess about a type is exactly
 * how a narrowing change gets reported as compatible.
 *
 * A type pair this lattice does not relate is `unclassified`. It is not
 * "probably fine" and it is not "probably breaking": it is a comparison this
 * tool could not make, and the caller is told so.
 */

/** Bases that take parameters, and how many integers each takes. */
const PARAMETERISED = Object.freeze({ varchar: 1, decimal: 2 })

/** Bases that take no parameters. */
const SCALAR_BASES = Object.freeze([
  'int8', 'int16', 'int32', 'int64',
  'float32', 'float64',
  'bool', 'text', 'date', 'time', 'timestamp', 'timestamptz', 'bytes', 'uuid', 'json',
])

/**
 * Declared widening edges. Each one is value-preserving: every value of the
 * source type is representable in the target type with no loss.
 *
 * What is deliberately absent matters as much as what is here:
 *
 * - `int32 -> float32` is NOT an edge. binary32 carries a 24-bit significand,
 *   so 16777217 is not representable; the conversion is lossy and calling it
 *   widening would be false. `int8`/`int16` do fit and are edges.
 * - `int64 -> float64` is NOT an edge, for the same reason at 2^53.
 * - `date -> timestamp` is NOT an edge: a date has no time of day, so the
 *   conversion invents midnight, and `timestamp -> timestamptz` invents a zone.
 *   Inventing a value is not preserving one.
 * - `bool -> int8` is NOT an edge: the mapping is conventional, not definitional.
 *
 * Every pair reachable here is reachable by transitive closure too, computed
 * once below from this list alone.
 */
const WIDENING_EDGES = Object.freeze([
  ['int8', 'int16'],
  ['int16', 'int32'],
  ['int32', 'int64'],
  ['int8', 'float32'],
  ['int16', 'float32'],
  ['int32', 'float64'],
  ['float32', 'float64'],
  ['varchar', 'text'],
])

/** The full vocabulary, exported so the README and a test can be checked against it. */
export const KNOWN_TYPE_BASES = Object.freeze(
  [...SCALAR_BASES, ...Object.keys(PARAMETERISED)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
)

/** The declared edges, exported for the same reason. */
export const DECLARED_WIDENING_EDGES = WIDENING_EDGES

/** Transitive closure of WIDENING_EDGES, as `base -> Set(bases it widens to)`. */
const WIDENS_TO = (() => {
  const direct = new Map()
  for (const base of KNOWN_TYPE_BASES) direct.set(base, new Set())
  for (const [from, to] of WIDENING_EDGES) direct.get(from).add(to)
  // Reachability by repeated relaxation. The graph has fewer than twenty nodes
  // and no cycles, so this settles in a couple of passes; the loop is written
  // to settle rather than to trust that.
  let changed = true
  while (changed) {
    changed = false
    for (const base of KNOWN_TYPE_BASES) {
      const reachable = direct.get(base)
      for (const step of [...reachable]) {
        for (const next of direct.get(step)) {
          if (!reachable.has(next)) {
            reachable.add(next)
            changed = true
          }
        }
      }
    }
  }
  return direct
})()

/**
 * Normalise a declared type for comparison: lower case, outer whitespace and
 * whitespace around parameters removed. `DECIMAL(12, 2)` and `decimal(12,2)`
 * are the same declaration written two ways; nothing else is folded.
 */
export function normaliseType(raw) {
  return String(raw).trim().toLowerCase().replace(/\s*([(),])\s*/g, '$1')
}

const TYPE_SHAPE = /^([a-z][a-z0-9_]{0,30})(?:\((\d{1,9}(?:,\d{1,9})?)\))?$/

/**
 * Parse a normalised type into `{ base, params, known }`.
 *
 * `known` means "in this tool's vocabulary, with the right number of
 * parameters". `int32(5)` is not `int32`: the arity is wrong, so the type is
 * unknown rather than invalid. An unknown type is not an error -- a manifest
 * may legitimately describe `geography(point)` -- it only limits what can be
 * said when it changes.
 */
export function parseType(raw) {
  const normalised = normaliseType(raw)
  const match = TYPE_SHAPE.exec(normalised)
  if (match === null) return { normalised, base: null, params: [], known: false }
  const base = match[1]
  const params = match[2] === undefined ? [] : match[2].split(',').map(Number)
  const arity = Object.hasOwn(PARAMETERISED, base) ? PARAMETERISED[base] : (SCALAR_BASES.includes(base) ? 0 : -1)
  if (arity === -1 || params.length !== arity) return { normalised, base, params, known: false }
  if (params.some((value) => !Number.isInteger(value) || value < 1)) return { normalised, base, params, known: false }
  return { normalised, base, params, known: true }
}

/**
 * Classify a type transition as `same`, `widened`, `narrowed` or
 * `unclassified`.
 *
 * Two types that are written differently but normalise identically are `same`;
 * that is the only folding done. Two UNKNOWN types that differ textually are
 * `unclassified` and never `same`: this tool cannot tell whether
 * `geography(point)` and `geography(polygon)` relate, so it says so rather than
 * choosing.
 */
export function classifyTypeChange(before, after) {
  const from = parseType(before)
  const to = parseType(after)
  if (from.normalised === to.normalised) return 'same'
  if (!from.known || !to.known) return 'unclassified'

  if (from.base === to.base) {
    if (from.base === 'varchar') {
      return to.params[0] > from.params[0] ? 'widened' : 'narrowed'
    }
    if (from.base === 'decimal') {
      // Same scale: precision alone decides. A different scale changes the
      // integer range and the fractional range in opposite directions, so
      // neither "widened" nor "narrowed" describes it.
      if (from.params[1] !== to.params[1]) return 'unclassified'
      return to.params[0] > from.params[0] ? 'widened' : 'narrowed'
    }
    return 'unclassified'
  }

  if (WIDENS_TO.get(from.base)?.has(to.base)) return 'widened'
  if (WIDENS_TO.get(to.base)?.has(from.base)) return 'narrowed'
  return 'unclassified'
}
