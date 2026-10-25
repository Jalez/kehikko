import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * "What's new" waits in the bar: in WebKit, the desktop app's engine, with a
 * real pointer and keyboard on a scratch host of its own. After a simulated
 * update the notice is drawn within a second — with GitHub's release list
 * never answering — while focus is in a module's page, every key typed there
 * reaches it, the dialog never opens by itself, and pressing the notice opens
 * it and acknowledges. `dev/whats-new-notice.drive.mjs` is the drive; this
 * runs it on every `bun test`. It needs Playwright's WebKit; missing, it
 * fails and says the command that installs it.
 */
test('the notice waits in the bar and typing in a module goes on, in WebKit', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/whats-new-notice.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 180_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out)
  expect(out).toContain('the notice waited in the bar, and typing in the module went on')
  expect(run.exitCode).toBe(0)
}, 190_000)
