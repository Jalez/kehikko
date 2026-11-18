import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { readBundleInfo } from 'kehikot-module-protocol/bundle'

import { isUnder } from './moduleBuilds.ts'
import type { Official } from './official.ts'
import { splitRemote } from './trackers/sources.ts'
import { startedOnSaid, summaryLines, summarySaid, type DevModule, type Development, type MoveStep, type Tally } from '../src/host/development.ts'

/**
 * "Kehikko development": where the official modules run from — Kehikot's releases, or the person's
 * own folders — and the one path that moves a module from one to the other. The words and the
 * shapes are `src/host/development.ts`.
 *
 * ## The rule
 *
 * Every official module has a place it should run from (`wantsOf`): its development folder when
 * development is on, it has one, and the person has not said "use the release for this one";
 * otherwise its release, `installed/<id>/`. Only official modules that are registered on this
 * computer are ever moved; a module on no list is the person's own business and is never offered.
 *
 * ## Moving a module (`moveOne`)
 *
 *  1. To its release: a release copy is put at `installed/<id>/` when none is there (the install
 *     path: the ready-built bundle, or git when the release has none). To a folder: the folder must
 *     still be there and still be this module's.
 *  2. The registration is pointed at the new folder and the module is started from it (`move`,
 *     the server's: the old one stopped first, as a restart stops it). It must answer.
 *  3. If it does not, the old registration goes back word for word, the old one is started again
 *     when it was running, and the sentence says so.
 *
 * A person's folder is only ever READ here: its `package.json`, its git config, whether `run.sh`
 * is there. Nothing in it is written, moved or removed. Kehikot stops using it, and the summary
 * says which folders it no longer uses, for the person to remove when they want.
 *
 * ## A module set to keep running
 *
 * Kehikot never stops a module whose registration says `keep` (it holds live work), so a move that
 * needs it stopped cannot happen under it. That is not a failure and not forever: the move is
 * DEFERRED (`later`: the summary names the module and says so, and its row in Settings › Development
 * says "Moves at its next restart"), and it happens by itself the next time the module restarts for
 * any reason — an app restart, an update, Restart (`beforeStart`, called by the host just before it
 * starts a module). A person who does not want to wait presses "Move now" (`now`), which restarts
 * the module through the same path as "Restart anyway" and moves it; the page warns first.
 * What was deferred is never stored: it is a `keep` registration that runs from somewhere other
 * than where it should, which a restart of the host finds again by itself.
 *
 * ## Where it is kept
 *
 * Machine-level, in the frame database's `settings` table (`development`): the switch, each
 * module's development folder, and "use the release for this one". Never in a project.
 *
 * ## The first start on a machine
 *
 * No setting yet: every official module registered from a folder outside `installed/` has that
 * folder as its development folder, and development starts ON when there is any — so nothing moves
 * under the person — with one Inbox line saying why and how to turn it off. With none, it is off.
 */

const KEY = 'development'

/** What is kept. */
export interface DevStore {
  on: boolean
  folders: Record<string, { dir: string; release?: true; always?: true }>
  /** The folder each module's registration named when it was last read: a folder is learned from a registration only when that changes. */
  seen?: Record<string, string>
  /** Folders Kehikot stopped using when a module moved to its release, until the person clears them (`unusedFolders.ts`). */
  freed?: string[]
}

export function readDevelopment(db: Database): DevStore | null {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    if (!row) return null
    const stored = JSON.parse(row.value) as unknown
    if (typeof stored !== 'object' || stored === null || typeof (stored as { on?: unknown }).on !== 'boolean') return null
    const raw = (stored as { folders?: unknown }).folders
    const folders: DevStore['folders'] = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, one] of Object.entries(raw as Record<string, unknown>)) {
        const dir = (one as { dir?: unknown } | null)?.dir
        if (typeof dir === 'string' && isAbsolute(dir)) folders[id] = { dir, ...((one as { release?: unknown }).release === true ? { release: true as const } : (one as { always?: unknown }).always === true ? { always: true as const } : {}) }
      }
    }
    const rawSeen = (stored as { seen?: unknown }).seen
    const seen: Record<string, string> = {}
    if (rawSeen && typeof rawSeen === 'object' && !Array.isArray(rawSeen)) for (const [id, dir] of Object.entries(rawSeen as Record<string, unknown>)) if (typeof dir === 'string') seen[id] = dir
    const rawFreed = (stored as { freed?: unknown }).freed
    const freed = Array.isArray(rawFreed) ? rawFreed.filter((dir): dir is string => typeof dir === 'string' && isAbsolute(dir)) : []
    return { on: (stored as { on: boolean }).on, folders, seen, ...(freed.length ? { freed } : {}) }
  } catch {
    return null
  }
}

export function writeDevelopment(db: Database, store: DevStore): void {
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(KEY, JSON.stringify(store))
}

/** One registration, as much as this reads. */
export interface Registered {
  id: string
  dir?: string
  /** The registration says to keep it running: Kehikot does not stop it. */
  keep?: boolean
}

/** `later`: not moved because it is set to keep running and runs now; it moves at its next restart. */
export type Moved = { ok: true } | { ok: false; why: string; restored: boolean; later?: true }

export interface DevelopmentDeps {
  db: Database
  official(): readonly Official[]
  /** `installsDir()`. */
  installsRoot: string
  registrations(): Promise<Registered[]>
  nameOf?(id: string): string | null
  /** Put a release copy of the entry at `installed/<id>/`, when none is there. */
  copy(entry: Official): Promise<{ ok: true } | { ok: false; why: string }>
  /**
   * Point the registration at `dir` and start the module from there; put the old one back when it does not answer.
   * A module set to keep running that is running is not stopped (`later`), unless `now`: a person pressed "Move now".
   */
  move(id: string, dir: string, how?: { now?: boolean }): Promise<Moved>
  /** Point the registration at `dir` and nothing else: the host is about to start the module, and starts it from there. */
  point?(id: string, dir: string): Promise<{ ok: true } | { ok: false; why: string }>
  /** One line in every project's Inbox, by the host. */
  tell(message: string): void
  /** Something a page reads changed. */
  changed?(): void
  /** The home folder: to say paths as `~/…` and to look for checkouts under. */
  home?: string | null
  log?(line: string): void
}

/** Two spellings of one folder. */
function same(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return real(a) === real(b)
}

/** The repository a folder's git config names as `origin`, `owner/repo`, lower case; null when there is none to read. Read, never run. */
function originOf(dir: string): string | null {
  try {
    const config = readFileSync(join(dir, '.git', 'config'), 'utf8')
    const block = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? ''
    const url = /^\s*url\s*=\s*(.+)$/m.exec(block)?.[1]?.trim()
    const found = url ? splitRemote(url) : null
    return found ? found.repo.toLowerCase() : null
  } catch {
    return null
  }
}

/** The name in a folder's `package.json`, or null. */
function packageName(dir: string): string | null {
  try {
    const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}

/**
 * Why `dir` cannot be this module's development folder, or null when it can: a full path to a
 * folder with a `run.sh`, not one of Kehikot's own copies, and this module's — its git `origin` is
 * the entry's repository, or its `package.json` is named as the repository is.
 */
export function folderRefused(entry: Pick<Official, 'name' | 'repo'>, dir: string, installsRoot: string): string | null {
  if (!isAbsolute(dir)) return `${dir} is not a full path.`
  try {
    if (!statSync(dir).isDirectory()) return `${dir} is not a folder.`
  } catch {
    return `${dir} is not there.`
  }
  if (isUnder(dir, installsRoot)) return `${dir} is one of Kehikot’s own copies, not your folder.`
  if (!existsSync(join(dir, 'run.sh'))) return `${dir} has no run.sh, so it is not a module Kehikot can start.`
  const repo = entry.repo.toLowerCase()
  const ofRepo = originOf(dir) === repo || packageName(dir)?.toLowerCase() === basename(repo)
  return ofRepo ? null : `${dir} is not a copy of ${entry.repo}, so it is not ${entry.name}.`
}

/** The release a copy is: its bundle's version, or its `package.json` version; null when neither says. */
export function releaseOf(dir: string): string | null {
  const info = readBundleInfo(dir)
  if (info) return info.version
  try {
    const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** How many folders a look for checkouts reads in one parent, at most. */
const LOOK_LIMIT = 400

/**
 * Folders under `~/Projects` (and `~/projects`) that look like a checkout of each entry: named as
 * its repository is, there or one folder down (`~/Projects/kehikko-modules/kehikko-notes`), and
 * passing `folderRefused`. Only offered; never taken without a press.
 */
export function lookForCheckouts(home: string, entries: readonly Pick<Official, 'id' | 'name' | 'repo'>[], installsRoot: string): Map<string, string> {
  const found = new Map<string, string>()
  const wanted = new Map(entries.map((entry) => [basename(entry.repo).toLowerCase(), entry]))
  const seen = new Set<string>()
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((one) => one.isDirectory() && !one.name.startsWith('.'))
        .slice(0, LOOK_LIMIT)
        .map((one) => one.name)
    } catch {
      return []
    }
  }
  const consider = (dir: string, name: string) => {
    const entry = wanted.get(name.toLowerCase())
    if (!entry || found.has(entry.id)) return
    if (folderRefused(entry, dir, installsRoot) === null) found.set(entry.id, dir)
  }
  let parents: string[] = []
  try {
    parents = readdirSync(home).filter((name) => /^projects$/i.test(name))
  } catch {
    return found
  }
  for (const parent of parents) {
    const root = join(home, parent)
    let real: string
    try {
      real = realpathSync(root)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    for (const name of list(root)) {
      const dir = join(root, name)
      consider(dir, name)
      if (!wanted.has(name.toLowerCase())) for (const inner of list(dir)) consider(join(dir, inner), inner)
    }
  }
  return found
}

export function developmentDesk(deps: DevelopmentDeps) {
  const moves = new Map<string, { step: MoveStep; why: string | null }>()
  const queue: string[] = []
  let moving: Promise<void> | null = null
  let summary: string | null = null
  /** What the run under way has done so far. */
  let tally: Tally = { toRelease: 0, toFolder: 0, failed: [], freed: [] }
  /** Modules a person pressed "Move now" on, until their move is done. */
  const nowFor = new Set<string>()
  /** Modules whose move at a restart did not take, so the next start does not try again by itself. */
  const tried = new Set<string>()
  /** The setting as last read: what `owes` answers from, being asked where nothing can wait. */
  let lastStore: DevStore | null = null
  const home = deps.home ?? null
  const log = deps.log ?? (() => {})

  const nameOf = (id: string) => deps.nameOf?.(id) ?? deps.official().find((one) => one.id === id)?.name ?? id
  const entryOf = (id: string) => deps.official().find((one) => one.id === id) ?? null
  const fromFolder = (dir: string | undefined): dir is string => !!dir && !isUnder(dir, deps.installsRoot)
  const releaseDir = (id: string) => join(deps.installsRoot, id)

  /** Remember folders Kehikot no longer uses, for "Move unused folders to the Trash". */
  function rememberFreed(dirs: readonly string[]): void {
    if (!dirs.length) return
    const store = readDevelopment(deps.db) ?? { on: false, folders: {} }
    const freed = [...(store.freed ?? [])]
    for (const dir of dirs) if (!freed.some((one) => same(one, dir))) freed.push(dir)
    writeDevelopment(deps.db, { ...store, freed })
  }

  /** The official modules registered here, with where each is registered from. */
  async function officialRegistered(): Promise<(Registered & { entry: Official })[]> {
    const out: (Registered & { entry: Official })[] = []
    for (const one of await deps.registrations()) {
      const entry = entryOf(one.id)
      if (entry) out.push({ ...one, entry })
    }
    return out
  }

  /**
   * The setting as it stands, learning what the registrations say: a module registered from a
   * folder has that folder as its development folder. The first time on a machine, the setting is
   * made — on when any module runs from a folder, with one Inbox line — and kept.
   */
  async function current(): Promise<{ store: DevStore; registered: (Registered & { entry: Official })[] }> {
    const registered = await officialRegistered()
    const kept = readDevelopment(deps.db)
    const store: DevStore = kept ?? { on: false, folders: {} }
    lastStore = store
    let changed = kept === null
    store.seen ??= {}
    for (const one of registered) {
      /* Learned once per registration: a folder the person forgot here is not learned again from the registration still naming it. */
      if (!one.dir || store.seen[one.id] === one.dir) continue
      store.seen[one.id] = one.dir
      changed = true
      if (!fromFolder(one.dir)) continue
      const had = store.folders[one.id]
      if (had && same(had.dir, one.dir)) continue
      store.folders[one.id] = { dir: one.dir, ...(had?.release ? { release: true as const } : had?.always ? { always: true as const } : {}) }
    }
    if (kept === null) {
      const onFolders = registered.filter((one) => fromFolder(one.dir)).length
      store.on = onFolders > 0
      writeDevelopment(deps.db, store)
      if (store.on) {
        deps.tell(startedOnSaid(onFolders))
        log(`kehikko: ${onFolders} official module${onFolders === 1 ? '' : 's'} run from your own folders, so Kehikko development starts on`)
      }
    } else if (changed) writeDevelopment(deps.db, store)
    return { store, registered }
  }

  /** Where a module should run from, by the switch and its own choice. */
  function wantsOf(store: DevStore, id: string): 'release' | 'folder' {
    const folder = store.folders[id]
    if (!folder || folder.release) return 'release'
    /* An exemption: "always my folder" holds whatever the switch says. */
    return store.on || folder.always ? 'folder' : 'release'
  }

  /** What a module set to keep running says while it has not moved. */
  const laterWhy = 'It is set to keep running, so Kehikot did not stop it. It moves at its next restart, or press Move now.'

  /** The folders freed and still there. */
  async function unusedCandidates(): Promise<string[]> {
    const store = readDevelopment(deps.db)
    return (store?.freed ?? []).filter((dir) => existsSync(dir))
  }

  /** Who still uses `dir`: a registration naming it, or a module set to run from it. */
  async function usedBy(dir: string): Promise<string | null> {
    const registered = await deps.registrations()
    const named = registered.find((one) => one.dir && same(one.dir, dir))
    if (named) return nameOf(named.id)
    const store = readDevelopment(deps.db)
    if (store) for (const [id, folder] of Object.entries(store.folders)) if (same(folder.dir, dir) && wantsOf(store, id) === 'folder') return nameOf(id)
    return null
  }

  /** Folders cleared: no longer freed, and no longer anyone's development folder. */
  function cleared(dirs: readonly string[]): void {
    const store = readDevelopment(deps.db)
    if (!store) return
    const folders = Object.fromEntries(Object.entries(store.folders).filter(([, one]) => !dirs.some((dir) => same(dir, one.dir))))
    const freed = (store.freed ?? []).filter((one) => !dirs.some((dir) => same(dir, one)))
    writeDevelopment(deps.db, { ...store, folders, freed })
    deps.changed?.()
  }

  async function state(): Promise<Development> {
    const { store, registered } = await current()
    const lacking = store.on && home ? registered.filter((one) => !store.folders[one.id]).map((one) => one.entry) : []
    const found = lacking.length && home ? lookForCheckouts(home, lacking, deps.installsRoot) : new Map<string, string>()
    const modules: DevModule[] = registered
      .filter((one) => !!one.dir)
      .map((one) => {
        const dir = one.dir!
        const folder = store.folders[one.id] ?? null
        const wants = wantsOf(store, one.id)
        const target = wants === 'folder' ? folder?.dir : releaseDir(one.id)
        /* Kept running and not where it should be: it moves at its next restart, whatever a restart of the host forgot. */
        const owed = one.keep === true && !!target && !same(dir, target)
        return {
          id: one.id,
          name: nameOf(one.id),
          runs: fromFolder(dir) ? { from: 'folder' as const, dir } : { from: 'release' as const, version: releaseOf(dir) },
          folder: folder?.dir ?? null,
          release: folder?.release === true,
          mode: folder?.release ? ('release' as const) : folder?.always ? ('folder' as const) : ('follow' as const),
          keeps: one.keep === true,
          wants,
          found: found.get(one.id) ?? null,
          move: moves.get(one.id) ?? (owed ? { step: 'later' as const, why: laterWhy } : null),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    return { on: store.on, home, modules, moving: moving !== null, summary, unused: (await unusedCandidates()).length }
  }

  /** Move one module to where it should run from, when it is not there. */
  async function moveOne(id: string): Promise<void> {
    const { store, registered } = await current()
    const one = registered.find((r) => r.id === id)
    if (!one?.dir) return void moves.delete(id)
    const name = nameOf(id)
    const wants = wantsOf(store, id)
    const target = wants === 'folder' ? store.folders[id]!.dir : releaseDir(id)
    if (same(one.dir, target)) return void moves.delete(id)
    const said = (step: MoveStep, why: string | null = null) => {
      moves.set(id, { step, why })
      deps.changed?.()
    }
    const failed = (why: string, step: MoveStep = 'failed') => {
      said(step, why)
      tally.failed.push({ name, why })
      log(`kehikko: ${id} was not moved to ${target}: ${why}`)
    }
    if (wants === 'release') {
      said('installing')
      const copied = await deps.copy(one.entry).catch((error: unknown) => ({ ok: false as const, why: error instanceof Error ? error.message : String(error) }))
      if (!copied.ok) return failed(`${name}’s release could not be put in place, so it still runs from your folder: ${copied.why}`)
    } else {
      const refused = folderRefused(one.entry, target, deps.installsRoot)
      if (refused) return failed(`${name} still runs from its release: ${refused}`)
    }
    said('starting')
    const now = nowFor.delete(id)
    const moved = await deps.move(id, target, { now }).catch((error: unknown): Moved => ({ ok: false, why: error instanceof Error ? error.message : String(error), restored: false }))
    if (!moved.ok && moved.later) {
      said('later', laterWhy)
      tally.failed.push({ name, why: moved.why, later: true })
      log(`kehikko: ${id} keeps running, so it was not moved to ${target} now; it moves at its next restart`)
      return
    }
    if (!moved.ok) return failed(moved.why, moved.restored ? 'restored' : 'failed')
    said('done')
    log(`kehikko: ${id} now runs from ${target} (was ${one.dir})`)
    if (wants === 'release') {
      tally.toRelease += 1
      /* A folder no other registration names any more is one Kehikot no longer uses. */
      const others = (await deps.registrations()).some((r) => r.id !== id && r.dir && same(r.dir, one.dir!))
      if (fromFolder(one.dir) && !others && !tally.freed.some((dir) => same(dir, one.dir!))) tally.freed.push(one.dir)
    } else {
      tally.toFolder += 1
      tally.freed = tally.freed.filter((dir) => !same(dir, target))
    }
  }

  /** Move these modules (all the official ones registered here when not given), one at a time. */
  async function apply(ids?: readonly string[], how: { now?: boolean } = {}): Promise<void> {
    const names = ids ?? (await officialRegistered()).map((one) => one.id)
    const { store, registered } = await current()
    for (const id of names) {
      const one = registered.find((r) => r.id === id)
      if (!one?.dir) continue
      const target = wantsOf(store, id) === 'folder' ? store.folders[id]!.dir : releaseDir(id)
      if (same(one.dir, target) || queue.includes(id)) continue
      queue.push(id)
      if (how.now) nowFor.add(id)
      moves.set(id, { step: 'waiting', why: null })
    }
    if (moving || !queue.length) return
    if (!moving) {
      tally = { toRelease: 0, toFolder: 0, failed: [], freed: [] }
      /* The exemptions: modules that stay on their own folder whatever the switch says. */
      tally.kept = store.on ? [] : registered.filter((one) => store.folders[one.id]?.always && fromFolder(one.dir) && same(one.dir!, store.folders[one.id]!.dir)).map((one) => nameOf(one.id))
      summary = null
    }
    moving = (async () => {
      try {
        while (queue.length) {
          const id = queue.shift()!
          await moveOne(id).catch((error: unknown) => {
            /* Whatever went wrong, the module is in the summary: nothing that did not move goes unsaid. */
            log(`kehikko: moving ${id} failed: ${String(error)}`)
            const why = error instanceof Error ? error.message : String(error)
            moves.set(id, { step: 'failed', why })
            if (!tally.failed.some((one) => one.name === nameOf(id))) tally.failed.push({ name: nameOf(id), why })
          })
        }
      } finally {
        rememberFreed(tally.freed)
        summary = summarySaid(tally, home)
        moving = null
        /* One Inbox line each, the first the one a person reads first: the Inbox keeps a line only so long (`SUMMARY_LINE_MAX`). */
        for (const line of summaryLines(tally, home).reverse()) deps.tell(line)
        deps.changed?.()
      }
    })()
    deps.changed?.()
  }

  /** The switch. Turning it either way moves every official module to where it then should run from. */
  async function setOn(on: boolean): Promise<void> {
    tried.clear()
    const { store } = await current()
    if (store.on !== on) writeDevelopment(deps.db, { ...store, on })
    await apply()
  }

  /** One module's development folder (null: forget it) or "use the release for this one"; moves it when that changes where it runs. */
  async function setModule(id: string, change: { folder?: string | null; release?: boolean; mode?: 'follow' | 'folder' | 'release'; move?: true; now?: true }): Promise<{ ok: true } | { ok: false; why: string; status: number }> {
    const entry = entryOf(id)
    tried.delete(id)
    if (!entry) return { ok: false, why: `${id} is not on the official module list.`, status: 404 }
    const { store } = await current()
    const folders = { ...store.folders }
    if (change.folder === null) delete folders[id]
    else if (typeof change.folder === 'string') {
      const refused = folderRefused(entry, change.folder, deps.installsRoot)
      if (refused) return { ok: false, why: refused, status: 409 }
      folders[id] = { dir: resolve(change.folder), ...(folders[id]?.release ? { release: true as const } : folders[id]?.always ? { always: true as const } : {}) }
    }
    if (change.mode) {
      const had = folders[id]
      if (!had) return { ok: false, why: `${entry.name} has no folder of yours to follow, so it runs from its release.`, status: 409 }
      folders[id] = change.mode === 'release' ? { dir: had.dir, release: true } : change.mode === 'folder' ? { dir: had.dir, always: true } : { dir: had.dir }
    }
    if (typeof change.release === 'boolean') {
      const had = folders[id]
      if (!had && change.release) return { ok: false, why: `${entry.name} has no folder of yours, so it already runs from its release.`, status: 409 }
      if (had) folders[id] = change.release ? { dir: had.dir, release: true } : { dir: had.dir }
    }
    writeDevelopment(deps.db, { ...store, folders })
    await apply([id], { now: change.now === true })
    return { ok: true }
  }

  /** Whether a module set to keep running owes a move: it runs from somewhere other than where it should. Sync, for the host's starts. */
  function owes(id: string, registration: { dir?: string; keep?: boolean } | null): boolean {
    if (!registration?.dir || registration.keep !== true || !lastStore || tried.has(id) || !entryOf(id)) return false
    const target = wantsOf(lastStore, id) === 'folder' ? lastStore.folders[id]!.dir : releaseDir(id)
    return !same(registration.dir, target)
  }

  /**
   * The host is about to start a module that is not running — after an app restart, an update, Restart
   * or the module ending — and it owes a move (`owes`): put its release in place and point its
   * registration there, so it starts from where it should. Null when there is nothing to do or it
   * could not be done (said). The host starts it, then tells `finish` whether it answered; when it did
   * not, the registration goes back and the host starts the old one.
   */
  async function beforeStart(id: string): Promise<{ dir: string; from: string; finish(answered: boolean, why?: string): Promise<void> } | null> {
    const { store, registered } = await current()
    const one = registered.find((r) => r.id === id)
    if (!one?.dir || !owes(id, one) || !deps.point) return null
    const name = nameOf(id)
    const from = one.dir
    const wants = wantsOf(store, id)
    const target = wants === 'folder' ? store.folders[id]!.dir : releaseDir(id)
    const gave = (why: string) => {
      tried.add(id)
      moves.set(id, { step: 'failed', why })
      deps.tell(`${name} did not move: ${why}`)
      deps.changed?.()
      log(`kehikko: ${id} was not moved at its restart to ${target}: ${why}`)
      return null
    }
    moves.set(id, { step: 'installing', why: null })
    deps.changed?.()
    if (wants === 'release') {
      const copied = await deps.copy(one.entry).catch((error: unknown) => ({ ok: false as const, why: error instanceof Error ? error.message : String(error) }))
      if (!copied.ok) return gave(`${name}’s release could not be put in place, so it still runs from your folder: ${copied.why}`)
    } else {
      const refused = folderRefused(one.entry, target, deps.installsRoot)
      if (refused) return gave(`${name} still runs from its release: ${refused}`)
    }
    const pointed = await deps.point(id, target)
    if (!pointed.ok) return gave(pointed.why)
    moves.set(id, { step: 'starting', why: null })
    deps.changed?.()
    return {
      dir: target,
      from,
      async finish(answered, why) {
        if (!answered) {
          await deps.point?.(id, from)
          tried.add(id)
          const said = `${name} did not start from ${target}, so it was put back on ${from}${why ? `: ${why}` : '.'}`
          moves.set(id, { step: 'restored', why: said })
          deps.tell(said)
          deps.changed?.()
          return
        }
        moves.set(id, { step: 'done', why: null })
        log(`kehikko: ${id} now runs from ${target} (was ${from}), moved at its restart`)
        const others = (await deps.registrations()).some((r) => r.id !== id && r.dir && same(r.dir, from))
        const lines = summaryLines(
          wants === 'release'
            ? { toRelease: 1, toFolder: 0, failed: [], freed: fromFolder(from) && !others ? [from] : [] }
            : { toRelease: 0, toFolder: 1, failed: [], freed: [] },
          home,
        )
        if (wants === 'release' && fromFolder(from) && !others) rememberFreed([from])
        for (const line of lines.reverse()) deps.tell(line)
        deps.changed?.()
      },
    }
  }

  /** Make the setting now, at the host's start: the first time, that is when the Inbox is told. */
  async function boot(): Promise<void> {
    await current()
  }

  /** Resolves once nothing is being moved. */
  async function idle(): Promise<void> {
    while (moving) await moving
  }

  return { state, setOn, setModule, apply, boot, idle, wantsOf, owes, beforeStart, unusedCandidates, usedBy, cleared }
}

export type DevelopmentDesk = ReturnType<typeof developmentDesk>

/**
 * A registration pointed at another folder: the file merged (every other key, `keep` above all,
 * kept), written beside itself and renamed into place so a sweep never reads half of one. Returns
 * what the file said before, word for word, to put back.
 */
export function pointRegistrationAt(file: string, dir: string): { ok: true; before: string } | { ok: false; why: string } {
  let before: string
  let parsed: unknown
  try {
    before = readFileSync(file, 'utf8')
    parsed = JSON.parse(before)
  } catch {
    return { ok: false, why: `${file} could not be read.` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, why: `${file} is not a registration.` }
  writeWhole(file, `${JSON.stringify({ ...(parsed as Record<string, unknown>), dir }, null, 2)}\n`)
  return { ok: true, before }
}

/** A registration put back as it was. */
export function restoreRegistration(file: string, before: string): void {
  writeWhole(file, before)
}

function writeWhole(file: string, text: string): void {
  const temporary = `${file}.moving-${process.pid}`
  writeFileSync(temporary, text)
  renameSync(temporary, file)
}
