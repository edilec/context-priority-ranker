/**
 * Path confinement, and the false refusals a confinement must not produce.
 *
 * Rejecting `..` and absolute paths lexically is not confinement: a symbolic
 * link planted inside the root contains neither and points anywhere. Both real
 * paths are resolved and compared. Equally, a root reached THROUGH a symbolic
 * link -- every run under the macOS temp directory, where /var is a link to
 * /private/var -- must still work, because a guard that refuses everything
 * passes a confinement test while making the tool useless.
 */

import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { isInside } from '../src/index.mjs'
import { BASE_POLICY, POLICY_NAME, fixture, governingItem, run, workspace } from './support.mjs'

const SECRET = 'AKIAIOSFODNN7EXAMPLE'
const OUTSIDE = 'OUTSIDE THE ROOT'

test('a symbolic link inside the root pointing outside is refused, and its content is not echoed', async (t) => {
  const dir = await workspace(t)
  const root = join(dir, 'root')
  await mkdir(root, { recursive: true })
  await writeFile(join(dir, POLICY_NAME), JSON.stringify(BASE_POLICY))
  await writeFile(join(dir, 'outside.json'), JSON.stringify({
    items: [governingItem({ id: SECRET, text: SECRET })],
  }))
  await symlink(join(dir, 'outside.json'), join(root, 'context-set.json'))

  const result = await run(['--root', root, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)

  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(report.findings[0].ruleId, 'path-escapes-root')
  assert.ok(!result.stdout.includes(SECRET), 'out-of-root content reached stdout')
  assert.ok(!result.stderr.includes(SECRET), 'out-of-root content reached stderr')
})

/**
 * The separator is the whole boundary.
 *
 * `candidate.startsWith(root)` is true for a sibling directory whose name
 * merely begins with the root's, so `/tmp/rootEVIL/context-set.json` reads as
 * being inside `/tmp/root`. Every other confinement case in this file passes
 * with that mutation in place -- the out-of-root file they use is a PARENT, not
 * a sibling-prefix -- which is exactly how the boundary went unpinned.
 */
test('a sibling directory whose name starts with the root\'s name is outside it', async (t) => {
  assert.equal(isInside('/a/root', '/a/rootEVIL'), false)
  assert.equal(isInside('/a/root', '/a/rootEVIL/context-set.json'), false)
  assert.equal(isInside('/a/root', '/a/root'), true, 'the root itself is inside the root')
  assert.equal(isInside('/a/root', '/a/root/nested/context-set.json'), true)
  assert.equal(isInside('/a/root/', '/a/root/nested'), true, 'a trailing separator must not double it')

  const dir = await workspace(t)
  const root = join(dir, 'root')
  const sibling = join(dir, 'rootEVIL')
  await mkdir(root, { recursive: true })
  await mkdir(sibling, { recursive: true })
  await writeFile(join(dir, POLICY_NAME), JSON.stringify(BASE_POLICY))
  await writeFile(join(sibling, 'context-set.json'), JSON.stringify({
    items: [governingItem({ id: 'outside-secret', title: OUTSIDE, text: SECRET })],
  }))
  await symlink(join(sibling, 'context-set.json'), join(root, 'context-set.json'))

  const result = await run(['--root', root, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)

  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(report.findings[0].ruleId, 'path-escapes-root')
  assert.deepEqual(report.ranking, [], 'a document from outside the root was ranked')
  assert.ok(!result.stdout.includes(OUTSIDE), 'out-of-root content reached stdout')
  assert.ok(!result.stdout.includes(SECRET))
  assert.ok(!result.stderr.includes(OUTSIDE), 'out-of-root content reached stderr')
})

test('a directory inside the root whose name starts with the root\'s name is still read', async (t) => {
  const dir = await workspace(t)
  const root = join(dir, 'root')
  await mkdir(join(root, 'rootNOTES'), { recursive: true })
  await writeFile(join(dir, POLICY_NAME), JSON.stringify(BASE_POLICY))
  await writeFile(join(root, 'rootNOTES', 'context-set.json'), JSON.stringify({ items: [governingItem()] }))

  const result = await run([
    '--root', root, '--policy', join(dir, POLICY_NAME),
    '--context-set', 'rootNOTES/context-set.json', '--today', '2026-09-14',
  ])
  assert.equal(result.code, 0, 'a confinement that refuses everything is not a confinement')
  assert.equal(JSON.parse(result.stdout).summary.scored, 1)
})

/**
 * A dangling link is the case where "read-only" and "unknown is never a pass"
 * meet: resolving the target may not create it, and not finding it may not read
 * as an absence the run was content with.
 *
 * The second half of that sentence used to be the whole test. Nothing stated
 * that the target stayed absent, so a build that opened the link for writing --
 * which is what creating it would mean -- passed while the name said otherwise.
 */
test('a symbolic link to a path that does not exist is refused without creating anything', async (t) => {
  const dir = await workspace(t)
  const root = join(dir, 'root')
  await mkdir(root, { recursive: true })
  await writeFile(join(dir, POLICY_NAME), JSON.stringify(BASE_POLICY))
  const target = join(dir, 'never-created.json')
  await symlink(target, join(root, 'context-set.json'))
  const before = (await readdir(dir)).sort()

  const result = await run(['--root', root, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)
  assert.equal(result.code, 2)
  assert.equal(report.status, 'incomplete')
  assert.ok(['path-escapes-root', 'input-unreadable'].includes(report.findings[0].ruleId))

  // The "without creating anything" half, which the name claimed and nothing
  // asserted. lstat, not stat: stat would follow the link and report ENOENT
  // whether or not the run had created something else beside it.
  await assert.rejects(
    () => lstat(target),
    (error) => error.code === 'ENOENT',
    'the run created the file the dangling link pointed at',
  )
  assert.deepEqual((await readdir(dir)).sort(), before, 'the run created something in the workspace')
  assert.deepEqual(await readdir(root), ['context-set.json'], 'the run created something inside the root')
})

test('a legitimate document under a symlinked root is still read', async (t) => {
  const dir = await workspace(t)
  const real = join(dir, 'real')
  await mkdir(real, { recursive: true })
  await writeFile(join(real, POLICY_NAME), JSON.stringify(BASE_POLICY))
  await writeFile(join(real, 'context-set.json'), JSON.stringify({ items: [governingItem()] }))
  const linked = join(dir, 'linked')
  await symlink(real, linked)

  const result = await run(['--root', linked, '--policy', join(linked, POLICY_NAME), '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)
  assert.equal(result.code, 0, 'a symlinked root must not be a false refusal')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.scored, 1)
})

test('a context set named with .. or an absolute path is a configuration error', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem()] } })

  for (const name of ['../elsewhere.json', join(dir, 'context-set.json')]) {
    const result = await run([
      '--root', dir, '--policy', join(dir, POLICY_NAME), '--context-set', name,
    ])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a configuration error leaves stdout empty')
  }
})

test('the reported file path is relative to the root, never a host path', async (t) => {
  const dir = await workspace(t)
  await fixture(dir, { set: { items: [governingItem({ relevance: 5 })] } })
  const result = await run(['--root', dir, '--policy', join(dir, POLICY_NAME), '--today', '2026-09-14'])
  const report = JSON.parse(result.stdout)

  assert.equal(report.findings[0].location.file, 'context-set.json')
  assert.ok(!result.stdout.includes(dir), 'the report carried an absolute host path')
})
