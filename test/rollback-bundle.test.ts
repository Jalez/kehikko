import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * A release whose bundle does not start is rolled back — on a scratch host running the real host
 * code (`dev/rollback.drive.mjs`, with CHECK=1): v1.0.0 installed from a bundle and answering, v1.1.0
 * published as a real bundle whose server throws, then Check now. The host downloads and swaps in
 * v1.1.0, restarts the module, finds it does not answer, puts v1.0.0 back at the same folder, starts
 * it, and says so in the Inbox. Nothing reaches the internet or the person's modules: every
 * location is scratch, every `https://` request goes to a fake GitHub, and git reads a local repository.
 */
test('a release that does not start is rolled back to the version before, which runs again, and the Inbox says so', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/rollback.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath, CHECK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 240_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  if (run.exitCode !== 0) console.error(out)
  expect(out).toContain('the rollback held')
  expect(run.exitCode).toBe(0)
}, 250_000)
