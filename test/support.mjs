import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PROJECT = dirname(HERE)
export const BIN = join(PROJECT, 'bin', 'dataset-schema-diff.mjs')

const roots = []

/** A temporary directory, removed when the process exits. */
export async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dataset-schema-diff-'))
  roots.push(root)
  return root
}

process.on('exit', () => {
  for (const root of roots) {
    try {
      // Synchronous on purpose: an exit handler cannot await.
      rmSync(root, { recursive: true, force: true })
    } catch {
      // A leftover temp directory is not worth failing a test run over.
    }
  }
})

export async function removeRoot(root) {
  await rm(root, { recursive: true, force: true })
}

/** Write one document into a root. `body` may be an object or raw text/bytes. */
export async function writeDocument(root, name, body) {
  const path = join(root, name)
  const content = typeof body === 'string' || body instanceof Uint8Array ? body : `${JSON.stringify(body, null, 2)}\n`
  await writeFile(path, content)
  return path
}

/** A minimal valid manifest, overridable field by field. */
export function manifestDoc(overrides = {}) {
  return {
    manifestVersion: '1',
    dataset: 'orders',
    version: '2026-01',
    sourceFormat: 'csv',
    columns: [{ name: 'order_id', type: 'int32', nullable: false, hasDefault: false }],
    ...overrides,
  }
}

/** A column with every required field declared. */
export function column(overrides = {}) {
  return { name: 'value', type: 'int32', nullable: false, hasDefault: false, ...overrides }
}

/** Run the CLI and resolve with its exit code and streams, whatever the code. */
export function runCli(args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: options.cwd ?? PROJECT, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
      },
    )
  })
}

/** Build a root holding a before and an after manifest, and return their names. */
export async function twoManifests(before, after) {
  const root = await makeRoot()
  await writeDocument(root, 'before.json', before)
  await writeDocument(root, 'after.json', after)
  return { root, before: 'before.json', after: 'after.json' }
}
