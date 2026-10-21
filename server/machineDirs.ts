import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where this machine's own Kehikot state lives — spelled once, here.
 *
 * Six things are machine-level rather than project-level: the canvases cache
 * (`frame.sqlite`), the module registry (`modules/<id>.json`), the module
 * versions a container can be pinned to (`versions/`), the modules installed
 * from the app (`installed/`), the last official module list read from where
 * it is published (`official-modules.json`) and the person's own list of
 * modules added from a repository (`my-modules.json`). Everything else belongs
 * under `<project>/.kehikot/`.
 *
 * They live in `~/Library/Application Support/Kehikot/` on macOS (the place
 * the platform keeps an app's own data), and `$XDG_DATA_HOME/kehikot` (default
 * `~/.local/share/kehikot`) elsewhere.
 *
 * ## Environment
 *
 * `KEHIKOT_FRAME_DB` and `KEHIKOT_MODULES_DIR` point either one somewhere else
 * (tests, scratch hosts).
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

/** The canvases cache. `KEHIKOT_FRAME_DB` overrides it. */
export function frameDbFile(env: Env = process.env): string {
  return env.KEHIKOT_FRAME_DB || join(machineDir(env), 'frame.sqlite')
}

/** The module registry. `KEHIKOT_MODULES_DIR` overrides it. */
export function modulesDir(env: Env = process.env): string {
  return env.KEHIKOT_MODULES_DIR || join(machineDir(env), 'modules')
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
 * Where the output of the modules this host starts is kept, one file per
 * module — see `server/moduleLog.ts`. `~/Library/Logs/Kehikot` on macOS, where
 * Console looks; beside the rest of the machine's Kehikot state elsewhere.
 * `KEHIKOT_LOGS_DIR` overrides it (tests, scratch hosts).
 */
export function logsDir(env: Env = process.env, platform: string = process.platform): string {
  if (env.KEHIKOT_LOGS_DIR) return env.KEHIKOT_LOGS_DIR
  if (platform === 'darwin') return join(home(env), 'Library', 'Logs', 'Kehikot')
  return join(machineDir(env, platform), 'logs')
}

/**
 * Where modules installed from the app are cloned — official ones and the
 * person's own (`myModulesFile`): one checkout per module id, `installed/<id>/` — see `server/installs.ts`. Machine-level for
 * `versionsDir`'s reason: it is program code, and it must never land in
 * somebody's own working copy. `KEHIKOT_INSTALLS_DIR` overrides it.
 */
export function installsDir(env: Env = process.env): string {
  return env.KEHIKOT_INSTALLS_DIR || join(machineDir(env), 'installed')
}

/**
 * The last official module list this host read from where it is published —
 * see `server/officialSource.ts`. One small file beside the rest: it is what
 * the app knows about which modules exist, not anything of a project's, and a
 * host started offline reads it to still offer what it saw before.
 * `KEHIKOT_OFFICIAL_CACHE` overrides it (tests, scratch hosts).
 */
export function officialListFile(env: Env = process.env): string {
  return env.KEHIKOT_OFFICIAL_CACHE || join(machineDir(env), 'official-modules.json')
}

/**
 * Which protocol package each Kehikot app release shipped, as last read from
 * the app tags of the host's repository — see `server/appProtocols.ts`. One
 * small file beside the official list's cache, so a host started offline can
 * still say which Kehikot a module release works with.
 * `KEHIKOT_APP_PROTOCOLS_CACHE` overrides it (tests, scratch hosts).
 */
export function appProtocolsFile(env: Env = process.env): string {
  return env.KEHIKOT_APP_PROTOCOLS_CACHE || join(machineDir(env), 'app-protocols.json')
}

/**
 * "My modules": the modules this person added from a repository, private or
 * not, that are on no official list — see `server/myModules.ts`. One small
 * file beside the official list's cache. It is this machine's alone: never
 * published, never proposed, never read by another install, and nothing in it
 * leaves the machine. `KEHIKOT_MY_MODULES` overrides it (tests, scratch hosts).
 */
export function myModulesFile(env: Env = process.env): string {
  return env.KEHIKOT_MY_MODULES || join(machineDir(env), 'my-modules.json')
}

/**
 * Per-install secrets one module presents to another, one file each, readable
 * only by the user: today Review's Factory key, `keys/review-factory.key`
 * (kehikko-review, created on its first start). Machine-level because it
 * belongs to this install, not to any project, and must never be committed.
 * `KEHIKOT_KEYS_DIR` overrides it (tests, scratch hosts).
 */
export function keysDir(env: Env = process.env, platform: string = process.platform): string {
  return env.KEHIKOT_KEYS_DIR || join(machineDir(env, platform), 'keys')
}

/**
 * Factory's per-author re-review rules (`factory/author-rules.json`,
 * kehikko-factory): a person's rule for when an author's work is ready for
 * another look holds in every project, so it is the machine's, not one
 * project's. `KEHIKOT_FACTORY_DIR` overrides it (tests, scratch hosts).
 */
export function factoryDir(env: Env = process.env, platform: string = process.platform): string {
  return env.KEHIKOT_FACTORY_DIR || join(machineDir(env, platform), 'factory')
}

/**
 * Where the Browser module keeps its Chromium profile, so its logins survive a
 * restart (kehikko-browser `browser/engine.ts`, `profileDir`). Not this host's
 * to write: the host only measures it for the storage overview
 * (`server/storage.ts`). `KEHIKOT_BROWSER_PROFILE` points it elsewhere (tests).
 */
export function browserProfileDir(env: Env = process.env): string {
  return env.KEHIKOT_BROWSER_PROFILE || join(machineDir(env), 'browser-profile') // kehikot-storage: allow the Browser module's profile, measured read-only for the storage overview
}
