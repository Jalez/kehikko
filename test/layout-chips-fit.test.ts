import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * The module lists on the layout picker's cards stay inside their cards — in
 * WebKit, the desktop app's engine, and in Chromium, light and dark, at a
 * phone width, a small window and a typical one, for every template and for
 * two made up to be worse (fourteen modules; very long names).
 * `dev/layout-chips.drive.mjs` renders it for real and asserts that no
 * element in the dialog has `scrollWidth > clientWidth` (apart from text cut
 * with an ellipsis on purpose, which must itself lie inside its card).
 *
 * It needs Playwright's browsers in Playwright's own cache. Missing, it fails
 * and says the command that installs them — it does not skip.
 */
test('no template overflows its card or the dialog, in WebKit and Chromium', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/layout-chips.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 240_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out)
  expect(out).toContain('no template overflows its card')
  expect(run.exitCode).toBe(0)
}, 250_000)
