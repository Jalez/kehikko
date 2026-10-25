import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * Adding a module to a kehikko with a hole in it: the container lands in the hole, is ringed
 * (`data-landed`), scrolled into view when it is off screen, and keyboard focus stays where it
 * was — in WebKit and Chromium, with and without reduced motion
 * (`dev/place-in-gaps.drive.mjs`, on a scratch host). It needs Playwright's browsers.
 */
test('a new module takes the first free space, is ringed and brought into view', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/place-in-gaps.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 240_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out)
  expect(out).toContain('all good')
  expect(run.exitCode).toBe(0)
}, 250_000)
