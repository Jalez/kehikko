import { LIMITS, MODULE_ID, REFRESH_EVERY_MAX } from 'kehikot-module-protocol'
import { z } from 'zod'

import listed from '../../modules.json'

import { COLUMNS, type Placement } from './canvases.ts'
import { finer } from './fit.ts'

/**
 * Suggested layouts: a kehikko to start from instead of an empty one.
 *
 * ## Three shelves
 *
 *   - BUILT IN — ours, kept as DATA beside the official module list, in
 *     `modules.json`'s `layouts` (`BUILT_IN_LAYOUTS`, `readBuiltInLayouts`), so
 *     the app's code names no module. Like an entry of the list, a layout is
 *     published by merging it to `main`: a host reads the published list's
 *     `layouts` over the ones it was built with (`server/officialSource.ts`).
 *   - THE PROJECT'S — `<project>/.kehikot/host/layouts/<slug>.json`, so a
 *     layout somebody made for this project travels with it, like
 *     `kehikot.json` (`server/layouts.ts`).
 *   - MINE — the same files in the machine directory's `layouts/`
 *     (`layoutsDir` in `server/machineDirs.ts`): this person's, on this
 *     computer, for every project.
 *
 * A layout is only rectangles and modules — what `kehikot.json` would say about
 * one kehikko, without a key, a fold or a filter. Using one makes an ordinary
 * kehikko; nothing remembers which layout it came from.
 *
 * ## Modules that are not here
 *
 * A layout may name a module this computer does not have. `availability` says
 * what each is: `here`, on the official list and installable (`install`), on
 * the list but needing a newer app (`newer`), or `missing` — on no list this
 * host knows, so it cannot be had from here. The picker says "will install
 * Review" for the second and "not available" for the last, and installs only
 * on the person's press, through the same `/host/official/install` the
 * modules list uses. A container marked `optional` (Flows in "Design" and "Plan an epic")
 * is used when it is here and left out without a word when it is not.
 */

export type LayoutSource = 'builtin' | 'project' | 'mine'

/** One container in a layout: a module and its rectangle, and the few layout facts worth suggesting. */
export interface LayoutContainer {
  module: string
  x: number
  y: number
  w: number
  h: number
  grow?: boolean
  prompt?: string
  promptFor?: string | null
  refreshEvery?: number | null
  /** Used when the module is here, left out without a word when it is not. Built-in layouts only. */
  optional?: boolean
}

export interface Layout {
  /** Unique on its shelf: a built-in's name, or the file's slug. */
  id: string
  from: LayoutSource
  name: string
  summary: string
  containers: LayoutContainer[]
}

const NAME_MAX = 60
const SUMMARY_MAX = 200

/** A layout file's container: the rectangle required, the rest defaulted. Unknown fields are dropped. */
export const layoutContainerSchema = z.object({
  module: z.string().regex(MODULE_ID, 'is not a module id'),
  x: z.number().int().min(0).max(COLUMNS - 1),
  y: z.number().int().min(0).max(10_000),
  w: z.number().int().min(1).max(COLUMNS),
  h: z.number().int().min(1).max(400),
  grow: z.boolean().optional(),
  prompt: z.string().max(LIMITS.PROMPT).optional(),
  promptFor: z.string().regex(MODULE_ID).nullable().optional(),
  refreshEvery: z.number().max(REFRESH_EVERY_MAX).nullable().optional(),
})

/**
 * The version a layout file is written as. 2 is 1 counted in the rows a canvas
 * has now: a version 1 file's `y` and `h` are in the old twenty-eight rows, and
 * are doubled as it is read (`layoutFromFile`) — the same move, for the same
 * reason, as a `kehikot.json` without `rows` (`server/kehikot.ts`). A host from
 * before reads a version 2 file as "not a layout" and leaves it off its shelf,
 * which is better than offering it at twice its height; it never writes a
 * layout file it did not make, so nothing is lost.
 */
export const LAYOUT_VERSION = 2

/** A layout as it is kept in a file, on the project's shelf or the person's. */
export const layoutFileSchema = z.object({
  version: z.union([z.literal(1), z.literal(LAYOUT_VERSION)]),
  name: z.string().trim().min(1).max(NAME_MAX),
  summary: z.string().max(SUMMARY_MAX).default(''),
  containers: z.array(layoutContainerSchema).min(1).max(64),
})
export type LayoutFile = z.infer<typeof layoutFileSchema>

/** A layout file as read, in the rows a canvas has now, whichever version wrote it. */
export function layoutFromFile(file: LayoutFile): LayoutFile {
  if (file.version === LAYOUT_VERSION) return file
  return {
    ...file,
    version: LAYOUT_VERSION,
    containers: file.containers.map((c) => ({ ...c, y: finer(c.y), h: finer(c.h) })),
  }
}

/**
 * One built-in layout as `modules.json` keeps it: an id, the layout file's fields, and `optional` on
 * a container (used when its module is here, left out without a word when it is not).
 */
const builtInLayoutSchema = layoutFileSchema.extend({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48),
  containers: z.array(layoutContainerSchema.extend({ optional: z.boolean().optional() })).min(1).max(64),
})

/** How many built-in layouts a list may carry. */
export const BUILT_IN_MAX = 32

/**
 * The built-in layouts a module list carries (`layouts` in `modules.json`, beside `modules`), in
 * the rows a canvas has now, or null when the list has none or they do not read: a host then keeps
 * the ones it has. Read whole: one layout that does not read drops them all, as one bad entry drops
 * the module list (`readOfficial`). An id said twice is refused the same way. A host from before
 * this field drops the key unread (`z.object` strips it), so publishing it breaks no app.
 */
export function readBuiltInLayouts(raw: unknown): Layout[] | null {
  const parsed = z.object({ layouts: z.array(builtInLayoutSchema).min(1).max(BUILT_IN_MAX) }).safeParse(raw)
  if (!parsed.success) return null
  const ids = new Set(parsed.data.layouts.map((one) => one.id))
  if (ids.size !== parsed.data.layouts.length) return null
  return parsed.data.layouts.map((one) => {
    const optional = new Map(one.containers.map((c, i) => [i, c.optional === true]))
    const file = layoutFromFile({ version: one.version, name: one.name, summary: one.summary, containers: one.containers })
    return {
      id: one.id,
      from: 'builtin' as const,
      name: file.name,
      summary: file.summary,
      containers: file.containers.map((c, i) => ({ ...c, ...(optional.get(i) ? { optional: true } : {}) })),
    }
  })
}

/**
 * The built-in layouts this host was built with: `modules.json`'s `layouts`. The first five are the
 * five ways of working the introduction names — Design, Research, Development, Review, Learning —
 * in that order; then the rest. Parsed where it is imported, so a list no host can use fails the
 * start (and the tests), not the first open of the picker.
 */
export const BUILT_IN_LAYOUTS: readonly Layout[] = (() => {
  const read = readBuiltInLayouts(listed)
  if (!read) throw new Error('modules.json carries no built-in layouts this host can read')
  return read
})()

/**
 * The file's slug for a layout's name: lowercase words joined by dashes, or
 * null when the name has nothing in it to make one from.
 */
export function slugFor(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug.length ? slug : null
}

/**
 * A layout file's text — one container per line, so a layout committed with a
 * project reads and diffs like `kehikot.json` does.
 */
export function layoutText(file: LayoutFile): string {
  const lines = [
    '{',
    `  "version": ${LAYOUT_VERSION},`,
    `  "name": ${JSON.stringify(file.name)},`,
    `  "summary": ${JSON.stringify(file.summary)},`,
    '  "containers": [',
    ...file.containers.map((c, i) => `    ${JSON.stringify(c)}${i < file.containers.length - 1 ? ',' : ''}`),
    '  ]',
    '}',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * A kehikko's placements as a layout's containers: rectangles and the layout
 * facts worth suggesting, nothing personal, nothing about a version. Expects
 * the placements as the shared file has them (unfolded).
 */
export function containersOf(placements: readonly Placement[]): LayoutContainer[] {
  return [...placements]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((p) => ({
      module: p.i,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.wish || p.h,
      ...(p.grow ? { grow: true } : {}),
      ...(p.prompt ? { prompt: p.prompt } : {}),
      ...(p.promptFor ? { promptFor: p.promptFor } : {}),
      ...(p.refreshEvery !== null ? { refreshEvery: p.refreshEvery } : {}),
    }))
}

/** What the picker needs to know about the official list: id, name, whether it is installed, whether it needs a newer app. */
export interface OfficialEntry {
  id: string
  name: string
  installed: boolean
  newer?: unknown
  /** The list's icon key for it (protocol 2.14.0); absent from an older host. */
  icon?: string | null
}

export type ModuleState = 'here' | 'install' | 'newer' | 'missing'

export interface Available {
  module: string
  /** The module's name where one is known — registered, or on the official list — else its id. */
  name: string
  state: ModuleState
  optional: boolean
}

/**
 * What using this layout would mean on this computer, container by container.
 * `registered` is what the registry holds now (id → name); `official` is the
 * official list as `/host/official` answers it, or empty when it could not be
 * read — and then nothing is offered for install.
 */
export function availability(
  layout: Layout,
  registered: ReadonlyMap<string, string>,
  official: readonly OfficialEntry[],
): Available[] {
  const listed = new Map(official.map((one) => [one.id, one]))
  return layout.containers.map((c) => {
    const optional = c.optional === true
    const here = registered.get(c.module)
    if (here !== undefined) return { module: c.module, name: here, state: 'here', optional }
    const entry = listed.get(c.module)
    if (entry) {
      /* Installed but not registered yet — a sweep away from `here`. */
      if (entry.installed) return { module: c.module, name: entry.name, state: 'here', optional }
      return { module: c.module, name: entry.name, state: entry.newer ? 'newer' : 'install', optional }
    }
    return { module: c.module, name: nameOf(c.module), state: 'missing', optional }
  })
}

/** `kehikot.references` → "References", for a module nobody has a name for; another vendor's id stays whole. */
export function nameOf(id: string): string {
  const short = id.replace(/^(kehikot|roadmap)\./, '')
  return short === id ? id : short.charAt(0).toUpperCase() + short.slice(1)
}

/** The modules a press on this layout would install: on the list, not here, not optional. */
export function toInstall(available: readonly Available[]): Available[] {
  return available.filter((one) => one.state === 'install' && !one.optional)
}

/** What a card says under its picture: "will install Review, Factory · not available: atlas". Null when everything is here. */
export function availabilitySaid(available: readonly Available[]): string | null {
  const install = toInstall(available).map((one) => one.name)
  const newer = available.filter((one) => one.state === 'newer' && !one.optional).map((one) => one.name)
  const missing = available.filter((one) => one.state === 'missing' && !one.optional).map((one) => one.name)
  const said = [
    install.length ? `will install ${install.join(', ')}` : null,
    newer.length ? `needs a newer Kehikot: ${newer.join(', ')}` : null,
    missing.length ? `not available: ${missing.join(', ')}` : null,
  ].filter((one): one is string => one !== null)
  return said.length ? said.join(' · ') : null
}

/**
 * The placements a new kehikko gets from a layout: every container whose
 * module is here, plus the ones about to be installed when `installing` names
 * them (they stand as "missing" until the install registers them). Others
 * are left out. Defaults as `place` gives a new container.
 */
export function placementsFor(
  layout: Layout,
  available: readonly Available[],
  installing: ReadonlySet<string> = new Set(),
): Placement[] {
  const state = new Map(available.map((one) => [one.module, one.state]))
  return layout.containers
    .filter((c) => state.get(c.module) === 'here' || installing.has(c.module))
    .map((c) => ({
      i: c.module,
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      grow: c.grow ?? false,
      pinned: false,
      prompt: c.prompt ?? '',
      promptFor: c.promptFor ?? null,
      collapsed: false,
      wish: c.h,
      selected: false,
      filters: {},
      refreshEvery: c.refreshEvery ?? null,
      version: null,
      /* A layout is rectangles and prompts; each container starts at its module's default scope. */
      scope: null,
    }))
}

/* The page's side of the routes. */

const layoutSchema = z.object({
  id: z.string(),
  from: z.enum(['builtin', 'project', 'mine']),
  name: z.string(),
  summary: z.string(),
  containers: z.array(layoutContainerSchema.extend({ optional: z.boolean().optional() })),
})

export interface Shelves {
  builtIn: Layout[]
  project: Layout[]
  mine: Layout[]
  /** Sentences about layout files that would not read. */
  trouble: string[]
}

/** Every layout this page could start a kehikko from, for the open project. */
export async function fetchLayouts(project: number | null, signal?: AbortSignal): Promise<Shelves> {
  const response = await fetch(`/host/layouts${project === null ? '' : `?project=${project}`}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  return z
    .object({
      builtIn: z.array(layoutSchema),
      project: z.array(layoutSchema),
      mine: z.array(layoutSchema),
      trouble: z.array(z.string()).default([]),
    })
    .parse(await response.json())
}

/** Save a kehikko as a layout, on the project's shelf or the person's own. */
export async function saveLayout(body: {
  kehikko: number
  name: string
  summary?: string
  where: 'project' | 'mine'
}): Promise<Layout> {
  const response = await fetch('/host/layouts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ layout: layoutSchema }).parse(await response.json()).layout
}

async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (body && typeof body.error === 'string') return body.error
  return `the host's server answered ${response.status}`
}
