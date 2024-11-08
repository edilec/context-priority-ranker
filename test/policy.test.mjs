/**
 * The policy is operator configuration and the context set is data. Everything
 * that would blur that line is refused here, before any evidence is gathered,
 * and refusing means an empty stdout and exit 2.
 */

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { BAND_ORDER, loadPolicyFile, validatePolicy } from '../src/index.mjs'
import { BASE_POLICY, POLICY_NAME, fixture, governingItem, policyWith, run, workspace } from './support.mjs'

test('the band order is not a policy value and cannot be supplied as one', () => {
  assert.deepEqual([...BAND_ORDER], ['governing', 'trusted', 'reference', 'untrusted'])
  assert.throws(
    () => validatePolicy({ ...BASE_POLICY, bandOrder: ['untrusted', 'governing'] }),
    /Unknown policy key "bandOrder"/,
  )
  assert.throws(
    () => validatePolicy({ ...BASE_POLICY, bands: { supreme: { freshnessHorizonDays: 1 } } }),
    /Unknown band "supreme"/,
  )
})

test('a policy that maps nothing, or maps to a band that does not exist, is refused', () => {
  assert.throws(() => validatePolicy({}), /policy.authority must be an object/)
  assert.throws(() => validatePolicy({ authority: {} }), /at least one source/)
  assert.throws(() => validatePolicy({ authority: { web: 'trustworthy' } }), /must be one of governing, trusted/)
})

test('mistyped policy keys are refused rather than ignored', () => {
  assert.throws(() => validatePolicy({ ...BASE_POLICY, weight: { relevance: 1 } }), /Unknown policy key "weight"/)
  assert.throws(
    () => validatePolicy({ ...BASE_POLICY, weights: { relevence: 1 } }),
    /Unknown policy.weights key "relevence"/,
  )
  const bands = { governing: { reviewAfterDay: 30 } }
  assert.throws(
    () => validatePolicy({ ...BASE_POLICY, bands }),
    /Unknown policy.bands.governing key "reviewAfterDay"/,
  )
})

/**
 * `limits` was listed as a known policy key and read by nothing, so a policy
 * file could declare `"limits": {"maxItems": 1}` and be accepted in silence
 * while the run used the defaults -- and the refusal message for a real typo
 * advertised the key. This is the behavioural pin: the refusal, through the
 * real CLI, with the empty stdout that a configuration error owes.
 */
test('a policy that declares limits is refused, not accepted and ignored', async (t) => {
  assert.throws(
    () => validatePolicy({ ...BASE_POLICY, limits: { maxItems: 1 } }),
    /Policy key "limits" is not read by this tool/,
  )
  assert.throws(() => validatePolicy({ ...BASE_POLICY, limits: 'nonsense' }), /not read by this tool/)
  let typoMessage = ''
  try {
    validatePolicy({ ...BASE_POLICY, limitz: 1 })
  } catch (error) {
    typoMessage = error.message
  }
  assert.match(typoMessage, /Unknown policy key "limitz"/)
  assert.ok(!typoMessage.includes('limits'), 'the unknown-key message still advertises limits as a known key')

  const dir = await workspace(t)
  await fixture(dir, {
    policy: { ...BASE_POLICY, limits: { maxItems: 1, utterNonsense: true } },
    set: { items: [governingItem(), governingItem({ id: 'second' })] },
  })
  const result = await run(['--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14'])

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'a configuration error never had a subject to report about')
  assert.match(result.stderr, /limits are command-line options/)
})

test('the limits that do exist are reached from the command line, not from the policy', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem(), governingItem({ id: 'second' })] } })
  const result = await run([
    '--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14', '--max-items', '1',
  ])

  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'too-many-items'))
})

test('weights and intervals are checked for sense', () => {
  assert.throws(
    () => validatePolicy({ ...BASE_POLICY, weights: { relevance: 0, freshness: 0, evidence: 0 } }),
    /at least one component non-zero/,
  )
  assert.throws(() => validatePolicy({ ...BASE_POLICY, weights: { relevance: -1 } }), /between 0 and 1000/)
  assert.throws(() => validatePolicy({ ...BASE_POLICY, evidenceSaturation: 0 }), /between 1 and 100/)

  const shortExpiry = policyWith()
  shortExpiry.bands.governing = { reviewAfterDays: 90, expireAfterDays: 30, freshnessHorizonDays: 365 }
  assert.throws(() => validatePolicy(shortExpiry), /expireAfterDays must not be earlier/)
})

test('a high-authority band cannot opt out of review, a low-authority one may', () => {
  const noTrustedReview = policyWith()
  noTrustedReview.bands.trusted.reviewAfterDays = null
  assert.throws(() => validatePolicy(noTrustedReview), /policy.bands.trusted.reviewAfterDays/)

  const noReferenceReview = policyWith()
  noReferenceReview.bands.reference.reviewAfterDays = null
  assert.doesNotThrow(() => validatePolicy(noReferenceReview))
})

test('an unreadable or unparseable policy file is a configuration error with an empty stdout', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem()] } })

  const missing = await run(['--root', dir, '--policy', join(dir, 'absent.json')])
  assert.equal(missing.code, 2)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /--policy could not be read/)

  await writeFile(join(dir, 'broken.json'), '{ "authority": ')
  const broken = await run(['--root', dir, '--policy', join(dir, 'broken.json')])
  assert.equal(broken.code, 2)
  assert.equal(broken.stdout, '')
  assert.match(broken.stderr, /--policy is not valid JSON/)
})

test('loadPolicyFile returns a frozen, defaulted policy', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, POLICY_NAME), JSON.stringify({ authority: { desk: 'governing' } }))
  const policy = await loadPolicyFile(join(dir, POLICY_NAME))

  assert.equal(policy.authority.desk, 'governing')
  assert.equal(policy.weights.relevance, 5)
  assert.equal(policy.bands.governing.reviewAfterDays, 90)
  assert.ok(Object.isFrozen(policy))
  assert.throws(() => { policy.weights.relevance = 1000 }, TypeError)
})
