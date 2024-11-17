# Ranking rules

Every finding this tool emits carries one of these rule ids, and its severity
comes from the single frozen table in `src/index.mjs`. This document is the
catalog that table is checked against by `test/rule-catalog.test.mjs`, in both
directions: a rule missing from either side fails the suite.

The check between this table and the source is a consistency check, not the
guarantee. Severity is pinned behaviourally in `test/severity-outcomes.test.mjs`,
which drives a real document through the real CLI for every rule below and
asserts the emitted severity word, the report status and the process exit code.

| Rule id | Severity | What it means |
| --- | --- | --- |
| `authority-unknown` | error | The item's `source` is not mapped in the policy, so its band is unknown. The run is incomplete; no band is assumed. |
| `document-invalid` | error | The document is not an object with an `items` array, or an item member has the wrong type. |
| `document-unknown-field` | error | A top-level field this build does not know. Refused rather than ignored, so a typo cannot disable something. |
| `evidence-invalid` | error | `evidence` is not an array of item id strings. |
| `evidence-link-self` | warning | An item cites itself. The link is not counted as support. |
| `evidence-link-unresolved` | warning | An evidence link names no item in this set. It is not counted as support. |
| `evidence-link-unscored` | error | An evidence link names an item that IS in this set and could not be scored. The support is unknown, not absent, so the run is incomplete. |
| `expired-high-authority-context` | error | A governing or trusted item is older than its band's `expireAfterDays`. It still outranks every lower band, which is why this is an error. |
| `freshness-unknown` | error | The item declares no `updated` date. The run is incomplete; an undated document is not a fresh document. |
| `high-authority-evidence-untrusted` | warning | A governing or trusted item rests on an untrusted item. The support is counted; the chain is reported. |
| `input-not-json` | error | The context set did not parse. The failure is described without reproducing the document. |
| `input-not-utf8` | error | The context set is not valid UTF-8. Decoding is strict; decoded text never gets a vote. |
| `input-too-large` | error | The context set is past `maxDocumentBytes`. It was not parsed. |
| `input-unreadable` | error | The context set could not be opened. |
| `item-declares-authority` | error | The item carries `tier`, `band`, `bandRank`, `rank`, `priority`, `score` or `authority`. Authority comes from the policy, never from the item. |
| `item-id-duplicate` | error | Two items share an id, so evidence links to it are ambiguous. |
| `item-id-invalid` | error | The id is missing, too long, or carries a control, separator or bidi character. |
| `item-invalid` | error | The item is not an object, or `title`/`text` is not a string. |
| `item-text-too-long` | error | The item's text is past `maxTextChars`. It was not scanned, so nothing is claimed about its content. |
| `item-unknown-field` | error | A field this build does not know. Refused rather than ignored. |
| `no-context-items` | error | The document declares no items. A green report over nothing is not a pass. |
| `no-governing-context` | warning | Nothing maps to the governing band, so the ranking has no instruction floor. |
| `path-escapes-root` | error | The context set resolves outside `--root`, through a symbolic link or otherwise. It was not read. |
| `relevance-missing` | error | The item declares no `relevance`. The run is incomplete; an absent relevance is not zero. |
| `relevance-out-of-range` | error | `relevance` is not a finite number between 0 and 1. |
| `schema-version-unsupported` | error | The document declares a `schemaVersion` this build does not understand. It was not interpreted. |
| `source-missing` | error | The item declares no `source`, so the policy has nothing to map. |
| `stale-high-authority-context` | warning | A governing or trusted item is past its band's `reviewAfterDays`. Flagged for review. |
| `time-budget-exceeded` | error | `maxRuntimeMs` expired mid-run. The remaining items were not examined and no ranking was produced. |
| `too-many-evidence-links` | error | One item declares more links than `maxEvidenceLinks`. None were resolved. |
| `too-many-findings` | error | The report reached `maxFindings`. It is partial, and therefore incomplete. |
| `too-many-items` | error | The document declares more items than `maxItems`. None were ranked. |
| `untrusted-authority-claim` | warning | An untrusted item's own text asserts authority over the instructions. It changes nothing about the ranking. |
| `updated-in-future` | warning | The item is dated after the evaluation date. It is scored as fresh and the date is reported. |
| `updated-invalid` | error | `updated` is not a `YYYY-MM-DD` calendar date, so freshness could not be determined. |

## Which rules make a run incomplete

`authority-unknown`, `evidence-link-unscored`, `freshness-unknown`,
`input-not-json`, `input-not-utf8`, `input-too-large`, `input-unreadable`,
`item-text-too-long`, `path-escapes-root`, `relevance-missing`,
`schema-version-unsupported`, `time-budget-exceeded`,
`too-many-evidence-links`, `too-many-findings`, `too-many-items` and
`updated-invalid` all mean the tool wanted a fact and did not get it. Each marks the run `incomplete`, exits 2 and suppresses the ranking.

The rest are facts the tool *did* obtain about a document that is wrong. They
fail the run (exit 1) and, where every item still scored, the ranking is
emitted alongside them.
