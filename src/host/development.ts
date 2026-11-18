import { z } from 'zod'

/**
 * "Kehikko development": the one switch that says where the official modules run from, and the words
 * a person reads about it. Shared by the page (Settings › Modules, the modules list) and the server
 * (`server/development.ts`, which holds the rule and does the moving).
 *
 * ## From the person's side
 *
 * Almost everybody wants every module to run from Kehikot's releases: ready-built, small, updated
 * by themselves, nothing to think about. Somebody who works on a module wants that one module to run
 * from their own folder while they do. So: one switch, off by default. Off, every official module
 * runs from its release. On, the modules that have a development folder run from it, and the rest
 * from their releases — and any one of them can still be put back on its release.
 *
 * A module's development folder is learned, never assumed: from a registration that already named
 * the person's folder (what `bun run register` in a checkout writes), or from a folder the person
 * picks. Folders that look like a module's checkout are only offered.
 */

/** Where a module runs from now, as its registration says. */
export const runsSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('release'), version: z.string().nullable() }),
  z.object({ from: z.literal('folder'), dir: z.string() }),
])
export type Runs = z.infer<typeof runsSchema>

/** How a module's move is going, while a switch runs and after. */
export const moveStepSchema = z.enum(['waiting', 'installing', 'starting', 'done', 'failed', 'restored', 'later'])
export type MoveStep = z.infer<typeof moveStepSchema>

export const devModuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  runs: runsSchema,
  /** The module's development folder, when it has one. */
  folder: z.string().nullable(),
  /** "Use the release for this one", while development is on. */
  release: z.boolean(),
  /** The module's own choice: follow the switch, always its folder (an exemption), or always its release. */
  mode: z.enum(['follow', 'folder', 'release']).default('follow'),
  /** Whether the module is set to keep running: Kehikot does not stop it, so it moves at its next restart or on "Move now". */
  keeps: z.boolean(),
  /** Where it should run from, by the switch and its own choice. */
  wants: z.enum(['release', 'folder']),
  /** A folder on this computer that looks like this module's checkout: offered, never assumed. */
  found: z.string().nullable(),
  move: z.object({ step: moveStepSchema, why: z.string().nullable() }).nullable(),
})
export type DevModule = z.infer<typeof devModuleSchema>

export const developmentSchema = z.object({
  on: z.boolean(),
  /** The home folder, to say paths under it as `~/…`. */
  home: z.string().nullable(),
  modules: z.array(devModuleSchema),
  /** Whether modules are being moved now. */
  moving: z.boolean(),
  /** What the last switch came to, in a sentence or two; null before any. */
  summary: z.string().nullable(),
  /** How many folders Kehikot no longer uses and the person has not cleared (`unusedFolders.ts`). */
  unused: z.number().default(0),
})
export type Development = z.infer<typeof developmentSchema>

/** The switch, as Settings › Modules says it. */
export const DEVELOPMENT = {
  label: 'Kehikko development',
  description: 'Off: every module runs from Kehikot’s releases. On: modules you develop run from your own folders.',
} as const

/** A path as a person reads it: under their home folder as `~/…`. */
export function pathSaid(dir: string, home: string | null): string {
  if (home && (dir === home || dir.startsWith(`${home}/`))) return `~${dir.slice(home.length)}`
  return dir
}

/** Where a module runs from, in a few words: "Release 1.6.1", "Your folder ~/projects/kehikko-notes". */
export function runsSaid(runs: Runs, home: string | null): string {
  if (runs.from === 'release') return runs.version ? `Release ${runs.version.replace(/^v/, '')}` : 'Release'
  return `Your folder ${pathSaid(runs.dir, home)}`
}

/** Whether a module runs from somewhere other than where it should: a folder while it wants its release, or the reverse. */
export function drifted(one: Pick<DevModule, 'runs' | 'wants'>): boolean {
  return one.runs.from !== one.wants
}

/** Whether the modules list says where a module runs from: while development is on, or when a module runs from a folder it should not. */
export function showsRuns(on: boolean, one: Pick<DevModule, 'runs' | 'wants'>): boolean {
  return on || one.runs.from === 'folder'
}

/** The three choices of a module, as its row says them. */
export const MODES: ReadonlyArray<{ mode: 'follow' | 'folder' | 'release'; label: string }> = [
  { mode: 'follow', label: 'Follow the switch' },
  { mode: 'folder', label: 'Always my folder' },
  { mode: 'release', label: 'Always the release' },
]

/** The one Inbox line a machine with modules on the person's folders starts with. */
export function startedOnSaid(count: number): string {
  return `Kehikko development is on because ${count} module${count === 1 ? '' : 's'} run${count === 1 ? 's' : ''} from your own folders. Turn it off in Settings › Modules to run them all from Kehikot’s releases.`
}

/** What did not move, and why: `later` is a module set to keep running, which Kehikot does not stop for this. */
export interface Unmoved {
  name: string
  why: string
  later?: boolean
}

/** What a finished switch came to. */
export interface Tally {
  toRelease: number
  toFolder: number
  failed: Unmoved[]
  freed: string[]
  /** Modules exempt from the switch: kept on their own folders. */
  kept?: string[]
}

/** The most one line of the summary says: what the Inbox keeps of a notice (`DETAIL_MAX` in `inbox.ts`), so none of it is cut off. */
export const SUMMARY_LINE_MAX = 400

/** The words for a module set to keep running: it is moved at its next restart, or by a press. */
export const MOVES_LATER = 'it is set to keep running, so Kehikot did not stop it. It moves by itself the next time it restarts, or press Move now in Settings › Modules.'

/** What a module that did not move says, in words: its name first. */
export function unmovedSaid(one: Unmoved): string {
  if (one.later) return `${one.name} did not move yet: ${MOVES_LATER}`
  return one.why.startsWith(one.name) ? one.why : `${one.name} did not move: ${one.why}`
}

const clip = (line: string) => (line.length > SUMMARY_LINE_MAX ? `${line.slice(0, SUMMARY_LINE_MAX - 1)}…` : line)

/**
 * What a finished switch came to, as lines the Inbox can hold whole: how many moved where; EVERY module that
 * did not move, one line each with its reason; and which folders are no longer used. The Inbox keeps
 * `SUMMARY_LINE_MAX` characters of a line, so the folders go in lines of their own after what did not
 * move — one long line used to push that out of sight.
 */
export function summaryLines(done: Tally, home: string | null): string[] {
  const lines: string[] = []
  const heads: string[] = []
  if (done.toRelease) heads.push(`${done.toRelease} module${done.toRelease === 1 ? '' : 's'} now run${done.toRelease === 1 ? 's' : ''} from Kehikot’s releases.`)
  if (done.toFolder) heads.push(`${done.toFolder} module${done.toFolder === 1 ? '' : 's'} now run${done.toFolder === 1 ? 's' : ''} from your own folder${done.toFolder === 1 ? '' : 's'}.`)
  if (done.failed.length) heads.push(`${done.failed.length} did not move.`)
  if (heads.length) lines.push(heads.join(' '))
  for (const one of done.failed) lines.push(unmovedSaid(one))
  const folders = done.freed.map((dir) => pathSaid(dir, home))
  if (folders.length === 1) lines.push(`Your folder ${folders[0]} is no longer used by Kehikot; you can remove it.`)
  else if (folders.length > 1) {
    let line = 'These folders are no longer used by Kehikot; you can remove them:'
    for (const folder of folders) {
      const next = `${line}${line.endsWith(':') ? ' ' : ', '}${folder}`
      if (next.length > SUMMARY_LINE_MAX - 20 && !line.endsWith(':')) {
        lines.push(`${line}.`)
        line = `More folders no longer used by Kehikot: ${folder}`
      } else line = next
    }
    lines.push(`${line}.`)
  }
  if (done.kept?.length) lines.push(`Kept in development: ${done.kept.join(', ')}.`)
  if (done.freed.length) lines.push(`Press Move unused folders to the Trash in Settings › Modules to clear ${done.freed.length === 1 ? 'it' : 'them'}; each is checked first.`)
  return lines.length ? lines.map(clip) : ['Every module already ran from where it should.']
}

/** The summary as one piece, for Settings › Modules. */
export function summarySaid(done: Tally, home: string | null): string {
  return summaryLines(done, home).join(' ')
}

/** What the page sends: the switch, or one module's folder or choice. */
export type DevelopmentChange = { on: boolean } | { module: string; folder?: string | null; release?: boolean; mode?: 'follow' | 'folder' | 'release' } | { module: string; move: true; now?: true }

async function said(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : `Kehikot answered ${response.status}.`
}

/** The switch, every official module here and where it runs from, and how a switch is going. */
export async function fetchDevelopment(signal?: AbortSignal): Promise<Development> {
  const response = await fetch('/host/development', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await said(response))
  return developmentSchema.parse(await response.json())
}

/** Turn the switch, or change one module; answers the state after it. Moving modules goes on after the answer. */
export async function changeDevelopment(change: DevelopmentChange): Promise<Development> {
  const response = await fetch('/host/development', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) })
  if (!response.ok) throw new Error(await said(response))
  return developmentSchema.parse(await response.json())
}

/** What a person is told before "Move now" on a module set to keep running: it is stopped and started again, and what it holds goes on without it. */
export function moveNowWarning(name: string): string {
  return `Move now restarts ${name}, which ends whatever it is doing at this moment. Agent sessions it started keep running on their own. It then runs from its release.`
}

/** A module's move, in a word or two for its row. */
export function moveSaid(step: MoveStep): string {
  return { waiting: 'Waiting…', installing: 'Getting its release…', starting: 'Starting…', done: 'Moved', failed: 'Not moved', restored: 'Put back', later: 'Moves at its next restart' }[step]
}
