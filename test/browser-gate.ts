import { test } from 'bun:test'

/**
 * Browser tests run on bee, never on the Mac they are written on.
 *
 * A test that launches Playwright, or spawns a drive that does
 * (`dev/*.drive.mjs`, `dev/tooltips.mjs`, `dev/viewport.mjs`), is declared
 * with `browserTest` instead of `test`. It runs only when
 * `KEHIKOT_BROWSER_TESTS=1`, which `dev/bee-browser-tests.sh` sets on bee; a
 * plain `bun test` anywhere else skips it, and says so in its name. Browsers
 * and their headless shells are not to be started on the person's machine at
 * all — by an agent, a test, or a test an agent runs.
 *
 * `test/browser-gate.test.ts` fails when a test file reaches a browser without
 * coming through here.
 */
export const BROWSER_TESTS = process.env.KEHIKOT_BROWSER_TESTS === '1'

export const SKIPPED = 'skipped: a browser test, run on bee with dev/bee-browser-tests.sh <ref>'

/**
 * `needs`, when it is a sentence, skips the test there too, saying it: for a browser test that
 * only means something when it is told what to drive (`test/paper-visibility.test.ts`, which
 * drives a module checked out at a ref it is given).
 */
export function browserTest(name: string, run: () => void | Promise<void>, timeout: number, needs: string | null = null) {
  if (BROWSER_TESTS && needs === null) test(name, run, timeout)
  else test.skip(`${name} (${BROWSER_TESTS ? `skipped: ${needs}` : SKIPPED})`, run)
}
