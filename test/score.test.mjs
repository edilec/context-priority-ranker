/** The scoring arithmetic, which is integer-only and clock-free. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  POINT_SCALE, combine, dayDifference, evidencePoints, freshnessPoints, parseCalendarDate, relevancePoints,
} from '../src/index.mjs'

test('freshness is full on the day, zero at the horizon, and linear between', () => {
  assert.equal(freshnessPoints(0, 100), POINT_SCALE)
  assert.equal(freshnessPoints(-5, 100), POINT_SCALE, 'a future date is not penalised, it is reported')
  assert.equal(freshnessPoints(50, 100), 500)
  assert.equal(freshnessPoints(99, 100), 10)
  assert.equal(freshnessPoints(100, 100), 0)
  assert.equal(freshnessPoints(1000, 100), 0)
  assert.throws(() => freshnessPoints(1, 0), /positive integer/)
})

test('evidence support saturates and never goes negative', () => {
  assert.equal(evidencePoints(0, 3), 0)
  assert.equal(evidencePoints(1, 3), 333)
  assert.equal(evidencePoints(3, 3), POINT_SCALE)
  assert.equal(evidencePoints(30, 3), POINT_SCALE)
  assert.equal(evidencePoints(-1, 3), 0)
})

test('relevance maps 0..1 onto the point scale', () => {
  assert.equal(relevancePoints(0), 0)
  assert.equal(relevancePoints(0.5), 500)
  assert.equal(relevancePoints(1), POINT_SCALE)
  assert.equal(relevancePoints(0.3333), 333)
})

test('the weighted mean respects the weights', () => {
  const components = { relevance: 1000, freshness: 0, evidence: 0 }
  assert.equal(combine(components, { relevance: 1, freshness: 1, evidence: 0 }), 500)
  assert.equal(combine(components, { relevance: 1, freshness: 0, evidence: 0 }), 1000)
  assert.equal(combine(components, { relevance: 0, freshness: 1, evidence: 1 }), 0)
  assert.equal(combine({ relevance: 400, freshness: 900, evidence: 300 }, { relevance: 5, freshness: 3, evidence: 2 }), 530)
  assert.throws(() => combine(components, { relevance: 0, freshness: 0, evidence: 0 }), /positive integer/)
})

test('dates are parsed strictly, in UTC, and 30 February is refused', () => {
  assert.equal(parseCalendarDate('2026-09-14').ms, Date.UTC(2026, 8, 14))
  assert.equal(parseCalendarDate('2026-02-30').ok, false)
  assert.equal(parseCalendarDate('2026-13-01').ok, false)
  assert.equal(parseCalendarDate('2026-9-14').ok, false)
  assert.equal(parseCalendarDate('2026-09-14T00:00:00Z').ok, false)
  assert.equal(parseCalendarDate(20260914).ok, false)
  assert.equal(parseCalendarDate('2024-02-29').ok, true, 'a leap day is a real date')
})

test('day differences are whole days and survive a daylight-saving boundary', () => {
  assert.equal(dayDifference(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2)), 1)
  assert.equal(dayDifference(Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1)), 31)
  assert.equal(dayDifference(Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 1)), -1)
})
