import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * A page load asks each of the host's page endpoints once, and the host asks no module for its
 * manifest on the page's own reports — read from the host's own record of traffic, as the Monitor
 * reads it, on a scratch host with three stand-in modules (`dev/traffic-counts.drive.mjs`, with
 * CHECK=1: one page, twenty seconds). Monitor once saw `/host/health`, `/host/modules`,
 * `/host/settings`, `/host/onboarding` and `/host/whats-new` asked several times per load, every
 * manifest re-read every few seconds for "the page says what it has open", and `git fetch` on every
 * checkout on every automatic update check. It needs Playwright's Chromium.
 */
test('a page load asks each page endpoint once, and no manifest is fetched for its reports', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/traffic-counts.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath, CHECK: '1', PAGES: '1', DURATION_MS: '20000' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 150_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out)
  expect(out).toContain('the counts were read from the record of traffic')
  expect(run.exitCode).toBe(0)
}, 160_000)
