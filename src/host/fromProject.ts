import { z } from 'zod'

import { canvasSchema, type Canvas } from './canvases.ts'
import { availability, type LayoutContainer, type OfficialEntry } from './layouts.ts'

/**
 * A kehikko started from one in another project ("From another project" in the New kehikko dialog,
 * and `create_kehikko` with `from` at the door). The rules, shared by the page and the server; the
 * store is `server/fromProject.ts`.
 *
 * ## What is copied
 *
 *   - THE ARRANGEMENT, always: which modules, each container's rectangle and the height it asks
 *     for, whether it grows to fit, is folded or is a tile, its scope word, the prompt written on it
 *     and how often it refreshes (`copiedPlacements`).
 *   - Three groups of the kehikko's own settings, each a checkbox (`CopyTake`), all on by default:
 *       - General: how its modules connect (the connections switched off or chosen). Its name is the
 *         one the person gives, offered as the source's.
 *       - Skills: the skills the person wrote for it, as files in this project's
 *         `.kehikot/host/skills/<new key>/`. On by default: they are the person's own instructions
 *         for this kind of kehikko, which is most of why one is copied.
 *       - Primary agent: which agent module is primary, when that module is in the arrangement.
 *
 * ## What is not
 *
 * Anything about the OTHER project: which containers were picked out, pinned containers, a
 * container's filters (a module's choices, which may name that project's things), a version pin,
 * "ask me later" about the primary agent, and every module's own state — a picked document, a
 * session, a branch. The project's epic, spaces and selection belong to the project, never to a
 * kehikko, so none of them can travel. No project data is read or written: only the frame's rows and
 * the kehikko's skills.
 *
 * ## Modules that are not here
 *
 * Kept, never dropped: the new kehikko has their containers where they were, drawn as the canvas
 * draws any module this computer lacks (`Missing.tsx`, install from Kehikko modules). The card says
 * "Not installed: <name>" first (`notInstalled`).
 */

export type CopyGroup = 'general' | 'skills' | 'agents'
export type CopyTake = Record<CopyGroup, boolean>

export const COPY_GROUPS: readonly CopyGroup[] = ['general', 'skills', 'agents']
export const TAKE_DEFAULT: CopyTake = { general: true, skills: true, agents: true }

/** What the person ticked, from a request: each group a literal boolean, otherwise its default. */
export function takeIn(raw: unknown): CopyTake {
  const got = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = { ...TAKE_DEFAULT }
  for (const group of COPY_GROUPS) if (typeof got[group] === 'boolean') out[group] = got[group] as boolean
  return out
}

/** The fields of a placement this file reads and writes. Both sides' `Placement` have them. */
export interface CopyablePlacement {
  i: string
  x: number
  y: number
  w: number
  h: number
  wish: number
  grow: boolean
  pinned: boolean
  prompt: string
  promptFor: string | null
  collapsed: boolean
  tiled?: boolean
  selected: boolean
  filters: Record<string, unknown>
  refreshEvery: number | null
  version: string | null
  scope: unknown
  foldRows?: unknown
}

/**
 * The arrangement as the new kehikko gets it: every container kept, with the other project's
 * particulars cleared. Nothing is dropped, a module this computer lacks included.
 */
export function copiedPlacements<T extends CopyablePlacement>(placements: readonly T[]): T[] {
  return placements.map((p) => {
    const { foldRows: _drawn, tiled, ...rest } = p
    return {
      ...rest,
      ...(tiled === true && p.collapsed !== true ? { tiled: true } : {}),
      pinned: false,
      selected: false,
      filters: {},
      version: null,
    } as unknown as T
  })
}

/** One kehikko of another project, as the dialog and the door read it. */
export interface ElsewhereKehikko {
  id: number
  key: string
  name: string
  /** Its rectangles as a layout's, in the order a layout keeps them. */
  containers: LayoutContainer[]
  /** How many containers are folded or tiles, for the card's line. */
  folded: number
  /** The names of the skills the person wrote for it. */
  skills: string[]
  /** Its primary agent module, when one was chosen and is on it. */
  primary: string | null
  /** Whether any connection between its modules was switched off or chosen. */
  connections: boolean
}

/** Another project the host knows, with its kehikot. `visited` is when the person was last in it. */
export interface ElsewhereProject {
  id: number
  name: string
  path: string
  visited: number | null
  missing: boolean
  kehikot: ElsewhereKehikko[]
}

/** Recent first, then by name: the order the dialog lists projects in. */
export function byRecent<P extends { name: string; visited: number | null }>(projects: readonly P[]): P[] {
  return [...projects].sort((a, b) => (b.visited ?? 0) - (a.visited ?? 0) || a.name.localeCompare(b.name))
}

/** The projects whose name or folder holds every word typed, case and accents aside. */
export function findProjects<P extends { name: string; path: string }>(projects: readonly P[], query: string): P[] {
  const fold = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return [...projects]
  return projects.filter((one) => {
    const hay = fold(`${one.name} ${one.path}`)
    return words.every((word) => hay.includes(word))
  })
}

/**
 * The names of the modules on a kehikko this computer does not have, in its order: what the card says
 * as "Not installed: …". `registered` is id → name; a module the official list names is said by that
 * name, otherwise by its id's last word.
 */
export function notInstalled(
  containers: readonly LayoutContainer[],
  registered: ReadonlyMap<string, string>,
  official: readonly OfficialEntry[],
): string[] {
  const available = availability({ id: '', from: 'mine', name: '', summary: '', containers: [...containers] }, registered, official)
  return available.filter((one) => one.state !== 'here').map((one) => one.name)
}

/** What a card says about the settings that would come with it: "3 skills · primary agent · connections". */
export function settingsSaid(kehikko: ElsewhereKehikko, names: ReadonlyMap<string, string> = new Map()): string | null {
  const said = [
    kehikko.skills.length ? `${kehikko.skills.length} ${kehikko.skills.length === 1 ? 'skill' : 'skills'}` : null,
    kehikko.primary ? `primary agent ${names.get(kehikko.primary) ?? kehikko.primary}` : null,
    kehikko.connections ? 'connection choices' : null,
  ].filter((one): one is string => one !== null)
  return said.length ? said.join(' · ') : null
}

/* The page's side of the routes. */

const elsewhereSchema = z.object({
  projects: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      path: z.string(),
      visited: z.number().nullable(),
      missing: z.boolean().default(false),
      kehikot: z.array(
        z.object({
          id: z.number(),
          key: z.string(),
          name: z.string(),
          containers: z.array(z.object({ module: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })),
          folded: z.number().default(0),
          skills: z.array(z.string()).default([]),
          primary: z.string().nullable().default(null),
          connections: z.boolean().default(false),
        }),
      ),
    }),
  ),
})

/** Every other project this host knows, recent first, with its kehikot. */
export async function fetchElsewhere(project: number | null, signal?: AbortSignal): Promise<ElsewhereProject[]> {
  const response = await fetch(`/host/kehikot/elsewhere${project === null ? '' : `?project=${project}`}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  return elsewhereSchema.parse(await response.json()).projects
}

/** Make a kehikko in `into` from kehikko `from` of another project. */
export async function copyKehikko(body: { from: number; into: number | null; name: string; take: CopyTake }): Promise<{ canvas: Canvas; said: string }> {
  const response = await fetch('/host/kehikot/copy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ canvas: canvasSchema, said: z.string() }).parse(await response.json())
}

async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (body && typeof body.error === 'string') return body.error
  return `Kehikot answered with error ${response.status}`
}
