import { expect } from 'bun:test'
import { join } from 'node:path'

import { browserTest } from './browser-gate.ts'

/*
 * A module's named Inbox event drawn for real, light and dark: the toast says "Research complete" and
 * Settings lists the event with the research chime (`dev/inbox-events.drive.mjs`, on a scratch
 * host). On bee only (`dev/bee-browser-tests.sh`).
 */
browserTest('a module’s named event heads its toast and has a sound of its own in Settings', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/inbox-events.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 240_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (process.env.PRINT_SHOTS === '1' || run.exitCode !== 0) console.log(out)
  expect(out).toContain('all good')
  expect(run.exitCode).toBe(0)
}, 250_000)
