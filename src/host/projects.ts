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
   * Whether this project brings its own `data/epics`.
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
})
export type Epic = z.infer<typeof epicSchema>

export interface Epics {
  /** Whether the project has a `data/epics` at all. See `projectSchema.epics`. */
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

/** Which project this browser had open, for the reason the open kehikko is local. */
export const OPEN_PROJECT_KEY = 'roadmap.frame.project.v1'

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
