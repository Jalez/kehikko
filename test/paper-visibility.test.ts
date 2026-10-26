import { expect } from 'bun:test'
import { join } from 'node:path'

import { browserTest } from './browser-gate.ts'

/*
 * Paper (2.8.0) asks its server nothing while its page is not shown — folded, on another
 * kehikko, scrolled out of the canvas — and keeps up while it is: an edit on disk and a
 * `propose_edit` suggestion pushed to the page within about two seconds, the stream kept open
 * through two idle minutes with a safety ask about once a minute. In WebKit, the desktop app's
 * engine, and in Chromium, inside a real host page (`dev/paper-visibility.drive.mjs`, on a scratch
 * host with Paper served ready-built).
 *
 * It drives a module, so it is told which: `PAPER_REF=<branch|tag|sha>` clones and builds Paper
 * at that ref (on bee: `BEE_ENV='PAPER_REF=<ref>' dev/bee-browser-tests.sh <host ref>
 * test/paper-visibility.test.ts`), `PAPER_DIR=<checkout>` uses a built checkout. Told neither, it
 * is skipped. About fifteen minutes: the quiet spells are minutes long because a safety ask is
 * once a minute.
 */
const PAPER = process.env.PAPER_REF ?? process.env.PAPER_DIR ?? null
const LIMIT = 1_500_000

browserTest(
  "Paper's page asks nothing while not shown and keeps up while shown, in WebKit and Chromium",
  async () => {
    const root = join(import.meta.dir, '..')
    const run = Bun.spawn([process.env.NODE ?? 'node', join(root, 'dev/paper-visibility.drive.mjs')], {
      cwd: root,
      env: { ...process.env, BUN: process.execPath },
      /* Streamed: the drive's readings are the result, passing or not. */
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const timer = setTimeout(() => run.kill(), LIMIT - 10_000)
    const status = await run.exited
    clearTimeout(timer)
    expect(status).toBe(0)
  },
  LIMIT,
  PAPER ? null : 'it drives Paper: name one with PAPER_REF=<ref> (BEE_ENV on bee) or PAPER_DIR=<built checkout>',
)
