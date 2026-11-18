import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * Uninstall is a real uninstall — on a scratch host running the real host code (`dev/uninstall.drive.mjs`,
 * with CHECK=1): a running module installed from a real bundle is stopped, its copy, rollback copy, log,
 * registration and Inbox items go, its own `uninstall.ts` runs from the bundle and takes out what it wrote
 * in the agent's folder (the person's entry beside it stays), its project data stays without the checkbox,
 * and its container stays as "Module removed"; two retired modules are one Inbox item, and one press
 * uninstalls both, leaving the person's checkout whole. With `CLAUDE_BUNDLE` it also uninstalls the real
 * Claude module from its real bundle. Nothing reaches the internet or the person's modules.
 */
test('Uninstall removes everything Kehikot put on the computer, runs the module’s own clean-up, keeps the person’s folder and unticked data, and the retired modules go on one press', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/uninstall.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath, CHECK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 240_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out)
  expect(out).toContain('Uninstall held')
  expect(run.exitCode).toBe(0)
}, 250_000)
