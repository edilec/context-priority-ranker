/**
 * A credential that arrives in a context set does not leave in the report.
 *
 * A context set is assembled from retrieved material, pasted commands and
 * whatever an agent had in hand, and this tool reproduces parts of it: an item
 * id and a source name reach `ranking` and the human summary, and an unmapped
 * source reaches a finding's message *and* its evidence. The house contract
 * says evidence is redacted and that a report never emits a credential, so the
 * redaction lives at `excerpt` -- the one boundary every untrusted string
 * already passes through -- rather than at the routes somebody remembered.
 *
 * Two halves, and each is useless alone. A redactor that replaced everything
 * would pass every leak test while making the ranking unreadable, so the
 * ordinary-value cases are as load-bearing as the leak cases.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { excerpt, redactCredentials } from '../src/index.mjs'
import { POLICY_NAME, fixture, governingItem, rank, run, workspace } from './support.mjs'

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

test('a credential-shaped item id reaches neither stream, and the placeholder names the shape', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem({ id: AWS_KEY, updated: '2024-01-01' })] } })
  const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])

  assert.ok(!result.stdout.includes(AWS_KEY), 'the access key reached stdout')
  assert.ok(!result.stderr.includes(AWS_KEY), 'the access key reached the human summary')
  const report = JSON.parse(result.stdout)
  assert.equal(report.ranking[0].id, '[redacted aws-access-key-id]')
  assert.ok(
    report.findings.some((finding) => finding.message.includes('[redacted aws-access-key-id]')),
    'the expired-context message named the item without the placeholder',
  )
})

test('a credential-shaped source reaches neither the message nor the evidence field', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem({ source: GITHUB_TOKEN })] } })
  const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])

  assert.ok(!result.stdout.includes(GITHUB_TOKEN), 'the token reached stdout')
  assert.ok(!result.stderr.includes(GITHUB_TOKEN), 'the token reached the human summary')
  const finding = JSON.parse(result.stdout).findings.find((entry) => entry.ruleId === 'authority-unknown')
  assert.ok(finding.message.includes('[redacted github-token]'))
  assert.ok(finding.evidence.includes('[redacted github-token]'))
})

test('a credential smuggled in as a field name is redacted out of the message and the pointer', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [{ ...governingItem(), [GITHUB_TOKEN]: 'x' }] } })
  const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])

  assert.ok(!result.stdout.includes(GITHUB_TOKEN), 'the token reached stdout through a field name')
  assert.ok(!result.stderr.includes(GITHUB_TOKEN), 'the token reached the human summary through a field name')
  const finding = JSON.parse(result.stdout).findings.find((entry) => entry.ruleId === 'item-unknown-field')
  assert.ok(finding.location.pointer.includes('[redacted github-token]'))
})

test('redaction happens before truncation, so no bound can cut a credential back into the report', () => {
  const padded = `${'x'.repeat(45)} ${AWS_KEY}`
  const rendered = excerpt(padded, 60)

  // Truncating first would leave "AKIAIOSFODNN" in the report, short enough
  // that the pattern no longer matches it and long enough to be the key.
  assert.ok(rendered.includes('[redacted aws'), `redaction did not see the whole string: ${rendered}`)
  assert.ok(!rendered.includes('AKIAIOSFODNN'))
})

test('ordinary values pass through untouched, so the redactor is not simply eating the report', async (t) => {
  assert.equal(redactCredentials('operating-policy'), 'operating-policy')
  assert.equal(redactCredentials('docs/retention-runbook.md'), 'docs/retention-runbook.md')
  assert.equal(redactCredentials('AKIA'), 'AKIA')
  assert.equal(excerpt('a perfectly ordinary title'), 'a perfectly ordinary title')

  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem()] } })
  const result = await rank(dir)

  assert.equal(result.code, 0)
  assert.equal(result.report.ranking[0].id, 'operating-policy')
  assert.equal(result.report.ranking[0].source, 'operator-instruction')
  assert.ok(result.stderr.includes('operating-policy'))
})
