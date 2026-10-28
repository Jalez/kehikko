import { expect } from 'bun:test'
import { join } from 'node:path'

import { browserTest } from './browser-gate.ts'

/*
 * The Inbox toast drawn for real, light and dark: a burst of three reported items is one toast at
 * the bottom right, says how many, and goes by itself (`dev/inbox-toast.drive.mjs`, on a scratch
 * host). On bee only (`dev/bee-browser-tests.sh`).
 */
browserTest('a burst of new Inbox items is one toast, bottom right, and it goes by itself', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/inbox-toast.drive.mjs')], {
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
