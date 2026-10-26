import { expect } from 'bun:test'
import { join } from 'node:path'

import { browserTest } from './browser-gate.ts'

/*
 * A kehikko fills to its bottom: at window heights 700, 823, 900 and 1117, a
 * container stored at the last row and one resized there with the real pointer
 * both end within a pixel of the canvas's bottom less its gap — the gap at its
 * right edge — and neither the canvas nor the page scrolls, in WebKit and
 * Chromium (`dev/fill-to-bottom.drive.mjs`, on a scratch host). It needs
 * Playwright's browsers.
 */
browserTest('a container resized to the bottom ends at the bottom, at every window height, with no scrollbar', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/fill-to-bottom.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 240_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  console.log(out)
  expect(out).toContain('all good')
  expect(run.exitCode).toBe(0)
}, 250_000)
