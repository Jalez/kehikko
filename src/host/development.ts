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
export const moveStepSchema = z.enum(['waiting', 'installing', 'starting', 'done', 'failed', 'restored'])
export type MoveStep = z.infer<typeof moveStepSchema>

export const devModuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  runs: runsSchema,
  /** The module's development folder, when it has one. */
  folder: z.string().nullable(),
  /** "Use the release for this one", while development is on. */
  release: z.boolean(),
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

/** The one Inbox line a machine with modules on the person's folders starts with. */
export function startedOnSaid(count: number): string {
  return `Kehikko development is on because ${count} module${count === 1 ? '' : 's'} run${count === 1 ? 's' : ''} from your own folders. Turn it off in Settings › Modules to run them all from Kehikot’s releases.`
}

/** What a finished switch came to: how many moved where, what did not, and which folders are no longer used. */
export function summarySaid(done: { toRelease: number; toFolder: number; failed: { name: string }[]; freed: string[] }, home: string | null): string {
  const parts: string[] = []
  if (done.toRelease) parts.push(`${done.toRelease} module${done.toRelease === 1 ? '' : 's'} now run${done.toRelease === 1 ? 's' : ''} from Kehikot’s releases.`)
  if (done.toFolder) parts.push(`${done.toFolder} module${done.toFolder === 1 ? '' : 's'} now run${done.toFolder === 1 ? 's' : ''} from your own folder${done.toFolder === 1 ? '' : 's'}.`)
  if (done.freed.length === 1) parts.push(`Your folder ${pathSaid(done.freed[0]!, home)} is no longer used by Kehikot; you can remove it.`)
  else if (done.freed.length > 1) parts.push(`These folders are no longer used by Kehikot; you can remove them: ${done.freed.map((dir) => pathSaid(dir, home)).join(', ')}.`)
  if (done.failed.length) {
    const names = done.failed.map((one) => one.name)
    const said = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    parts.push(`${said} did not move and ${names.length === 1 ? 'runs' : 'run'} from where ${names.length === 1 ? 'it' : 'they'} did; Settings › Modules says why.`)
  }
  return parts.join(' ') || 'Every module already ran from where it should.'
}

/** What the page sends: the switch, or one module's folder or choice. */
export type DevelopmentChange = { on: boolean } | { module: string; folder?: string | null; release?: boolean } | { module: string; move: true }

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

/** A module's move, in a word or two for its row. */
export function moveSaid(step: MoveStep): string {
  return { waiting: 'Waiting…', installing: 'Getting its release…', starting: 'Starting…', done: 'Moved', failed: 'Not moved', restored: 'Put back' }[step]
}
