/**
 * Every documented limit is enforced, reported by name, and reachable from the
 * command line. A documented limit the CLI never wires through is a limit that
 * does not exist, and this catalog has already shipped one.
 */

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, EXCERPT_LIMIT, HARD_LIMITS, excerpt, rankContext, validateLimits } from '../src/index.mjs'
import { BASE_POLICY, POLICY_NAME, fixture, governingItem, run, untrustedItem, workspace } from './support.mjs'

const LIMIT_CASES = [
  {
    flag: '--max-document-bytes',
    value: '32',
    ruleId: 'input-too-large',
    set: { items: [governingItem(), untrustedItem()] },
    expect: /maxDocumentBytes limit of 32/,
  },
  {
    flag: '--max-evidence-links',
    value: '2',
    ruleId: 'too-many-evidence-links',
    set: { items: [governingItem({ evidence: ['a', 'b', 'c'] })] },
    expect: /maxEvidenceLinks limit of 2/,
  },
  {
    flag: '--max-findings',
    value: '2',
    ruleId: 'too-many-findings',
    set: {
      items: [
        governingItem({ id: 'a', evidence: ['nope'] }),
        governingItem({ id: 'b', evidence: ['nope'] }),
        governingItem({ id: 'c', evidence: ['nope'] }),
      ],
    },
    expect: /maxFindings limit of 2/,
  },
  {
    flag: '--max-items',
    value: '2',
    ruleId: 'too-many-items',
    set: { items: [governingItem(), untrustedItem(), untrustedItem({ id: 'third' })] },
    expect: /maxItems limit of 2/,
  },
  {
    flag: '--max-text-chars',
    value: '20',
    ruleId: 'item-text-too-long',
    set: { items: [governingItem({ text: 'y'.repeat(50) })] },
    expect: /maxTextChars limit of 20/,
  },
]

for (const entry of LIMIT_CASES) {
  test(`${entry.flag} is enforced, named in the finding, and never a silent truncation`, async (t) => {
    const dir = await workspace(t)
    await fixture(dir, { set: entry.set })

    const generous = await run(['--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14'])
    assert.ok(
      !JSON.parse(generous.stdout).findings.some((row) => row.ruleId === entry.ruleId),
      `${entry.flag}: the fixture already trips the limit at its default, so the flag proves nothing`,
    )

    const bounded = await run([
      '--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14', entry.flag, entry.value,
    ])
    const report = JSON.parse(bounded.stdout)
    const finding = report.findings.find((row) => row.ruleId === entry.ruleId)
    assert.ok(finding !== undefined, `expected ${entry.ruleId} from ${entry.flag} ${entry.value}`)
    assert.match(finding.message, entry.expect)
    assert.equal(report.status, 'incomplete')
    assert.equal(bounded.code, 2)
    assert.deepEqual(report.ranking, [])
  })
}

test('--max-runtime-ms is wired through the CLI and stops the run', async (t) => {
  const dir = await workspace(t)
  const items = []
  for (let index = 0; index < 1500; index += 1) {
    items.push(governingItem({ id: `policy-${index}`, relevance: 0.5, updated: '2026-09-01', text: 'x'.repeat(200) }))
  }
  await fixture(dir, { set: { items } })

  const result = await run([
    '--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14', '--max-runtime-ms', '1',
  ])
  const report = JSON.parse(result.stdout)
  const finding = report.findings.find((row) => row.ruleId === 'time-budget-exceeded')
  assert.ok(finding !== undefined, 'the CLI did not pass the time budget through')
  assert.match(finding.message, /budget of 1 ms/)
  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.deepEqual(report.ranking, [])
})

test('a limit the caller invents is refused rather than ignored', () => {
  assert.throws(() => validateLimits({ maxItem: 5 }), /Unknown limit "maxItem"/)
  assert.throws(() => validateLimits({ maxItems: 0 }), /between 1 and/)
  assert.throws(() => validateLimits({ maxItems: HARD_LIMITS.maxItems + 1 }), /between 1 and/)
  assert.throws(() => validateLimits({ maxItems: 2.5 }), /between 1 and/)
  assert.deepEqual({ ...validateLimits() }, { ...DEFAULT_LIMITS })
})

test('a mistyped limit flag is a configuration error with an empty stdout', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem()] } })
  const result = await run([
    '--root', dir, '--policy', join(dir, POLICY_NAME), '--max-item', '2',
  ])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--max-item"/)
})

test('an option the API does not know is refused rather than ignored', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem()] } })
  await assert.rejects(
    () => rankContext({ root: dir, policy: BASE_POLICY, todays: '2026-09-14' }),
    /Unknown option "todays"/,
  )
})

test('an oversized document is reported by size, not truncated to what fits', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem()] } })
  const big = join(dir, 'big.json')
  await writeFile(big, JSON.stringify({ items: [governingItem({ text: 'z'.repeat(5000) })] }))
  const result = await run([
    '--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14',
    '--context-set', 'big.json', '--max-document-bytes', '100',
  ])
  const report = JSON.parse(result.stdout)
  assert.equal(report.findings[0].ruleId, 'input-too-large')
  assert.match(report.findings[0].message, /It was not parsed/)
  assert.equal(report.summary.items, 0)
  assert.equal(result.code, 2)
})


/**
 * The output bound, which is a limit like any other and was defended by
 * nothing.
 *
 * The house contract calls evidence "length-bounded" and this tool's own README
 * says its excerpts are bounded. Removing the length check from excerpt() left
 * the whole suite green while a single finding carried a 50,008-character
 * evidence string -- nothing asserted a maximum length on any emitted string.
 *
 * Both halves are here: the function at its own boundary, and every string in a
 * real report driven from a document built to be long in each place an
 * untrusted value reaches output.
 */
test('excerpt bounds what it returns, and does not truncate what already fits', () => {
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT)), 'x'.repeat(EXCERPT_LIMIT), 'a value at the limit is emitted whole')
  assert.equal(excerpt('x'.repeat(EXCERPT_LIMIT + 1)).length, EXCERPT_LIMIT + 3)
  assert.ok(excerpt('x'.repeat(EXCERPT_LIMIT + 1)).endsWith('...'))
  assert.equal(excerpt('x'.repeat(5000), 40).length, 43)
  assert.equal(excerpt('short', 40), 'short')
  assert.throws(() => excerpt('x', 0), /positive integer/)
})

/** The widest string the report may carry: the message limit plus an ellipsis. */
const OUTPUT_LIMIT = 403

function stringsOf(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringsOf(entry, found)
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) stringsOf(entry, found)
  return found
}

test('no string in a report is longer than the widest documented bound', async (t) => {
  const dir = await workspace(t)
  const long = 'q'.repeat(50000)
  await fixture(dir, {
    set: {
      items: [
        governingItem({ updated: long }),
        { ...governingItem({ id: 'second' }), [`unknown_${'k'.repeat(400)}`]: 'x' },
        governingItem({ id: 'third', source: `unmapped-${long}` }),
        governingItem({ id: 'fourth', evidence: ['e'.repeat(119)] }),
      ],
      [`document_${'d'.repeat(400)}`]: 'x',
    },
  })
  const result = await run(['--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)

  assert.ok(report.findings.length >= 4, 'the fixture stopped producing the findings it was built for')
  for (const value of stringsOf(report)) {
    assert.ok(
      value.length <= OUTPUT_LIMIT,
      `a report string ran to ${value.length} characters: ${value.slice(0, 80)}...`,
    )
  }
  for (const line of result.stderr.split('\n')) {
    assert.ok(line.length <= OUTPUT_LIMIT + 20, `a human summary line ran to ${line.length} characters`)
  }
})
