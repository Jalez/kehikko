import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * Module pages take clicks, typing and the wheel — in WebKit, the desktop
 * app's engine, and in Chromium — after a load, a kehikko switch, a project
 * switch, a header menu press, a resize and a fold.
 *
 * 0.1.54 and 0.1.55 shipped a canvas where they did not: a full-canvas layer
 * over the pages took every click, and every test passed, because no test
 * pressed inside a page the way a hand does. `dev/pages-take-input.drive.mjs`
 * does, with a real pointer and keyboard on a scratch host of its own, and
 * this runs it on every `bun test` so it is not a probe somebody has to
 * remember. About half a minute.
 *
 * It needs Playwright's browsers in Playwright's own cache. Missing, it fails
 * and says the command that installs them — it does not skip.
 */
test('every module page takes the pointer, the keyboard and the wheel, in WebKit and Chromium', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/pages-take-input.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 240_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out)
  expect(out).toContain('every page took the pointer, the keyboard and the wheel')
  expect(run.exitCode).toBe(0)
}, 250_000)
