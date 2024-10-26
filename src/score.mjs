/**
 * The score: three components, each an integer on a 0-1000 scale, combined by
 * integer weights.
 *
 * Everything here is integer arithmetic over exactly representable values, and
 * no function reads a clock. The current date arrives as an argument, because a
 * score that silently depends on the day it was computed is not reproducible
 * and cannot be tested against a deadline it has not yet reached.
 *
 * The score never decides the ranking on its own. It orders items *within* one
 * authority band; the band comes first and no score crosses it.
 */

export const POINT_SCALE = 1000
const MS_PER_DAY = 86400000
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Parse a strict `YYYY-MM-DD` calendar date as UTC midnight.
 *
 * `Date.parse` accepts a great deal more than that, in ways that differ between
 * engines and that quietly reinterpret a typo: `2026-02-30` becomes 2 March in
 * a lenient parser, which makes a document look 30 days fresher than it is. The
 * round-trip check rejects it instead.
 */
export function parseCalendarDate(value) {
  if (typeof value !== 'string') return { ok: false }
  const match = CALENDAR_DATE.exec(value)
  if (match === null) return { ok: false }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false }
  const ms = Date.UTC(year, month - 1, day)
  const date = new Date(ms)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false }
  }
  return { ok: true, ms }
}

/** Whole days between two UTC midnights. Negative when `laterMs` precedes `earlierMs`. */
export function dayDifference(earlierMs, laterMs) {
  return Math.round((laterMs - earlierMs) / MS_PER_DAY)
}

/**
 * The calendar date a run is evaluated against, in UTC.
 *
 * The clock is an argument with a default, never an unconditional read: a test
 * steps it past a review interval, and a caller that wants a fixed evaluation
 * date passes one. UTC rather than local time because a report that changes
 * band membership when the machine moves timezone is not deterministic.
 */
export function todayFromClock(now = Date.now) {
  const ms = typeof now === 'function' ? now() : now
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) throw new TypeError('The clock did not produce a usable instant')
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Declared retrieval relevance, 0..1, on the point scale. */
export function relevancePoints(relevance) {
  return Math.round(relevance * POINT_SCALE)
}

/**
 * Freshness on the point scale: full marks on the day it was written, nothing
 * once it is older than the band's horizon, linear in between.
 *
 * A document dated in the future scores full marks and is reported separately.
 * Treating it as infinitely fresh is the conservative reading -- the penalty
 * would be arbitrary -- and the finding is what tells a reader the date is
 * wrong.
 */
export function freshnessPoints(ageDays, horizonDays) {
  if (!Number.isInteger(horizonDays) || horizonDays < 1) throw new TypeError('The freshness horizon must be a positive integer')
  if (ageDays <= 0) return POINT_SCALE
  if (ageDays >= horizonDays) return 0
  return Math.round((POINT_SCALE * (horizonDays - ageDays)) / horizonDays)
}

/** Evidence support on the point scale: resolved links, saturating. */
export function evidencePoints(supported, saturation) {
  if (!Number.isInteger(saturation) || saturation < 1) throw new TypeError('The evidence saturation must be a positive integer')
  if (supported <= 0) return 0
  if (supported >= saturation) return POINT_SCALE
  return Math.round((POINT_SCALE * supported) / saturation)
}

/** The weighted mean of the three components, on the point scale. */
export function combine(components, weights) {
  const total = weights.relevance + weights.freshness + weights.evidence
  if (total <= 0) throw new TypeError('The weights must sum to a positive integer')
  const weighted = components.relevance * weights.relevance
    + components.freshness * weights.freshness
    + components.evidence * weights.evidence
  return Math.round(weighted / total)
}
