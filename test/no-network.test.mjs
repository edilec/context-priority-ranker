/**
 * The tool opens no socket.
 *
 * This is a source scan, and a source scan is a weak instrument: it proves no
 * networking module is imported and no fetch is called by name, and it would
 * miss an indirect call. It is here because it is cheap and it catches the
 * realistic mistake -- someone adding a convenience fetch -- not because it is
 * a proof. The stronger statement is structural: the package declares no
 * dependencies at all, so there is nothing to reach the network with except the
 * runtime itself.
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const FORBIDDEN = [
  'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls',
  'fetch(', 'XMLHttpRequest', 'WebSocket',
]

test('no source file imports a networking module or calls fetch', async () => {
  const roots = [new URL('../src/', import.meta.url), new URL('../bin/', import.meta.url)]
  for (const root of roots) {
    for (const name of await readdir(root)) {
      const text = await readFile(new URL(name, root), 'utf8')
      for (const needle of FORBIDDEN) {
        assert.ok(!text.includes(needle), `${name} mentions ${needle}`)
      }
    }
  }
})

test('the package declares no dependencies of any kind', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
})
