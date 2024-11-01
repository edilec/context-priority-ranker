/**
 * Unknown is never a pass.
 *
 * Every case here is a fact the tool wanted about the subject and did not get.
 * All of them must produce `status: "incomplete"`, exit 2, and an empty
 * ranking -- never a shorter ranking over the part that was readable, and never
 * a default band standing in for one that was never determined.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { POLICY_NAME, fixture, governingItem, run, untrustedItem, workspace } from './support.mjs'

const UNKNOWN_CASES = [
  {
    name: 'a source the policy does not map',
    ruleId: 'authority-unknown',
    set: { items: [governingItem(), untrustedItem({ source: 'somewhere-else' })] },
  },
  {
    name: 'an item with no relevance',
    ruleId: 'relevance-missing',
    set: { items: [{ id: 'x', source: 'operator-instruction', updated: '2026-09-01' }] },
  },
  {
    name: 'an undated item',
    ruleId: 'freshness-unknown',
    set: { items: [{ id: 'x', source: 'operator-instruction', relevance: 0.5 }] },
  },
  {
    name: 'an item dated 30 February',
    ruleId: 'updated-invalid',
    set: { items: [governingItem({ updated: '2026-02-30' })] },
  },
  {
    name: 'a schema version this build does not understand',
    ruleId: 'schema-version-unsupported',
    set: { schemaVersion: '9', items: [governingItem()] },
  },
]

for (const entry of UNKNOWN_CASES) {
  test(`${entry.name} is incomplete, not a pass and not a partial ranking`, async (t) => {
    const dir = await workspace(t)
    await fixture(dir, { set: entry.set })
    const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])
    const report = JSON.parse(result.stdout)

    assert.equal(report.status, 'incomplete')
    assert.equal(result.code, 2)
    assert.deepEqual(report.ranking, [])
    assert.equal(report.summary.rankingProduced, false)
    assert.equal(report.summary.ranked, 0)

    const finding = report.findings.find((row) => row.ruleId === entry.ruleId)
    assert.ok(finding !== undefined, `expected ${entry.ruleId}`)

    // The incomplete flag is one defence; the error severity is the other. If
    // the flag were deleted the status would fall to "fail", never to "pass" --
    // and the exit code would change from 2 to 1, which is what the flag's own
    // test catches.
    assert.equal(finding.severity, 'error')
    assert.ok(report.summary.errors > 0)
  })
}

test('an item whose source is unmapped is not quietly treated as untrusted', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [untrustedItem({ source: 'retrieved-web-pages', relevance: 1 })] } })
  const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)

  const finding = report.findings.find((row) => row.ruleId === 'authority-unknown')
  // The message says what actually happened. "No source was supplied" would be
  // false: a source was supplied and could not be resolved, which is a
  // different fact with a different fix.
  assert.match(finding.message, /maps no band to source "retrieved-web-pages"/)
  assert.ok(!/declares no "source"/.test(finding.message))
  assert.equal(report.summary.bands.untrusted, 0)
  assert.equal(report.summary.scored, 0)
  assert.equal(report.summary.unscored, 1)
})

test('one unreadable item does not leave the rest ranked', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    set: {
      items: [
        governingItem({ id: 'good-one' }),
        governingItem({ id: 'good-two', relevance: 0.9 }),
        { id: 'undated', source: 'repository-doc', relevance: 0.5 },
      ],
    },
  })
  const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)

  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(report.summary.scored, 2)
  assert.equal(report.summary.unscored, 1)
  assert.deepEqual(report.ranking, [], 'an ordering missing a member is not a shorter ordering')
})

test('incomplete outranks fail: a run with both is reported incomplete', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    set: {
      items: [
        governingItem({ id: 'expired', updated: '2023-01-01' }),
        { id: 'undated', source: 'repository-doc', relevance: 0.5 },
      ],
    },
  })
  const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)

  assert.ok(report.findings.some((row) => row.ruleId === 'expired-high-authority-context'))
  assert.ok(report.findings.some((row) => row.ruleId === 'freshness-unknown'))
  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
})
