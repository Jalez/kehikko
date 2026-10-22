import { LIMITS, MODULE_ID, REFRESH_EVERY_MAX } from 'kehikot-module-protocol'
import { z } from 'zod'

import { COLUMNS, type Placement } from './canvases.ts'

/**
 * Suggested layouts: a kehikko to start from instead of an empty one.
 *
 * ## Three shelves
 *
 *   - BUILT IN — `BUILT_IN_LAYOUTS` below, from us, naming modules on the
 *     official list (`modules.json`).
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

/**
 * Ours. The first five are the five ways of working the introduction names —
 * Design, Research, Development, Review, Learning — in that order; then the
 * rest. "Development" was "Build software" (same modules): one layout for the
 * one way of working, not two names for it.
 */
export const BUILT_IN_LAYOUTS: readonly Layout[] = [
  {
    id: 'design',
    from: 'builtin',
    name: 'Design',
    summary: 'The thing you are shaping, live in a browser, with your notes, its issues and Claude beside it.',
    containers: [
      { module: 'kehikot.browser', x: 0, y: 0, w: 7, h: 18 },
      { module: 'kehikot.flows', x: 0, y: 18, w: 7, h: 10, optional: true },
      { module: 'kehikot.claude', x: 7, y: 0, w: 5, h: 14 },
      { module: 'kehikot.notes', x: 7, y: 14, w: 5, h: 7 },
      { module: 'kehikot.references', x: 7, y: 21, w: 5, h: 7 },
    ],
  },
  {
    id: 'research',
    from: 'builtin',
    name: 'Research',
    summary: 'Read and write with your sources at hand: the paper, what it cites, your notes, the web and Claude.',
    containers: [
      { module: 'kehikot.paper', x: 0, y: 0, w: 5, h: 28 },
      { module: 'kehikot.browser', x: 5, y: 0, w: 4, h: 16 },
      { module: 'kehikot.notes', x: 5, y: 16, w: 4, h: 12 },
      { module: 'kehikot.citations', x: 9, y: 0, w: 3, h: 9 },
      { module: 'kehikot.references', x: 9, y: 9, w: 3, h: 9 },
      { module: 'kehikot.claude', x: 9, y: 18, w: 3, h: 10 },
    ],
  },
  {
    id: 'development',
    from: 'builtin',
    name: 'Development',
    summary: 'Plan the work, build it with Claude, and review and ship the changes.',
    containers: [
      { module: 'kehikot.journeys', x: 0, y: 0, w: 4, h: 10 },
      { module: 'kehikot.references', x: 0, y: 10, w: 4, h: 9 },
      { module: 'kehikot.checklist', x: 0, y: 19, w: 4, h: 9 },
      { module: 'kehikot.claude', x: 4, y: 0, w: 5, h: 28 },
      { module: 'kehikot.review', x: 9, y: 0, w: 3, h: 14 },
      { module: 'kehikot.factory', x: 9, y: 14, w: 3, h: 14 },
    ],
  },
  {
    id: 'review',
    from: 'builtin',
    name: 'Review',
    summary: 'Go through a change line by line, hold it to its checklist, and try it in a real browser.',
    containers: [
      { module: 'kehikot.references', x: 0, y: 0, w: 3, h: 14 },
      { module: 'kehikot.checklist', x: 0, y: 14, w: 3, h: 14 },
      { module: 'kehikot.diff', x: 3, y: 0, w: 5, h: 16 },
      { module: 'kehikot.review', x: 3, y: 16, w: 5, h: 12 },
      { module: 'kehikot.browser', x: 8, y: 0, w: 4, h: 16 },
      { module: 'kehikot.claude', x: 8, y: 16, w: 4, h: 12 },
    ],
  },
  {
    id: 'learning',
    from: 'builtin',
    name: 'Learning',
    summary: 'Read a paper with questions on what you read, your notes and slides, and Claude to explain.',
    containers: [
      { module: 'kehikot.paper', x: 0, y: 0, w: 5, h: 28 },
      { module: 'kehikot.learning', x: 5, y: 0, w: 4, h: 15 },
      { module: 'kehikot.notes', x: 5, y: 15, w: 4, h: 13 },
      { module: 'kehikot.slides', x: 9, y: 0, w: 3, h: 12 },
      { module: 'kehikot.claude', x: 9, y: 12, w: 3, h: 16 },
    ],
  },
  {
    id: 'write-a-paper',
    from: 'builtin',
    name: 'Write a paper',
    summary: 'The paper as prose, what it cites, and the work it reports on.',
    containers: [
      { module: 'kehikot.paper', x: 0, y: 0, w: 6, h: 28 },
      { module: 'kehikot.citations', x: 6, y: 0, w: 3, h: 14 },
      { module: 'kehikot.references', x: 6, y: 14, w: 3, h: 14 },
      { module: 'kehikot.claude', x: 9, y: 0, w: 3, h: 18 },
      { module: 'kehikot.journeys', x: 9, y: 18, w: 3, h: 10 },
    ],
  },
  {
    id: 'plan-an-epic',
    from: 'builtin',
    name: 'Plan an epic',
    summary: 'What has to become true, the issues behind it, and what is left to check.',
    containers: [
      { module: 'kehikot.journeys', x: 0, y: 0, w: 6, h: 28 },
      { module: 'kehikot.flows', x: 6, y: 0, w: 6, h: 12, optional: true },
      { module: 'kehikot.references', x: 6, y: 12, w: 6, h: 8 },
      { module: 'kehikot.checklist', x: 6, y: 20, w: 6, h: 8 },
    ],
  },
  {
    id: 'start-simple',
    from: 'builtin',
    name: 'Start simple',
    summary: 'Claude beside the project’s issues and pull requests. Add more as you need them.',
    containers: [
      { module: 'kehikot.claude', x: 0, y: 0, w: 7, h: 28 },
      { module: 'kehikot.references', x: 7, y: 0, w: 5, h: 28 },
    ],
  },
]

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

/** A layout as it is kept in a file, on the project's shelf or the person's. */
export const layoutFileSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(NAME_MAX),
  summary: z.string().max(SUMMARY_MAX).default(''),
  containers: z.array(layoutContainerSchema).min(1).max(64),
})
export type LayoutFile = z.infer<typeof layoutFileSchema>

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
    '  "version": 1,',
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
