/**
 * The package, and the documents that describe it.
 *
 * A documentation overclaim counts as a defect here, so the rule table is
 * checked against the code in BOTH directions -- a rule the code can emit and
 * the docs never mention, and a rule the docs promise and the code cannot
 * produce, are both failures.
 */

import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, RULE_CATALOG, TOOL_ID } from '../src/index.mjs'
import { PROJECT } from './support.mjs'

const readProjectFile = (name) => readFile(join(PROJECT, name), 'utf8')
const readPackage = async () => JSON.parse(await readProjectFile('package.json'))

/** The rule rows a markdown table declares, as `id -> { severity, incomplete }`. */
function ruleRows(markdown) {
  const rows = new Map()
  for (const [, ruleId, severity, incomplete] of markdown.matchAll(/^\| `([a-z0-9-]+)` \| (error|warning|info) \| (yes|no) \|/gm)) {
    rows.set(ruleId, { severity, incomplete: incomplete === 'yes' })
  }
  return rows
}

test('TOOL_ID equals the directory name and the package name', async () => {
  const manifest = await readPackage()
  assert.equal(TOOL_ID, basename(PROJECT))
  assert.equal(TOOL_ID, manifest.name)
  assert.equal(manifest.bin[TOOL_ID], `./bin/${TOOL_ID}.mjs`)
})

test('the package declares the scripts the release check needs', async () => {
  const manifest = await readPackage()
  for (const script of ['lint', 'test', 'example', 'example:failing', 'pack:check', 'check']) {
    assert.ok(Object.hasOwn(manifest.scripts, script), `missing script: ${script}`)
  }
  assert.match(manifest.scripts.check, /npm run lint/)
  assert.match(manifest.scripts.check, /npm test/)
  assert.match(manifest.scripts.check, /npm run example/)
  assert.match(manifest.scripts.check, /npm run example:failing/)
  assert.match(manifest.scripts.check, /npm run pack:check/)
})

test('the package declares no dependencies of any kind', async () => {
  const manifest = await readPackage()
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
})

for (const document of ['README.md', 'docs/rules.md']) {
  test(`${document} documents exactly the rules the code can emit`, async () => {
    const rows = ruleRows(await readProjectFile(document))
    const catalogue = new Map(RULE_CATALOG.map((entry) => [entry.ruleId, entry]))

    for (const entry of RULE_CATALOG) {
      const row = rows.get(entry.ruleId)
      assert.ok(row !== undefined, `${document} does not document ${entry.ruleId}`)
      assert.equal(row.severity, entry.severity, `${document} disagrees about the severity of ${entry.ruleId}`)
      assert.equal(row.incomplete, entry.incomplete, `${document} disagrees about whether ${entry.ruleId} makes the run incomplete`)
    }
    for (const ruleId of rows.keys()) {
      assert.ok(catalogue.has(ruleId), `${document} documents ${ruleId}, which the code cannot emit`)
    }
    assert.equal(rows.size, RULE_CATALOG.length)
  })
}

test('the CHANGELOG states the size of the catalogue the code can emit', async () => {
  // The count is a claim about the code, so it is checked against the code. It
  // was written once and then went stale the first time a rule was added.
  const changelog = await readProjectFile('CHANGELOG.md')
  const stated = /A (\d+)-rule catalogue/.exec(changelog)
  assert.ok(stated !== null, 'the CHANGELOG does not state a catalogue size')
  assert.equal(Number(stated[1]), RULE_CATALOG.length)
})

test('the README states the limits the code actually enforces', async () => {
  const readme = await readProjectFile('README.md')
  const documented = Object.fromEntries(
    [...readme.matchAll(/^\| `--([a-z-]+)` \| (\d+) \|/gm)].map(([, flag, value]) => [flag, Number(value)]),
  )
  assert.deepEqual(documented, {
    'max-document-bytes': DEFAULT_LIMITS.maxDocumentBytes,
    'max-columns': DEFAULT_LIMITS.maxColumns,
    'max-field-length': DEFAULT_LIMITS.maxFieldLength,
    'max-findings': DEFAULT_LIMITS.maxFindings,
  })
})

test('the README claims no confinement and no destination check the code does not perform', async () => {
  const readme = await readProjectFile('README.md')
  // This tool writes nothing, so it must not describe a write guard it has no
  // use for -- documenting a check that is not performed reads as coverage.
  assert.match(readme, /It writes nothing/)
  assert.match(readme, /no destination check applies/)
  assert.ok(!/assertWritableDestination/.test(readme))
  assert.match(readme, /--root/)
})

test('the README carries the sections a reader needs', async () => {
  const readme = await readProjectFile('README.md')
  for (const heading of ['## Why this exists', '## Quick start', '## Rules', '## Exit codes', '## Limits', '## Non-goals']) {
    assert.ok(readme.includes(heading), `missing section: ${heading}`)
  }
})

/**
 * Shapes that must not appear in anything this package publishes.
 *
 * None is global, so `exec` starts at the beginning every time. A failure names
 * the file, the line and the shape -- never the text that matched, which for a
 * credential would be the credential.
 */
const FORBIDDEN_SHAPES = Object.freeze({
  'an access key': /AKIA[0-9A-Z]{16}/,
  'a private key block': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  'an email address': /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  'an IPv4 address': /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  'a path in somebody home directory': /\/(?:Users|home)\/[A-Za-z0-9._-]+/,
  'an assigned secret': /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"']+["']/i,
})

/**
 * Every file `npm publish` would ship: each `files` entry expanded, plus
 * `package.json`, which npm always includes whether it is listed or not.
 */
async function publishedFiles() {
  const manifest = await readPackage()
  const found = ['package.json']
  for (const entry of manifest.files) {
    const full = join(PROJECT, entry)
    if ((await stat(full)).isDirectory()) {
      for (const child of await readdir(full, { recursive: true, withFileTypes: true })) {
        if (child.isFile()) found.push(relative(PROJECT, join(child.parentPath ?? child.path, child.name)))
      }
    } else {
      found.push(entry)
    }
  }
  return found.sort()
}

test('the published-tree walk reaches every file the package manifest ships', async () => {
  // The companion to the scan below, and the reason it exists: the scan used to
  // read four documentation files under a name that claimed the tree, and the
  // one published file that would have tripped its own pattern was outside the
  // loop. An absence assertion over a list needs the list pinned, or an empty
  // walk passes it.
  //
  // The list this walk produces was compared against `npm pack --dry-run` at
  // this commit -- both name the same fifteen files -- and the count below is
  // the tripwire that makes the next addition re-check that rather than assume
  // it.
  const files = await publishedFiles()
  for (const required of [
    'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE',
    'bin/dataset-schema-diff.mjs',
    'src/index.mjs', 'src/text.mjs', 'src/types.mjs',
    'docs/README.md', 'docs/rules.md',
    // Two directories deep: a walk that stopped at the top level would pass
    // every assertion above this one.
    'examples/compatible/policy.json', 'examples/breaking/orders.2026-07.json',
  ]) {
    assert.ok(files.includes(required), `the published-tree walk missed ${required}`)
  }
  assert.equal(files.length, 15)
})

test('no file npm would publish carries a credential, an address or a host path', async () => {
  // The catalogue rule: nothing that looks like a real record, anywhere in what
  // ships -- source included, not only the documents.
  for (const name of await publishedFiles()) {
    const text = await readProjectFile(name)
    for (const [shape, pattern] of Object.entries(FORBIDDEN_SHAPES)) {
      const hit = pattern.exec(text)
      const where = hit === null ? '' : `:${text.slice(0, hit.index).split('\n').length}`
      assert.equal(hit, null, `${name}${where} carries something shaped like ${shape}`)
    }
  }
})
