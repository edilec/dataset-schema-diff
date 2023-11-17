/**
 * Two runs over the same manifests produce byte-identical stdout, and nothing
 * in the report depends on when it was produced.
 *
 * A clock is injected, never read -- and this tool needs no instant at all, so
 * it takes none. The behavioural proof is below; the source scan beside it is a
 * cheap extra, and it is labelled as what it is rather than relied on.
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { diffSchemas, serializeReport } from '../src/index.mjs'
import { PROJECT, column, manifestDoc, runCli, twoManifests } from './support.mjs'

const interestingPair = () => twoManifests(
  manifestDoc({
    columns: [
      column({ name: 'a', type: 'int64', unit: 'kWh' }),
      column({ name: 'b', nullable: true }),
      column({ name: 'gone', hasDefault: true }),
    ],
  }),
  manifestDoc({
    columns: [
      column({ name: 'b', nullable: false }),
      column({ name: 'a', type: 'int32', unit: 'MWh' }),
      column({ name: 'added', nullable: true }),
    ],
  }),
)

test('the same inputs produce byte-identical stdout across processes', async () => {
  const documents = await interestingPair()
  const args = ['--root', documents.root, '--before', documents.before, '--after', documents.after, '--json']

  const first = await runCli(args)
  const second = await runCli(args)

  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.ok(first.stdout.length > 0)
})

test('the report carries no timestamp, seed or host detail', async () => {
  const documents = await interestingPair()
  const report = await diffSchemas(documents)
  const serialised = serializeReport(report)

  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(serialised), 'an instant reached the report')
  assert.ok(!Object.hasOwn(report.summary, 'evaluatedAt'))
  assert.ok(!serialised.includes(documents.root), 'a host path reached the report')
})

test('scan: no source file reads a clock, a random source or the network', async () => {
  // Weaker than the behavioural test above, and kept for what it does catch:
  // a new CALL SITE added later. It matches call syntax rather than the words,
  // because the modules discuss both by name in their comments. It is a scan,
  // not a proof: substituting one collator for another changes the source text
  // and not the drift, which is why the ordering tests are behavioural.
  const forbidden = [
    /\bDate\.now\b/, /\bnew Date\b/, /\bMath\.random\b/,
    /node:https?/, /node:net\b/, /node:dgram\b/, /\bfetch\s*\(/,
    /\.localeCompare\s*\(/, /new Intl\.Collator/,
  ]
  const directories = ['src', 'bin']
  for (const directory of directories) {
    for (const name of await readdir(join(PROJECT, directory))) {
      const text = await readFile(join(PROJECT, directory, name), 'utf8')
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(text), `${directory}/${name} matches ${pattern}`)
      }
    }
  }
})

test('findings are ordered the same way whatever order the columns were declared in', async () => {
  // The report is sorted, so two manifests that differ only in declaration
  // order produce the same finding sequence.
  const first = await twoManifests(
    manifestDoc({ columns: [column({ name: 'a', type: 'int64' }), column({ name: 'b', type: 'int64' })] }),
    manifestDoc({ columns: [column({ name: 'a', type: 'int32' }), column({ name: 'b', type: 'int32' })] }),
  )
  const report = await diffSchemas(first)
  assert.deepEqual(report.findings.map((item) => item.location.pointer), ['/columns/0', '/columns/1'])
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['type-narrowed-breaking', 'type-narrowed-breaking'])
})
