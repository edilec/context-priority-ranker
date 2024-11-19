/**
 * context-priority-ranker -- rank supplied context items by configured
 * authority, declared relevance, freshness and resolved evidence links, and
 * explain every score.
 *
 * The one guarantee the tool exists for: **relevance cannot buy authority.**
 * Ranking is lexicographic on (band rank, then score, then id). The band comes
 * from the operator's policy file by way of the item's declared `source`; the
 * score orders items inside a band and never across one. A retrieved page that
 * declares relevance 1.0, is dated today and cites three supporting documents
 * still ranks below a governing instruction that scores zero on all three.
 *
 * The second thing it does: a high-authority item that has gone past its review
 * interval is reported, because the failure mode of a governing document is not
 * that it is ignored -- it is that it is obeyed long after the system it
 * describes has changed.
 *
 * Everything here is static analysis of declared configuration. The tool reads
 * two JSON documents, opens no socket, executes nothing, and writes no file
 * anywhere. Item text is data: it is scanned, bounded, sanitised and counted,
 * and it never decides what the tool does.
 */

import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  BAND_ORDER, RESERVED_ITEM_FIELDS, ALLOWED_ITEM_FIELDS,
  bandRank, isHighAuthority, validatePolicy,
} from './policy.mjs'
import {
  combine, dayDifference, evidencePoints, freshnessPoints, parseCalendarDate, relevancePoints,
  todayFromClock, POINT_SCALE,
} from './score.mjs'
import {
  byCodeUnit, decodeUtf8, escapePointerSegment, excerpt, hasForbiddenCharacter, isPlainObject,
  parseFailureDetail,
} from './text.mjs'

export {
  BAND_ORDER, HIGH_AUTHORITY_BANDS, RESERVED_ITEM_FIELDS, ALLOWED_ITEM_FIELDS, DEFAULT_POLICY,
  bandRank, isHighAuthority, validatePolicy,
} from './policy.mjs'
export {
  POINT_SCALE, combine, dayDifference, evidencePoints, freshnessPoints, parseCalendarDate,
  relevancePoints, todayFromClock,
} from './score.mjs'
export {
  CONTROL_CLASSES, CREDENTIAL_PATTERNS, byCodeUnit, decodeUtf8, escapePointerSegment, excerpt,
  hasForbiddenCharacter, isPlainObject, parseFailureDetail, redactCredentials, renderable,
} from './text.mjs'

export const TOOL_ID = 'context-priority-ranker'
export const REPORT_SCHEMA_VERSION = '1'
export const SUPPORTED_DOCUMENT_VERSION = '1'
export const DEFAULT_CONTEXT_SET_NAME = 'context-set.json'

/**
 * Limits, each enforced and each reported by name when it is reached.
 *
 * Exceeding one is never a silent truncation: it produces a finding naming the
 * limit, marks the run `incomplete`, and suppresses the ranking -- a ranking
 * over the part of a document somebody happened to reach is not a ranking.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxDocumentBytes: 1048576,
  maxEvidenceLinks: 32,
  maxFindings: 1000,
  maxItems: 2000,
  maxRuntimeMs: 10000,
  maxTextChars: 20000,
})

/** A caller may lower a limit, never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxDocumentBytes: 67108864,
  maxEvidenceLinks: 512,
  maxFindings: 20000,
  maxItems: 100000,
  maxRuntimeMs: 600000,
  maxTextChars: 2000000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity decides whether a run fails, so it lives in exactly one place and
 * every finding takes its value from here. An unknown rule id throws rather
 * than defaulting, because a defaulted severity is a severity nobody chose.
 *
 * `test/rule-catalog.test.mjs` checks this table against docs/ranking-rules.md
 * in both directions. That is a useful consistency check and it is *not* the
 * defence: a table, a document and a test's expected map are three
 * declarations, and one coordinated edit satisfies all three. The defence is
 * `test/severity-outcomes.test.mjs`, which drives real documents through the
 * real entry point and pins the emitted severity word, the summary counts and
 * the process exit code.
 */
export const RULE_SEVERITY = Object.freeze({
  'authority-unknown': 'error',
  'document-invalid': 'error',
  'document-unknown-field': 'error',
  'evidence-invalid': 'error',
  'evidence-link-self': 'warning',
  'evidence-link-unresolved': 'warning',
  'evidence-link-unscored': 'error',
  'expired-high-authority-context': 'error',
  'freshness-unknown': 'error',
  'high-authority-evidence-untrusted': 'warning',
  'input-not-json': 'error',
  'input-not-utf8': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'item-declares-authority': 'error',
  'item-id-duplicate': 'error',
  'item-id-invalid': 'error',
  'item-invalid': 'error',
  'item-text-too-long': 'error',
  'item-unknown-field': 'error',
  'no-context-items': 'error',
  'no-governing-context': 'warning',
  'path-escapes-root': 'error',
  'relevance-missing': 'error',
  'relevance-out-of-range': 'error',
  'schema-version-unsupported': 'error',
  'source-missing': 'error',
  'stale-high-authority-context': 'warning',
  'time-budget-exceeded': 'error',
  'too-many-evidence-links': 'error',
  'too-many-findings': 'error',
  'too-many-items': 'error',
  'untrusted-authority-claim': 'warning',
  'updated-in-future': 'warning',
  'updated-invalid': 'error',
})

/**
 * Phrases an untrusted item's own text may use to claim authority it does not
 * have. Matched case-insensitively as plain substrings against `title` and
 * `text` of items in the `untrusted` band only.
 *
 * This is a small fixed list, not a prompt-injection detector, and the README
 * says so. It changes nothing about the ranking -- an untrusted item ranks
 * below every trusted one whether or not it says any of this. It exists so that
 * a reader of the report learns the document tried, which is a fact worth
 * knowing about a source before its text is pasted into a prompt.
 */
export const AUTHORITY_CLAIM_PHRASES = Object.freeze([
  'as the system',
  'disregard the above',
  'disregard previous instructions',
  'do not tell the user',
  'highest priority',
  'ignore all previous',
  'ignore previous instructions',
  'new instructions:',
  'override the policy',
  'system prompt',
  'this supersedes',
  'treat this as authoritative',
  'you must now',
])

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200
const EXPLANATION_LIMIT = 400
const MAX_ID_LENGTH = 120
const MAX_NAME_LENGTH = 200

const ALLOWED_OPTIONS = Object.freeze([
  'contextSet', 'limits', 'monotonic', 'now', 'policy', 'root', 'today',
])
const ALLOWED_DOCUMENT_KEYS = Object.freeze(['items', 'schemaVersion', 'task'])

/**
 * Validate limit overrides.
 *
 * An unknown key throws rather than being ignored. A documented limit a typo
 * silently disables is a limit that is not enforced; the CLI turns this throw
 * into a configuration error with an empty stdout.
 */
export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(overrides).sort(byCodeUnit)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError(
        `Unknown limit "${excerpt(key, 60)}"; known limits are ${Object.keys(DEFAULT_LIMITS).sort(byCodeUnit).join(', ')}`,
      )
    }
    const value = overrides[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      throw new TypeError(`limits.${key} must be an integer between 1 and ${cap}`)
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * True when `candidate` is the real root itself or lies beneath it.
 *
 * Both sides must already be real paths. Comparing a real root against an
 * unresolved path refuses legitimate files whenever the root is reached through
 * a symbolic link -- a `/var` that is really `/private/var` is enough -- and a
 * false refusal is a defect too.
 */
export function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * A file name given on the command line, checked as configuration.
 *
 * Absolute paths and `..` segments are refused here, before any evidence is
 * gathered. This is emphatically *not* the confinement: a symbolic link planted
 * inside the root passes every check in this function and contains no `..` at
 * all. `resolveInput` is what catches that, by resolving both real paths.
 */
function validateName(name, flag) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(`${flag} must be a relative file name of 1-${MAX_NAME_LENGTH} characters`)
  }
  if (hasForbiddenCharacter(name)) {
    throw new TypeError(`${flag} must not contain a control, separator or bidi character`)
  }
  if (isAbsolute(name)) throw new TypeError(`${flag} must be relative to --root, not an absolute path`)
  if (normalize(name).split(/[\\/]/).includes('..')) throw new TypeError(`${flag} must not step outside --root with ".."`)
  return name
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message,
 * suggestion and evidence alike, not only the evidence field. A sibling tool
 * sanitised its evidence field carefully and left identifiers raw, so a record
 * id holding a newline forged an extra line in the human report.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/ranking-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, LOCATION_LIMIT), pointer: excerpt(row.pointer ?? '', LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/**
 * The documented sort key: `location.file`, `location.pointer`, `ruleId`,
 * `message`.
 *
 * Pointers are compared as strings, so `/items/10` precedes `/items/9`. That is
 * stated in the README rather than fixed, because the alternative -- a numeric
 * segment comparison -- is one more thing that can differ between
 * implementations of the same report.
 *
 * The message is part of the key because several rules deliberately anchor more
 * than one finding at the same pointer.
 */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file, b.location.file)
    || byCodeUnit(a.location.pointer, b.location.pointer)
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

/**
 * The documented ranking key: band rank ascending, then score descending, then
 * id by code unit.
 *
 * The band comes first and is compared before anything else. That is the
 * structural form of the guarantee: there is no score, no weight and no policy
 * value that can make a lower band sort above a higher one, because the score
 * is never consulted when the bands differ.
 */
export function compareRanked(a, b) {
  if (a.bandRank !== b.bandRank) return a.bandRank - b.bandRank
  if (a.score !== b.score) return b.score - a.score
  return byCodeUnit(a.id, b.id)
}

class Run {
  constructor(file, limits) {
    this.file = file
    this.limits = limits
    this.rows = []
    this.incomplete = false
    this.checked = 0
  }

  add(row) {
    this.rows.push({ pointer: '', file: this.file, ...row })
  }

  /**
   * Record a finding AND mark the run incomplete, in one call.
   *
   * The two belong together: every caller of this method is a place where the
   * tool wanted a fact about the subject and did not get one. Splitting them
   * into two statements is how a deleted line leaves an unread input reporting
   * a pass, which is defect class 3 in the contract.
   */
  addUnknown(row) {
    this.incomplete = true
    this.add(row)
  }
}

async function resolveInput(realRoot, name) {
  const target = resolve(realRoot, name)
  try {
    const real = await realpath(target)
    if (!isInside(realRoot, real)) return { ok: false, reason: 'escapes' }
    return { ok: true, real }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ELOOP') {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    // The entry may exist as a link resolving nowhere. Confine the nearest
    // existing ancestor first, so a symlinked parent cannot decide where a
    // "missing" file would have been read from.
    try {
      const realParent = await realpath(dirname(target))
      if (!isInside(realRoot, realParent)) return { ok: false, reason: 'escapes' }
    } catch {
      return { ok: false, reason: 'unreadable', code: error.code }
    }
    return { ok: false, reason: 'unreadable', code: error.code }
  }
}

/**
 * Read the policy file: a JSON document, parsed and validated.
 *
 * Failures throw, and the CLI reports them as configuration errors with an
 * empty stdout. The parse failure is described through `parseFailureDetail`,
 * because a policy file is as capable of holding a credential as any other
 * document and V8's own message would quote it back.
 */
export async function loadPolicyFile(path) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new TypeError(`--policy could not be read (${error.code ?? 'unreadable'})`)
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) throw new TypeError('--policy is not valid UTF-8')
  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    throw new TypeError(`--policy is not valid JSON: ${excerpt(parseFailureDetail(error), 200)}`)
  }
  return validatePolicy(parsed)
}

function compileItem(run, policy, limits, item, index) {
  const pointer = `/items/${index}`
  if (!isPlainObject(item)) {
    run.add({
      pointer,
      ruleId: 'item-invalid',
      message: 'This context item is not a JSON object, so it has no source, relevance or date to rank by.',
      suggestion: 'Give every entry of "items" an object with id, source, relevance and updated.',
    })
    return null
  }

  const compiled = { pointer, index, scored: true }
  const keys = Object.keys(item).sort(byCodeUnit)

  const rawId = item.id
  const idUsable = typeof rawId === 'string' && rawId.length > 0
    && rawId.length <= MAX_ID_LENGTH && !hasForbiddenCharacter(rawId)
  if (!idUsable) {
    run.add({
      pointer: `${pointer}/id`,
      ruleId: 'item-id-invalid',
      message: `This item has no usable "id": it must be a string of 1-${MAX_ID_LENGTH} characters with no control, separator or bidi character.`,
      suggestion: 'Give the item a stable identifier; evidence links are resolved by it.',
    })
    compiled.scored = false
  }
  compiled.id = idUsable ? rawId : `items[${index}]`
  compiled.idDeclared = idUsable

  for (const field of RESERVED_ITEM_FIELDS) {
    if (Object.hasOwn(item, field)) {
      run.add({
        pointer: `${pointer}/${escapePointerSegment(field)}`,
        ruleId: 'item-declares-authority',
        message: `This item declares "${field}". Authority is assigned by the policy file from the item's "source"; an item may not nominate its own band, rank or score.`,
        evidence: `reserved field "${field}" on item ${excerpt(compiled.id, 60)}`,
        suggestion: `Remove "${field}" and map the item's source to a band in the policy file.`,
      })
      compiled.scored = false
    }
  }

  for (const key of keys) {
    if (!ALLOWED_ITEM_FIELDS.includes(key) && !RESERVED_ITEM_FIELDS.includes(key)) {
      run.add({
        pointer: `${pointer}/${escapePointerSegment(key)}`,
        ruleId: 'item-unknown-field',
        message: `Unknown item field "${excerpt(key, 60)}"; known fields are ${ALLOWED_ITEM_FIELDS.join(', ')}.`,
        suggestion: 'Remove the field, or correct the spelling of the one you meant.',
      })
      compiled.scored = false
    }
  }

  const rawSource = item.source
  if (typeof rawSource !== 'string' || rawSource.length === 0) {
    run.add({
      pointer: `${pointer}/source`,
      ruleId: 'source-missing',
      message: 'This item declares no "source", so the policy has nothing to map to an authority band.',
      suggestion: 'Declare the source this item came from, and map that name in the policy file.',
    })
    compiled.scored = false
  } else if (!Object.hasOwn(policy.authority, rawSource)) {
    /**
     * An unmapped source is missing evidence, not a default band. Falling back
     * to "untrusted" would look safe and would be a lie in the other direction
     * too: an operator instruction whose source name was misspelt would be
     * ranked below a web page and the report would say nothing.
     */
    run.addUnknown({
      pointer: `${pointer}/source`,
      ruleId: 'authority-unknown',
      message: `The policy maps no band to source "${excerpt(rawSource, 60)}", so this item's authority is unknown. It is not ranked and no band is assumed for it.`,
      evidence: `unmapped source "${excerpt(rawSource, 60)}"`,
      suggestion: 'Add the source to policy.authority, or correct the spelling in the context set.',
    })
    compiled.scored = false
  } else {
    compiled.source = rawSource
    compiled.band = policy.authority[rawSource]
    compiled.bandRank = bandRank(compiled.band)
  }

  if (!Object.hasOwn(item, 'relevance')) {
    run.addUnknown({
      pointer: `${pointer}/relevance`,
      ruleId: 'relevance-missing',
      message: 'This item declares no "relevance", so its score is unknown. An absent relevance is not a relevance of zero.',
      suggestion: 'Declare the retrieval relevance as a number between 0 and 1.',
    })
    compiled.scored = false
  } else if (typeof item.relevance !== 'number' || !Number.isFinite(item.relevance)
    || item.relevance < 0 || item.relevance > 1) {
    run.add({
      pointer: `${pointer}/relevance`,
      ruleId: 'relevance-out-of-range',
      message: 'This item\'s "relevance" is not a finite number between 0 and 1.',
      suggestion: 'Normalise the retrieval score to the 0-1 range before writing the context set.',
    })
    compiled.scored = false
  } else compiled.relevance = item.relevance

  if (!Object.hasOwn(item, 'updated')) {
    run.addUnknown({
      pointer: `${pointer}/updated`,
      ruleId: 'freshness-unknown',
      message: 'This item declares no "updated" date, so its freshness is unknown. An undated document is not a fresh document.',
      suggestion: 'Declare the date the item was last reviewed, as YYYY-MM-DD.',
    })
    compiled.scored = false
  } else {
    const parsed = parseCalendarDate(item.updated)
    if (!parsed.ok) {
      run.addUnknown({
        pointer: `${pointer}/updated`,
        ruleId: 'updated-invalid',
        message: 'This item\'s "updated" is not a YYYY-MM-DD calendar date, so its freshness could not be determined.',
        // Not `String(item.updated)`: a value carrying a non-callable
        // `toString` throws there and would cost the whole report. `excerpt`
        // describes such a value by its shape instead.
        evidence: `updated ${excerpt(item.updated, 40)}`,
        suggestion: 'Write the date as YYYY-MM-DD; a lenient parser would read 2026-02-30 as 2 March.',
      })
      compiled.scored = false
    } else {
      compiled.updated = item.updated
      compiled.updatedMs = parsed.ms
    }
  }

  if (Object.hasOwn(item, 'title') && typeof item.title !== 'string') {
    run.add({
      pointer: `${pointer}/title`,
      ruleId: 'item-invalid',
      message: 'This item\'s "title" is not a string.',
      suggestion: 'Remove the field, or write the title as a string.',
    })
    compiled.scored = false
  }
  compiled.title = typeof item.title === 'string' ? item.title : ''

  compiled.text = ''
  if (Object.hasOwn(item, 'text')) {
    if (typeof item.text !== 'string') {
      run.add({
        pointer: `${pointer}/text`,
        ruleId: 'item-invalid',
        message: 'This item\'s "text" is not a string.',
        suggestion: 'Remove the field, or write the text as a string.',
      })
      compiled.scored = false
    } else if (item.text.length > limits.maxTextChars) {
      run.addUnknown({
        pointer: `${pointer}/text`,
        ruleId: 'item-text-too-long',
        message: `This item's text is ${item.text.length} characters, past the maxTextChars limit of ${limits.maxTextChars}. It was not scanned, so nothing is claimed about what it contains.`,
        suggestion: 'Raise --max-text-chars, or summarise the item before ranking it.',
      })
      compiled.scored = false
    } else compiled.text = item.text
  }

  compiled.evidence = []
  if (Object.hasOwn(item, 'evidence')) {
    if (!Array.isArray(item.evidence)) {
      run.add({
        pointer: `${pointer}/evidence`,
        ruleId: 'evidence-invalid',
        message: 'This item\'s "evidence" is not an array of item ids.',
        suggestion: 'List the ids of the items that support this one, or remove the field.',
      })
      compiled.scored = false
    } else if (item.evidence.length > limits.maxEvidenceLinks) {
      run.addUnknown({
        pointer: `${pointer}/evidence`,
        ruleId: 'too-many-evidence-links',
        message: `This item declares ${item.evidence.length} evidence links, past the maxEvidenceLinks limit of ${limits.maxEvidenceLinks}. None were resolved.`,
        suggestion: 'Raise --max-evidence-links, or cite fewer supporting items.',
      })
      compiled.scored = false
    } else {
      for (const [position, link] of item.evidence.entries()) {
        if (typeof link !== 'string' || link.length === 0 || link.length > MAX_ID_LENGTH) {
          run.add({
            pointer: `${pointer}/evidence/${position}`,
            ruleId: 'evidence-invalid',
            message: `Evidence link ${position} is not an item id string of 1-${MAX_ID_LENGTH} characters.`,
            suggestion: 'Every evidence entry is the id of another item in this set.',
          })
          compiled.scored = false
        } else compiled.evidence.push({ position, id: link })
      }
    }
  }

  return compiled
}

/**
 * Report an untrusted item whose own text claims authority over the
 * instructions.
 *
 * Scoped to the untrusted band on purpose, and the README's non-goals say so: a
 * security policy that quotes an injection phrase in order to warn about it is
 * a governing document doing its job, and flagging it would train a reader to
 * ignore the rule. An item whose band is unknown is not scanned either --
 * nothing is claimed about a band the policy did not map.
 */
function checkAuthorityClaims(run, compiled) {
  if (compiled.band !== 'untrusted') return
  const haystack = `${compiled.title}\n${compiled.text}`.toLowerCase()
  for (const phrase of AUTHORITY_CLAIM_PHRASES) {
    const at = haystack.indexOf(phrase)
    if (at < 0) continue
    run.add({
      pointer: compiled.pointer,
      ruleId: 'untrusted-authority-claim',
      message: `Untrusted item "${excerpt(compiled.id, 60)}" contains text asserting authority over the instructions ("${phrase}"). It is ranked in the untrusted band regardless; this is reported so a reader knows before the text is pasted anywhere.`,
      // The phrase comes from this module's own fixed list, and the offset is a
      // number: neither reproduces the document.
      evidence: `matched the phrase "${phrase}" at character ${at}`,
      suggestion: 'Review the source before including this item, and keep it out of any instruction section.',
    })
  }
}

/**
 * Count the evidence links that resolve to a scored item, and say what happened
 * to the ones that did not.
 *
 * The distinction between the two failures is the point. "Names no item in this
 * context set" is a statement of absence, and it was being made about ids that
 * were present and merely unscored -- an item with one misspelt field silently
 * became an item that does not exist. That is the forbidden shape: reporting
 * "no X was supplied" when an X was supplied and could not be read. A present
 * but unscored target is unknown support, not absent support, so it marks the
 * run incomplete rather than letting a reader conclude the citation was
 * dangling.
 */
function resolveEvidence(run, compiled, byId, declaredIds) {
  let supported = 0
  for (const link of compiled.evidence) {
    if (link.id === compiled.id) {
      run.add({
        pointer: `${compiled.pointer}/evidence/${link.position}`,
        ruleId: 'evidence-link-self',
        message: `Item "${excerpt(compiled.id, 60)}" cites itself as evidence; a self-citation adds no support and is not counted.`,
        suggestion: 'Cite the item that actually supports this one, or drop the link.',
      })
      continue
    }
    const target = byId.get(link.id)
    if (target === undefined) {
      const present = declaredIds.get(link.id)
      if (present === undefined) {
        run.add({
          pointer: `${compiled.pointer}/evidence/${link.position}`,
          ruleId: 'evidence-link-unresolved',
          message: `Evidence link "${excerpt(link.id, 60)}" names no item in this context set, so it counts as no support.`,
          suggestion: 'Include the cited item in the set, or remove the link.',
        })
      } else {
        run.addUnknown({
          pointer: `${compiled.pointer}/evidence/${link.position}`,
          ruleId: 'evidence-link-unscored',
          message: `Evidence link "${excerpt(link.id, 60)}" names the item at ${present}, which could not be scored, so whether it supports this one is unknown. It is present in the set; it is not counted as support and it is not reported as missing.`,
          suggestion: 'Fix what is already reported against that item, then rank the set again.',
        })
      }
      continue
    }
    supported += 1
    if (isHighAuthority(compiled.band) && target.band === 'untrusted') {
      run.add({
        pointer: `${compiled.pointer}/evidence/${link.position}`,
        ruleId: 'high-authority-evidence-untrusted',
        message: `High-authority item "${excerpt(compiled.id, 60)}" rests on untrusted item "${excerpt(target.id, 60)}"; the support is counted but the chain is only as good as its weakest source.`,
        suggestion: 'Confirm the claim against a source in the trusted band or above.',
      })
    }
  }
  return supported
}

function describeFreshness(compiled, ageDays, band) {
  if (ageDays < 0) return `dated ${compiled.updated}, ${-ageDays} day(s) in the future`
  const review = band.reviewAfterDays === null ? 'no review interval' : `review after ${band.reviewAfterDays}`
  return `${ageDays} day(s) since ${compiled.updated} (${review})`
}

function buildReport(run, state, limits) {
  let findings = run.rows.map((row) => createFinding(row)).sort(compareFindings)
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(createFinding({
      file: run.file,
      pointer: '',
      ruleId: 'too-many-findings',
      message: `The run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} were not reported and this report is partial.`,
      suggestion: 'Raise --max-findings, or rank the context set in parts.',
    }))
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const incomplete = run.incomplete || truncated
  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  /**
   * The ranking is emitted only when every item in the document was scored and
   * nothing was left unknown.
   *
   * A ranking missing one member is not a shorter ranking: the absent item
   * might belong anywhere in it, including first. Emitting the rest would be a
   * confident-looking answer to a question the run did not answer -- which is
   * exactly the "unknown reported as a pass" defect, wearing an array.
   */
  const rankingProduced = !incomplete && state.items > 0 && state.unscored === 0
  const ranking = rankingProduced ? state.ranking : []

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: state.checked,
      errors,
      warnings,
      items: state.items,
      scored: state.scored,
      unscored: state.unscored,
      ranked: ranking.length,
      rankingProduced,
      today: state.today,
      bands: state.bands,
      stale: state.stale,
      expired: state.expired,
    },
    ranking,
    findings,
  }
}

function emptyBands() {
  const counts = {}
  for (const band of BAND_ORDER) counts[band] = 0
  return counts
}

/**
 * Rank a context set against a policy.
 *
 * Returns a report; it throws only for configuration that never gave the run a
 * subject -- an unusable root, an unknown option, an invalid policy or limit.
 * Everything about the subject, including an input that could not be read,
 * comes back as a report with `status: "incomplete"`.
 */
export async function rankContext(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options).sort(byCodeUnit)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new TypeError(`Unknown option "${excerpt(key, 60)}"; known options are ${ALLOWED_OPTIONS.join(', ')}`)
    }
  }

  const limits = validateLimits(options.limits)
  const policy = validatePolicy(options.policy)
  const monotonic = options.monotonic ?? (() => performance.now())
  if (typeof monotonic !== 'function') throw new TypeError('monotonic must be a function returning milliseconds')
  const startedAt = monotonic()

  const today = options.today ?? todayFromClock(options.now)
  const todayParsed = parseCalendarDate(today)
  if (!todayParsed.ok) throw new TypeError('today must be a YYYY-MM-DD calendar date')

  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('root is required')
  let realRoot
  try {
    realRoot = await realpath(options.root)
  } catch (error) {
    throw new TypeError(`root is not a readable directory (${error.code ?? 'unreadable'})`)
  }

  const name = validateName(options.contextSet ?? DEFAULT_CONTEXT_SET_NAME, 'contextSet')
  const file = relative(realRoot, resolve(realRoot, name)).split(sep).join('/')
  const run = new Run(file, limits)
  const state = {
    checked: 0,
    items: 0,
    scored: 0,
    unscored: 0,
    today,
    bands: emptyBands(),
    stale: 0,
    expired: 0,
    ranking: [],
  }

  const located = await resolveInput(realRoot, name)
  if (!located.ok) {
    run.addUnknown(located.reason === 'escapes'
      ? {
        ruleId: 'path-escapes-root',
        message: 'The context set resolves outside the declared root, so it was not read.',
        suggestion: 'Point --root at the directory that really holds the document.',
      }
      : {
        ruleId: 'input-unreadable',
        message: `The context set could not be read (${excerpt(located.code ?? 'unreadable', 40)}).`,
        suggestion: 'Check the path and the file permissions.',
      })
    return buildReport(run, state, limits)
  }

  let bytes
  try {
    bytes = await readFile(located.real)
  } catch (error) {
    run.addUnknown({
      ruleId: 'input-unreadable',
      message: `The context set could not be read (${excerpt(error.code ?? 'unreadable', 40)}).`,
      suggestion: 'Check the path and the file permissions.',
    })
    return buildReport(run, state, limits)
  }

  if (bytes.byteLength > limits.maxDocumentBytes) {
    run.addUnknown({
      ruleId: 'input-too-large',
      message: `The context set is ${bytes.byteLength} bytes, past the maxDocumentBytes limit of ${limits.maxDocumentBytes}. It was not parsed.`,
      suggestion: 'Raise --max-document-bytes, or split the context set.',
    })
    return buildReport(run, state, limits)
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    run.addUnknown({
      ruleId: 'input-not-utf8',
      message: 'The context set is not valid UTF-8, so it was not parsed.',
      suggestion: 'Re-encode the document as UTF-8.',
    })
    return buildReport(run, state, limits)
  }

  let document
  try {
    document = JSON.parse(decoded.text)
  } catch (error) {
    run.addUnknown({
      ruleId: 'input-not-json',
      // The detail describes where the parse failed and never reproduces the
      // document; `createFinding` sanitises it again on the way out.
      message: `The context set is not valid JSON: ${parseFailureDetail(error)}.`,
      suggestion: 'Validate the document with a JSON parser before ranking it.',
    })
    return buildReport(run, state, limits)
  }

  if (!isPlainObject(document)) {
    run.add({
      ruleId: 'document-invalid',
      message: 'The context set is not a JSON object with an "items" array.',
      suggestion: 'Wrap the items: { "schemaVersion": "1", "items": [ ... ] }.',
    })
    return buildReport(run, state, limits)
  }

  if (Object.hasOwn(document, 'schemaVersion') && document.schemaVersion !== SUPPORTED_DOCUMENT_VERSION) {
    run.addUnknown({
      pointer: '/schemaVersion',
      ruleId: 'schema-version-unsupported',
      message: `This build understands context-set schemaVersion "${SUPPORTED_DOCUMENT_VERSION}"; the document declares "${excerpt(document.schemaVersion, 40)}". It was not interpreted.`,
      suggestion: 'Rank the document with a build that understands its schema version.',
    })
    return buildReport(run, state, limits)
  }

  for (const key of Object.keys(document).sort(byCodeUnit)) {
    if (!ALLOWED_DOCUMENT_KEYS.includes(key)) {
      run.add({
        pointer: `/${escapePointerSegment(key)}`,
        ruleId: 'document-unknown-field',
        message: `Unknown document field "${excerpt(key, 60)}"; known fields are ${ALLOWED_DOCUMENT_KEYS.join(', ')}.`,
        suggestion: 'Remove the field, or correct the spelling of the one you meant.',
      })
    }
  }

  if (!Array.isArray(document.items)) {
    run.add({
      pointer: '/items',
      ruleId: 'document-invalid',
      message: 'The context set has no "items" array.',
      suggestion: 'Declare "items" as an array of context items.',
    })
    return buildReport(run, state, limits)
  }

  if (document.items.length === 0) {
    /**
     * Zero items is not a pass. A green report over an empty document is the
     * "vacuous pass" defect: it reads as "the context is correctly ordered"
     * when what happened is that nothing was ordered at all.
     */
    run.add({
      pointer: '/items',
      ruleId: 'no-context-items',
      message: 'The context set declares no items, so there is nothing to rank and nothing this run can attest to.',
      suggestion: 'List the context items you intend to assemble, or stop calling this tool for this run.',
    })
    return buildReport(run, state, limits)
  }

  if (document.items.length > limits.maxItems) {
    run.addUnknown({
      pointer: '/items',
      ruleId: 'too-many-items',
      message: `The context set declares ${document.items.length} items, past the maxItems limit of ${limits.maxItems}. None were ranked.`,
      suggestion: 'Raise --max-items, or rank the set in parts.',
    })
    return buildReport(run, state, limits)
  }

  state.items = document.items.length
  const compiled = []
  const byId = new Map()
  /**
   * Every id the document declares, scored or not, with where it was declared.
   *
   * Kept apart from `byId`, which holds only the items that were scored and is
   * what an evidence link may actually resolve to. This map is what lets the
   * report tell "no item has that id" apart from "that item is right there and
   * could not be read".
   */
  const declaredIds = new Map()

  for (const [index, item] of document.items.entries()) {
    /**
     * The time budget is checked before each item, and reaching it stops the
     * loop, marks the run incomplete and suppresses the ranking. A budget that
     * expires mid-loop must never leave a confident-looking ordering behind.
     */
    if (monotonic() - startedAt > limits.maxRuntimeMs) {
      run.addUnknown({
        pointer: `/items/${index}`,
        ruleId: 'time-budget-exceeded',
        message: `The maxRuntimeMs budget of ${limits.maxRuntimeMs} ms expired after ${index} of ${state.items} items. The remaining items were not examined and no ranking was produced.`,
        suggestion: 'Raise --max-runtime-ms, or rank the set in parts.',
      })
      return buildReport(run, state, limits)
    }
    state.checked += 1
    const row = compileItem(run, policy, limits, item, index)
    if (row === null) {
      state.unscored += 1
      continue
    }
    compiled.push(row)
    if (row.scored) {
      if (byId.has(row.id)) {
        run.add({
          pointer: `${row.pointer}/id`,
          ruleId: 'item-id-duplicate',
          message: `Item id "${excerpt(row.id, 60)}" appears more than once; evidence links to it would be ambiguous.`,
          suggestion: 'Give every item a distinct id.',
        })
        row.scored = false
      } else byId.set(row.id, row)
    }
    if (row.idDeclared && !declaredIds.has(row.id)) declaredIds.set(row.id, row.pointer)
  }

  /**
   * Every compiled item is scanned, scored or not.
   *
   * Gating this on `scored` handed the suppression to the attacker: the context
   * set is the untrusted input, so an item carrying one unrecognised field --
   * or a reserved field, or a relevance out of range -- silenced every
   * authority-claim warning about ITSELF while its own text kept saying
   * "ignore previous instructions". The warning costs nothing to emit for an
   * item that will not be ranked, and it is the one thing in this report a
   * reader needs before pasting that text anywhere.
   */
  for (const row of compiled) checkAuthorityClaims(run, row)

  for (const row of compiled) {
    if (!row.scored) {
      state.unscored += 1
      continue
    }
    state.scored += 1
    state.bands[row.band] += 1

    const bandPolicy = policy.bands[row.band]
    const ageDays = dayDifference(row.updatedMs, todayParsed.ms)
    if (ageDays < 0) {
      run.add({
        pointer: `${row.pointer}/updated`,
        ruleId: 'updated-in-future',
        message: `Item "${excerpt(row.id, 60)}" is dated ${row.updated}, which is after the evaluation date ${today}. It is scored as fresh; the date is reported because one of the two is wrong.`,
        suggestion: 'Correct the date, or pass the evaluation date this set was assembled for with --today.',
      })
    }

    if (isHighAuthority(row.band) && ageDays > 0) {
      if (bandPolicy.expireAfterDays !== null && ageDays > bandPolicy.expireAfterDays) {
        state.expired += 1
        run.add({
          pointer: `${row.pointer}/updated`,
          ruleId: 'expired-high-authority-context',
          message: `${row.band} item "${excerpt(row.id, 60)}" was last updated ${row.updated}, ${ageDays} days ago, past its expireAfterDays of ${bandPolicy.expireAfterDays}. It still outranks every lower band, which is why an expired one is an error rather than a note.`,
          suggestion: 'Re-confirm the document against the current system, then update its "updated" date.',
        })
      } else if (bandPolicy.reviewAfterDays !== null && ageDays > bandPolicy.reviewAfterDays) {
        state.stale += 1
        run.add({
          pointer: `${row.pointer}/updated`,
          ruleId: 'stale-high-authority-context',
          message: `${row.band} item "${excerpt(row.id, 60)}" was last updated ${row.updated}, ${ageDays} days ago, past its reviewAfterDays of ${bandPolicy.reviewAfterDays}. High-authority context is obeyed whether or not it is still true; this one is due for review.`,
          suggestion: 'Review the document and refresh its "updated" date, or lower its band in the policy.',
        })
      }
    }

    const supported = resolveEvidence(run, row, byId, declaredIds)
    const components = {
      relevance: relevancePoints(row.relevance),
      freshness: freshnessPoints(ageDays, bandPolicy.freshnessHorizonDays),
      evidence: evidencePoints(supported, policy.evidenceSaturation),
    }
    const score = combine(components, policy.weights)
    state.ranking.push({
      id: excerpt(row.id, LOCATION_LIMIT),
      pointer: row.pointer,
      band: row.band,
      bandRank: row.bandRank,
      source: excerpt(row.source, LOCATION_LIMIT),
      score,
      components,
      evidenceResolved: supported,
      ageDays,
      stale: isHighAuthority(row.band) && bandPolicy.reviewAfterDays !== null && ageDays > bandPolicy.reviewAfterDays,
      explanation: excerpt(
        `${row.band} band (rank ${row.bandRank}) decides the position before any score; `
        + `relevance ${components.relevance}/${POINT_SCALE} x${policy.weights.relevance}, `
        + `freshness ${components.freshness}/${POINT_SCALE} x${policy.weights.freshness}, `
        + `evidence ${components.evidence}/${POINT_SCALE} x${policy.weights.evidence} `
        + `= ${score}/${POINT_SCALE}; ${supported} evidence link(s) resolved; `
        + describeFreshness(row, ageDays, bandPolicy),
        EXPLANATION_LIMIT,
      ),
    })
  }

  state.ranking.sort(compareRanked)
  for (const [position, entry] of state.ranking.entries()) entry.rank = position + 1

  if (state.bands.governing === 0 && state.scored > 0) {
    run.add({
      pointer: '/items',
      ruleId: 'no-governing-context',
      message: 'No item maps to the governing band, so this ranking has no instruction floor: the top of it is whatever scored highest.',
      suggestion: 'Include the governing instructions in the set, or map their source to the governing band.',
    })
  }

  return buildReport(run, state, limits)
}

/** The JSON report, exactly as it reaches stdout. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

/** 0 pass, 1 fail, 2 incomplete. An incomplete run is never a pass. */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

const SEVERITY_MARK = Object.freeze({ error: 'ERROR  ', warning: 'WARN   ', info: 'INFO   ' })

/** The human summary. It goes to stderr; stdout carries the JSON and nothing else. */
export function formatReport(report) {
  const lines = []
  lines.push(`${TOOL_ID}: ${report.status} (evaluated ${report.summary.today})`)
  lines.push(
    `  ${report.summary.items} item(s), ${report.summary.scored} scored, ${report.summary.unscored} unscored, `
    + `${report.summary.errors} error(s), ${report.summary.warnings} warning(s)`,
  )
  if (report.summary.rankingProduced) {
    for (const entry of report.ranking) {
      lines.push(`  ${String(entry.rank).padStart(3, ' ')}. [${entry.band}] ${entry.id} - ${entry.score}/${POINT_SCALE}${entry.stale ? ' (stale)' : ''}`)
    }
  } else {
    lines.push('  no ranking was produced: an item was not scored, so the ordering would have been missing a member')
  }
  for (const finding of report.findings) {
    const where = finding.location.pointer === '' ? finding.location.file : `${finding.location.file}${finding.location.pointer}`
    lines.push(`  ${SEVERITY_MARK[finding.severity]}${finding.ruleId}  ${where}`)
    lines.push(`         ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}
