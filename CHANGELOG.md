# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A rule id is part of the public interface: renaming one is a breaking change and
is recorded here.

## [0.1.0] - 2026-09-19

### Added

- Compare two versioned schema manifests and classify every difference under a
  declared compatibility policy (`backward`, `forward` or `full`).
- A declared type lattice with value-preserving widening edges only. A pair the
  lattice does not relate is reported as `type-change-unclassified` and the run
  is `incomplete`, rather than being folded into a clean result.
- Nullability transitions classified in both directions, with the verdict
  carried in the rule id so a severity cannot drift away from the policy.
- Column order compared over the shared columns, with `--column-order` taking
  `ignore`, `warn` or `breaking`. `ignore` suppresses the finding and never the
  fact: `summary.columnOrderChanged` is reported either way.
- Declared units compared, with a changed unit breaking under every mode.
- Bounds on document bytes, columns, field length and findings, each enforced
  before the work it bounds.
- Input paths confined to `--root`, by lexical check and by resolved real path,
  so a symbolic link out of the root is refused.
- A 38-rule catalogue with one frozen severity table, documented in
  `docs/rules.md` and in the README.
