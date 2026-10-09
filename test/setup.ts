/**
 * No test may reach a person's machine.
 *
 * This host keeps machine-level state — the module registry, the canvases
 * database, the materialised module versions, the installed official modules
 * and the logs of the modules it starts (`server/machineDirs.ts`), and it edits
 * Claude Code's own configuration (`server/agents.ts`). The DEFAULT location of
 * each is the real one, under the home directory of whoever runs the suite, and
 * a host they are using at that moment reads the same files: a registration
 * written there is a module appearing in somebody's app.
 *
 * Tests pointed these somewhere safe one at a time, each with its own
 * `process.env` line, and that held exactly as long as every one of them put
 * back what it found. One did not: `register.test.ts` ended with
 * `delete process.env.KEHIKOT_MODULES_DIR`, and every test loaded after it in
 * the same process resolved the real registry.
 *
 * So it is not left to each test. Before any test file is loaded, every one of
 * those locations is a directory under one scratch directory, and a test that
 * saves and restores a variable restores THIS. Then, before and after every
 * test, each location the code would resolve is checked: one under the real
 * home fails the test, naming the variable and where it would have written. (A
 * test may still set `HOME` to a scratch home and remove an override, which is
 * how the migration from `~/.roadmap` is tested — that resolves under its
 * scratch home, and passes.)
 *
 * The same idea as `test/setup.ts` in the protocol package, which guards the
 * one location it writes.
 */
import { afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { agentConfigFile } from '../server/agents.ts'
import { frameDbFile, installsDir, logsDir, modulesDir, versionsDir } from '../server/machineDirs.ts'

/* Read once, before any test can set `HOME` to something else. */
const REAL_HOME = realpathSync(homedir())
const TMP = realpathSync(tmpdir())
const SCRATCH = mkdtempSync(join(TMP, 'kehikko-tests-'))
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }))

/**
 * Every machine-level location this host can write: the variable that moves
 * it, where the suite puts it, and the function the code itself resolves it
 * with. A new one in `machineDirs.ts` belongs here.
 */
const LOCATIONS: ReadonlyArray<{ variable: string; scratch: string; resolved: () => string }> = [
  { variable: 'KEHIKOT_MODULES_DIR', scratch: join(SCRATCH, 'modules'), resolved: () => modulesDir() },
  { variable: 'KEHIKOT_FRAME_DB', scratch: join(SCRATCH, 'frame.sqlite'), resolved: () => frameDbFile() },
  { variable: 'KEHIKOT_VERSIONS_DIR', scratch: join(SCRATCH, 'versions'), resolved: () => versionsDir() },
  { variable: 'KEHIKOT_INSTALLS_DIR', scratch: join(SCRATCH, 'installed'), resolved: () => installsDir() },
  { variable: 'KEHIKOT_LOGS_DIR', scratch: join(SCRATCH, 'logs'), resolved: () => logsDir() },
  { variable: 'CLAUDE_CONFIG', scratch: join(SCRATCH, 'claude.json'), resolved: () => agentConfigFile() },
]

function pointAtScratch(): void {
  for (const { variable, scratch } of LOCATIONS) process.env[variable] = scratch
  /* The pre-rename names are still read as fallbacks by `machineDirs.ts`; one
     inherited from the shell must not be what a test falls through to. */
  delete process.env.ROADMAP_MODULES_DIR
  delete process.env.ROADMAP_FRAME_DB
}

const under = (path: string, dir: string) => path === dir || path.startsWith(dir + sep)

function nothingIsReal(when: string): void {
  const real = LOCATIONS.map((location) => ({ ...location, where: location.resolved() })).filter(
    ({ where }) => under(where, REAL_HOME) && !under(where, TMP),
  )
  if (real.length === 0) return
  /* Put them back first, so one test's mistake is one failure and not every later test's. */
  pointAtScratch()
  throw new Error(
    `${when}, ${real.map(({ variable, where }) => `${variable} resolved to ${where}`).join(' and ')} — under the real home `
      + 'directory, where a host somebody is using reads and writes. A test that moves one of these must put back what '
      + 'it found, never delete it.',
  )
}

pointAtScratch()
nothingIsReal('Before any test ran')
beforeEach(() => nothingIsReal('Before this test'))
afterEach(() => nothingIsReal('After this test'))
