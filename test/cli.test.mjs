/**
 * The CLI surface, including the part of the contract that is easy to get
 * wrong: exit 2 has two shapes. A configuration error never had a subject, so
 * stdout is EMPTY; an input that could not be read did have one, so stdout
 * carries an `incomplete` report.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ConfigError, diffSchemas } from '../src/index.mjs'

import { column, makeRoot, manifestDoc, runCli, twoManifests, writeDocument } from './support.mjs'

test('--help explains the tool and exits 0', async () => {
  const run = await runCli(['--help'])

  assert.equal(run.code, 0)
  assert.match(run.stdout, /dataset-schema-diff/)
  assert.match(run.stdout, /Exit codes:/)
  assert.match(run.stdout, /This tool writes nothing/)
  assert.match(run.stdout, /reads no clock/)
})

test('--version prints a version and exits 0', async () => {
  const run = await runCli(['--version'])
  assert.equal(run.code, 0)
  assert.match(run.stdout.trim(), /^\d+\.\d+\.\d+$/)
})

test('an unknown option is refused with an empty stdout', async () => {
  const run = await runCli(['--root', '.', '--before', 'a.json', '--after', 'b.json', '--max-column', '5'])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /Unknown option "--max-column"/)
})

test('a repeated value flag is refused rather than silently last-wins', async () => {
  const run = await runCli(['--root', '.', '--root', '/tmp', '--before', 'a.json', '--after', 'b.json'])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--root was given more than once/)
})

test('a missing required flag is refused', async () => {
  for (const argv of [[], ['--root', '.'], ['--root', '.', '--before', 'a.json']]) {
    const run = await runCli(argv)
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /is required/)
  }
})

test('a flag with no value is refused', async () => {
  const run = await runCli(['--root'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--root requires a value/)
})

test('a policy file and the policy flags cannot both be given', async () => {
  const run = await runCli(['--root', '.', '--before', 'a.json', '--after', 'b.json', '--policy', 'p.json', '--compatibility', 'full'])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /mutually exclusive/)
})

test('an unknown compatibility mode is a configuration error with an empty stdout', async () => {
  const { root, before, after } = await twoManifests(manifestDoc(), manifestDoc())
  const run = await runCli(['--root', root, '--before', before, '--after', after, '--compatibility', 'sideways'])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /policy.compatibility must be one of backward, forward, full/)
})

test('an unknown key in a policy document is refused, not ignored', async () => {
  const { root, before, after } = await twoManifests(manifestDoc(), manifestDoc())
  await writeDocument(root, 'policy.json', { policyVersion: '1', compatibilty: 'forward' })
  const run = await runCli(['--root', root, '--before', before, '--after', after, '--policy', `${root}/policy.json`])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /Unknown policy key "compatibilty"/)
})

test('a policy document without policyVersion is refused', async () => {
  const { root, before, after } = await twoManifests(manifestDoc(), manifestDoc())
  await writeDocument(root, 'policy.json', { compatibility: 'forward' })
  const run = await runCli(['--root', root, '--before', before, '--after', after, '--policy', `${root}/policy.json`])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /policyVersion/)
})

test('an unreadable policy document is a configuration error, not an incomplete report', async () => {
  const { root, before, after } = await twoManifests(manifestDoc(), manifestDoc())
  const run = await runCli(['--root', root, '--before', before, '--after', after, '--policy', `${root}/absent.json`])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '', 'a run with no policy never had a subject to report on')
  assert.match(run.stderr, /--policy could not be read/)
})

test('a root that does not exist is a configuration error', async () => {
  const run = await runCli(['--root', '/no/such/root/here', '--before', 'a.json', '--after', 'b.json'])

  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /root could not be resolved/)
})

test('an input that could not be read still produces a report on stdout', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'after.json', manifestDoc())
  const run = await runCli(['--root', root, '--before', 'missing.json', '--after', 'after.json'])

  assert.equal(run.code, 2)
  assert.notEqual(run.stdout, '')
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'input-unreadable')
})

test('stdout carries the report and nothing else, so it pipes into a parser', async () => {
  const documents = await twoManifests(
    manifestDoc({ columns: [column({ type: 'int64' })] }),
    manifestDoc({ columns: [column({ type: 'int32' })] }),
  )
  const run = await runCli(['--root', documents.root, '--before', documents.before, '--after', documents.after])

  assert.equal(run.code, 1)
  const report = JSON.parse(run.stdout)
  assert.equal(report.tool, 'dataset-schema-diff')
  assert.equal(report.schemaVersion, '1')
  // The human summary is on stderr, where it cannot corrupt the JSON.
  assert.match(run.stderr, /dataset-schema-diff: fail/)
})

test('--json silences the human summary without changing stdout', async () => {
  const documents = await twoManifests(
    manifestDoc({ columns: [column({ type: 'int64' })] }),
    manifestDoc({ columns: [column({ type: 'int32' })] }),
  )
  const args = ['--root', documents.root, '--before', documents.before, '--after', documents.after]
  const loud = await runCli(args)
  const quiet = await runCli([...args, '--json'])

  assert.equal(quiet.stderr, '')
  assert.equal(quiet.stdout, loud.stdout)
  assert.equal(quiet.code, loud.code)
})

test('a location never carries an absolute host path', async () => {
  const root = await makeRoot()
  await writeDocument(root, 'after.json', manifestDoc())
  const run = await runCli(['--root', root, '--before', 'missing.json', '--after', 'after.json'])
  const report = JSON.parse(run.stdout)

  for (const item of report.findings) {
    assert.ok(!item.location.file.startsWith('/'), `${item.location.file} is an absolute path`)
    assert.ok(!item.location.file.includes(root))
  }
})

test('exactly one unknown option in a library call is refused', async () => {
  // `unknownKeys.length > 0`: loosening it by one lets a single unknown key
  // through, and every test that had unknown keys had more than one. One typo
  // is the realistic case, and ignoring it is how a documented limit becomes a
  // limit nobody enforces.
  const { root, before, after } = await twoManifests(manifestDoc(), manifestDoc())

  await assert.rejects(
    diffSchemas({ root, before, after, maxColumns: 5 }),
    (error) => error instanceof ConfigError && /Unknown option "maxColumns"/.test(error.message),
  )
})
