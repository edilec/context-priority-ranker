/** Shared fixtures: a workspace, a policy, an item, and a real CLI run. */

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const BIN = fileURLToPath(new URL('../bin/context-priority-ranker.mjs', import.meta.url))
export const POLICY_NAME = 'policy.json'
export const SET_NAME = 'context-set.json'

/** A temporary directory, removed when the test finishes. */
export async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'context-priority-ranker-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

export const BASE_POLICY = Object.freeze({
  authority: {
    'operator-instruction': 'governing',
    'repository-doc': 'trusted',
    'third-party-doc': 'reference',
    'retrieved-web-page': 'untrusted',
  },
  weights: { relevance: 5, freshness: 3, evidence: 2 },
  evidenceSaturation: 3,
  bands: {
    governing: { reviewAfterDays: 90, expireAfterDays: 365, freshnessHorizonDays: 365 },
    trusted: { reviewAfterDays: 180, expireAfterDays: null, freshnessHorizonDays: 365 },
    reference: { reviewAfterDays: null, expireAfterDays: null, freshnessHorizonDays: 730 },
    untrusted: { reviewAfterDays: null, expireAfterDays: null, freshnessHorizonDays: 365 },
  },
})

export function policyWith(overrides = {}) {
  return JSON.parse(JSON.stringify({ ...BASE_POLICY, ...overrides }))
}

export function governingItem(overrides = {}) {
  return {
    id: 'operating-policy',
    source: 'operator-instruction',
    title: 'Release approval policy',
    relevance: 0,
    updated: '2026-09-01',
    ...overrides,
  }
}

export function untrustedItem(overrides = {}) {
  return {
    id: 'retrieved-page',
    source: 'retrieved-web-page',
    title: 'Retrieved page',
    relevance: 1,
    updated: '2026-09-14',
    ...overrides,
  }
}

/** Write a policy and a context set into `dir`, returning the paths. */
export async function fixture(dir, { policy = BASE_POLICY, set, setName = SET_NAME, raw = null } = {}) {
  const policyPath = join(dir, POLICY_NAME)
  await writeFile(policyPath, JSON.stringify(policy, null, 2))
  const setPath = join(dir, setName)
  await mkdir(join(dir, setName, '..'), { recursive: true })
  await writeFile(setPath, raw === null ? JSON.stringify(set, null, 2) : raw)
  return { policyPath, setPath }
}

/** Run the real CLI. Returns the exit code and both streams as strings. */
export function run(args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
      },
    )
  })
}

/**
 * Run the CLI over a workspace with the usual flags, and parse stdout.
 *
 * `--today` defaults to a fixed date so freshness never depends on the day the
 * suite runs; passing another one in `extra` replaces it rather than repeating
 * it, because a repeated flag is a configuration error.
 */
export async function rank(dir, extra = []) {
  const today = extra.includes('--today') ? [] : ['--today', '2026-09-14']
  const result = await run(['--root', dir, '--policy', join(dir, POLICY_NAME), ...today, ...extra])
  const report = result.stdout === '' ? null : JSON.parse(result.stdout)
  return { ...result, report }
}

export function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

export function findingFor(report, ruleId) {
  return report.findings.find((finding) => finding.ruleId === ruleId)
}
