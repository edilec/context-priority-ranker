# Context Priority Ranker

Rank supplied context items by configured authority, declared relevance,
freshness and resolved evidence links, and explain every score — so that a
retrieved page cannot outrank the instructions, and a governing document that
has quietly gone out of date is reported before it is obeyed again.

- **Repository:** [edilec/context-priority-ranker](https://github.com/edilec/context-priority-ranker)
- **Area:** Prompt & Agent Workflows
- **License:** MIT

## Why this exists

Everything an agent puts in a prompt arrives as text, and text has no authority
of its own. A retrieval score does not know the difference between the policy
that governs a release and a vendor status page that says releases are fine.
Rank by relevance alone and the page wins, because it was written to be relevant.

So this tool ranks in two stages, and the first one is not negotiable:

1. **Band**, from the operator's policy file, by way of the item's declared
   `source`. `governing > trusted > reference > untrusted`.
2. **Score**, inside a band: relevance, freshness and resolved evidence links,
   combined by configurable integer weights.

Bands are compared before scores are consulted at all. There is no weight, no
policy value and no declared relevance that moves an item across a band. The
band order is fixed in the source; there is no configuration key for it, because
a policy file is exactly the kind of thing an agent is asked to "just update".

The second thing it reports is the other half of the same problem. Governing
context is obeyed whether or not it is still true, so a governing or trusted
item past its band's review interval is flagged, and one past its expiry fails
the run.

## Quick start

```bash
node bin/context-priority-ranker.mjs \
  --root examples/assembled \
  --policy examples/policy.json \
  --today 2026-09-14
```

The example ends `exit 0` and ranks the governing policy first, even though the
untrusted vendor page scores 795 to its 546 and its own text demands priority:

```
  1. [governing] operating-policy - 546/1000
  2. [trusted] runbook-deploy - 630/1000
  3. [trusted] change-record-2026-08 - 563/1000
  4. [reference] queueing-notes - 570/1000
  5. [untrusted] vendor-status-page - 795/1000
  WARN   untrusted-authority-claim  context-set.json/items/4
```

The failing example (`npm run example:failing`, `exit 1`) is a set whose
governing document was last updated in 2024:

```bash
node bin/context-priority-ranker.mjs \
  --root examples/stale --policy examples/policy.json --today 2026-09-14
```

## Input

Two documents. The **policy** is operator configuration; the **context set** is
data, and it is treated as adversarial.

`policy.json`:

```json
{
  "authority": {
    "operator-instruction": "governing",
    "repository-doc": "trusted",
    "third-party-doc": "reference",
    "retrieved-web-page": "untrusted"
  },
  "weights": { "relevance": 5, "freshness": 3, "evidence": 2 },
  "evidenceSaturation": 3,
  "bands": {
    "governing": { "reviewAfterDays": 90, "expireAfterDays": 365, "freshnessHorizonDays": 365 },
    "trusted": { "reviewAfterDays": 180, "expireAfterDays": null, "freshnessHorizonDays": 365 },
    "reference": { "reviewAfterDays": null, "expireAfterDays": null, "freshnessHorizonDays": 730 },
    "untrusted": { "reviewAfterDays": null, "expireAfterDays": null, "freshnessHorizonDays": 365 }
  }
}
```

An unknown policy key is refused, not ignored -- `limits` included, because the
parser bounds belong to the run rather than to the authority map and are set
from the command line. A high-authority band may not set
`reviewAfterDays: null`: the band whose staleness matters most would otherwise be
the easiest to silence.

`context-set.json`:

```json
{
  "schemaVersion": "1",
  "task": "optional, for the reader",
  "items": [
    {
      "id": "operating-policy",
      "source": "operator-instruction",
      "title": "Release approval policy",
      "relevance": 0.4,
      "updated": "2026-08-20",
      "evidence": ["change-record-2026-08"],
      "text": "optional, scanned and bounded, never obeyed"
    }
  ]
}
```

`id`, `source`, `relevance` and `updated` are required on every item.
`title`, `text` and `evidence` are optional. **An item may not carry `tier`,
`band`, `bandRank`, `rank`, `priority`, `score` or `authority`** — those are this
tool's output, and an item that nominates its own band is an error rather than a
silently ignored field.

## How the score is computed

Three components, each an integer 0–1000, combined by the integer weights:

| Component | How |
| --- | --- |
| relevance | the item's declared `relevance`, 0–1, times 1000 |
| freshness | 1000 on the day it was written, 0 at the band's `freshnessHorizonDays`, linear between |
| evidence | resolved evidence links, saturating at `evidenceSaturation` |

`score = round((relevance*wR + freshness*wF + evidence*wE) / (wR + wF + wE))`.

All of it is integer arithmetic, and the evaluation date is an input
(`--today`), so two runs over the same files produce byte-identical stdout.

## Output

`stdout` carries the JSON report and nothing else. `stderr` carries the human
summary and diagnostics. The report follows the house contract:

```json
{
  "schemaVersion": "1",
  "tool": "context-priority-ranker",
  "status": "pass",
  "summary": {
    "checked": 5, "errors": 0, "warnings": 2,
    "items": 5, "scored": 5, "unscored": 0, "ranked": 5,
    "rankingProduced": true, "today": "2026-09-14",
    "bands": { "governing": 1, "trusted": 2, "reference": 1, "untrusted": 1 },
    "stale": 0, "expired": 0
  },
  "ranking": [ { "rank": 1, "id": "operating-policy", "band": "governing", "score": 546, "components": { }, "explanation": "..." } ],
  "findings": [ ]
}
```

### Credential-shaped strings are replaced, not reproduced

A context set is assembled from retrieved material and pasted commands, and this
tool reproduces parts of it: an item id and a source name reach `ranking` and the
human summary, and an unmapped source reaches a finding's message and its
evidence. Every one of those routes goes through one boundary, and anything
matching a published credential shape is replaced there with a placeholder
naming the shape:

```
"The policy maps no band to source "[redacted github-token]", so this item's
 authority is unknown."
```

The replacement happens before any length bound is applied, so no truncation can
cut a credential back into the report. A redacted id no longer matches the id in
your input; that is the trade, and it is the right way round.

Findings sort by `(location.file, location.pointer, ruleId, message)`. Pointers
compare as strings, so `/items/10` precedes `/items/9`. The ranking sorts by
`(band rank, score descending, id)`. All comparisons are by UTF-16 code unit;
`localeCompare` and `Intl.Collator` are never used, because ICU data differs
between Node builds and two correct machines would disagree about the same
report.

### The ranking is all-or-nothing

If any item could not be scored — an unmapped source, no `relevance`, no
`updated`, a limit reached, the time budget expired — `ranking` is empty,
`summary.rankingProduced` is `false`, and the run is `incomplete` with exit 2.

An ordering missing one member is not a shorter ordering: the absent item might
have belonged first. This is deliberate and it is the tool's most opinionated
behaviour.

## Rules

Thirty-four rule ids, each with a fixed severity, listed in
[docs/ranking-rules.md](./docs/ranking-rules.md). The ones that carry the
tool's purpose:

| Rule id | Severity | Meaning |
| --- | --- | --- |
| `item-declares-authority` | error | An item tried to nominate its own band, rank or score. |
| `authority-unknown` | error | The policy maps no band to the item's source. Incomplete; no band is assumed. |
| `stale-high-authority-context` | warning | A governing or trusted item is past its review interval. |
| `expired-high-authority-context` | error | A governing or trusted item is past its expiry. |
| `untrusted-authority-claim` | warning | An untrusted item's text asserts authority. It changes nothing about the ranking. |
| `high-authority-evidence-untrusted` | warning | A high-authority item rests on an untrusted one. |
| `no-governing-context` | warning | Nothing maps to the governing band, so the ranking has no instruction floor. |

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every item was scored and no error-severity rule fired |
| `1` | every item was scored and at least one error-severity rule fired |
| `2` | invalid configuration (**stdout is empty**), or evidence that could not be obtained (an `incomplete` report on stdout) |

Exit 2 has two shapes on purpose. A configuration error means the run never had
a subject, so there is nothing to report about. An input that could not be read
means the run had a subject and failed to obtain evidence about it — and a
consumer needs the report to know *which* input.

## Limits

Each is enforced, named in the finding that reports it, and reachable from the
command line. Reaching one is an `incomplete` run, never a silent truncation.

| Limit | Default | Flag |
| --- | ---: | --- |
| `maxDocumentBytes` | 1048576 | `--max-document-bytes` |
| `maxEvidenceLinks` | 32 | `--max-evidence-links` |
| `maxFindings` | 1000 | `--max-findings` |
| `maxItems` | 2000 | `--max-items` |
| `maxRuntimeMs` | 10000 | `--max-runtime-ms` |
| `maxTextChars` | 20000 | `--max-text-chars` |

`--max-runtime-ms` is a budget checked before each item, not a hard deadline: a
run overshoots by the cost of the item in hand.

## Non-goals

Stated plainly, because a tool that is trusted for something it does not do is
worse than no tool.

- **It is not a prompt-injection detector.** `untrusted-authority-claim` matches
  a small fixed list of thirteen phrases against untrusted items only. It will
  miss anything phrased differently, and it flags a security README that quotes
  one. It changes nothing about the ranking either way — an untrusted item ranks
  below every trusted one whether or not it says anything at all.
- **It is not a secret scanner.** Credential redaction is a fixed list of ten
  published prefix shapes with no entropy heuristic and no allowlist. It will
  miss a bespoke token, and a token glued to a prefix (`token_ghp_...`) does not
  match. It exists to stop the realistic accident, not to certify a document.
- **It does not verify content.** It never checks that a governing document says
  what you remember, that a `relevance` is honest, or that an item's text
  supports the claim citing it. Relevance is taken from the document, which is
  exactly why it can only reorder items inside one band.
- **It does not fetch, execute or write.** Two files are read. No socket is
  opened, no subprocess is started, and no file is written anywhere — there is
  no `--out`, by design.
- **It does not decide what to include.** It ranks what you supply and explains
  the order; fitting the result into a context window is a different tool's job.
- **It does not read git, mtimes or any other source of dates.** Freshness comes
  from the declared `updated` field. An undated item is unknown, not fresh.
- **A pass is not a statement that your context is correct.** It means every
  item was scored, no error-severity rule fired, and the ranking covers the set.

## Verification

```bash
npm run check    # lint, tests, the passing example, the failing example, npm pack --dry-run
```

The suite pins behaviour rather than declarations. Severity is asserted through
real exit codes for every rule in the table; ordering is asserted with inputs
that code-unit order and ICU collation genuinely disagree about; every character
class that forges or hides output is driven through an identifier as well as an
excerpt; and the parse-failure helper is tested against the document that reads
`at position 1`, which is how the rest of this catalog found that bug.

## License

MIT. See [LICENSE](./LICENSE).
