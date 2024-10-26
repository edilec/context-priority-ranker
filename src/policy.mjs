/**
 * The ranking policy: what authority a source carries, how fast each band goes
 * stale, and how the three configurable score components are weighted.
 *
 * The policy is operator-controlled configuration. The context set is data.
 * That split is the whole point of this tool and it is enforced here: the band
 * an item lands in is decided by mapping the item's declared `source` through
 * `authority`, a map that lives in the policy file. Nothing an item says about
 * itself reaches this module.
 */

import { byCodeUnit, excerpt, isPlainObject } from './text.mjs'

/**
 * The authority bands, most authoritative first. The index is the band rank.
 *
 * This order is fixed in the source and there is no configuration key that
 * changes it. An ordering that a policy file could rewrite is an ordering a
 * retrieved document could argue its way up, because the policy file is exactly
 * the kind of thing an agent is asked to "just update". Ranking is
 * lexicographic on (band rank, then score), so no score a lower band can reach
 * lifts it above a higher one.
 */
export const BAND_ORDER = Object.freeze(['governing', 'trusted', 'reference', 'untrusted'])

/** Bands whose staleness is a reviewable fact rather than a scoring penalty. */
export const HIGH_AUTHORITY_BANDS = Object.freeze(['governing', 'trusted'])

/** Position of a band in BAND_ORDER; -1 for a name that is not a band. */
export function bandRank(band) {
  return BAND_ORDER.indexOf(band)
}

export function isHighAuthority(band) {
  return HIGH_AUTHORITY_BANDS.includes(band)
}

/**
 * Fields an item may not carry.
 *
 * `tier`, `authority`, `band`, `rank`, `priority` and `score` are the outputs of
 * this tool, not inputs to it. A context set assembled by an agent from
 * retrieved material would otherwise be able to nominate its own band, which is
 * the single failure this tool exists to prevent. An item carrying one is a
 * hard error rather than a silently ignored key, because silently ignoring it
 * leaves the author believing it worked.
 */
export const RESERVED_ITEM_FIELDS = Object.freeze(['authority', 'band', 'bandRank', 'priority', 'rank', 'score', 'tier'])

/** Members an item may carry. Anything else is a typo or a smuggled field. */
export const ALLOWED_ITEM_FIELDS = Object.freeze(['evidence', 'id', 'relevance', 'source', 'text', 'title', 'updated'])

/**
 * The shipped policy. Every value is overridable through the policy file except
 * BAND_ORDER, which is not a policy value at all.
 *
 * The day counts are defaults, not findings of fact: 90 days for a governing
 * document is a working default for a quarterly review cycle, and an operator
 * whose cycle differs sets their own. What is not overridable is that
 * `reviewAfterDays` exists for a high-authority band -- see `validatePolicy`.
 */
export const DEFAULT_POLICY = Object.freeze({
  authority: Object.freeze({}),
  weights: Object.freeze({ relevance: 5, freshness: 3, evidence: 2 }),
  evidenceSaturation: 3,
  bands: Object.freeze({
    governing: Object.freeze({ reviewAfterDays: 90, expireAfterDays: 365, freshnessHorizonDays: 365 }),
    trusted: Object.freeze({ reviewAfterDays: 180, expireAfterDays: null, freshnessHorizonDays: 365 }),
    reference: Object.freeze({ reviewAfterDays: null, expireAfterDays: null, freshnessHorizonDays: 730 }),
    untrusted: Object.freeze({ reviewAfterDays: null, expireAfterDays: null, freshnessHorizonDays: 365 }),
  }),
})

const ALLOWED_POLICY_KEYS = Object.freeze(['authority', 'bands', 'evidenceSaturation', 'limits', 'weights'])
const ALLOWED_BAND_KEYS = Object.freeze(['expireAfterDays', 'freshnessHorizonDays', 'reviewAfterDays'])
const WEIGHT_KEYS = Object.freeze(['evidence', 'freshness', 'relevance'])

const MAX_SOURCE_NAME = 120
const MAX_SOURCES = 200
const MAX_DAYS = 36500

function fail(message) {
  throw new TypeError(message)
}

function positiveInteger(value, label, maximum = MAX_DAYS) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    fail(`${label} must be an integer between 1 and ${maximum}`)
  }
  return value
}

/**
 * Turn a parsed policy document into a frozen policy, or throw.
 *
 * Every rejection here is a *configuration* error: the run has no subject yet,
 * so the CLI prints the message on stderr, writes nothing to stdout and exits
 * 2. Unknown keys are refused rather than ignored, because a one-character typo
 * in `reviewAfterDays` would otherwise turn a real staleness finding into a
 * green run -- the exact defect this catalog has already shipped once.
 */
export function validatePolicy(raw = {}) {
  if (!isPlainObject(raw)) fail('The policy must be a JSON object')
  for (const key of Object.keys(raw).sort(byCodeUnit)) {
    if (!ALLOWED_POLICY_KEYS.includes(key)) {
      fail(`Unknown policy key "${excerpt(key, 60)}"; known keys are ${ALLOWED_POLICY_KEYS.join(', ')}`)
    }
  }

  if (!isPlainObject(raw.authority)) fail('policy.authority must be an object mapping each source name to a band')
  const sources = Object.keys(raw.authority).sort(byCodeUnit)
  if (sources.length === 0) fail('policy.authority must map at least one source name to a band')
  if (sources.length > MAX_SOURCES) fail(`policy.authority may map at most ${MAX_SOURCES} source names`)
  const authority = {}
  for (const source of sources) {
    if (source.length === 0 || source.length > MAX_SOURCE_NAME) {
      fail(`policy.authority source names must be 1-${MAX_SOURCE_NAME} characters`)
    }
    const band = raw.authority[source]
    if (typeof band !== 'string' || bandRank(band) < 0) {
      fail(`policy.authority["${excerpt(source, 60)}"] must be one of ${BAND_ORDER.join(', ')}`)
    }
    authority[source] = band
  }

  const weights = { ...DEFAULT_POLICY.weights }
  if (raw.weights !== undefined) {
    if (!isPlainObject(raw.weights)) fail('policy.weights must be an object')
    for (const key of Object.keys(raw.weights).sort(byCodeUnit)) {
      if (!WEIGHT_KEYS.includes(key)) {
        fail(`Unknown policy.weights key "${excerpt(key, 60)}"; known keys are ${WEIGHT_KEYS.join(', ')}`)
      }
      const value = raw.weights[key]
      if (!Number.isInteger(value) || value < 0 || value > 1000) {
        fail(`policy.weights.${key} must be an integer between 0 and 1000`)
      }
      weights[key] = value
    }
    if (WEIGHT_KEYS.every((key) => weights[key] === 0)) fail('policy.weights must leave at least one component non-zero')
  }

  let evidenceSaturation = DEFAULT_POLICY.evidenceSaturation
  if (raw.evidenceSaturation !== undefined) {
    evidenceSaturation = positiveInteger(raw.evidenceSaturation, 'policy.evidenceSaturation', 100)
  }

  const bands = {}
  for (const band of BAND_ORDER) bands[band] = { ...DEFAULT_POLICY.bands[band] }
  if (raw.bands !== undefined) {
    if (!isPlainObject(raw.bands)) fail('policy.bands must be an object')
    for (const band of Object.keys(raw.bands).sort(byCodeUnit)) {
      if (bandRank(band) < 0) {
        fail(`Unknown band "${excerpt(band, 60)}" in policy.bands; the bands are ${BAND_ORDER.join(', ')}`)
      }
      const declared = raw.bands[band]
      if (!isPlainObject(declared)) fail(`policy.bands.${band} must be an object`)
      for (const key of Object.keys(declared).sort(byCodeUnit)) {
        if (!ALLOWED_BAND_KEYS.includes(key)) {
          fail(`Unknown policy.bands.${band} key "${excerpt(key, 60)}"; known keys are ${ALLOWED_BAND_KEYS.join(', ')}`)
        }
      }
      if (declared.reviewAfterDays !== undefined) {
        bands[band].reviewAfterDays = declared.reviewAfterDays === null
          ? null
          : positiveInteger(declared.reviewAfterDays, `policy.bands.${band}.reviewAfterDays`)
      }
      if (declared.expireAfterDays !== undefined) {
        bands[band].expireAfterDays = declared.expireAfterDays === null
          ? null
          : positiveInteger(declared.expireAfterDays, `policy.bands.${band}.expireAfterDays`)
      }
      if (declared.freshnessHorizonDays !== undefined) {
        bands[band].freshnessHorizonDays = positiveInteger(
          declared.freshnessHorizonDays, `policy.bands.${band}.freshnessHorizonDays`,
        )
      }
    }
  }

  for (const band of BAND_ORDER) {
    const policy = bands[band]
    /**
     * A high-authority band must keep a review interval.
     *
     * Letting a policy file set `governing.reviewAfterDays: null` would switch
     * off the one finding that says a rule everyone is still obeying was
     * written for a system that has since changed. The band whose staleness
     * matters most would be the easiest to silence, and silencing it would look
     * like configuration rather than like a decision.
     */
    if (isHighAuthority(band) && policy.reviewAfterDays === null) {
      fail(`policy.bands.${band}.reviewAfterDays must be a positive integer; a high-authority band cannot opt out of review`)
    }
    if (policy.expireAfterDays !== null && policy.reviewAfterDays !== null
      && policy.expireAfterDays < policy.reviewAfterDays) {
      fail(`policy.bands.${band}.expireAfterDays must not be earlier than reviewAfterDays`)
    }
    bands[band] = Object.freeze(policy)
  }

  return Object.freeze({
    authority: Object.freeze(authority),
    weights: Object.freeze(weights),
    evidenceSaturation,
    bands: Object.freeze(bands),
  })
}
