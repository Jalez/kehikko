import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where this machine's own Kehikot state lives — spelled once, here.
 *
 * Three things are machine-level rather than project-level: the canvases cache
 * (`frame.sqlite`), the module registry (`modules/<id>.json`) and the module
 * versions a container can be pinned to (`versions/`). Everything else belongs
 * under `<project>/.kehikot/`.
 *
 * They used to live in `~/.roadmap/`, named after the retired prototype. They
 * now live in `~/Library/Application Support/Kehikot/` on macOS (the place the
 * platform keeps an app's own data), and `$XDG_DATA_HOME/kehikot` (default
 * `~/.local/share/kehikot`) elsewhere.
 *
 * ## Environment
 *
 * `KEHIKOT_FRAME_DB` and `KEHIKOT_MODULES_DIR` point either one somewhere else
 * (tests, scratch hosts). The old `ROADMAP_FRAME_DB` / `ROADMAP_MODULES_DIR`
 * are still read as a fallback, so an old script keeps working.
 *
 * ## The old home is read, never written
 *
 * `~/.roadmap` is copied from once (`migrateMachineData`) and its `modules/`
 * is read as a fallback for modules that still register there. Nothing here
 * deletes, moves or edits anything under it: an older host — the installed app,
 * or a checkout on another branch — may still have that database open.
 */

type Env = Record<string, string | undefined>

function home(env: Env): string {
  return env.HOME || homedir()
}

/** `~/Library/Application Support/Kehikot` (macOS) or the XDG equivalent. */
export function machineDir(env: Env = process.env, platform: string = process.platform): string {
  if (platform === 'darwin') return join(home(env), 'Library', 'Application Support', 'Kehikot')
  return join(env.XDG_DATA_HOME || join(home(env), '.local', 'share'), 'kehikot')
}

/** The retired home, `~/.roadmap`. Read only. */
export function legacyMachineDir(env: Env = process.env): string {
  return join(home(env), '.roadmap')
}

/** The canvases cache. `KEHIKOT_FRAME_DB` (or the old `ROADMAP_FRAME_DB`) overrides it. */
export function frameDbFile(env: Env = process.env): string {
  return env.KEHIKOT_FRAME_DB || env.ROADMAP_FRAME_DB || join(machineDir(env), 'frame.sqlite')
}

/** The module registry. `KEHIKOT_MODULES_DIR` (or the old `ROADMAP_MODULES_DIR`) overrides it. */
export function modulesDir(env: Env = process.env): string {
  return env.KEHIKOT_MODULES_DIR || env.ROADMAP_MODULES_DIR || join(machineDir(env), 'modules')
}

/**
 * Where module VERSIONS are materialised: one bare mirror per module and one
 * working tree per module and tag, `versions/<module>/repo.git` and
 * `versions/<module>/<tag>/` — see `server/versionRuns.ts`. Machine-level
 * because it is program code, not anybody's project data, and because two
 * projects pinned to the same tag run the same tree. `KEHIKOT_VERSIONS_DIR`
 * overrides it (tests, scratch hosts).
 */
export function versionsDir(env: Env = process.env): string {
  return env.KEHIKOT_VERSIONS_DIR || join(machineDir(env), 'versions')
}

/**
 * `~/.roadmap/modules`, read as a fallback — or null when the registry was
 * pointed somewhere on purpose, so a test's scratch registry never picks up a
 * person's real modules.
 *
 * Modules register themselves through the protocol's `registerAt` and their own
 * `register.ts`, and until those move, they still write here.
 */
export function legacyModulesDir(env: Env = process.env): string | null {
  if (env.KEHIKOT_MODULES_DIR || env.ROADMAP_MODULES_DIR) return null
  return join(legacyMachineDir(env), 'modules')
}

export interface Migration {
  /** Set when the canvases database was copied, with where from. */
  frameDb: { from: string; to: string } | null
  /** Registration files copied, by file name. */
  modules: string[]
}

/**
 * Bring `~/.roadmap` over, once. Safe while another host has the old database open.
 *
 *  - The database is copied only when the new one does not exist and the old
 *    one does, and only when neither location was overridden by environment.
 *    It is copied with `VACUUM INTO` from a read-only connection — a consistent
 *    snapshot even with a WAL another process is writing — into a temp file
 *    next to the target, then renamed into place, so a crash leaves either no
 *    file or a whole one.
 *  - Registration files are copied the first time the new `modules/` is made,
 *    keeping their modification times (see `readRegistrations` for why that
 *    matters: on an id held in both places, the newer file wins).
 *  - Both present: nothing happens.
 *
 * Nothing under `~/.roadmap` is changed.
 */
export function migrateMachineData(env: Env = process.env): Migration {
  const done: Migration = { frameDb: null, modules: [] }
  const legacy = legacyMachineDir(env)

  if (!env.KEHIKOT_FRAME_DB && !env.ROADMAP_FRAME_DB) {
    const to = frameDbFile(env)
    const from = join(legacy, 'frame.sqlite')
    if (!existsSync(to) && existsSync(from)) {
      mkdirSync(dirname(to), { recursive: true })
      const tmp = `${to}.migrating-${process.pid}`
      rmSync(tmp, { force: true })
      const source = new Database(from, { readonly: true })
      try {
        source.query('VACUUM INTO ?').run(tmp)
      } finally {
        source.close()
      }
      renameSync(tmp, to)
      done.frameDb = { from, to }
    }
  }

  const legacyModules = legacyModulesDir(env)
  if (legacyModules) {
    const to = modulesDir(env)
    if (!existsSync(to) && existsSync(legacyModules)) {
      const tmp = `${to}.migrating-${process.pid}`
      rmSync(tmp, { recursive: true, force: true })
      mkdirSync(tmp, { recursive: true })
      for (const name of readdirSync(legacyModules).sort()) {
        if (!/\.(json|ya?ml)$/i.test(name)) continue
        const file = join(legacyModules, name)
        let stat
        try {
          stat = statSync(file)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        copyFileSync(file, join(tmp, name))
        utimesSync(join(tmp, name), stat.atime, stat.mtime)
        done.modules.push(name)
      }
      renameSync(tmp, to)
    }
  }

  return done
}
