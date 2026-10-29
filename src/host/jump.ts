/**
 * An agent jumping the person's view, and the walk to a step.
 *
 * ## The jump (#208)
 *
 * The person asked for it: "I want to enable Claude to jump me to another
 * epic/part/project/kehikko." So the host's door has `jump { project?,
 * kehikko?, epic?, parts?, step? }` (`server/mcp.ts`), and this file holds
 * every rule the page keeps when it carries one out. What is left out stays
 * where the person is: a jump naming only a step turns the kehikko to that
 * step and moves nothing else; one naming only parts picks them in the epic
 * that is open; one naming another project goes there as the person's own
 * switch does (`onProject`, the calm switch) and then to the kehikko, epic
 * and parts in it, exactly as a module's 2.28 `view.goto { project }` does.
 *
 * Bounds, which are what keep the view the person's:
 *
 *  - It acts on the page on screen. No page, nothing moves.
 *  - It is marked: "Jumped here by an agent" on the kehikko, and **Go back**
 *    puts back exactly where the person was — project, kehikko, epic (or all
 *    epics), parts and step. A second jump while the mark stands keeps the
 *    first place to go back to: going back undoes the agent, not its last move.
 *  - It is paced: jumps are at least `JUMP_MIN_INTERVAL_MS` apart (the server
 *    holds it), and a jump to where the person already is is ignored
 *    (`planJump`).
 *  - It changes nothing but the view: no arrangement, no data, and not the
 *    conversation's own place (`my_place`), which stays what it was recorded
 *    as until somebody calls `set_my_place`.
 *
 * ## The walk to a step
 *
 * A step is a place on a module's own page — a journey's card, a paper's
 * section — and the host has no page with anchors of its own. What it has is
 * the walk: `kehikot.goto { epic, step }`, posted to a framed module, which
 * answers whether it found that step. Turning the kehikko to a step is walking
 * every container on it there and hearing who found it; a module that does
 * not follow a walk answers "not found" (its client's backstop does it), so
 * "the containers that follow `kehikot.goto`" are the ones that said found.
 * A module's `view.goto { epic, step }` — a person's press on a step of the
 * journey's tree in Flows — walks every OTHER container the same way.
 *
 * The mark is the page's alone, like a fold's (`folds.ts`): never stored, gone
 * with a reload, with Go back, or once the person is somewhere else.
 */

import { NOT_GREETED } from './conversation.ts'
import type { Presses, Walked } from './presses.ts'

/** The least time between two agents' jumps. Long enough to read what arrived, short enough to follow a conversation. */
export const JUMP_MIN_INTERVAL_MS = 2500

/** Who signs a jump. The fold mark's word: `SIGNED` in `server/mcp.ts`. */
export const JUMP_SIGNED = 'an agent'

/** Where the person is: what a jump moves, and what Go back restores. */
export interface Place {
  project: number
  /** The kehikko's key; null when the page has none open. */
  kehikko: string | null
  epic: string | null
  /** `'project'` is "All epics": then `epic` is null and that is not "no epic". */
  scope?: 'epic' | 'project'
  parts: string[]
  /** The step the kehikko was last turned to on this epic, or null. */
  step: number | null
}

/** What an agent asked for. Anything left out is where the person is. */
export interface JumpAsk {
  project?: number
  kehikko?: string
  epic?: string
  parts?: string[]
  step?: number
  /** The step's title, when the server could read it, for the mark. */
  title?: string
}

/** What the page knows when an agent's jump comes in. */
export interface JumpFacts {
  projects: readonly { id: number; name: string; missing?: boolean }[]
  /** The kehikot of a project, by key. */
  kehikotOf(project: number): readonly { key: string; name: string }[]
  /** What a project is about now: where a jump into it lands when it names no epic. */
  subjectOf(project: number): { epic: string | null; scope?: 'epic' | 'project'; parts: readonly string[] }
}

export type JumpPlan = { kind: 'go'; target: Place } | { kind: 'ignored'; why: string } | { kind: 'refused'; why: string }

const sameParts = (a: readonly string[], b: readonly string[]) => [...a].sort().join('+') === [...b].sort().join('+')

/** Whether two places are the same, step aside. */
export function sameView(a: Place, b: Place): boolean {
  return (
    a.project === b.project
    && a.kehikko === b.kehikko
    && (a.scope === 'project') === (b.scope === 'project')
    && a.epic === b.epic
    && sameParts(a.parts, b.parts)
  )
}

/**
 * Where an agent's jump lands, from where the person is: each thing asked for
 * replaces what is there, and the rest stays. Into another project, what is
 * not named is where that project is (its epic and parts; its own kehikko).
 * The server resolved names and checked existence; this checks again against
 * what the page holds, and never guesses.
 */
export function planJump(ask: JumpAsk, now: Place, facts: JumpFacts): JumpPlan {
  const project = ask.project ?? now.project
  const held = facts.projects.find((one) => one.id === project)
  if (!held) return { kind: 'refused', why: 'This page does not hold that project, so nothing moved.' }
  if (held.missing) return { kind: 'refused', why: `The folder of ${held.name} is gone, so nothing moved.` }
  const away = project !== now.project
  if (ask.kehikko !== undefined && !facts.kehikotOf(project).some((one) => one.key === ask.kehikko)) {
    return { kind: 'refused', why: `${held.name} has no such kehikko on this page, so nothing moved.` }
  }
  const kehikko = ask.kehikko ?? (away ? null : now.kehikko)
  const there = away ? facts.subjectOf(project) : { epic: now.epic, scope: now.scope, parts: now.parts }
  const scope: 'epic' | 'project' = ask.epic !== undefined ? 'epic' : there.scope === 'project' ? 'project' : 'epic'
  const epic = ask.epic ?? (scope === 'project' ? null : there.epic)
  const parts = ask.parts ?? (ask.epic === undefined || ask.epic === there.epic ? [...there.parts] : [])
  if ((ask.step !== undefined || ask.parts !== undefined) && epic === null) {
    return {
      kind: 'refused',
      why: `${scope === 'project' ? 'All epics are' : 'No epic is'} open there, and parts and steps are an epic's: name the epic too. Nothing moved.`,
    }
  }
  const sameEpic = !away && epic === now.epic
  const target: Place = {
    project,
    kehikko,
    epic,
    ...(scope === 'project' ? { scope } : {}),
    parts: scope === 'project' ? [] : parts,
    step: ask.step ?? (sameEpic && kehikko === now.kehikko ? now.step : null),
  }
  /* Into another project the project picks its own kehikko: never "already there". */
  if (!away && sameView(target, now) && (ask.step === undefined || ask.step === now.step)) {
    return { kind: 'ignored', why: 'The person is already there, so nothing moved.' }
  }
  return { kind: 'go', target }
}

/** What a jump left on the kehikko: where it went, who, and where the person was before the agent. */
export interface JumpMark {
  to: Place
  /** The step's title, when the server could read it. Text only. */
  title?: string
  by: string
  back: Place
  /** Only the step changed: said as a move to the step, not a jump. */
  stepOnly: boolean
}

/** Whether a mark still describes where the person is. Once they are elsewhere, it is no mark. */
export function markStands(mark: JumpMark | null, now: Place | null): JumpMark | null {
  if (!mark || !now) return null
  return sameView(mark.to, now) ? mark : null
}

/** The mark a jump leaves. Go back is to where the PERSON was: a second jump keeps the first's way back. */
export function markAfter(was: JumpMark | null, now: Place, to: Place, title?: string, by = JUMP_SIGNED): JumpMark {
  const standing = markStands(was, now)
  const back = standing ? standing.back : now
  return { to, ...(title ? { title } : {}), by, back, stepOnly: sameView(back, to) }
}

/** The mark's line. Text only. */
export function jumpMarkText(mark: JumpMark): string {
  const step = mark.to.step !== null ? `step ${mark.to.step}${mark.title ? ` (${mark.title})` : ''}` : ''
  if (mark.stepOnly && step) return `Moved to ${step} by ${mark.by}.`
  return `Jumped here by ${mark.by}${step ? `, at ${step}` : ''}.`
}

/** One container told of a walk: whether it found the step, and its sentence when it did not. */
export interface Told {
  module: string
  found: boolean
  why: string
}

/** More containers than a kehikko holds, and the bound on a sentence carried back. */
export const TOLD_MAX = 64
export const TOLD_WHY_MAX = 300

/** Who is told of a walk: every container on the kehikko whose frame is standing, but the one that asked. */
export function walkersOf(placed: readonly string[], standing: (id: string) => boolean, except?: string): string[] {
  return [...new Set(placed)].filter((id) => id !== except && standing(id))
}

/** Walk each of `ids` to the step, all at once, and hear what each said. A frame not standing is left out. */
export async function walkAll(presses: Pick<Presses, 'walk'>, ids: readonly string[], target: { epic: string; step: number }): Promise<Told[]> {
  const asked = ids.map((id) => [id, presses.walk(id, target)] as const)
  const out: Told[] = []
  for (const [module, walking] of asked) {
    if (!walking) continue
    const came: Walked = await walking.catch((): Walked => ({ found: false, why: 'it did not answer' }))
    out.push({ module, found: came.found, why: came.found ? '' : came.why.slice(0, TOLD_WHY_MAX) })
  }
  return out
}

/**
 * The walk after a jump: the frames of a kehikko just switched to are still
 * coming up, so a container that is not standing yet, or not yet greeted, is
 * asked again a moment later, a few times. `ids` answers null once the person
 * is somewhere else, which ends it.
 */
export async function walkSoon(
  presses: Pick<Presses, 'walk'>,
  ids: () => readonly string[] | null,
  target: { epic: string; step: number },
  { tries = 10, gapMs = 400, wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) } = {},
): Promise<Told[]> {
  const heard = new Map<string, Told>()
  const unheard = () => (ids() ?? []).filter((id) => !heard.has(id))
  for (let attempt = 0; attempt < tries; attempt++) {
    if (ids() === null) break
    const waiting = unheard()
    if (!waiting.length) break
    const came = await Promise.all(
      waiting.map(async (id) => [id, (await presses.walk(id, target)?.catch((): Walked => ({ found: false, why: 'it did not answer' }))) ?? null] as const),
    )
    for (const [module, walked] of came) {
      if (walked === null || (!walked.found && walked.why === NOT_GREETED)) continue
      heard.set(module, { module, found: walked.found, why: walked.found ? '' : walked.why.slice(0, TOLD_WHY_MAX) })
    }
    if (attempt < tries - 1 && unheard().length) await wait(gapMs)
  }
  for (const id of unheard()) heard.set(id, { module: id, found: false, why: 'it was not ready in time' })
  return [...heard.values()]
}

/** A walk's answer, for an agent: who followed and who was told and did not. */
export function toldWords(told: readonly Told[], names: (id: string) => string): string {
  const found = told.filter((one) => one.found)
  const not = told.filter((one) => !one.found)
  const said: string[] = []
  said.push(
    found.length
      ? `Followed the step: ${found.map((one) => `${names(one.module)} (${one.module})`).join(', ')}.`
      : 'No container on the kehikko followed the step: none answered that it found it.',
  )
  if (not.length) {
    said.push(`Told and did not follow: ${not.map((one) => `${names(one.module)} (${one.module})${one.why ? ` — ${one.why}` : ''}`).join('; ')}.`)
  }
  return said.join(' ')
}

/** Why the server will not pass a jump on yet, or null. `last` is when an agent last jumped the view. */
export function paceRefusal(last: number | undefined, now: number, min = JUMP_MIN_INTERVAL_MS): string | null {
  if (last === undefined || now - last >= min) return null
  const wait = Math.ceil((min - (now - last)) / 100) / 10
  return `The view was jumped a moment ago; jumps are at least ${min / 1000} seconds apart so the person can follow. Nothing moved. Ask again in ${wait} s, and only when there is somewhere new to go.`
}

/** A list of told containers off the wire, bounded, or null for anything else. */
export function toldIn(value: unknown): Told[] | null {
  if (!Array.isArray(value) || value.length > TOLD_MAX) return null
  const out: Told[] = []
  for (const one of value) {
    if (typeof one !== 'object' || one === null) return null
    const { module, found, why } = one as Record<string, unknown>
    if (typeof module !== 'string' || !module || module.length > 64 || typeof found !== 'boolean') return null
    out.push({ module, found, why: typeof why === 'string' ? why.slice(0, TOLD_WHY_MAX) : '' })
  }
  return out
}
