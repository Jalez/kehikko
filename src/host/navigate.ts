import { canShow, gotoProjectIsId, type SharedShow, type ShowAsk, type ShowingManifest } from 'kehikot-module-protocol'

/**
 * `view.goto` into another project, and one thing to be shown there (protocol 2.28.0). Every rule is
 * here, pure, and `test/navigate.test.ts` is its table; `App.tsx` carries them out with the pickers'
 * own functions (`onProject`, then the in-project goto).
 *
 * - `project` and `show` are answered only for a module whose manifest says them
 *   (`declares.navigates`), as every method is held to what the manifest asks for.
 * - A project is found by its permanent id, else by its folder now. One this host does not hold, or
 *   whose folder is gone, is `declined` with a sentence that names no other project: a module is
 *   handed one project, never the list.
 * - A switch of project is a person's: only from a container on the kehikko in front of them, while
 *   the page has their focus (a click in a module's frame keeps it), and never from a module an
 *   agent's press reached a moment ago. No door tool reaches it.
 * - `show` goes as `context.show` only to the containers on the kehikko the move ended on whose
 *   manifests say they show that subject.
 */

/** How long after an agent's press (`press_item`) to a module that module may not switch project. */
export const AGENT_PRESS_HOLD_MS = 10_000

/** How long a switch of project may take before the `view.goto` that asked for it is answered `declined`. */
export const ARRIVAL_WAIT_MS = 15_000

/** The words. Text, never markup; no project's name or path but the one asked about. */
export const NAVIGATE_SAYS = {
  undeclaredProject: (name: string) =>
    `${name} did not say it takes you to other projects (declares.navigates), so Kehikot stayed where it is.`,
  undeclaredShow: (name: string) =>
    `${name} did not say it asks for things to be shown (declares.navigates), so Kehikot stayed where it is.`,
  unknownProject: 'Kehikot does not have that project, so it stayed where it is.',
  goneProject: (name: string) => `The folder of ${name} is gone, so Kehikot stayed where it is. Locate it from the projects menu first.`,
  notInFront: 'Only a container on the kehikko in front of you can take you to another project.',
  notFocused: 'Kehikot switches project only when you press for it, with Kehikot in front of you.',
  agentPressed: "An agent's press does not take you to another project. Press it yourself.",
  noPage: 'No page of Kehikot is open to switch project in.',
  notArrived: (name: string) => `Kehikot opened ${name}, but its epics were not read in time to go further.`,
} as const

/** A project as the page holds it, as far as finding one needs. */
export interface HeldProject {
  id: number
  name: string
  path: string
  uid?: string | null
  missing?: boolean
}

const trimmed = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/**
 * The project a `view.goto`'s `project` names: by its permanent id when it is spelled as one, else by
 * its folder now. Never a guess: no prefix, no name, no folder above or below.
 */
export function projectFor(
  projects: readonly HeldProject[],
  key: string,
): { ok: true; project: HeldProject } | { ok: false; why: string } {
  const asked = key.trim()
  const found = gotoProjectIsId(asked)
    ? (projects.find((one) => one.uid === asked) ?? projects.find((one) => trimmed(one.path) === trimmed(asked)))
    : projects.find((one) => trimmed(one.path) === trimmed(asked))
  if (!found) return { ok: false, why: NAVIGATE_SAYS.unknownProject }
  if (found.missing) return { ok: false, why: NAVIGATE_SAYS.goneProject(found.name) }
  return { ok: true, project: found }
}

/** Why a module may not send what it sent, or null: `project` and `show` are held to `declares.navigates`. */
export function navigatesRefusal(
  call: { project?: string; show?: ShowAsk },
  navigates: readonly string[],
  name: string,
): string | null {
  if (call.project !== undefined && !navigates.includes('project')) return NAVIGATE_SAYS.undeclaredProject(name)
  if (call.show !== undefined && !navigates.includes('show')) return NAVIGATE_SAYS.undeclaredShow(name)
  return null
}

/** What the page knows about the press that asked for a switch of project. */
export interface PressFacts {
  /** Whether the asking module is placed on the kehikko on screen. */
  onScreen: boolean
  /** Whether this page's document has the person's focus (`document.hasFocus()`, true with focus in a frame) and is visible. */
  focused: boolean
  /** When an agent's press was last handed to the asking module, or null. */
  agentPressedAt: number | null
  now: number
}

/**
 * Why a switch of project is not a person's, or null when it is. A page cannot see a click inside a
 * module's frame; what it can see is that the frame is in front of the person, that the person is in
 * this window, and that no agent pressed the module just before.
 */
export function personsPressRefusal(facts: PressFacts): string | null {
  if (!facts.onScreen) return NAVIGATE_SAYS.notInFront
  if (facts.agentPressedAt !== null && facts.now - facts.agentPressedAt < AGENT_PRESS_HOLD_MS) return NAVIGATE_SAYS.agentPressed
  if (!facts.focused) return NAVIGATE_SAYS.notFocused
  return null
}

/** The `context.show` a `moved` hands over: the ask, who asked (from the registration) and when. */
export function shownBy(show: ShowAsk, by: string | undefined, at: Date): SharedShow {
  return { subject: show.subject, id: show.id, ...(by ? { by } : {}), at: at.toISOString() }
}

/** A show the page holds, with the kehikko it is for. */
export interface HeldShow {
  kehikko: number
  show: SharedShow
}

/**
 * The containers told `context.show`: those placed on the kehikko it is for, while that kehikko is
 * open, whose manifests say they show its subject. Nobody else; no module named.
 */
export function showReceivers(
  held: HeldShow | null,
  open: number | null,
  placed: readonly string[],
  manifestOf: (id: string) => ShowingManifest | null | undefined,
): string[] {
  if (held === null || open === null || held.kehikko !== open) return []
  return placed.filter((id) => canShow(manifestOf(id), held.show.subject))
}

/** What the page knows when a `view.goto` comes in. */
export interface JumpFacts {
  /** The asking module's name, for the words, and what its manifest says it sends. */
  name: string
  navigates: readonly string[]
  projects: readonly HeldProject[]
  /** The project open now. */
  open: number | null
  press: PressFacts
}

/** What to do with a `view.goto`: go within the open project, switch project first, or say no. */
export type Jump<C> =
  | { kind: 'here'; call: Omit<C, 'project'> }
  | { kind: 'switch'; project: HeldProject; call: Omit<C, 'project'> }
  | { kind: 'decline'; why: string }

/**
 * The one decision, in order: what the manifest says it sends; then, with a project, that this host
 * holds it; the open one is a move within it; another one only on a person's press.
 */
export function planJump<C extends { project?: string; show?: ShowAsk }>(call: C, facts: JumpFacts): Jump<C> {
  const { project, ...rest } = call
  if (project === undefined && call.show === undefined) return { kind: 'here', call: rest }
  const undeclared = navigatesRefusal(call, facts.navigates, facts.name)
  if (undeclared) return { kind: 'decline', why: undeclared }
  if (project === undefined) return { kind: 'here', call: rest }
  const found = projectFor(facts.projects, project)
  if (!found.ok) return { kind: 'decline', why: found.why }
  if (found.project.id === facts.open) return { kind: 'here', call: rest }
  const refused = personsPressRefusal(facts.press)
  if (refused) return { kind: 'decline', why: refused }
  return { kind: 'switch', project: found.project, call: rest }
}
