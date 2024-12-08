# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and rule ids are part
of the public surface: renaming one is a breaking change and is recorded here.

## [0.1.0] - 2026-09-14

### Added

- Two-stage ranking: authority band from the policy file first, then a weighted
  score inside the band. Relevance cannot move an item across a band.
- Staleness review for high-authority context: `stale-high-authority-context`
  (warning) past `reviewAfterDays`, `expired-high-authority-context` (error)
  past `expireAfterDays`. `summary.stale` counts every ranked item past its
  review interval and `summary.expired` the subset also past expiry, so the
  summary and the `stale` flag on a ranking entry always agree.
- Policy validation with unknown-key refusal, and a refusal to switch off the
  review interval of a high-authority band. `limits` is not a policy key: the
  parser bounds are command-line options, and a policy file that names one is
  refused rather than accepted and ignored.
- `task-invalid`: `task` is optional, which means the document may omit it, not
  that anything may be written there. A declared `task` that is not a usable
  line is refused rather than accepted and ignored.
- Thirty-six rules with a frozen severity table, documented in
  `docs/ranking-rules.md`.
- `evidence-link-unscored`: a cited item that is present in the set but could
  not be scored is reported as unknown support, never as an absent item.
- Limits for document size, item count, evidence links, text length, findings
  and run time, each enforced and each reported by name.
- `--today` for an injected evaluation date, recorded in `summary.today`.
- `untrusted-authority-claim` is emitted for every untrusted item, scored or
  not, so a stray field on an item cannot silence the warning about itself.
- A value the document supplies that cannot be rendered as a string -- an object
  with a non-callable `toString` -- is described by its shape (`[object]`,
  `[array]`) and the run reports the input as invalid with status `incomplete`,
  rather than aborting with an empty stdout.
- Credential redaction at the sanitising boundary: every untrusted string that
  reaches the report or the human summary -- item ids, source names, JSON
  Pointer segments, messages and evidence -- has anything matching a published
  credential shape replaced with a placeholder naming the shape, before any
  length bound is applied.
- Examples: `examples/assembled` (exit 0) and `examples/stale` (exit 1).
