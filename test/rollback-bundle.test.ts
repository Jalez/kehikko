import { expect, test } from 'bun:test'
import { join } from 'node:path'

/*
 * A release whose bundle does not start is rolled back — on a scratch host running the real host
 * code (`dev/rollback.drive.mjs`, with CHECK=1): v1.0.0 installed from a bundle and answering, v1.1.0
 * published as a real bundle whose server throws, then Check now. The host downloads and swaps in
 * v1.1.0, restarts the module, finds it does not answer, puts v1.0.0 back at the same folder, starts
 * it, and says so in the Inbox. Then, with the module stopped, v1.2.0 (also broken) is put in place by
 * the check and fails at the first start, which rolls it back too; and v1.3.0 becomes current while a
 * container pinned to v1.0.0 runs from its release bundle beside it. Nothing reaches the internet or the person's modules: every
 * location is scratch, every `https://` request goes to a fake GitHub, and git reads a local repository.
 */
test('a release that does not start is rolled back, whether it was restarted by the update or first started after it landed while the module was idle; and a container pinned to an older bundled version runs beside the current one', () => {
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
  /* \`bringUp\`'s own rollback: 1.2.0 landed while the module was stopped, and failed at its first start. */
  expect(out).toContain('the idle rollback held')
  /* A container pinned to v1.0.0 runs from its release bundle beside 1.3.0, the current version. */
  expect(out).toContain('the pinned version ran beside the current one, from its bundle')
  expect(run.exitCode).toBe(0)
}, 250_000)
