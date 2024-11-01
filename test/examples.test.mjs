/**
 * The shipped examples run, and they produce what the README says they do.
 *
 * One of them fails on purpose. An examples directory where everything passes
 * teaches nothing about what a failure looks like, and it lets a tool that has
 * stopped failing at all keep shipping.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { run } from './support.mjs'

const POLICY = fileURLToPath(new URL('../examples/policy.json', import.meta.url))
const ASSEMBLED = fileURLToPath(new URL('../examples/assembled', import.meta.url))
const STALE = fileURLToPath(new URL('../examples/stale', import.meta.url))

test('the assembled example passes, and the untrusted page ranks last', async () => {
  const result = await run(['--root', ASSEMBLED, '--policy', POLICY, '--today', '2026-09-14'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.rankingProduced, true)

  const first = report.ranking[0]
  const last = report.ranking.at(-1)
  assert.equal(first.id, 'operating-policy')
  assert.equal(first.band, 'governing')
  assert.equal(last.id, 'vendor-status-page')
  assert.equal(last.band, 'untrusted')
  assert.ok(last.score > first.score, 'the example is only interesting while the untrusted page outscores the policy')

  const claim = report.findings.find((finding) => finding.ruleId === 'untrusted-authority-claim')
  assert.equal(claim.severity, 'warning')
})

test('the stale example fails on an expired governing document', async () => {
  const result = await run(['--root', STALE, '--policy', POLICY, '--today', '2026-09-14'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.expired, 1)
  assert.equal(report.summary.stale, 1)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'expired-high-authority-context'))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'stale-high-authority-context'))

  // Every item still scored, so the ranking is emitted alongside the failure.
  assert.equal(report.summary.rankingProduced, true)
  assert.equal(report.ranking[0].id, 'security-baseline')
})
