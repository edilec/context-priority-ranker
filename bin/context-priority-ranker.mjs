#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_CONTEXT_SET_NAME, BAND_ORDER,
  excerpt, exitCodeFor, formatReport, loadPolicyFile, rankContext, serializeReport,
} from '../src/index.mjs'

const VERSION = '0.1.0'

const HELP = `context-priority-ranker

Rank supplied context items by configured authority, declared relevance,
freshness and resolved evidence links, and explain every score. Reads two JSON
documents, writes no file anywhere, opens no socket and executes nothing.

The guarantee: relevance cannot buy authority. Items are ordered by
(band, then score, then id), bands being ${BAND_ORDER.join(' > ')}.
The band comes from --policy by way of the item's declared "source"; the score
only orders items inside a band. An untrusted item with relevance 1.0, dated
today and citing three supporting documents still ranks below a governing item
that scores zero on all three.

The second thing it reports: a governing or trusted item older than its
reviewAfterDays is flagged for review, and one past its expireAfterDays is an
error. High-authority context is obeyed whether or not it is still true.

Usage:
  context-priority-ranker --root DIR --policy FILE [--context-set FILE]
                          [--today YYYY-MM-DD] [--json] [limits]

Options:
  --root DIR                Directory holding the context set (required)
  --policy FILE             Policy document: authority map, weights, band
                            freshness intervals (required). Read from wherever
                            you name it -- it is operator configuration, not
                            subject material, and it is not confined to --root
  --context-set FILE        Context set, relative to --root
                            (default ${DEFAULT_CONTEXT_SET_NAME})
  --today YYYY-MM-DD        Evaluation date, UTC. Default: today on this host's
                            clock. Freshness depends on it, so it is recorded in
                            the report as summary.today
  --json                    Suppress the human summary on stderr
  --max-document-bytes N    Maximum context-set size (default 1048576)
  --max-evidence-links N    Maximum evidence links on one item (default 32)
  --max-findings N          Maximum findings in one report (default 1000)
  --max-items N             Maximum items in one context set (default 2000)
  --max-runtime-ms N        Time budget, checked before each item. Not a hard
                            deadline: a run overshoots by the cost of the item
                            in hand. Reaching it is an incomplete run with no
                            ranking, never a shorter one (default 10000)
  --max-text-chars N        Maximum characters of one item's text (default
                            20000). Longer text is not scanned, and nothing is
                            then claimed about what it contains
  -h, --help                Show this help
  -v, --version             Show the version

Every option that carries a value may be given once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

What a pass means:
  Every item was scored, no error-severity rule fired, and the ranking in the
  report covers the whole set. It does not mean the context is correct, that a
  governing document says what you remember, or that an item's declared
  relevance is honest -- relevance is taken from the document, which is exactly
  why it can only reorder items inside one band.

What no run produces:
  A ranking over part of a document. If any item could not be scored -- unknown
  source, absent relevance, undated, a limit reached, the time budget expired --
  the ranking is empty and the run is incomplete. An ordering missing one member
  is not a shorter ordering: the absent item might have belonged first.

Exit codes:
  0  every item was scored and no error-severity rule fired
  1  every item was scored and at least one error-severity rule fired
  2  invalid configuration (no report on stdout), or evidence that could not be
     obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-evidence-links', 'maxEvidenceLinks'],
  ['--max-findings', 'maxFindings'],
  ['--max-items', 'maxItems'],
  ['--max-runtime-ms', 'maxRuntimeMs'],
  ['--max-text-chars', 'maxTextChars'],
])

const VALUE_FLAGS = new Map([
  ['--context-set', 'contextSet'],
  ['--policy', 'policy'],
  ['--root', 'root'],
  ['--today', 'today'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { root: null, policy: null, contextSet: null, today: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag carrying a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--policy real.json --policy lax.json` ranks against a policy nobody named.
   * That is the same defect as an ignored typo, which this tool also refuses.
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
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened exactly as a finding would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  if (options.policy === null) throw new Error('--policy is required; there is no default authority map')
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

  let policy
  try {
    policy = await loadPolicyFile(options.policy)
  } catch (error) {
    // A configuration error never had a subject, so stdout stays empty rather
    // than carrying a fabricated report.
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  let report
  try {
    report = await rankContext({
      root: options.root,
      policy,
      limits: options.limits,
      ...(options.contextSet === null ? {} : { contextSet: options.contextSet }),
      ...(options.today === null ? {} : { today: options.today }),
    })
  } catch (error) {
    process.stderr.write(`${excerpt(error.message, 400)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  if (options.today === null) {
    process.stderr.write(`evaluated against ${report.summary.today}, taken from this host's clock; pass --today to fix it\n`)
  }
  if (report.status === 'incomplete') {
    process.stderr.write('incomplete: this run is not a pass, and no ranking was produced.\n')
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
