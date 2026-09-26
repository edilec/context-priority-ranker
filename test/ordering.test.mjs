/**
 * Ordering is observable, so it is pinned behaviourally.
 *
 * The inputs are chosen so that code-unit order and ICU collation genuinely
 * disagree about them -- `Z` before `a`, `a-b` before `a_b`, `README` before
 * `assets` -- and the emitted order is asserted exactly. A test whose inputs
 * sort the same way under both orders cannot fail when someone substitutes a
 * collator, which is how this defect reached production twice in this catalog.
 *
 * Scanning the source for `.localeCompare(` would not do it either:
 * `Intl.Collator` produces identical drift with different source text.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { compareFindings, createFinding } from '../src/index.mjs'
import { fixture, governingItem, rank, workspace } from './support.mjs'

const TIED_IDS = ['a_b', 'assets', 'Z-item', 'a-item', 'README', 'a-b']
const EXPECTED_ORDER = ['README', 'Z-item', 'a-b', 'a-item', 'a_b', 'assets']

test('items tied on score are ordered by id in UTF-16 code units, not by collation', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    set: {
      items: TIED_IDS.map((id) => ({
        id, source: 'retrieved-web-page', relevance: 0.5, updated: '2026-09-01',
      })),
    },
  })

  const { code, report } = await rank(dir)
  assert.equal(code, 0)
  assert.deepEqual(report.ranking.map((entry) => entry.id), EXPECTED_ORDER)

  // Every score really is tied, so the id comparison is what decided the order.
  assert.equal(new Set(report.ranking.map((entry) => entry.score)).size, 1)

  // And the inputs really do discriminate: a collator disagrees with all of it.
  const collated = [...TIED_IDS].sort(new Intl.Collator('en').compare)
  assert.notDeepEqual(collated, EXPECTED_ORDER)
})

test('findings sort by pointer as a string, so /items/10 precedes /items/9', async (t) => {
  const dir = await workspace(t)
  const items = []
  for (let index = 0; index < 11; index += 1) {
    items.push(governingItem({ id: `policy-${index}`, relevance: 0.5, updated: '2026-09-01' }))
  }
  items[0].zzUnknown = 'zero'
  items[0].relevance = 5
  items[9].zzUnknown = 'nine'
  items[10].zzUnknown = 'ten'
  await fixture(dir, { set: { items } })

  const { code, report } = await rank(dir)
  assert.equal(code, 1)
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
    '/items/0/relevance',
    '/items/0/zzUnknown',
    '/items/10/zzUnknown',
    '/items/9/zzUnknown',
  ])

  // The emitted order is not the order the findings were produced in: the
  // unknown field on item 0 is detected before its relevance is examined, and
  // item 9 is compiled before item 10. Sorting is what put them here.
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), [
    'relevance-out-of-range', 'item-unknown-field', 'item-unknown-field', 'item-unknown-field',
  ])
})

test('two findings at one pointer are ordered by rule id, then by message', () => {
  const file = 'context-set.json'
  const pointer = '/items/0'
  const rows = [
    createFinding({ file, pointer, ruleId: 'untrusted-authority-claim', message: 'b' }),
    createFinding({ file, pointer, ruleId: 'evidence-link-self', message: 'z' }),
    createFinding({ file, pointer, ruleId: 'untrusted-authority-claim', message: 'a' }),
  ]
  assert.deepEqual(
    [...rows].sort(compareFindings).map((finding) => `${finding.ruleId}:${finding.message}`),
    ['evidence-link-self:z', 'untrusted-authority-claim:a', 'untrusted-authority-claim:b'],
  )
})
