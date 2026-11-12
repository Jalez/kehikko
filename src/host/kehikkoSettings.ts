import { z } from 'zod'

/**
 * A kehikko's own settings, as the page and the server both read them: its name and skills (kept
 * where they always were) and which agent module is the PRIMARY one when more than one is placed
 * on it. The store is `server/kehikkoSettings.ts` (frame.sqlite, per project and kehikko key); the
 * window is `src/canvas/KehikkoSettings.tsx`, opened with `openKehikkoSettings`.
 *
 * ## Which modules are agent modules
 *
 * The ones whose manifest says they run agent sessions (`declares.agentSessions`, protocol 2.21.0;
 * `runsAgents` in `connections.ts`). Never by id: the host names no module.
 *
 * ## What "primary" changes
 *
 * Only news to a PLACE: what a module sends to every session at a kehikko or an epic
 * (`messages.tell`) and the host's own tracker news. A session of the primary module is handed it;
 * a session of another agent module on the same kehikko is not. A message to one session
 * (`messages.notify`, `messages.notifySession`, a session's `messages.send` to it), to a module, to
 * the project, a session's own message to a place, and the person's are handed as before.
 *
 * With no primary chosen, or the chosen one no longer on the kehikko, every session gets the news,
 * as before there was a choice. With one agent module there is nothing to choose: it gets it all.
 */

export type KehikkoSection = 'general' | 'skills' | 'agents'
export const KEHIKKO_SECTIONS: readonly KehikkoSection[] = ['general', 'skills', 'agents']

/** What is kept for one kehikko. `later` is the agent modules that were there when the person said Later. */
export interface KehikkoSettings {
  primary: string | null
  later: string[]
}

export const NO_SETTINGS: KehikkoSettings = { primary: null, later: [] }

/** An agent module on a kehikko, as the choice draws it: its icon and name, like its tile. */
export interface AgentChoice {
  id: string
  name: string
  icon: string | null
}

/**
 * The primary that routing uses: the chosen module while it is on the kehikko and there is more
 * than one agent module to choose between; otherwise none, and everyone gets the news.
 */
export function routingPrimary(agents: readonly string[], settings: KehikkoSettings): string | null {
  if (agents.length < 2) return null
  return settings.primary !== null && agents.includes(settings.primary) ? settings.primary : null
}

/** The primary as the person reads it: the chosen one, or the only agent module (implicitly). */
export function shownPrimary(agents: readonly string[], settings: KehikkoSettings): string | null {
  if (agents.length === 1) return agents[0]!
  return routingPrimary(agents, settings)
}

/**
 * Whether the person should be asked to choose: two or more agent modules, none of them chosen,
 * and not put off with Later for this same set (a new agent module asks again).
 */
export function choiceDue(agents: readonly string[], settings: KehikkoSettings): boolean {
  if (agents.length < 2) return false
  if (routingPrimary(agents, settings) !== null) return false
  return !agents.every((one) => settings.later.includes(one))
}

/** Whether news to a place is handed to a session of `module` at this kehikko. */
export function takesPlaceNews(module: string, agents: readonly string[], settings: KehikkoSettings): boolean {
  const primary = routingPrimary(agents, settings)
  return primary === null || module === primary
}

/** What the person is told above the choice: what `takesPlaceNews` does, in plain words. */
export const PRIMARY_SAID = {
  title: 'Which agent is primary here?',
  lede: 'This kehikko has more than one agent. Choose the one that should get its shared news.',
  implications:
    'The primary agent gets this kehikko’s shared news: tracker news about the epic, and news modules send to the whole kehikko or epic. '
    + 'The other agents still work normally, and still get messages meant for them directly. You can change this in Kehikko settings.',
  none: 'No primary agent is chosen, so every agent here gets the shared news.',
  later: 'You chose Later: every agent here gets the shared news until you choose a primary one.',
  one: 'Only one agent is on this kehikko, so it gets the shared news. Add another and you will be asked which one is primary.',
  zero: 'No agent is on this kehikko.',
} as const

/* ------------------------------------------------------------ the page's door */

export const agentChoiceSchema = z.object({ id: z.string(), name: z.string(), icon: z.string().nullable() })
export const kehikkoSettingsAnswerSchema = z.object({
  settings: z.object({ primary: z.string().nullable(), later: z.array(z.string()) }),
  agents: z.array(agentChoiceSchema),
  primary: z.string().nullable(),
  due: z.boolean(),
})
export type KehikkoSettingsAnswer = z.infer<typeof kehikkoSettingsAnswerSchema>

/** A kehikko's settings and its agent modules, by its id on this machine. */
export async function fetchKehikkoSettings(kehikko: number, signal?: AbortSignal): Promise<KehikkoSettingsAnswer> {
  const response = await fetch(`/host/kehikko-settings?kehikko=${kehikko}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  return kehikkoSettingsAnswerSchema.parse(await response.json())
}

/** Choose the primary (a module id), clear it (null), or put the choice off (`later`). */
export async function postKehikkoSettings(kehikko: number, edit: { primary: string | null } | { later: true }): Promise<KehikkoSettingsAnswer> {
  const response = await fetch('/host/kehikko-settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kehikko, ...edit }) })
  if (!response.ok) throw new Error(await reason(response))
  return kehikkoSettingsAnswerSchema.parse(await response.json())
}

async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (body && typeof body.error === 'string') return body.error
  return `Kehikot answered with error ${response.status}`
}

/* ------------------------------------------------------------ opening it */

const OPEN = 'kehikot:open-kehikko-settings'

export interface KehikkoSettingsLink {
  section: KehikkoSection | null
  target: string | null
  /** Which kehikko, by id; absent is the open one. */
  kehikko: number | null
}

const isSection = (value: unknown): value is KehikkoSection => typeof value === 'string' && (KEHIKKO_SECTIONS as readonly string[]).includes(value)
const TARGET = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Read an open event's detail, whatever was put in it. */
export function kehikkoLinkOf(detail: unknown): KehikkoSettingsLink {
  if (!detail || typeof detail !== 'object') return { section: null, target: null, kehikko: null }
  const { section, target, kehikko } = detail as { section?: unknown; target?: unknown; kehikko?: unknown }
  return {
    section: isSection(section) ? section : null,
    target: typeof target === 'string' && TARGET.test(target) ? target : null,
    kehikko: typeof kehikko === 'number' && Number.isInteger(kehikko) && kehikko > 0 ? kehikko : null,
  }
}

/** Open Kehikko settings: at one section, one control in it, for one kehikko (the open one when not named). */
export function openKehikkoSettings(section?: KehikkoSection, target?: string, kehikko?: number): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(OPEN, { detail: { section: section ?? null, target: target ?? null, kehikko: kehikko ?? null } }))
}

export function onOpenKehikkoSettings(then: (link: KehikkoSettingsLink) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const heard = (event: Event) => then(kehikkoLinkOf((event as CustomEvent<unknown>).detail))
  window.addEventListener(OPEN, heard)
  return () => window.removeEventListener(OPEN, heard)
}
