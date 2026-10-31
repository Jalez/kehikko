import { expect } from 'bun:test'
import { join } from 'node:path'

import { browserTest } from './browser-gate.ts'

/*
 * Focus mode's reveal, for real: the header and the footer show while the pointer
 * is over the middle of a module's page (no edge strip), push the page — its box
 * shrinks by the two rows, nothing of either overlaps it — hold without flicker,
 * hide when the pointer leaves, and have no transition under reduced motion. In
 * WebKit and Chromium, light and dark. `dev/focus-reveal.drive.mjs` drives it on a
 * scratch host whose stand-in declares a footer. Runs on bee only
 * (`dev/bee-browser-tests.sh`; `test/browser-gate.ts`).
 */
browserTest('in focus mode the header and footer reveal on hover anywhere and push the page, in WebKit and Chromium', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/focus-reveal.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 420_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out.length > 12000 ? `${out.slice(0, 6000)}\n…\n${out.slice(-6000)}` : out)
  expect(run.exitCode).toBe(0)
  expect(out.includes('reveal on hover anywhere and push the page')).toBe(true)
}, 430_000)
