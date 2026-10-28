import { expect } from 'bun:test'
import { join } from 'node:path'

import { browserTest } from './browser-gate.ts'

/*
 * A module's jump into another project (protocol 2.28.0): pressed in the module's own page, it
 * switches project by the calm switch, lands on the epic there, and `context.show` reaches only the
 * module that says it shows agent sessions (`dev/cross-project-jump.drive.mjs`, on a scratch host).
 * It needs Playwright's browsers.
 */
browserTest('a module takes the person to a place in another project, calmly', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/cross-project-jump.drive.mjs')], {
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
