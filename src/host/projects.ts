import {
  LIMITS,
  dispositionSchema,
  partsSetResult,
  trackerRefreshResult,
  trackerSourceSchema,
  type Disposition,
  type PartsSetResult,
  type TrackerRefreshResult,
  type TrackerSource,
} from 'kehikot-module-protocol'
import { partSchema, type PartsEdit } from './parts.ts'
import { trackerEditedSchema, trackerListingSchema, type TrackerEdit, type TrackerEdited, type TrackerListing } from './trackerSources.ts'
import { z } from 'zod'

/**
 * The page's side of the projects, the folder browser, and one project's epics.
 *
 * The shapes are declared here rather than imported from `server/projects.ts`,
 * for the reason `canvases.ts` and `registry.ts` both give: the page and the
 * server are two programs that share a repository, what crosses between them is
 * JSON, and typing that JSON as the server's own interface lets a change on one
 * side become a wrong belief on the other with nothing failing in between.
 */

export const projectSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** Absolute, and what the filesystem resolved it to. This is what modules are told. */
  path: z.string(),
  /**
   * Whether this project brings its own `.kehikot/kehikko/epics`.
   *
   * The field the header depends on. A project with no epics directory and a
   * project whose epics directory is empty both produce an empty list, and only
   * one of them should make the picker say there are none to pick — an empty
   * dropdown and a project that has none look identical otherwise, and the
   * first looks broken.
   */
  epics: z.boolean(),
  /**
   * Whether this folder has a git history at all.
   *
   * What decides between a checkbox and a sentence. A project that is not a
   * repository has nothing to keep out of a history, and a disabled control
   * with no explanation is worse than a line of prose saying why.
   */
  git: z.boolean(),
  /**
   * Whether this project's `.kehikot/` goes into its history rather than being
   * ignored.
   *
   * Read from the project's own `.gitignore` on every list, never stored — see
   * `sharesKehikot` in `server/projects.ts`. The file is the truth, because it
   * is a file the person can edit themselves.
   */
  shared: z.boolean(),
})
export type Project = z.infer<typeof projectSchema>

/**
 * Put a project's `.kehikot/` into its history, or take it out again.
 *
 * The whole project comes back, re-read from disk, so a caller replaces its row
 * rather than patching the field it just sent. See the route.
 */
export async function shareProject(id: number, shared: boolean): Promise<Project> {
  const response = await fetch('/host/projects', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, shared }),
  })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ project: projectSchema }).parse(await response.json()).project
}

export async function fetchProjects(signal?: AbortSignal): Promise<Project[]> {
  const response = await fetch('/host/projects', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ projects: z.array(projectSchema) }).parse(await response.json()).projects
}

/**
 * Stop holding a folder as a project. Nothing on disk is touched.
 *
 * The count that comes back is how many kehikot went with it — the one thing
 * this does destroy, and the reason the control is armed rather than pressed.
 * See `forgetProject` on the server, and the paragraph there about why erasing
 * `.kehikot/` is deliberately not what this word does now that papers are in it.
 */
export async function forgetProject(id: number): Promise<{ project: Project; canvases: number }> {
  const response = await fetch('/host/projects', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ project: projectSchema, canvases: z.number().int() }).parse(await response.json())
}

/** Add a folder as a project. The server decides whether the folder is one. */
export async function addProject(path: string, name?: string): Promise<Project> {
  const response = await fetch('/host/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, name }),
  })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ project: projectSchema }).parse(await response.json()).project
}

const entrySchema = z.object({
  name: z.string(),
  path: z.string(),
  git: z.boolean(),
  worktree: z.boolean(),
  epics: z.boolean(),
})
export type Entry = z.infer<typeof entrySchema>

const listingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(entrySchema),
  more: z.number().int(),
})
export type Listing = z.infer<typeof listingSchema>

/**
 * What is inside one folder.
 *
 * `path` is what the person walked to and is sent back verbatim; the server
 * resolves it, contains it, and refuses it if it leaves the roots. The page
 * never decides where it may look — see the four rules in `server/folders.ts`.
 */
export async function fetchFolders(path: string | null, signal?: AbortSignal): Promise<Listing> {
  const where = path ? `?path=${encodeURIComponent(path)}` : ''
  const response = await fetch(`/host/folders${where}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ listing: listingSchema }).parse(await response.json()).listing
}

/** One epic, as much of it as a picker needs. The spine the host reads off disk. */
export const epicSchema = z.object({
  slug: z.string(),
  title: z.string().optional(),
  project: z.string().optional(),
  lede: z.string().optional(),
  size: z.number().optional(),
  /* What `size` adds up, present exactly when it is. `catch` so that an odd
     value costs the tooltip and not the list. */
  sizeParts: z
    .object({ parts: z.number(), steps: z.number(), exists: z.number(), open: z.number() })
    .optional()
    .catch(undefined),
  /* The parts the epic is divided into. Empty for an epic with none and for a
     server from before parts were read — both mean there is nothing to focus
     on, and the picker is not drawn. `catch` rather than a refusal: parts that
     will not read must not cost the page its list of epics. */
  parts: z.array(partSchema).max(LIMITS.PARTS).catch([]).default([]),
})
export type Epic = z.infer<typeof epicSchema>

export interface Epics {
  /** Whether the project has a `.kehikot/kehikko/epics` at all. See `projectSchema.epics`. */
  holds: boolean
  epics: Epic[]
}

export async function fetchEpics(project: number, signal?: AbortSignal): Promise<Epics> {
  const response = await fetch(`/host/epics?project=${project}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  return z
    .object({ holds: z.boolean(), epics: z.array(epicSchema) })
    .parse(await response.json())
}

/**
 * The marks people have put on a project's refs — `context.dispositions`.
 *
 * Parsed with the protocol's own schema, so what reaches the context is what a
 * module is promised. Not cached, for `fetchEpics`' reason: a file somebody can
 * edit by hand is read when the page has a reason to read it, which is a
 * project switch or the server saying a mark changed.
 */
export async function fetchDispositions(project: number, signal?: AbortSignal): Promise<Disposition[]> {
  const response = await fetch(`/host/dispositions?project=${project}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  return z
    .object({ dispositions: z.array(dispositionSchema).max(LIMITS.DISPOSITIONS) })
    .parse(await response.json()).dispositions
}

/**
 * The open project's tracker reading, as the bar shows it: `context.tracker`'s
 * two facts and how each source fared. Asking counts as somebody looking — the
 * server starts the project's first read on it, and keeps its schedule going.
 */
export interface TrackerState {
  at: string | null
  refreshing: boolean
  sources: TrackerSource[]
  /** Which project this is, for the panel's edits. Absent until the first read of it. */
  project?: number
  /** The sources as a person is told them (`trackerSources.ts`). Absent from a host that does not say. */
  listing?: TrackerListing
}

export async function fetchTracker(project: number, signal?: AbortSignal): Promise<TrackerState> {
  const response = await fetch(`/host/tracker?project=${project}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  const read = z
    .object({
      at: z.string().datetime({ offset: true }).nullable(),
      refreshing: z.boolean(),
      sources: z.array(trackerSourceSchema).max(LIMITS.TRACKER_SOURCES),
      listing: trackerListingSchema.optional(),
    })
    .parse(await response.json())
  return { ...read, project }
}

/**
 * One edit of the project's tracker sources, or a "Check" of one before it is
 * added. Answered with a sentence, and the sources as they now stand.
 */
export async function editTrackers(project: number, edit: TrackerEdit): Promise<TrackerEdited> {
  const response = await fetch('/host/trackers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, edit }),
  })
  if (!response.ok) throw new Error(await reason(response))
  return trackerEditedSchema.parse(await response.json())
}

/** "Refresh all": read every source of the project again. Answers when the read lands. */
export async function refreshTracker(project: number): Promise<TrackerRefreshResult> {
  const response = await fetch('/host/tracker/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project }),
  })
  if (!response.ok) throw new Error(await reason(response))
  return trackerRefreshResult.parse(await response.json())
}

/**
 * Make one edit of an epic's list of parts: add, rename, move or remove.
 *
 * The body is the protocol's own `parts.set`, so the picker asks for exactly
 * what a module may ask for and is answered by the same writer (`editParts`
 * in `server/holdings.ts`). The answer is the protocol's result — `changed`,
 * `unchanged`, `declined` with a sentence, `no-such-part` — and the epic's
 * row as the server now reads it, which the caller puts in place of the one
 * it has rather than patching in what it sent, for `retitleEpic`'s reason.
 */
export async function editParts(project: number, epic: string, edit: PartsEdit): Promise<{ result: PartsSetResult; epic: Epic | null }> {
  const response = await fetch('/host/parts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, epic, ...edit }),
  })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ result: partsSetResult, epic: epicSchema.nullable() }).parse(await response.json())
}

/**
 * Change what one epic is called. Its slug does not move.
 *
 * The distinction is the whole of this function and it is why it is not called
 * `renameEpic`. A title is a label in one field of one file. A slug is the
 * identity: it is on `projects.epic`, it is what every framed module is told in
 * `kehikot.context.epic`, and the modules key their own material by it — a
 * record in `journeys.json`, a file per epic in `checklist/`, a whole directory
 * under `paper/`. Changing that is a migration across programs this host cannot
 * see inside, and `retitleEpic` in `server/holdings.ts` says at length why it
 * is deliberately not offered.
 *
 * The epic comes back as the server re-read it, so a caller replaces its row
 * rather than patching in the title it just sent — the same decision
 * `shareProject` makes, for the same reason: the file is one a person can also
 * edit by hand.
 */
export async function retitleEpic(project: number, slug: string, title: string): Promise<Epic> {
  const response = await fetch('/host/epics', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, slug, title }),
  })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ epic: epicSchema }).parse(await response.json()).epic
}

/**
 * Make a new epic in one project: a file that did not exist.
 *
 * The slug is sent as the page shows it — derived by `slugFrom` in `epics.ts`
 * unless the person edited it — and NOT checked here. The server's `createEpic`
 * is the one rule about what a slug and a title may be, and its sentence is
 * what the error line shows when it refuses; a check on this side would be a second
 * copy of that rule, and the copy nobody tests against a real file is the one
 * that drifts. See `src/host/epics.ts`.
 *
 * The epic comes back as the server wrote and re-read it, for the reason
 * `retitleEpic` gives. `madeDirectory` says whether `.kehikot/kehikko/epics` had to be
 * created, which is worth a sentence to a person whose thesis folder just
 * gained a `.kehikot/`.
 */
export async function createEpic(
  project: number,
  slug: string,
  title: string,
): Promise<{ epic: Epic; madeDirectory: boolean }> {
  const response = await fetch('/host/epics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, slug, title }),
  })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ epic: epicSchema, madeDirectory: z.boolean() }).parse(await response.json())
}

/**
 * Delete one epic's file from a project. What modules filed under its slug
 * stays — see `deleteEpic` in `server/holdings.ts`.
 */
export async function deleteEpic(project: number, slug: string): Promise<void> {
  const response = await fetch('/host/epics', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, slug }),
  })
  if (!response.ok) throw new Error(await reason(response))
}

/** Which project this browser had open, for the reason the open kehikko is local. */
export const OPEN_PROJECT_KEY = 'kehikot.frame.project.v1'

/**
 * Which project was open, remembered per browser rather than per person.
 *
 * The same decision `readOpen` makes about the kehikko and for the same reason:
 * two windows on two screens showing two projects is a reasonable thing to do,
 * and a server that stored "the current project" would make them fight over it.
 */
export function readOpenProject(storage: Pick<Storage, 'getItem'>): number | null {
  try {
    const raw = storage.getItem(OPEN_PROJECT_KEY)
    if (raw === null) return null
    const id = Number(raw)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function writeOpenProject(storage: Pick<Storage, 'setItem'>, id: number): void {
  try {
    storage.setItem(OPEN_PROJECT_KEY, String(id))
  } catch {
    /* Private browsing, or storage refused. It opens on the first project next
       time, which is a smaller loss than an exception in a click handler. */
  }
}

/**
 * Which project to open, given what is stored and what exists.
 *
 * A remembered project that has since been removed falls back to the first.
 * Null only when there are none at all, which is a state the header has to be
 * able to draw — `adopt()` seeds one at startup, and a seed that could not be
 * added is a host that starts anyway rather than one that refuses to serve.
 */
export function chooseProject(projects: readonly Project[], remembered: number | null): number | null {
  if (remembered !== null && projects.some((project) => project.id === remembered)) return remembered
  return projects[0]?.id ?? null
}

async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (body && typeof body.error === 'string') return body.error
  return `the host's server answered ${response.status}`
}

/**
 * The tooltip and label for an epic's number: only the non-zero parts, in
 * words. An epic with no parts yet says so first, because its number is then
 * its steps and not the count the parts menu shows.
 */
export function sizeWords(parts: { parts: number; steps: number; exists: number; open: number }): string {
  const said: string[] = []
  if (parts.parts) said.push(`${parts.parts} ${parts.parts === 1 ? 'part' : 'parts'}`)
  else said.push('no parts yet')
  if (parts.steps) said.push(`${parts.steps} ${parts.steps === 1 ? 'step' : 'steps'}`)
  if (parts.exists) said.push(`${parts.exists} already in place`)
  if (parts.open) said.push(`${parts.open} open ${parts.open === 1 ? 'question' : 'questions'}`)
  return said.join(' · ')
}
