# Rule catalogue

Every rule this tool can emit, with the severity it always carries and whether
it makes the run `incomplete`. Severity is read from one frozen table in
`src/index.mjs`; it is never written at a call site, and an id that is not in
that table throws rather than defaulting.

`incomplete` means the rule reports evidence the tool did not obtain or could
not evaluate. Any one of them makes the report `incomplete` and the process exit
`2` — never `0`, and never folded into a clean result.

## How a verdict reaches a rule id

A verdict depends on the declared policy, and a severity may not. So the verdict
is part of the id: under `forward` compatibility a narrowing genuinely is
compatible, and it gets `type-narrowed-compatible` rather than a severity
quietly demoted where the finding is built.

The two directional questions behind every verdict:

- **backward** — can the NEW schema read data written under the old one?
- **forward** — can the OLD schema read data written under the new one?
- **full** — both.

| Change | backward-safe | forward-safe |
| --- | --- | --- |
| column added, nullable or with a declared default | yes | yes |
| column added, required, no default | no | yes |
| column added, required, default not declared | **unknown** | yes |
| column removed, was nullable or had a declared default | yes | yes |
| column removed, was required with no default | yes | no |
| column removed, was required, default not declared | yes | **unknown** |
| type widened | yes | no |
| type narrowed | no | yes |
| nullability relaxed (required to nullable) | yes | no |
| nullability tightened (nullable to required) | no | yes |
| unit changed | no | no |
| source format changed | no | no |

An **unknown** answer in the direction the declared mode actually needs produces
a `*-default-unknown` rule and an `incomplete` run. In the direction it does not
need, nothing is reported: asking for a fact that cannot change the verdict
would be a finding raised on correct input.

## Rules

| Rule | Severity | Makes the run incomplete | What it means |
| --- | --- | --- | --- |
| `column-added-breaking` | error | no | A column was added and the declared policy cannot absorb it. |
| `column-added-compatible` | info | no | A column was added and the declared policy absorbs it. |
| `column-added-default-unknown` | error | yes | A required column was added and the manifest does not say whether it has a default, so the verdict the policy needs cannot be reached. |
| `column-invalid` | error | yes | A column entry is not an object, or a required field is missing, mistyped, over `--max-field-length`, or renders empty once control characters are removed. |
| `column-name-duplicate` | error | yes | One manifest declares a column name twice, so a comparison by name is ambiguous. No diff is attempted. |
| `column-nullability-undeclared` | error | yes | A column does not declare `nullable`. The tool does not assume a value for it. |
| `column-order-changed-breaking` | error | no | The shared columns are listed in a different order and the policy calls that breaking. |
| `column-order-changed-noted` | warning | no | The shared columns are listed in a different order and the policy calls that worth noting. |
| `column-removed-breaking` | error | no | A column was removed and the declared policy cannot absorb it. |
| `column-removed-compatible` | info | no | A column was removed and the declared policy absorbs it. |
| `column-removed-default-unknown` | error | yes | A required column was removed and the older manifest does not say whether it had a default. |
| `column-unknown-field` | error | yes | A column declares a field this tool does not understand, so it cannot claim to have read the column completely. |
| `dataset-mismatch` | warning | no | The two manifests name different datasets. They are compared anyway, which is only meaningful if the rename was intended. |
| `input-not-json` | error | yes | A manifest is not valid JSON. The failure is described without reproducing the document. |
| `input-not-utf8` | error | yes | A manifest is not valid UTF-8. Decoding is strict; nothing is inferred from decoded content. |
| `input-too-large` | error | yes | A manifest is larger than `--max-document-bytes`. It was not read. |
| `input-unreadable` | error | yes | A manifest could not be opened. |
| `manifest-invalid` | error | yes | A manifest is not a JSON object, or `dataset`, `version` or `columns` is missing or unusable. |
| `manifest-unknown-field` | error | yes | A manifest declares a top-level field this tool does not understand. |
| `manifest-version-unsupported` | error | yes | `manifestVersion` is not a version this tool understands. |
| `no-columns-declared` | error | yes | A manifest declares no columns. A clean result over nothing would mean nothing. |
| `nullability-relaxed-breaking` | error | no | Required became nullable and the declared policy cannot absorb it. |
| `nullability-relaxed-compatible` | info | no | Required became nullable and the declared policy absorbs it. |
| `nullability-tightened-breaking` | error | no | Nullable became required and the declared policy cannot absorb it. |
| `nullability-tightened-compatible` | info | no | Nullable became required and the declared policy absorbs it. |
| `path-escapes-root` | error | yes | An input path resolves outside `--root`, lexically or through a symbolic link. It was not read. |
| `source-format-changed-breaking` | error | no | The declared source format changed. Every reader has to change, whatever the columns do. |
| `source-format-unsupported` | error | yes | A manifest declares a source format this tool has not been taught. Nothing about it is guessed. |
| `too-many-columns` | error | yes | A manifest declares more columns than `--max-columns`. None were examined. |
| `too-many-findings` | error | yes | More findings were produced than `--max-findings`. The list is truncated and says so. |
| `type-change-unclassified` | error | yes | A type changed and the declared lattice relates neither type to the other, in either direction. |
| `type-narrowed-breaking` | error | no | A type narrowed and the declared policy cannot absorb it. |
| `type-narrowed-compatible` | info | no | A type narrowed and the declared policy absorbs it. |
| `type-widened-breaking` | error | no | A type widened and the declared policy cannot absorb it. |
| `type-widened-compatible` | info | no | A type widened and the declared policy absorbs it. |
| `unit-changed-breaking` | error | no | A column's declared unit changed. The numbers mean something else now, which no compatibility mode absorbs. |
| `unit-declared` | info | no | A column now declares a unit where the older manifest declared none. Whether the values changed with it is not knowable from the manifests. |
| `unit-undeclared` | warning | no | A column declared a unit and now declares none, so the values carry no declared unit. |

## Ordering

Findings sort by `(location.file, location.pointer, ruleId)`, compared by UTF-16
code unit. That means `Z.json` precedes `a.json` and `/columns/10` precedes
`/columns/2`. Both are deliberate: collation depends on ICU data that differs
between Node builds, and a report that two machines order differently is a
report nobody can diff.
