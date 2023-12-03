/**
 * The examples in the README are run here, with the exit codes the README
 * claims. An example that stopped working is a documentation defect.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { PROJECT, runCli } from './support.mjs'

test('the compatible example passes, and every finding in it is advisory', async () => {
  const run = await runCli([
    '--root', 'examples/compatible',
    '--before', 'orders.2026-01.json',
    '--after', 'orders.2026-04.json',
    '--policy', 'examples/compatible/policy.json',
  ])

  assert.equal(run.code, 0)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.diffAttempted, true)
  assert.deepEqual([...new Set(report.findings.map((item) => item.severity))], ['info'])
  assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), [
    'column-added-compatible',
    'type-widened-compatible',
    'type-widened-compatible',
    'type-widened-compatible',
  ])
})

test('the failing example exits 1 and names every breaking change in it', async () => {
  const run = await runCli([
    '--root', 'examples/breaking',
    '--before', 'orders.2026-04.json',
    '--after', 'orders.2026-07.json',
    '--column-order', 'breaking',
  ])

  assert.equal(run.code, 1)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), [
    // `note` gained a declared default in this example. It changes no verdict
    // here and it decides whether a later removal of `note` is compatible, so
    // it is reported rather than dropped.
    'column-default-changed',
    'column-order-changed-breaking',
    'nullability-tightened-breaking',
    'type-narrowed-breaking',
    'unit-changed-breaking',
  ])
  assert.equal(report.summary.columnOrderChanged, true)
})

test('the same documents get other verdicts under another policy, and the unit change still breaks', async () => {
  // Same documents, different declared policy: the verdicts are the policy's,
  // and the report says which policy produced them.
  const run = await runCli([
    '--root', 'examples/breaking',
    '--before', 'orders.2026-04.json',
    '--after', 'orders.2026-07.json',
    '--compatibility', 'forward',
    '--column-order', 'ignore',
  ])

  assert.equal(run.code, 1, 'the changed unit breaks under every mode')
  const report = JSON.parse(run.stdout)
  assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), [
    'column-default-changed',
    'nullability-tightened-compatible',
    'type-narrowed-compatible',
    'unit-changed-breaking',
  ])
  assert.deepEqual(report.summary.policy, { compatibility: 'forward', columnOrder: 'ignore' })
})

test('the example commands in the README are the ones the package runs', async () => {
  const readme = await readFile(join(PROJECT, 'README.md'), 'utf8')
  const manifest = JSON.parse(await readFile(join(PROJECT, 'package.json'), 'utf8'))

  for (const fragment of ['--root examples/compatible', '--root examples/breaking']) {
    assert.ok(readme.includes(fragment.replace('--root ', '--root \\\n  ')) || readme.includes(fragment), `README does not show ${fragment}`)
  }
  assert.match(manifest.scripts.example, /examples\/compatible/)
  assert.match(manifest.scripts['example:failing'], /examples\/breaking/)
})
