import { expect } from 'bun:test'
import { join } from 'node:path'

import { browserTest } from './browser-gate.ts'

/*
 * An agent's `jump` into another project, drawn for real: the host's MCP door
 * asked, the calm switch, the mark "Jumped here by an agent", and Go back
 * restoring project, kehikko and epic (`dev/agent-jump.drive.mjs`, on a
 * scratch host). On bee only (`dev/bee-browser-tests.sh`).
 */
browserTest('an agent jumps the person into another project, calmly, and Go back puts them back', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/agent-jump.drive.mjs')], {
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
