/**
 * The shipped examples run, and they produce what the README says they do.
 *
 * One of them fails on purpose. An examples directory where everything passes
 * teaches nothing about what a failure looks like, and it lets a tool that has
 * stopped failing at all keep shipping.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
  // Two: the expired governing baseline and the trusted runbook. An expired
  // item is past its review interval by construction, so it counts in both.
  assert.equal(report.summary.stale, 2)
  assert.equal(report.summary.stale, report.ranking.filter((entry) => entry.stale).length)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'expired-high-authority-context'))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'stale-high-authority-context'))

  // Every item still scored, so the ranking is emitted alongside the failure.
  assert.equal(report.summary.rankingProduced, true)
  assert.equal(report.ranking[0].id, 'security-baseline')
})


/** Ranking and finding-header lines from a human summary, exactly as written. */
function summaryLines(text) {
  return text.split('\n').filter((line) => /^\s*\d+\. \[/.test(line) || /^\s*(ERROR|WARN|INFO) {2}/.test(line))
}

/**
 * The README's example block is output, and output is a contract.
 *
 * It showed one authority-claim warning where the tool emits two, while its own
 * JSON sample two sections later said `"warnings": 2`. Comparing the block
 * against a real run is the only version of this claim that cannot drift.
 *
 * "Exactly" is meant literally, which it was not before: the comparison used to
 * collapse every run of whitespace, so the block could indent its ranking lines
 * differently from the tool and still pass a test whose name promised they
 * matched. Lines are compared character for character now. What the block
 * leaves out -- the status header, the counts, and the explanation under each
 * finding -- it leaves out whole, and the assertion below is written as
 * "a subsequence, in order" so that eliding a line is allowed and rewriting one
 * is not.
 */
test('the README prints the passing example\'s summary lines exactly as the tool emits them', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const result = await run(['--root', ASSEMBLED, '--policy', POLICY, '--today', '2026-09-14'])

  const documented = summaryLines(readme)
  const emitted = summaryLines(result.stderr)

  assert.equal(emitted.length, 7, 'the example stopped producing five ranked items and two warnings')
  assert.equal(documented.length, 7, 'README.md no longer shows the whole summary block')

  // Every documented line is an emitted line, byte for byte, in the emitted
  // order. deepEqual would say the same here; walking it states which line
  // differs when one does.
  let next = 0
  for (const line of documented) {
    const found = emitted.indexOf(line, next)
    assert.notEqual(found, -1, `README.md shows a line the CLI does not write: ${JSON.stringify(line)}`)
    next = found + 1
  }
  assert.deepEqual(documented, emitted, 'README.md shows a different summary from the CLI')
})
