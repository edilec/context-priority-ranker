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
  past `expireAfterDays`.
- Policy validation with unknown-key refusal, and a refusal to switch off the
  review interval of a high-authority band. `limits` is not a policy key: the
  parser bounds are command-line options, and a policy file that names one is
  refused rather than accepted and ignored.
- Thirty-four rules with a frozen severity table, documented in
  `docs/ranking-rules.md`.
- Limits for document size, item count, evidence links, text length, findings
  and run time, each enforced and each reported by name.
- `--today` for an injected evaluation date, recorded in `summary.today`.
- Credential redaction at the sanitising boundary: every untrusted string that
  reaches the report or the human summary -- item ids, source names, JSON
  Pointer segments, messages and evidence -- has anything matching a published
  credential shape replaced with a placeholder naming the shape, before any
  length bound is applied.
- Examples: `examples/assembled` (exit 0) and `examples/stale` (exit 1).
