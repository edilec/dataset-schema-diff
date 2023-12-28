/**
 * The type lattice, including the edges that are deliberately NOT there.
 *
 * An absent edge is a design decision, not an oversight, so each one is pinned
 * with the reason: adding `int32 -> float32` or `int64 -> float64` would turn a
 * lossy conversion into a reported widening, which is the "unknown reported as
 * a pass" failure wearing a type name.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DECLARED_WIDENING_EDGES, KNOWN_TYPE_BASES, classifyTypeChange, normaliseType, parseType } from '../src/index.mjs'

test('integer widening follows the declared chain, in both directions', () => {
  assert.equal(classifyTypeChange('int8', 'int16'), 'widened')
  assert.equal(classifyTypeChange('int16', 'int32'), 'widened')
  assert.equal(classifyTypeChange('int32', 'int64'), 'widened')
  assert.equal(classifyTypeChange('int8', 'int64'), 'widened', 'the closure relates the ends of the chain')
  assert.equal(classifyTypeChange('int64', 'int8'), 'narrowed')
})

test('an integer to float edge exists only where every value is representable', () => {
  // binary32 carries a 24-bit significand; binary64 carries 53.
  assert.equal(classifyTypeChange('int16', 'float32'), 'widened')
  assert.equal(classifyTypeChange('int32', 'float64'), 'widened')
  assert.equal(classifyTypeChange('float32', 'float64'), 'widened')

  // 16777217 is not representable in binary32, so this is not a widening --
  // and it is not a narrowing either, because the ranges are not nested.
  assert.equal(classifyTypeChange('int32', 'float32'), 'unclassified')
  // 2^53 + 1 is not representable in binary64.
  assert.equal(classifyTypeChange('int64', 'float64'), 'unclassified')
})

test('a conversion that would invent a value is not classified', () => {
  // A date has no time of day; a timestamp has no zone. Both conversions are
  // well defined only once somebody chooses what to add.
  assert.equal(classifyTypeChange('date', 'timestamp'), 'unclassified')
  assert.equal(classifyTypeChange('timestamp', 'timestamptz'), 'unclassified')
  assert.equal(classifyTypeChange('bool', 'int8'), 'unclassified')
})

test('varchar widens by length and reaches text', () => {
  assert.equal(classifyTypeChange('varchar(10)', 'varchar(11)'), 'widened')
  assert.equal(classifyTypeChange('varchar(11)', 'varchar(10)'), 'narrowed')
  assert.equal(classifyTypeChange('varchar(10)', 'text'), 'widened')
  assert.equal(classifyTypeChange('text', 'varchar(10)'), 'narrowed')
})

test('decimal widens by precision at a fixed scale, and a scale change is not classified', () => {
  assert.equal(classifyTypeChange('decimal(10,2)', 'decimal(11,2)'), 'widened')
  assert.equal(classifyTypeChange('decimal(11,2)', 'decimal(10,2)'), 'narrowed')
  // Raising the scale at a fixed precision shrinks the integer range while
  // growing the fractional one. Neither word describes that.
  assert.equal(classifyTypeChange('decimal(10,2)', 'decimal(10,3)'), 'unclassified')
  assert.equal(classifyTypeChange('decimal(10,2)', 'decimal(12,3)'), 'unclassified')
})

test('normalisation folds spelling and nothing else', () => {
  assert.equal(normaliseType('  DECIMAL(12, 2) '), 'decimal(12,2)')
  assert.equal(classifyTypeChange('INT32', 'int32'), 'same')
  // `int` is not an alias for int32: this tool has no dialect to ask.
  assert.equal(classifyTypeChange('int', 'int32'), 'unclassified')
  assert.equal(classifyTypeChange('number', 'float64'), 'unclassified')
})

test('a type outside the vocabulary is unknown, not invalid', () => {
  assert.equal(parseType('geography(point)').known, false)
  assert.equal(parseType('int32(5)').known, false, 'the arity is wrong, so it is not int32')
  assert.equal(parseType('varchar(0)').known, false, 'a length of zero is not a length')
  assert.equal(parseType('varchar(10)').known, true)
  assert.equal(classifyTypeChange('geography(point)', 'geography(point)'), 'same')
  assert.equal(classifyTypeChange('geography(point)', 'geography(polygon)'), 'unclassified')
})

test('the declared vocabulary and edge list are what the lattice is built from', () => {
  assert.deepEqual([...KNOWN_TYPE_BASES], [
    'bool', 'bytes', 'date', 'decimal', 'float32', 'float64',
    'int16', 'int32', 'int64', 'int8', 'json', 'text', 'time', 'timestamp', 'timestamptz', 'uuid', 'varchar',
  ])
  for (const [from, to] of DECLARED_WIDENING_EDGES) {
    assert.ok(KNOWN_TYPE_BASES.includes(from), `${from} is not in the vocabulary`)
    assert.ok(KNOWN_TYPE_BASES.includes(to), `${to} is not in the vocabulary`)
  }
  // The edge list is the source of truth, so an edge nobody declared is absent.
  const declared = new Set(DECLARED_WIDENING_EDGES.map(([from, to]) => `${from}->${to}`))
  assert.ok(!declared.has('int32->float32'))
  assert.ok(!declared.has('int64->float64'))
  assert.ok(!declared.has('date->timestamp'))
})

test('classification is symmetric: reversing the pair reverses the verdict', () => {
  for (const [from, to] of [['int8', 'int64'], ['varchar(2)', 'text'], ['decimal(4,1)', 'decimal(9,1)'], ['float32', 'float64']]) {
    assert.equal(classifyTypeChange(from, to), 'widened')
    assert.equal(classifyTypeChange(to, from), 'narrowed')
  }
})

test('a known base with the wrong number of parameters is unclassified, never measured', () => {
  // `varchar(5,5)` names a base this tool knows with an arity it does not, so
  // the type is UNKNOWN, not a varchar of length 5. Dropping the known check
  // reads its first parameter anyway and answers "narrowed" -- a measurement
  // taken from a declaration the tool could not parse.
  assert.equal(classifyTypeChange('varchar(10)', 'varchar(5,5)'), 'unclassified')
  assert.equal(classifyTypeChange('varchar(5,5)', 'varchar(10)'), 'unclassified')
  assert.equal(parseType('varchar(5,5)').known, false)
  assert.equal(parseType('varchar(5,5)').base, 'varchar')

  assert.equal(classifyTypeChange('decimal(10,2)', 'decimal(4)'), 'unclassified')
  assert.equal(classifyTypeChange('decimal(4)', 'decimal(10,2)'), 'unclassified')
  assert.equal(parseType('decimal(4)').known, false)

  // The other side: the right arity is still measured.
  assert.equal(classifyTypeChange('varchar(10)', 'varchar(20)'), 'widened')
  assert.equal(classifyTypeChange('decimal(10,2)', 'decimal(18,2)'), 'widened')
})
