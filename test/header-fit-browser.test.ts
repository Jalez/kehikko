import { expect } from 'bun:test'
import { join } from 'node:path'

import { browserTest } from './browser-gate.ts'

/*
 * The left side of a container's header — name, version, branch mark, scope —
 * never overlaps, is never cut mid-glyph without an ellipsis and stays one row, at
 * 480, 440, 400, 380, 340, 300, 280, 220 and 200 pixels, folded and not, light and dark, in
 * WebKit and Chromium. `dev/header-fit.drive.mjs` renders it for real, with a
 * stand-in module with a long name, version and branch, and saves a screenshot
 * of the header at each width. It also narrows the window from 1400 to 360 pixels and holds the
 * bar at its top to one row with the pinned places and the Pin button whole in it, and pins, lists
 * and unpins a place at 400. Runs on bee only (`dev/bee-browser-tests.sh`;
 * `test/browser-gate.ts`).
 */
browserTest('the header’s name, version, branch and scope never overlap at any width, in WebKit and Chromium', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/header-fit.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 420_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out.length > 12000 ? `${out.slice(0, 6000)}\n…\n${out.slice(-6000)}` : out)
  expect(run.exitCode).toBe(0)
  expect(out.includes('never overlap')).toBe(true)
}, 430_000)
