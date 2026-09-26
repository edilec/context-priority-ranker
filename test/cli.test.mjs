/**
 * The command line surface: help, version, the two shapes of exit 2, and the
 * promise that stdout carries the JSON report and nothing else.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { POLICY_NAME, fixture, governingItem, run, workspace } from './support.mjs'

test('--help explains the guarantee, the streams and the exit codes, and exits 0', async () => {
  const result = await run(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /relevance cannot buy authority/)
  assert.match(result.stdout, /governing > trusted > reference > untrusted/)
  assert.match(result.stdout, /stdout {2}the JSON report only/)
  assert.match(result.stdout, /Exit codes/)
  assert.match(result.stdout, /writes no file anywhere/)
})

test('--version prints a version and exits 0', async () => {
  const result = await run(['--version'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/)
})

test('an unknown option is refused, with the help on stderr and nothing on stdout', async () => {
  const result = await run(['--roooot', '/tmp'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--roooot"/)
})

test('a repeated flag is a configuration error, not a silent last-wins', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem()] } })
  const result = await run([
    '--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14', '--today', '2020-01-01',
  ])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--today was given more than once/)
})

test('--root and --policy are both required', async () => {
  const withoutRoot = await run(['--policy', '/tmp/policy.json'])
  assert.equal(withoutRoot.code, 2)
  assert.equal(withoutRoot.stdout, '')
  assert.match(withoutRoot.stderr, /--root is required/)

  const withoutPolicy = await run(['--root', '/tmp'])
  assert.equal(withoutPolicy.code, 2)
  assert.equal(withoutPolicy.stdout, '')
  assert.match(withoutPolicy.stderr, /--policy is required/)
})

test('an unusable root is a configuration error with an empty stdout', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem()] } })
  const result = await run(['--root', join(dir, 'absent'), '--policy', join(dir, POLICY_NAME)])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /root is not a readable directory/)
})

/**
 * "In every outcome" is the claim, so every outcome is here.
 *
 * The body used to run one passing fixture twice. That left the three report
 * statuses the tool can reach uncovered, and it left the outcomes where stdout
 * is deliberately NOT JSON -- the empty stream a configuration error owes, and
 * the plain text of --help and --version -- looking like cases the name had
 * quietly excluded. Both halves of the contract are asserted here: a run with a
 * subject writes a parseable report and nothing else, and a run that never had
 * one writes nothing at all.
 */
test('stdout is parseable JSON in every outcome that produces a report, and empty in every one that does not', async (t) => {
  const dir = await workspace(t)
  const policy = join(dir, POLICY_NAME)

  const reported = [
    { name: 'pass', exit: 0, status: 'pass', set: { items: [governingItem()] } },
    { name: 'fail', exit: 1, status: 'fail', set: { items: [governingItem({ misspelt: 'x' })] } },
    { name: 'incomplete', exit: 2, status: 'incomplete', set: { items: [governingItem({ updated: 'not-a-date' })] } },
    { name: 'unparseable input', exit: 2, status: 'incomplete', raw: '{ not json' },
  ]

  for (const outcome of reported) {
    await fixture(dir, outcome.raw === undefined ? { set: outcome.set } : { raw: outcome.raw })
    const result = await run(['--root', dir, '--policy', policy, '--today', '2026-09-14'])

    assert.equal(result.code, outcome.exit, `the ${outcome.name} outcome exited ${result.code}`)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, outcome.status)
    assert.equal(`${JSON.stringify(report, null, 2)}\n`, result.stdout, `stdout carried something besides the ${outcome.name} report`)
  }

  const silent = [
    { name: 'an unknown option', args: ['--nonsense'] },
    { name: 'an unreadable root', args: ['--root', join(dir, 'absent'), '--policy', policy] },
    { name: 'an unparseable policy', args: ['--root', dir, '--policy', join(dir, 'context-set.json')] },
  ]

  for (const outcome of silent) {
    const result = await run(outcome.args)
    assert.equal(result.code, 2, `${outcome.name} did not exit 2`)
    assert.equal(result.stdout, '', `${outcome.name} wrote a report for a run that never had a subject`)
    assert.ok(result.stderr.trim().length > 0, `${outcome.name} said nothing on stderr either`)
  }

  for (const flag of ['--help', '--version']) {
    const result = await run([flag])
    assert.equal(result.code, 0)
    assert.throws(() => JSON.parse(result.stdout), `${flag} started emitting JSON; the report contract does not cover it`)
  }
})

test('--json silences the human summary and changes nothing on stdout', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem()] } })
  const base = ['--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14']

  const human = await run(base)
  assert.equal(human.code, 0)
  assert.doesNotThrow(() => JSON.parse(human.stdout))
  assert.match(human.stderr, /context-priority-ranker: pass/)

  const machine = await run([...base, '--json'])
  assert.equal(machine.code, 0)
  assert.equal(machine.stdout, human.stdout)
  assert.ok(!machine.stderr.includes('context-priority-ranker: pass'))
})

test('without --today the evaluation date is stated on stderr and recorded in the report', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem({ updated: '2020-01-01' })] } })
  const result = await run(['--root', dir, '--policy', join(dir, POLICY_NAME)])
  const report = JSON.parse(result.stdout)

  assert.match(result.stderr, /taken from this host's clock/)
  assert.match(report.summary.today, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(result.stderr, new RegExp(report.summary.today))
})

test('a malformed --today is a configuration error, not a silently ignored one', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem()] } })
  const result = await run(['--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '14-09-2026'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /today must be a YYYY-MM-DD calendar date/)
})
