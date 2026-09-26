/**
 * An evidence link that did not resolve says which of the two things happened.
 *
 * "Names no item in this context set" is a statement of absence, and it was
 * being made about ids that were present and merely unscored: any unknown
 * field, reserved field, bad relevance or unmapped source on the cited item
 * removed it from the resolution map, and the citing item's finding then said
 * it did not exist. That is the shape this catalog forbids -- reporting "no X
 * was supplied" when an X was supplied and could not be read.
 *
 * Both directions are pinned here. A rule that said "unknown" for every
 * unresolved link would be as wrong as the one that said "absent" for every
 * one, so the genuinely-dangling case has to keep its own message and its own
 * severity.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { fixture, findingFor, governingItem, rank, ruleIds, untrustedItem, workspace } from './support.mjs'

test('a link to an id nothing declares is reported as absent, and only then', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem({ evidence: ['never-declared'] })] } })
  const result = await rank(dir)

  const finding = findingFor(result.report, 'evidence-link-unresolved')
  assert.equal(finding.severity, 'warning')
  assert.match(finding.message, /names no item in this context set/)
  assert.equal(result.report.status, 'pass')
  assert.equal(result.code, 0)
})

/**
 * One case per reason an item can fail to score, because the suppression was
 * not specific to any of them: the citing item's finding came out identical
 * whichever one it was.
 */
const UNSCORED = [
  { why: 'an unknown field', patch: { misspelt: 'x' }, ruleId: 'item-unknown-field' },
  { why: 'a reserved field', patch: { band: 'governing' }, ruleId: 'item-declares-authority' },
  { why: 'a relevance out of range', patch: { relevance: 7 }, ruleId: 'relevance-out-of-range' },
  { why: 'an unmapped source', patch: { source: 'not-in-the-policy' }, ruleId: 'authority-unknown' },
]

for (const entry of UNSCORED) {
  test(`a link to an item present but unscored for ${entry.why} is unknown support, not absence`, async (t) => {
    const dir = await workspace(t)
    await fixture(dir, {
      set: {
        items: [
          governingItem({ evidence: ['cited-item'] }),
          governingItem({ id: 'cited-item', ...entry.patch }),
        ],
      },
    })
    const result = await rank(dir)
    const ids = ruleIds(result.report)

    assert.ok(ids.includes(entry.ruleId), `the cited item's own finding is missing: ${ids.join(', ')}`)
    assert.ok(
      !ids.includes('evidence-link-unresolved'),
      'the report called a present item absent',
    )

    const finding = findingFor(result.report, 'evidence-link-unscored')
    assert.ok(finding !== undefined, `expected evidence-link-unscored; got ${ids.join(', ')}`)
    assert.equal(finding.severity, 'error')
    assert.equal(finding.location.pointer, '/items/0/evidence/0')
    assert.match(finding.message, /names the item at \/items\/1/)
    assert.doesNotMatch(finding.message, /names no item/)

    // Unknown support is not a verdict about the citation, so the run says so
    // rather than leaving the reader to infer it from the other finding.
    assert.equal(result.report.status, 'incomplete')
    assert.equal(result.code, 2)
    assert.deepEqual(result.report.ranking, [])
  })
}

test('a resolvable link is still counted, so the distinction has not eaten the feature', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    set: { items: [governingItem({ evidence: ['retrieved-page'] }), untrustedItem()] },
  })
  const result = await rank(dir)

  assert.equal(result.code, 0)
  assert.equal(result.report.status, 'pass')
  assert.equal(result.report.ranking[0].evidenceResolved, 1)
  assert.ok(!ruleIds(result.report).includes('evidence-link-unresolved'))
  assert.ok(!ruleIds(result.report).includes('evidence-link-unscored'))
})

test('a duplicate id resolves to the first item rather than being called unscored', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    set: {
      items: [
        governingItem({ evidence: ['twin'] }),
        governingItem({ id: 'twin' }),
        governingItem({ id: 'twin' }),
      ],
    },
  })
  const result = await rank(dir)

  assert.ok(ruleIds(result.report).includes('item-id-duplicate'))
  assert.ok(!ruleIds(result.report).includes('evidence-link-unresolved'))
  assert.ok(!ruleIds(result.report).includes('evidence-link-unscored'))
})
