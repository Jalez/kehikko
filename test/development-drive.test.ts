import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * "Kehikko development" end to end, on a scratch host running the real host code
 * (`dev/development.drive.mjs`, with CHECK=1): two official modules registered from the person's own
 * folders and running from there; the first start makes development on and says so once; turning it
 * off downloads the release bundles from a fake GitHub, points the registrations at the installed
 * copies and starts them, puts the one whose release does not start back on its folder, and says
 * which folder Kehikot no longer uses; on again and "use the release for this one" move them back and
 * forth; and neither folder is changed. Nothing reaches the internet or the person's modules.
 *
 * With CLAUDE_BUNDLE and CLAUDE_CHECKOUT set (a built bundle and a clone of that module), the drive
 * also moves that real agent module and checks its session hook follows it.
 */
test('Kehikko development moves official modules between the person’s folders and their releases, puts a failed one back, and never touches a folder', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/development.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath, CHECK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 300_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out)
  expect(out).toContain('Kehikko development held')
  expect(run.exitCode).toBe(0)
}, 310_000)
