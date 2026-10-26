import { expect } from 'bun:test'
import { join } from 'node:path'

import { browserTest } from './browser-gate.ts'

/*
 * The cold start of `test/cold-start.test.ts` with the real page in Chromium
 * (`dev/cold-start-page.drive.mjs`, with CHECK=1): six modules the host starts, some slow, and the
 * page arriving at the kehikko that has them. The page reads `/host/modules` at most twice and
 * frames every one of them by the end — it is told when each is up, with the reading, instead of
 * looking every 1.5 s, which on 0.1.72 was 33 reads in 9.1 s. It needs Playwright's Chromium.
 */
browserTest('a cold start with the real page reads the modules twice and frames every module', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/cold-start-page.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath, CHECK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 170_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  console.log(out)
  expect(out).toContain('the counts were read from the record of traffic, with the page in Chromium')
  expect(run.exitCode).toBe(0)
}, 180_000)
