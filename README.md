# dataset-schema-diff

Compare two versioned schema manifests — columns, types, nullability and units —
and classify every difference under a declared compatibility policy. A
difference it cannot classify is reported as unclassified and the run is
`incomplete`, because "no breaking changes found" is a sentence people act on.

- **Repository:** [edilec/dataset-schema-diff](https://github.com/edilec/dataset-schema-diff)
- **Area:** Data & Analytics
- **License:** MIT

## Why this exists

A schema change is reviewed twice: once when somebody writes it, and once at
three in the morning when a job that has run for two years stops. Between those
two moments the only durable record is a pair of manifests in version control,
and the question asked of them is always the same — *is this safe for the
readers we have?*

Answering it by eye goes wrong in a specific way. `int32` to `int64` looks like
`int64` to `int32` in a diff. `decimal(10,2)` to `decimal(10,3)` looks like a
widening and is not. A column that changed from `NOT NULL` to nullable reads as
harmless and breaks every consumer that dereferences it. And a unit that quietly
moved from `kWh` to `MWh` does not change the schema at all — it changes every
number in the dataset by a factor of a thousand.

This tool answers that question from the manifests alone, and says so when it
cannot.

## What it reads, and what it never does

It reads two JSON documents. It connects to no database, resolves no host, runs
no query, opens no network socket and reads no clock. A manifest is an export
somebody wrote; every sentence in the report is a sentence about those two
documents.

It writes nothing. There is no `--out`, it creates no directory and it modifies
no file, so no destination check applies to it.

For the wider producer-and-consumer review, see Edilec's [data contract
compatibility guide](https://edilec.com/blog/datana-11008/test-data-contract-compatibility-before-merge/).
This CLI compares declared local manifests; it does not test actual consumer
code or enforce a registry's format-specific compatibility rules.

## Quick start

From a checkout of this repository with Node.js 22 or newer:

```sh
# A compatible change: widened types and an added nullable column.
node bin/dataset-schema-diff.mjs \
  --root examples/compatible \
  --before orders.2026-01.json \
  --after  orders.2026-04.json \
  --policy examples/compatible/policy.json
# exit 0

# A breaking change: a narrowed key, a tightened column, a changed unit and a
# reordering, judged against a policy that calls reordering breaking.
node bin/dataset-schema-diff.mjs \
  --root examples/breaking \
  --before orders.2026-04.json \
  --after  orders.2026-07.json \
  --column-order breaking
# exit 1
```

To run the CLI from its public GitHub source without installing a registry
package, use `npm exec --yes --package=git+https://github.com/edilec/dataset-schema-diff.git -- dataset-schema-diff --help`.

`stdout` carries the JSON report and nothing else, so it pipes straight into a
parser. `stderr` carries the human summary; `--json` silences it.

## The manifest format

```json
{
  "manifestVersion": "1",
  "dataset": "orders",
  "version": "2026-04",
  "sourceFormat": "csv",
  "columns": [
    { "name": "order_id", "type": "int64", "nullable": false, "hasDefault": false },
    { "name": "net_amount", "type": "decimal(12,2)", "nullable": false, "unit": "EUR" },
    { "name": "note", "type": "varchar(120)", "nullable": true, "description": "free text" }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `manifestVersion` | yes | `"1"`. Any other value is unsupported, not assumed. |
| `dataset` | yes | The dataset both manifests describe. |
| `version` | yes | Which version of it this manifest is. |
| `sourceFormat` | yes | `csv`, `json` or `sql`. |
| `columns[].name` | yes | Compared case-sensitively. |
| `columns[].type` | yes | From the vocabulary below, or anything else — see *unknown types*. |
| `columns[].nullable` | yes | `true` or `false`. Never assumed. |
| `columns[].hasDefault` | no | Whether a reader has a value to use when the column is absent. Compared on a matched column too, because it decides whether removing that column later is compatible. |
| `columns[].unit` | no | A declared unit for the values. |
| `columns[].description` | no | Ignored by the comparison. |

An unknown field, at either level, is refused: a manifest that says something
this tool does not understand is a manifest it cannot claim to have read.

## The type lattice

| Family | Types |
| --- | --- |
| Integers | `int8`, `int16`, `int32`, `int64` |
| Floats | `float32`, `float64` |
| Exact decimal | `decimal(precision,scale)` |
| Text | `varchar(length)`, `text` |
| Other | `bool`, `date`, `time`, `timestamp`, `timestamptz`, `bytes`, `uuid`, `json` |

A change is **widening** only when every value of the old type is representable
in the new one:

- `int8 → int16 → int32 → int64`
- `int8 → float32`, `int16 → float32`, `int32 → float64`, `float32 → float64`
- `varchar(n) → varchar(m)` for `m > n`, and `varchar(n) → text`
- `decimal(p,s) → decimal(q,s)` for `q > p` — the same scale, precision only

**Narrowing** is any of those reversed. Everything else is **unclassified**, and
the absences are deliberate:

| Not classified | Why |
| --- | --- |
| `int32 → float32` | binary32 has a 24-bit significand: 16777217 does not survive. |
| `int64 → float64` | binary64 has a 53-bit significand: the same problem at 2^53. |
| `decimal(10,2) → decimal(10,3)` | A scale change grows the fractional range and shrinks the integer range. Neither word fits. |
| `date → timestamp` | The conversion invents a time of day; `timestamp → timestamptz` invents a zone. |
| `bool → int8` | The mapping is conventional, not definitional. |
| `int → int32` | `int` is not in the vocabulary. This tool has no dialect to ask, so it does not alias. |

### Unknown types

A type outside the vocabulary — `geography(point)`, say — is not an error. If it
did not change, nothing is reported. If it changed to another unknown type, the
change is `type-change-unclassified` and the run is `incomplete`: the tool
cannot tell you whether `geography(point)` and `geography(polygon)` relate, so
it does not choose.

## Compatibility modes

| Mode | Question | Default |
| --- | --- | --- |
| `backward` | Can the new schema read data written under the old one? | yes |
| `forward` | Can the old schema read data written under the new one? | |
| `full` | Both. | |

The full verdict matrix is in [docs/rules.md](docs/rules.md).

## Column order

`--column-order` takes `ignore`, `warn` (default) or `breaking`. Order is
compared over the columns present in *both* manifests, in the order each lists
them — so inserting a column at the front is not a reordering.

`ignore` suppresses the **finding**, never the **fact**:
`summary.columnOrderChanged` is reported either way, so a policy switch cannot
hide a positional change from somebody reading the summary.

## Policy document

```json
{
  "policyVersion": "1",
  "compatibility": "backward",
  "columnOrder": "warn"
}
```

`--policy FILE` and the `--compatibility` / `--column-order` flags are mutually
exclusive: a policy comes from one place. An unknown key is refused rather than
ignored, because a one-character typo must not turn a real failure into a green
run. A policy is configuration, so a policy that cannot be read is a
configuration error — empty `stdout`, exit 2 — and not a report.

## Two values that read the same

Every comparison of a declared text value in this tool — the dataset name, and
each column's name, type and unit — asks how the two values will be **rendered
in this report**, not whether the raw strings are equal. (`sourceFormat` is the
one text field compared raw, and it needs nothing else: it is held to a closed
vocabulary, so two accepted values differ or they do not.) The difference
matters for one case, and a plain trailing space is enough to reach it:

```
before.json  { "name": "energy", "unit": "kWh" }
after.json   { "name": "energy", "unit": "kWh " }
```

Comparing the raw strings and then rendering them produces

```
ERROR  unit-changed-breaking  after.json/columns/0
       column "energy" changed unit from kWh to kWh; the numbers mean
       something else now
       evidence: "kWh -> kWh"
```

— an error-severity finding whose own evidence contradicts it, and one nobody
can act on. What this tool reports instead names the difference by code point
and says what it could not decide:

```
ERROR  stripped-character-difference  after.json/columns/0/unit
       the column unit reads "kWh" in both manifests and the two are not the
       same text: they differ only in characters this report strips (at
       character 4: before the end of the value, after U+0020), so this tool
       cannot say what changed
```

The run is `incomplete` (exit 2) rather than a fail, because whether a trailing
space in an export is significant is a fact about the producer: a reader that
matches column names byte for byte and a reader that trims will disagree about
whether anything changed at all. Calling it breaking would assert one of those
answers and staying silent would assert the other.

The same rule applies to the **column name**, which is why two names that render
identically are matched as one column and reported once, rather than as an
addition and a removal of what reads as the same column. Where two columns in
**one** manifest render identically, the manifest is ambiguous and
`column-name-duplicate` says so.

## Rules

| Rule | Severity | Makes the run incomplete | What it means |
| --- | --- | --- | --- |
| `column-added-breaking` | error | no | A column was added and the declared policy cannot absorb it. |
| `column-added-compatible` | info | no | A column was added and the declared policy absorbs it. |
| `column-added-default-unknown` | error | yes | A required column was added and the manifest does not say whether it has a default. |
| `column-default-changed` | warning | no | `hasDefault` changed on a column present in both manifests. |
| `column-invalid` | error | yes | A column entry is unusable: not an object, a missing or mistyped field, over `--max-field-length`, or a value that renders empty. |
| `column-name-duplicate` | error | yes | A column name is declared twice, so a comparison by name is ambiguous. |
| `column-nullability-undeclared` | error | yes | A column does not declare `nullable`. |
| `column-order-changed-breaking` | error | no | The shared columns moved and the policy calls that breaking. |
| `column-order-changed-noted` | warning | no | The shared columns moved and the policy calls that worth noting. |
| `column-removed-breaking` | error | no | A column was removed and the declared policy cannot absorb it. |
| `column-removed-compatible` | info | no | A column was removed and the declared policy absorbs it. |
| `column-removed-default-unknown` | error | yes | A required column was removed and the older manifest does not say whether it had a default. |
| `column-unknown-field` | error | yes | A column declares a field this tool does not understand. |
| `dataset-mismatch` | warning | no | The two manifests name different datasets. |
| `input-not-json` | error | yes | A manifest is not valid JSON. |
| `input-not-utf8` | error | yes | A manifest is not valid UTF-8. |
| `input-too-large` | error | yes | A manifest is over `--max-document-bytes`, so it was not read. |
| `input-unreadable` | error | yes | A manifest could not be opened. |
| `manifest-invalid` | error | yes | A manifest, or one of its required fields, is not usable. |
| `manifest-unknown-field` | error | yes | A manifest declares a top-level field this tool does not understand. |
| `manifest-version-unsupported` | error | yes | `manifestVersion` is not a version this tool understands. |
| `no-columns-declared` | error | yes | A manifest declares no columns. |
| `nullability-relaxed-breaking` | error | no | Required became nullable and the policy cannot absorb it. |
| `nullability-relaxed-compatible` | info | no | Required became nullable and the policy absorbs it. |
| `nullability-tightened-breaking` | error | no | Nullable became required and the policy cannot absorb it. |
| `nullability-tightened-compatible` | info | no | Nullable became required and the policy absorbs it. |
| `path-escapes-root` | error | yes | An input path resolves outside `--root`. |
| `source-format-changed-breaking` | error | no | The declared source format changed. |
| `source-format-unsupported` | error | yes | A manifest declares a source format this tool has not been taught. |
| `stripped-character-difference` | error | yes | Two values are not the same text and this report renders them identically, so what changed cannot be shown or classified. |
| `too-many-columns` | error | yes | A manifest is over `--max-columns`, so none of its columns were examined. |
| `too-many-findings` | error | yes | The report is over `--max-findings` and was truncated. |
| `type-change-unclassified` | error | yes | A type changed and the lattice relates neither type to the other. |
| `type-narrowed-breaking` | error | no | A type narrowed and the policy cannot absorb it. |
| `type-narrowed-compatible` | info | no | A type narrowed and the policy absorbs it. |
| `type-widened-breaking` | error | no | A type widened and the policy cannot absorb it. |
| `type-widened-compatible` | info | no | A type widened and the policy absorbs it. |
| `unit-changed-breaking` | error | no | A declared unit changed, which no compatibility mode absorbs. |
| `unit-declared` | info | no | A column now declares a unit where the older manifest declared none. |
| `unit-undeclared` | warning | no | A column declared a unit and now declares none. |

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | Both manifests were read and every difference is compatible under the policy. | the report |
| `1` | Both manifests were read and at least one difference breaks the policy. | the report |
| `2` | Invalid configuration — the run never had a subject. | **empty** |
| `2` | Evidence that could not be obtained: an unreadable manifest, a limit reached, a change the lattice cannot classify. | an `incomplete` report |

A consumer that pipes `stdout` must handle an empty `stdout` on exit 2. That is
documented rather than papered over: emitting a fake report for a run that never
started would be worse.

## Limits

Each is enforced **before** the work it bounds, so a legal-sized input cannot
exhaust memory. Exceeding one is an `incomplete` result with a finding naming
the limit — never a silent truncation, never a pass. Every one is tested from
both sides: that it fires at N+1, and that it stays silent at exactly N.

| Flag | Default | Enforced |
| --- | ---: | --- |
| `--max-document-bytes` | 1048576 | Against the file size before a byte is read, and against the buffer after. |
| `--max-columns` | 2000 | Against the declared array length before any column is examined. |
| `--max-field-length` | 200 | Against every name, type, unit and description. |
| `--max-findings` | 1000 | The list is truncated and `too-many-findings` says so. |

`summary.errors` and `summary.warnings` count every finding detected, including
any the `--max-findings` truncation removed from the list.

## Report shape

The envelope follows the Edilec tool report contract. `summary` carries these
extra fields:

| Field | Meaning |
| --- | --- |
| `diffAttempted` | **False means no comparison happened at all.** An empty `findings` list means "no differences" only when this is true. |
| `policy` | The effective compatibility and column-order modes, so the report says what it was judged against. |
| `columnsBefore` / `columnsAfter` / `columnsMatched` / `columnsAdded` / `columnsRemoved` | Counts over the two column sets. |
| `typeChanges` / `nullabilityChanges` / `unitChanges` | Counts of changes found, including ones that could not be classified. |
| `defaultChanges` | How many matched columns changed `hasDefault`. |
| `columnOrderChanged` | Reported whatever `--column-order` says. |
| `columnsWithoutDeclaredUnit` | How many columns in the newer manifest declare no unit at all, so silence about units is not read as verification. |

`checked` is one comparison unit per column name in the union of the two
manifests, plus three document-level comparisons (dataset identity, source
format, column order).

## Non-goals

This tool does not, and will not without a deliberate decision:

- **Parse SQL.** It reads manifests. A `CREATE TABLE` statement is not an input,
  and no dialect is consulted, which is why `int` is not aliased to `int32`.
- **Read your data.** Nothing here has seen a row. A `unit-declared` finding
  means the manifest changed, not that the values did.
- **Infer renames.** A removal and an addition are reported as a removal and an
  addition. Nothing in two manifests says that `note` became `comment`, and
  guessing would invent a fact about the data.
- **Guess a default.** A required column with no `hasDefault` is unknown in the
  direction that needs the answer, and unknown makes the run `incomplete`.
- **Judge semantics.** Two columns with the same name and type may mean entirely
  different things. This tool compares declarations.
- **Promise a migration is safe.** It compares two documents against a policy.
  Whether your consumers actually behave the way the compatibility model says
  they do is not something a static check can establish.
- **Write anything.** No `--out`, no directory creation, no auto-fix.

## Verification

```sh
npm run check   # lint, tests, both examples, and a packaging dry run
```

## License

MIT. See [LICENSE](./LICENSE).
