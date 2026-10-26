import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * The host's wait for a module it started asks at widening intervals and under its own reason —
 * read from the host's own record of traffic on a scratch host (`dev/start-wait.drive.mjs`, with
 * CHECK=1). No browser: the page's requests are made over plain HTTP. Monitor once showed every
 * module of a restart round asked about thirty times in five and a half seconds, filed as "the page
 * reads the modules".
 */
test('a module the host started is waited for in a handful of asks, filed as the host waiting', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/start-wait.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath, CHECK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 90_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out)
  expect(out).toContain('the counts were read from the record of traffic')
  expect(run.exitCode).toBe(0)
}, 100_000)
