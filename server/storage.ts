import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { HOST_FOLDER, KEHIKOT_DIR, LEGACY_HOST_FOLDER, moduleFolder, PROJECT_FILE } from 'kehikot-module-protocol'

import {
  HOST_NAME,
  totalsByModule,
  type MachineKey,
  type MachinePart,
  type Owner,
  type ProjectStorage,
  type Share,
  type Sized,
  type StorageReport,
  type Tally,
} from '../src/host/storage.ts'
import { HOST_ID } from './kehikot.ts'
import {
  browserProfileDir,
  frameDbFile,
  installsDir,
  logsDir,
  machineDir,
  modulesDir,
  officialListFile,
  versionsDir,
} from './machineDirs.ts'

/**
 * The storage overview: how much room every module's data takes in every
 * project this host knows, and how much the host's own machine-level data
 * takes. Shapes and words are in `src/host/storage.ts`.
 *
 * ## Read-only, and bounded
 *
 * Nothing here writes, moves or deletes. The walk:
 *
 *  - never follows a symbolic link (counted, not entered), and only descends
 *    into a directory it found by name under the root it was given, so it
 *    stays inside each root;
 *  - stops when a budget runs out — a time limit and a number of entries for
 *    the whole report — and marks what it had not finished as `cut`, so a
 *    person reads "at least" rather than a number that looks exact;
 *  - is asynchronous and asked for only when somebody opens the view or calls
 *    the door's `storage` tool, so it never runs at startup;
 *  - is cached briefly, and two asks at once share one walk.
 */

export interface Budget {
  /** Milliseconds for the whole report. */
  ms: number
  /** Directory entries for the whole report. */
  entries: number
}

export const BUDGET: Budget = { ms: 5_000, entries: 250_000 }
/** How long a report is answered from memory. */
export const FRESH_FOR_MS = 30_000
/** How many of the largest files are named per folder. */
const LARGEST = 5

/** The budget as it is spent. One per report. */
export class Walk {
  readonly #deadline: number
  #left: number
  cut = false
  constructor(budget: Budget, now: () => number) {
    this.#deadline = now() + budget.ms
    this.#left = budget.entries
    this.now = now
  }
  readonly now: () => number
  /** Spend one entry; false (and `cut`) once the budget is gone. */
  spend(): boolean {
    if (this.cut) return false
    this.#left -= 1
    if (this.#left < 0 || this.now() > this.#deadline) this.cut = true
    return !this.cut
  }
}

const empty = (): Tally => ({ bytes: 0, files: 0, largest: [], modified: null, links: 0, cut: false })

function keepLargest(largest: Sized[], file: Sized): void {
  if (largest.length >= LARGEST && file.bytes <= largest[largest.length - 1]!.bytes) return
  largest.push(file)
  largest.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
  if (largest.length > LARGEST) largest.length = LARGEST
}

/** Several tallies as one. */
export function merged(tallies: readonly Tally[]): Tally {
  const out = empty()
  for (const one of tallies) {
    out.bytes += one.bytes
    out.files += one.files
    out.links += one.links
    out.cut ||= one.cut
    if (one.modified !== null) out.modified = Math.max(out.modified ?? 0, one.modified)
    for (const file of one.largest) keepLargest(out.largest, file)
  }
  return out
}

/**
 * What is at `path`, a file or a folder walked to the bottom, or null when
 * nothing is there. A symbolic link at `path` itself is not followed either.
 * Largest files are named `prefix` + their path below `path`.
 */
export async function tally(path: string, walk: Walk, prefix = ''): Promise<Tally | null> {
  const top = await lstat(path).catch(() => null)
  if (!top) return null
  const out = empty()
  if (top.isSymbolicLink()) {
    out.links = 1
    return out
  }
  if (!top.isDirectory()) {
    if (!walk.spend()) {
      out.cut = true
      return out
    }
    count(out, prefix.replace(/\/$/, '') || path.split('/').pop() || path, top.size, top.mtimeMs)
    return out
  }
  const stack: string[] = ['']
  while (stack.length) {
    const rel = stack.pop()!
    const entries = await readdir(join(path, rel), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!walk.spend()) {
        out.cut = true
        return out
      }
      const below = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        out.links += 1
      } else if (entry.isDirectory()) {
        stack.push(below)
      } else if (entry.isFile()) {
        const stat = await lstat(join(path, below)).catch(() => null)
        if (stat?.isFile()) count(out, `${prefix}${below}`, stat.size, stat.mtimeMs)
      }
    }
  }
  return out
}

function count(out: Tally, path: string, bytes: number, modified: number): void {
  out.bytes += bytes
  out.files += 1
  out.modified = Math.max(out.modified ?? 0, modified)
  keepLargest(out.largest, { path, bytes })
}

/** The modules this host can name: registered ones first, then the official list. */
export interface Named {
  id: string
  name: string
}

/**
 * Whose a folder under `.kehikot/` is. The host's own folder (and its folder
 * from before 2.2.0) and `project.json` are Kehikot's; a module's folder is
 * named after its id (`moduleFolder`), so the registry is asked rather than the
 * name rebuilt. A folder nobody claims is named as it is.
 */
export function ownerOf(folder: string, modules: readonly Named[]): Owner {
  if (folder === HOST_FOLDER || folder === LEGACY_HOST_FOLDER || folder === PROJECT_FILE) return { id: HOST_ID, name: HOST_NAME }
  for (const module of modules) {
    try {
      if (moduleFolder(module.id) === folder) return { id: module.id, name: module.name }
    } catch {
      /* An id that names no folder keeps none. */
    }
  }
  return { id: null, name: folder }
}

/** A machine part kept one folder per module id (`versions/`, `installed/`). */
function ownerById(id: string, modules: readonly Named[]): Owner {
  const found = modules.find((module) => module.id === id)
  return found ? { id: found.id, name: found.name } : { id: null, name: id }
}

export interface Measured {
  id: number
  name: string
  path: string
  missing: boolean
}

export interface Locations {
  machine: string
  frame: string
  registry: string
  officialList: string
  versions: string
  installed: string
  browserProfile: string
  logs: string
}

export function locations(): Locations {
  return {
    machine: machineDir(),
    frame: frameDbFile(),
    registry: modulesDir(),
    officialList: officialListFile(),
    versions: versionsDir(),
    installed: installsDir(),
    browserProfile: browserProfileDir(),
    logs: logsDir(),
  }
}

async function measureProject(project: Measured, modules: readonly Named[], walk: Walk): Promise<ProjectStorage> {
  const root = join(project.path, KEHIKOT_DIR)
  const top = await readdir(root, { withFileTypes: true }).catch(() => [])
  const byOwner = new Map<string, { folder: string; owner: Owner; tallies: Tally[] }>()
  let links = 0
  for (const entry of top) {
    if (entry.isSymbolicLink()) {
      links += 1
      continue
    }
    const owner = ownerOf(entry.name, modules)
    const folder = owner.id === HOST_ID ? HOST_FOLDER : entry.name
    const key = owner.id ?? `folder:${entry.name}`
    const measured = await tally(join(root, entry.name), walk, entry.isDirectory() ? `${entry.name}/` : entry.name)
    if (!measured) continue
    const group = byOwner.get(key) ?? { folder, owner, tallies: [] }
    group.tallies.push(measured)
    byOwner.set(key, group)
  }
  const shares: Share[] = [...byOwner.values()]
    .map((group) => ({ folder: group.folder, owner: group.owner, tally: merged(group.tallies) }))
    .sort((a, b) => b.tally.bytes - a.tally.bytes || a.owner.name.localeCompare(b.owner.name))
  const total = merged(shares.map((share) => share.tally))
  total.links += links
  return { id: project.id, name: project.name, path: project.path, total, shares }
}

async function perModule(dir: string, modules: readonly Named[], walk: Walk): Promise<MachinePart['modules']> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: NonNullable<MachinePart['modules']> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const measured = await tally(join(dir, entry.name), walk, `${entry.name}/`)
    if (measured) out.push({ folder: entry.name, owner: ownerById(entry.name, modules), tally: measured })
  }
  return out.sort((a, b) => b.tally.bytes - a.tally.bytes || a.owner.name.localeCompare(b.owner.name))
}

async function measureMachine(at: Locations, modules: readonly Named[], walk: Walk): Promise<StorageReport['machine']> {
  const part = async (key: MachineKey, label: string, path: string, split = false): Promise<MachinePart> => {
    const measured = await tally(path, walk)
    const out: MachinePart = { key, label, path, tally: measured }
    if (split && measured) out.modules = await perModule(path, modules, walk)
    return out
  }
  /* The database and its write-ahead log and shared memory, as one. */
  const frameParts = (await Promise.all(['', '-wal', '-shm'].map((suffix) => tally(`${at.frame}${suffix}`, walk)))).filter(
    (one): one is Tally => one !== null,
  )
  const parts: MachinePart[] = [
    { key: 'frame', label: 'Kehikot’s own database (kehikot, inbox, remembered names)', path: at.frame, tally: frameParts.length ? merged(frameParts) : null },
    await part('installed', 'Installed modules (their program code)', at.installed, true),
    await part('versions', 'Module versions prepared for pinning', at.versions, true),
    await part('browser-profile', 'The Browser module’s profile (its logins and cache)', at.browserProfile),
    await part('logs', 'Logs of the modules Kehikot starts', at.logs),
    await part('registry', 'The module registry', at.registry),
    await part('official-list', 'The official module list, as last read', at.officialList),
  ]
  const bytes = parts.reduce((sum, one) => sum + (one.tally?.bytes ?? 0), 0)
  return { path: at.machine, bytes, parts }
}

/** One whole report: every project that is there, then the machine. */
export async function measure(
  projects: readonly Measured[],
  modules: readonly Named[],
  options: { budget?: Budget; at?: Locations; now?: () => number } = {},
): Promise<StorageReport> {
  const now = options.now ?? Date.now
  const started = now()
  const walk = new Walk(options.budget ?? BUDGET, now)
  const measured: ProjectStorage[] = []
  const missing: StorageReport['missing'] = []
  for (const project of projects) {
    if (project.missing) {
      missing.push({ id: project.id, name: project.name, path: project.path })
      continue
    }
    measured.push(await measureProject(project, modules, walk))
  }
  const machine = await measureMachine(options.at ?? locations(), modules, walk)
  return {
    at: started,
    took: now() - started,
    cut: walk.cut,
    projects: measured.sort((a, b) => b.total.bytes - a.total.bytes || a.name.localeCompare(b.name)),
    missing,
    modules: totalsByModule(measured),
    machine,
  }
}

/**
 * The report, cached for `FRESH_FOR_MS`. `fresh` measures again (still one walk
 * at a time). The inputs are read at each measuring, so a project added a
 * moment ago is in the next fresh report.
 */
export function storageDesk(source: {
  projects(): readonly Measured[]
  modules(): Promise<readonly Named[]>
  budget?: Budget
  at?: () => Locations
  now?: () => number
}): { read(fresh?: boolean): Promise<StorageReport> } {
  const now = source.now ?? Date.now
  let last: StorageReport | null = null
  let running: Promise<StorageReport> | null = null
  return {
    read(fresh = false) {
      if (running) return running
      if (!fresh && last && now() - last.at < FRESH_FOR_MS) return Promise.resolve(last)
      running = (async () => {
        try {
          last = await measure(source.projects(), await source.modules(), {
            budget: source.budget,
            at: source.at?.(),
            now,
          })
          return last
        } finally {
          running = null
        }
      })()
      return running
    },
  }
}
