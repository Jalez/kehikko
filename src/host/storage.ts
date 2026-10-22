/**
 * How much room Kehikot's data takes on this machine: every module's folder in
 * every project, and the host's own machine-level data. The shapes and the
 * words, shared by the page (`src/canvas/Storage.tsx`) and the server, which
 * computes the report (`server/storage.ts`) and says it at the door (`storage`
 * in `server/mcp.ts`). One set of sentences, so the page and an agent are told
 * the same thing.
 *
 * Read-only throughout. Clearing a module's data is that module's own job: the
 * host says how much there is and, where a module offers one, points at the
 * module's own storage view. It never deletes anything.
 */

/** A file, by its path relative to what was measured. */
export interface Sized {
  path: string
  bytes: number
}

/** What one folder (or file) holds, as far as the walk got. */
export interface Tally {
  bytes: number
  files: number
  /** The largest files, largest first, by path relative to the project's `.kehikot/` (or the machine part). */
  largest: Sized[]
  /** The newest modification time of any file counted, ms since the epoch; null with no files. */
  modified: number | null
  /** Symbolic links met and not followed. */
  links: number
  /** Whether the time or size budget ran out before the walk finished: the numbers are at least this. */
  cut: boolean
}

/** Who a folder belongs to: a module by id and its name, Kehikot itself, or nobody this host knows. */
export interface Owner {
  /** The module id, `kehikko` for the host's own, null for a folder no module this host knows claims. */
  id: string | null
  name: string
}

/** One folder (or the host's files) under a project's `.kehikot/`. */
export interface Share {
  /** The folder's name under `.kehikot/` (`host` for the host's own, which also counts `project.json`). */
  folder: string
  owner: Owner
  tally: Tally
}

export interface ProjectStorage {
  id: number
  name: string
  path: string
  /** All of `.kehikot/`. */
  total: Tally
  /** Largest first. */
  shares: Share[]
}

/** A module's data, added up over every project that has some. */
export interface ModuleTotal {
  id: string | null
  name: string
  bytes: number
  files: number
  /** How many projects have a folder of this module's. */
  projects: number
  cut: boolean
}

export type MachineKey = 'frame' | 'registry' | 'official-list' | 'versions' | 'installed' | 'browser-profile' | 'logs'

/** One kind of machine-level data. */
export interface MachinePart {
  key: MachineKey
  label: string
  path: string
  /** Null when there is nothing at that path. */
  tally: Tally | null
  /** Per module, for the parts kept per module (`versions/`, `installed/`). Largest first. */
  modules?: { folder: string; owner: Owner; tally: Tally }[]
}

export interface StorageReport {
  /** When it was measured, ms since the epoch. */
  at: number
  /** How long the measuring took, ms. */
  took: number
  /** Whether the budget ran out anywhere. */
  cut: boolean
  projects: ProjectStorage[]
  /** Projects whose folder is gone: not measured. */
  missing: { id: number; name: string; path: string }[]
  /** Per module across projects, largest first. Kehikot's own files are one of them. */
  modules: ModuleTotal[]
  machine: { path: string; bytes: number; parts: MachinePart[] }
}

/** The name the host's own data is listed under. */
export const HOST_NAME = 'Kehikot'

/**
 * Bytes as a person reads them: "0 bytes", "1 byte", "812 bytes", "2.4 KB",
 * "18 MB", "1.2 GB". Powers of 1000, as the Finder counts.
 */
export function bytesSaid(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes < 1000) return `${Math.round(bytes)} byte${Math.round(bytes) === 1 ? '' : 's'}`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  const shown = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
  return `${shown} ${units[unit]}`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "1 file", "1,204 files". */
export function filesSaid(files: number): string {
  return `${files.toLocaleString('en-US')} ${files === 1 ? 'file' : 'files'}`
}

/** "2.4 MB in 12 files", with "at least" when the walk was cut short. */
export function tallySaid(tally: Tally): string {
  return `${tally.cut ? 'at least ' : ''}${bytesSaid(tally.bytes)} in ${filesSaid(tally.files)}`
}

/** "Checklist: 2.4 MB across 3 projects". */
export function moduleTotalSaid(total: ModuleTotal): string {
  return `${total.name}: ${total.cut ? 'at least ' : ''}${bytesSaid(total.bytes)} across ${plural(total.projects, 'project')}`
}

/** "changed 20 Oct 2026", or "" with nothing counted. */
export function modifiedSaid(modified: number | null): string {
  if (modified === null) return ''
  const date = new Date(modified)
  return `last changed ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
}

/** The sentence a cut walk adds, said once for the report. */
export const CUT_SAID =
  'Measuring stopped at its time or size limit, so some numbers are lower than what is on disk; they are marked "at least".'

/** The sentence that says what this view does not do. */
export const READ_ONLY_SAID =
  'This view only measures. Clearing a module’s data is done in that module, where it knows what the data is.'

/** Summed over the projects, largest first: one row per module (and one for Kehikot). */
export function totalsByModule(projects: readonly ProjectStorage[]): ModuleTotal[] {
  const totals = new Map<string, ModuleTotal>()
  for (const project of projects) {
    for (const share of project.shares) {
      const key = share.owner.id ?? `folder:${share.folder}`
      const was = totals.get(key) ?? { id: share.owner.id, name: share.owner.name, bytes: 0, files: 0, projects: 0, cut: false }
      was.bytes += share.tally.bytes
      was.files += share.tally.files
      was.projects += 1
      was.cut ||= share.tally.cut
      totals.set(key, was)
    }
  }
  return [...totals.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
}

/**
 * The whole report in words, for the door's `storage` tool: per module across
 * projects, per project with its folders, then the machine's own data.
 */
export function storageText(report: StorageReport): string {
  const lines: string[] = []
  const all = report.projects.reduce((sum, project) => sum + project.total.bytes, 0)
  lines.push(
    `Kehikot data in ${plural(report.projects.length, 'project')}: ${bytesSaid(all)}. `
      + `Kehikot’s own machine data: ${bytesSaid(report.machine.bytes)}. Measured ${new Date(report.at).toISOString()}.`,
  )
  if (report.cut) lines.push(CUT_SAID)
  lines.push('', 'Per module, across projects:')
  if (report.modules.length === 0) lines.push('  (no module has data in any project)')
  for (const total of report.modules) lines.push(`  ${moduleTotalSaid(total)} (${filesSaid(total.files)})`)
  for (const project of report.projects) {
    lines.push('', `Project ${project.name} (${project.path}): ${tallySaid(project.total)}${project.total.modified ? `, ${modifiedSaid(project.total.modified)}` : ''}.`)
    if (project.shares.length === 0) lines.push('  No .kehikot/ data here.')
    for (const share of project.shares) {
      const whose = share.owner.id === null ? `${share.folder}/ (no module this host knows claims it)` : `${share.owner.name} (.kehikot/${share.folder}/)`
      const big = share.tally.largest.slice(0, 3).map((file) => `${file.path} ${bytesSaid(file.bytes)}`)
      lines.push(`  ${whose}: ${tallySaid(share.tally)}${big.length ? `; largest: ${big.join(', ')}` : ''}.`)
    }
  }
  for (const gone of report.missing) {
    lines.push('', `Project ${gone.name} (${gone.path}): its folder is gone, so it was not measured.`)
  }
  lines.push('', `Machine data (${report.machine.path}):`)
  for (const part of report.machine.parts) {
    lines.push(`  ${part.label} (${part.path}): ${part.tally ? tallySaid(part.tally) : 'nothing there'}.`)
    for (const one of part.modules ?? []) lines.push(`    ${one.owner.name}: ${tallySaid(one.tally)}.`)
  }
  lines.push('', READ_ONLY_SAID)
  return lines.join('\n')
}

/**
 * Where a module offers its own storage view: a `switch` or `go` item in its
 * header with an option whose id is `storage`. The press that opens it, or null.
 * Read from the header the module declared on this page, so only a module on
 * the open kehikko can be taken there.
 */
export function storageViewOf(
  items: readonly { kind: string; id: string; options?: readonly { id: string }[] }[] | undefined,
): { item: string; value: string } | null {
  for (const item of items ?? []) {
    if ((item.kind === 'switch' || item.kind === 'go') && item.options?.some((option) => option.id === 'storage')) {
      return { item: item.id, value: 'storage' }
    }
  }
  return null
}

/* ---- reaching the storage overview from anywhere on the page ---- */

const OPEN_STORAGE_EVENT = 'kehikot:storage'

/** Open the storage overview (the projects menu's "storage…"), wherever it is mounted. */
export function openStorage(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_STORAGE_EVENT))
}

/** Listen for `openStorage`. Returns the unlisten. */
export function onOpenStorage(then: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(OPEN_STORAGE_EVENT, then)
  return () => window.removeEventListener(OPEN_STORAGE_EVENT, then)
}
