import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * A cold start is quiet — read from the host's own record of traffic on a scratch host
 * (`dev/cold-start.drive.mjs`, with CHECK=1): six modules the host starts, some slow to come up, and
 * the page's start-up requests made over plain HTTP the way the page makes them. Each module's
 * manifest is fetched at most once besides the host's own wait for it, the page reads
 * `/host/modules` at most twice, and every call Kehikot makes or is asked has a reason. Monitor on
 * 0.1.72 showed 33 reads of `/host/modules` in 9.1 s, every starting module's manifest fetched 28
 * times in 9.5 s, and 578 of Kehikot's 1261 calls with no reason. `test/traffic-counts.test.ts`
 * measures a steady page load, with every module already up, and never saw it.
 */
test('a cold start asks each module once, reads the modules twice, and says why for every call', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/cold-start.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath, CHECK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 150_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out)
  expect(out).toContain('the counts were read from the record of traffic')
  expect(run.exitCode).toBe(0)
}, 160_000)
