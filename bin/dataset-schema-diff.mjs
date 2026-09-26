#!/usr/bin/env node

import process from 'node:process'

import {
  COLUMN_ORDER_MODES, COMPATIBILITY_MODES, DEFAULT_LIMITS, DEFAULT_POLICY, SUPPORTED_SOURCE_FORMATS,
  ConfigError, diffSchemas, excerpt, exitCodeFor, formatReport, readPolicyDocument, serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `dataset-schema-diff

Compare two versioned schema manifests -- columns, types, nullability and units
-- and classify every difference under a declared compatibility policy.

Reads two JSON documents and nothing else. It connects to no database, resolves
no host, runs no query and reads no clock. A manifest is an export somebody
wrote, and every sentence in the report is a sentence about those two documents.

Source formats a manifest may declare: ${SUPPORTED_SOURCE_FORMATS.join(', ')}.
Any other value is refused rather than guessed at, because what "nullable" and
column order mean is a property of the format.

What "classified" means, exactly:
  A type change is widening only when this tool's declared lattice says every
  value of the old type is representable in the new one. int32 -> int64 is
  widening; int32 -> float32 is not classified at all, because binary32 cannot
  hold every int32. A pair the lattice does not relate is reported as
  unclassified and the run is incomplete -- not folded into "no breaking
  changes", which a reader would take for evidence.

Usage:
  dataset-schema-diff --root DIR --before FILE --after FILE
                      [--policy FILE | --compatibility MODE --column-order MODE]
                      [--json] [limits]

Options:
  --root DIR                 Directory holding both manifests (required)
  --before FILE              Older manifest, relative to --root (required)
  --after FILE               Newer manifest, relative to --root (required)
  --policy FILE              Policy document, a path this tool reads from the
                             working directory. Mutually exclusive with the two
                             policy flags below
  --compatibility MODE       ${COMPATIBILITY_MODES.join(' | ')} (default ${DEFAULT_POLICY.compatibility})
  --column-order MODE        ${COLUMN_ORDER_MODES.join(' | ')} (default ${DEFAULT_POLICY.columnOrder})
                             "ignore" suppresses the finding, never the fact:
                             summary.columnOrderChanged is reported either way
  --json                     Suppress the human summary on stderr

Limits (documents that could not be read completely, reported -- never silently
truncated, never a pass):
  --max-columns N            Maximum columns in one manifest (default ${DEFAULT_LIMITS.maxColumns})
  --max-document-bytes N     Maximum size of either manifest (default ${DEFAULT_LIMITS.maxDocumentBytes})
  --max-field-length N       Maximum characters in a name, type or unit
                             (default ${DEFAULT_LIMITS.maxFieldLength})
  --max-findings N           Maximum findings in one report (default ${DEFAULT_LIMITS.maxFindings})
  -h, --help                 Show this help
  -v, --version              Show the version

Every option that carries a value may be given once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused, and
so is an unknown key in a policy document.

This tool writes nothing. It has no --out, creates no directory and modifies no
file, so no destination check applies to it. The two manifests are confined to
--root and a symbolic link out of that root is refused.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

Where the line falls between exit 1 and exit 2:
  A difference between two manifests that were both read completely is a fact
  about them, and a breaking one fails (exit 1). A manifest this tool could not
  read, decode, parse or validate, and a difference its lattice cannot
  classify, are evidence it does not have -- that is incomplete (exit 2), never
  a pass.

Exit codes:
  0  both manifests were read and every difference is compatible under the policy
  1  both manifests were read and at least one difference breaks the policy
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const VALUE_FLAGS = new Map([
  ['--root', 'root'],
  ['--before', 'before'],
  ['--after', 'after'],
  ['--policy', 'policyFile'],
])

const POLICY_FLAGS = new Map([
  ['--compatibility', 'compatibility'],
  ['--column-order', 'columnOrder'],
])

const LIMIT_FLAGS = new Map([
  ['--max-columns', 'maxColumns'],
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-field-length', 'maxFieldLength'],
  ['--max-findings', 'maxFindings'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, before: null, after: null, policyFile: null, json: false, policy: {}, limits: {} }
  const given = new Set()

  /**
   * A flag carrying a value is accepted once. Letting it repeat discards the
   * earlier value with no diagnostic, so `--compatibility full
   * --compatibility forward` would judge against a mode nobody asked for.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once(argument)
      options.json = true
    } else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (POLICY_FLAGS.has(argument)) {
      once(argument)
      options.policy[POLICY_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else {
      // argv is the one untrusted string that reaches a stream without passing
      // through a finding, so it is flattened exactly as a finding would be.
      throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
    }
  }

  if (options.root === null) throw new Error('--root is required')
  if (options.before === null) throw new Error('--before is required')
  if (options.after === null) throw new Error('--after is required')
  if (options.policyFile !== null && Object.keys(options.policy).length > 0) {
    throw new Error('--policy and the --compatibility/--column-order flags are mutually exclusive; a policy comes from one place')
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    const policy = options.policyFile === null ? options.policy : await readPolicyDocument(options.policyFile)
    report = await diffSchemas({
      root: options.root,
      before: options.before,
      after: options.after,
      policy,
      limits: options.limits,
    })
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty rather
    // than carrying a fabricated report.
    const message = error instanceof ConfigError ? error.message : `unexpected failure: ${error.message}`
    process.stderr.write(`${excerpt(message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  if (report.status === 'incomplete') {
    process.stderr.write('incomplete: this run is not a pass. Part of the comparison was never made.\n')
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
