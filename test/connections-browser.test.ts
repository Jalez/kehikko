import { expect } from 'bun:test'
import { join } from 'node:path'

import { browserTest } from './browser-gate.ts'

/*
 * A module's settings window and its "Providers & Consumers" tab, drawn for real in WebKit and
 * Chromium, light and dark, typical and narrow: `dev/connections.drive.mjs` opens it from a
 * container's gear on a scratch host with one connection switched off, and fails when the tab is
 * missing, the off connection does not say "off", or anything scrolls sideways. On bee only
 * (`dev/bee-browser-tests.sh`; `test/browser-gate.ts`).
 */
browserTest('Providers & Consumers is drawn, says what is off, and fits', () => {
  const root = join(import.meta.dir, '..')
  const run = Bun.spawnSync([process.env.NODE ?? 'node', join(root, 'dev/connections.drive.mjs')], {
    cwd: root,
    env: { ...process.env, BUN: process.execPath },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 240_000,
  })
  const out = `${run.stdout.toString()}${run.stderr.toString()}`
  /* The screenshots, as base64, for whoever ran this from afar (`PRINT_SHOTS=1`). */
  if (process.env.PRINT_SHOTS === '1' || run.exitCode !== 0) console.log(out)
  expect(out).toContain('Providers & Consumers is drawn')
  expect(run.exitCode).toBe(0)
}, 250_000)
