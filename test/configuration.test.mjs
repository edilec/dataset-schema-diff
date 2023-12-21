/**
 * Configuration guards, driven one at a time.
 *
 * A mutation sweep found every guard here silent: removing it left the whole
 * suite green, because a LATER guard refused the same input with a different
 * message, or because nothing drove the shape at all. An input refused for the
 * wrong reason is the shape the contract warns about -- an assertion satisfied
 * by every path that produces nothing -- so each test pins the message and the
 * stream shape, never just the refusal.
 */

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { ConfigError, diffSchemas } from '../src/index.mjs'
import { makeRoot, manifestDoc, runCli, twoManifests, writeDocument } from './support.mjs'

const refuses = (pattern) => (error) => error instanceof ConfigError && pattern.test(error.message)

test('the options themselves must be an object', async () => {
  // Without this guard a string is destructured happily, `root` comes out
  // undefined, and the run is refused two guards later for a reason that is
  // true but not the reason.
  for (const options of ['root=.', null, 7, ['.']]) {
    await assert.rejects(
      diffSchemas(options),
      refuses(/^options must be an object$/),
      `options ${JSON.stringify(options)} was not refused as a non-object`,
    )
  }
})

test('root, before and after must each be a non-empty string, named individually', async () => {
  // Removing any of these three does not make the run succeed -- it makes it
  // fail somewhere else: `resolve(undefined)` throws a TypeError that is not a
  // ConfigError, and an absent manifest name becomes an unreadable-input
  // finding instead of a configuration error.
  const root = await makeRoot()
  for (const value of [undefined, '', 5, null]) {
    const shown = JSON.stringify(value) ?? 'undefined'
    await assert.rejects(
      diffSchemas({ root: value, before: 'a.json', after: 'b.json' }),
      refuses(/^root is required$/), `root ${shown}`,
    )
    await assert.rejects(
      diffSchemas({ root, before: value, after: 'b.json' }),
      refuses(/^before is required$/), `before ${shown}`,
    )
    await assert.rejects(
      diffSchemas({ root, before: 'a.json', after: value }),
      refuses(/^after is required$/), `after ${shown}`,
    )
  }
})

test('limits that are not an object are refused as such, not through a later guard', async () => {
  const { root, before, after } = await twoManifests(manifestDoc(), manifestDoc())

  // A string falls through to Object.entries and is refused as an unknown
  // limit named "0"; null throws a TypeError that is not a ConfigError at all.
  // Both are wrong answers to "what is wrong with this configuration".
  for (const limits of ['maxColumns=5', null, 5, ['maxColumns']]) {
    await assert.rejects(
      diffSchemas({ root, before, after, limits }),
      refuses(/^limits must be an object$/),
      `limits ${JSON.stringify(limits)} was not refused as a non-object`,
    )
  }
})

test('a policy that is not an object is refused as such', async () => {
  const { root, before, after } = await twoManifests(manifestDoc(), manifestDoc())

  for (const policy of ['backward', null, 3, ['backward']]) {
    await assert.rejects(
      diffSchemas({ root, before, after, policy }),
      refuses(/^policy must be an object$/),
      `policy ${JSON.stringify(policy)} was not refused as a non-object`,
    )
  }
})

test('an unknown column-order or compatibility mode is refused, not treated as a default', async () => {
  // Without the guard an unrecognised mode is not "ignore" and not "breaking",
  // so it silently becomes the warn branch: a policy nobody declared.
  const { root, before, after } = await twoManifests(manifestDoc(), manifestDoc())

  await assert.rejects(
    diffSchemas({ root, before, after, policy: { columnOrder: 'noted' } }),
    refuses(/policy\.columnOrder must be one of ignore, warn, breaking/),
  )
  await assert.rejects(
    diffSchemas({ root, before, after, policy: { compatibility: 'sideways' } }),
    refuses(/policy\.compatibility must be one of backward, forward, full/),
  )
})

test('a policy document that is not valid UTF-8 says so, rather than failing to parse', async () => {
  const root = await makeRoot()
  const document = manifestDoc()
  await writeDocument(root, 'before.json', document)
  await writeDocument(root, 'after.json', document)
  // 0x80 is a continuation byte with nothing to continue.
  await writeFile(join(root, 'policy.json'), Uint8Array.from([0x7b, 0x80, 0x7d]))

  const run = await runCli([
    '--root', root, '--before', 'before.json', '--after', 'after.json', '--policy', join(root, 'policy.json'),
  ])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '', 'a policy is configuration, so stdout stays empty')
  assert.match(run.stderr, /--policy is not valid UTF-8/)
  assert.ok(!/not valid JSON/.test(run.stderr), 'the decode failure must not be reported as a parse failure')
})

test('a policy document that does not parse says so, and reproduces none of it', async () => {
  // Without this throw the parse failure falls through to the next guard and
  // the run is refused for not being an object -- true of undefined, and the
  // wrong thing to tell somebody whose policy has a trailing comma.
  const root = await makeRoot()
  const document = manifestDoc()
  await writeDocument(root, 'before.json', document)
  await writeDocument(root, 'after.json', document)
  await writeDocument(root, 'policy.json', '{"policyVersion": "1",}')

  const run = await runCli([
    '--root', root, '--before', 'before.json', '--after', 'after.json', '--policy', join(root, 'policy.json'),
  ])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--policy is not valid JSON:/)
  assert.ok(!/must contain a JSON object/.test(run.stderr))
  // The detail describes the failure without quoting the document back.
  assert.ok(!run.stderr.includes('policyVersion'), 'the document must not be reproduced in the message')
})

test('a policy document that is not a JSON object says so, rather than blaming policyVersion', async () => {
  const root = await makeRoot()
  const document = manifestDoc()
  await writeDocument(root, 'before.json', document)
  await writeDocument(root, 'after.json', document)
  await writeDocument(root, 'policy.json', '[1, 2]')

  const run = await runCli([
    '--root', root, '--before', 'before.json', '--after', 'after.json', '--policy', join(root, 'policy.json'),
  ])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--policy must contain a JSON object/)
})

test('a manifest path that cannot be resolved reports its own error code, not ENOENT', async () => {
  // `error.code === 'ENOENT'` chooses between two branches that produce the
  // same sentence for a missing file. Forcing it true makes every other
  // failure -- a parent that is not a directory, a symlink loop, a permission
  // refusal -- claim the file is simply absent.
  const root = await makeRoot()
  await writeDocument(root, 'after.json', manifestDoc())
  await writeDocument(root, 'wall.json', 'not a directory')

  const report = await diffSchemas({ root, before: 'wall.json/inner.json', after: 'after.json' })

  const found = report.findings.find((item) => item.ruleId === 'input-unreadable')
  assert.equal(found.message, 'the manifest could not be opened (ENOTDIR)')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.diffAttempted, false)
})

test('a finding with no suggestion carries no suggestion key', async () => {
  // `if (suggestion !== undefined)` forced true writes the string "undefined"
  // into the report as advice, on every finding that has none.
  const { root, before, after } = await twoManifests(
    manifestDoc({ columns: [{ name: 'a', type: 'int64', nullable: false }] }),
    manifestDoc({ version: '2026-04', columns: [{ name: 'a', type: 'int32', nullable: false }] }),
  )
  const report = await diffSchemas({ root, before, after })

  const narrowed = report.findings.find((item) => item.ruleId === 'type-narrowed-breaking')
  assert.equal(Object.hasOwn(narrowed, 'suggestion'), false)
  assert.equal(narrowed.evidence, 'int64 -> int32')

  // The companion: a rule that does carry one still carries the real text.
  const added = await twoManifests(
    manifestDoc({ columns: [{ name: 'a', type: 'int32', nullable: false }] }),
    manifestDoc({
      version: '2026-04',
      columns: [{ name: 'a', type: 'int32', nullable: false }, { name: 'b', type: 'int32', nullable: false }],
    }),
  )
  const withSuggestion = await diffSchemas(added)
  const unknown = withSuggestion.findings.find((item) => item.ruleId === 'column-added-default-unknown')
  assert.equal(unknown.suggestion, 'declare "hasDefault": true or false on the added column')
  assert.equal(Object.hasOwn(unknown, 'evidence'), true)
})
