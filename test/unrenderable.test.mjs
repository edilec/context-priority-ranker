/**
 * A value that cannot be turned into a string costs nothing but its own field.
 *
 * `String({toString: {}})` throws `Cannot convert object to primitive value`,
 * and `{"toString": {}}` is four characters of JSON. Uncaught it took the whole
 * report with it: exit 2 with an EMPTY stdout -- the shape this contract
 * reserves for a configuration error -- so one malformed document suppressed
 * the findings for every other input in the same run, and the reader was never
 * told which field caused it.
 *
 * The fix is at the one boundary every untrusted string already passes through,
 * not at each `String(...)` call site. What is pinned here is therefore three
 * separate claims, because a guard that mangled every value would satisfy the
 * first one alone:
 *
 *   - the poison is real: `String(value)` genuinely throws for it;
 *   - the boundary describes it by shape, and the shape carries nothing of the
 *     document -- a neighbouring credential in the same object does not ride
 *     out on it, which a `JSON.stringify` "fix" would have allowed;
 *   - ordinary values are untouched, a real custom `toString` included.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { excerpt, renderable } from '../src/index.mjs'
import { POLICY_NAME, fixture, governingItem, run, workspace } from './support.mjs'

/** An object JSON can carry and `String` cannot render, with a secret beside it. */
const SECRET = 'AKIAIOSFODNN7EXAMPLE'
const poison = () => ({ toString: {}, leak: SECRET })

function stringsOf(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringsOf(entry, found)
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) stringsOf(entry, found)
  return found
}

test('the poison value really does throw in String(), so the rest of this file is about something', () => {
  assert.throws(() => String(poison()), TypeError)
  assert.throws(() => `${poison()}`, TypeError)
  assert.throws(() => String([poison()]), TypeError)
})

test('the boundary describes an unrenderable value by shape and reproduces none of it', () => {
  assert.equal(renderable(poison()), '[object]')
  assert.equal(excerpt(poison()), '[object]')
  assert.equal(renderable([poison()]), '[array]')
  assert.equal(excerpt([poison()]), '[array]')
  assert.ok(!excerpt(poison()).includes(SECRET))
  assert.ok(!excerpt(poison()).includes('leak'))
})

test('ordinary values are unaffected by the shape description', () => {
  assert.equal(excerpt('operating-policy'), 'operating-policy')
  assert.equal(excerpt(42), '42')
  assert.equal(excerpt(0), '0')
  assert.equal(excerpt(null), 'null')
  assert.equal(excerpt(true), 'true')
  assert.equal(excerpt({ toString: () => 'a real custom toString' }), 'a real custom toString')
  assert.equal(excerpt([1, 2, 3]), '1,2,3')
  assert.equal(renderable('already a string'), 'already a string')
})

/**
 * Both document positions that reached `String(...)` directly, driven through
 * the real CLI. `schemaVersion` is the worse of the two: it is read before any
 * schema check, so every packet in a run died on one malformed neighbour.
 */
const ROUTES = [
  {
    name: 'an item\'s "updated"',
    ruleId: 'updated-invalid',
    shape: 'updated [object]',
    set: () => ({ items: [governingItem({ updated: poison() })] }),
  },
  {
    name: 'an item\'s "updated" holding an array',
    ruleId: 'updated-invalid',
    shape: 'updated [array]',
    set: () => ({ items: [governingItem({ updated: [poison()] })] }),
  },
  {
    name: 'the document\'s "schemaVersion"',
    ruleId: 'schema-version-unsupported',
    shape: '"[object]"',
    set: () => ({ schemaVersion: poison(), items: [governingItem()] }),
  },
]

for (const route of ROUTES) {
  test(`${route.name} reports incomplete with a report on stdout, not an empty stream`, async (t) => {
    const dir = await workspace(t)
    await fixture(dir, { set: route.set() })
    const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])

    assert.notEqual(result.stdout, '', 'stdout was empty: the run had a subject and owes a report about it')
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(result.code, 2)
    assert.ok(
      report.findings.some((finding) => finding.ruleId === route.ruleId),
      `expected ${route.ruleId}; got ${report.findings.map((finding) => finding.ruleId).join(', ')}`,
    )
    assert.ok(
      stringsOf(report).some((value) => value.includes(route.shape)),
      `nothing in the report described the value as ${route.shape}`,
    )
    assert.ok(!result.stdout.includes(SECRET), 'the secret beside the unrenderable value reached stdout')
    assert.ok(!result.stderr.includes(SECRET), 'the secret beside the unrenderable value reached stderr')
    assert.ok(!result.stderr.includes('Cannot convert object to primitive value'))
  })
}

test('one unrenderable field does not suppress the findings for the rest of the document', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, {
    set: {
      items: [
        governingItem({ updated: poison() }),
        governingItem({ id: 'second-item', misspelt: 'x' }),
      ],
    },
  })
  const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)
  const ruleIds = report.findings.map((finding) => finding.ruleId)

  assert.ok(ruleIds.includes('updated-invalid'))
  assert.ok(ruleIds.includes('item-unknown-field'), 'the other item\'s finding was lost with the malformed one')
  assert.equal(report.summary.checked, 2)
})
