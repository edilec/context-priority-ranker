/**
 * Every untrusted string is stripped of forging and hiding characters on its
 * way out -- identifiers included, not only excerpt fields.
 *
 * One test per character class, and each class arrives through three different
 * routes: a source name, a field key and a date value. Two of the three are
 * identifiers rather than excerpts, because a sibling tool sanitised its
 * evidence field carefully and let a page id containing a newline forge whole
 * lines in the human report.
 *
 * Three assertions per case, because one of them alone would pass for the wrong
 * reason:
 *
 *   - no report string contains the character. On its own this would pass for
 *     C0 without any sanitiser at all, since JSON.stringify escapes C0 itself.
 *   - some report string contains the flattened rendering, so the value was
 *     carried through and sanitised rather than quietly dropped.
 *   - the human summary does not contain the raw marker. Checking stderr for a
 *     bare newline would be meaningless -- the summary is made of lines -- so
 *     the marker is checked as a whole, which is exactly the forgery.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CONTROL_CLASSES } from '../src/index.mjs'
import { POLICY_NAME, fixture, governingItem, run, workspace } from './support.mjs'

function stringsOf(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringsOf(entry, found)
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) stringsOf(entry, found)
  return found
}

const ROUTES = [
  {
    name: 'an unmapped source name',
    ruleId: 'authority-unknown',
    marker: (char) => `web${char}page`,
    flattened: 'web page',
    build: (char) => ({ items: [governingItem({ source: `web${char}page` })] }),
  },
  {
    name: 'an unknown field key',
    ruleId: 'item-unknown-field',
    marker: (char) => `extra${char}field`,
    flattened: 'extra field',
    build: (char) => ({ items: [{ ...governingItem(), [`extra${char}field`]: 'x' }] }),
  },
  {
    name: 'an invalid date value',
    ruleId: 'updated-invalid',
    marker: (char) => `2026-09${char}-01`,
    flattened: '2026-09 -01',
    build: (char) => ({ items: [governingItem({ updated: `2026-09${char}-01` })] }),
  },
]

for (const [className, codePoints] of Object.entries(CONTROL_CLASSES)) {
  test(`${className} characters never reach the report`, async (t) => {
    for (const codePoint of codePoints) {
      const char = String.fromCodePoint(codePoint)
      const label = `U+${codePoint.toString(16).padStart(4, '0')}`
      for (const route of ROUTES) {
        const dir = await workspace(t)
        await fixture(dir, { set: route.build(char) })
        const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])
        const report = JSON.parse(result.stdout)
        const strings = stringsOf(report)

        assert.ok(
          report.findings.some((finding) => finding.ruleId === route.ruleId),
          `expected ${route.ruleId} for ${label} through ${route.name}`,
        )
        for (const value of strings) {
          assert.ok(!value.includes(char), `${label} survived into the report through ${route.name}: ${JSON.stringify(value)}`)
        }
        assert.ok(
          strings.some((value) => value.includes(route.flattened)),
          `${label} through ${route.name}: nothing carried the flattened value ${JSON.stringify(route.flattened)}`,
        )
        assert.ok(
          !result.stderr.includes(route.marker(char)),
          `${label} survived into the human summary through ${route.name}`,
        )
      }
    }
  })
}

test('a bidi override in an item id cannot reverse the human summary', async (t) => {
  const dir = await workspace(t)
  const override = String.fromCodePoint(0x202e)
  await fixture(dir, { set: { items: [governingItem({ id: `policy${override}nimda` })] } })
  const result = await run(['--root', dir, '--policy', `${dir}/${POLICY_NAME}`, '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)

  // The id is refused outright rather than echoed, which is the stronger
  // outcome: nothing downstream resolves an evidence link to it either.
  assert.ok(report.findings.some((finding) => finding.ruleId === 'item-id-invalid'))
  assert.equal(result.code, 1)
  for (const value of stringsOf(report)) assert.ok(!value.includes(override))
  assert.ok(!result.stderr.includes(override))
})
