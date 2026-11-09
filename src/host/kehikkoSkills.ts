import { KEHIKKO_SKILL_LIMITS, kehikkoSkillIssue, kehikkoSkillText, LIMITS } from 'kehikot-module-protocol'
import { z } from 'zod'

/**
 * A kehikko's own skills, as the page sees them: the person's instructions for every agent session on
 * one kehikko (protocol 2.53.0; the store is `server/kehikkoSkills.ts`). The window is
 * `src/canvas/KehikkoSkills.tsx`, opened from the kehikko menu with `openKehikkoSkills`.
 */

export const keptSkillSchema = z.object({ name: z.string(), description: z.string(), body: z.string(), text: z.string() })
export type KeptSkill = z.infer<typeof keptSkillSchema>

/** What the window tells the person about who gets a skill and when. */
export const DELIVERY_SAID =
  'Every agent session on this kehikko gets these, whatever epic it works on. Sessions started from now on load them; '
  + 'one already running is told at its next prompt and can read the new text, and loads it as a skill after a restart.'

export const LIMITS_SAID = {
  name: LIMITS.SKILL_NAME,
  description: KEHIKKO_SKILL_LIMITS.DESCRIPTION,
  body: KEHIKKO_SKILL_LIMITS.BODY,
  most: KEHIKKO_SKILL_LIMITS.MOST,
} as const

/** A name typed in any way, made into a skill name as far as it can be: "Review Checklist!" → "review-checklist". */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, LIMITS.SKILL_NAME)
    .replace(/-+$/, '')
}

/** What is wrong with a draft, or null; the protocol's rule, so the page refuses what the server would. */
export const draftIssue = (draft: { name: string; description: string; body: string }): string | null => kehikkoSkillIssue(draft)

/** How the skill reads as a session loads it: its SKILL.md. Shown as text, never rendered. */
export const previewOf = (draft: { name: string; description: string; body: string }): string => kehikkoSkillText(draft.name || 'name', draft.description, draft.body)

/** The kehikko's skills, and where in the project they are kept. */
export async function fetchKehikkoSkills(kehikko: number, signal?: AbortSignal): Promise<{ skills: KeptSkill[]; folder: string | null }> {
  const response = await fetch(`/host/kehikko-skills?kehikko=${kehikko}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ skills: z.array(keptSkillSchema), folder: z.string().nullable() }).parse(await response.json())
}

/** Save one: new (`was` absent), changed, or renamed (`was` its old name). */
export async function saveKehikkoSkill(kehikko: number, draft: { name: string; description: string; body: string; was?: string | null }): Promise<string> {
  return post({ kehikko, act: 'save', ...draft })
}

/** Remove one. */
export async function removeKehikkoSkill(kehikko: number, name: string): Promise<string> {
  return post({ kehikko, act: 'remove', name })
}

async function post(body: Record<string, unknown>): Promise<string> {
  const response = await fetch('/host/kehikko-skills', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(await reason(response))
  const said = ((await response.json().catch(() => null)) as { said?: unknown } | null)?.said
  return typeof said === 'string' ? said : 'Done.'
}

async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (body && typeof body.error === 'string') return body.error
  return `Kehikot answered with error ${response.status}`
}

const OPEN = 'kehikot:open-kehikko-skills'

/** "Skills for this kehikko…", for the kehikko that is open. */
export function openKehikkoSkills(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN))
}

export function onOpenKehikkoSkills(then: () => void): () => void {
  window.addEventListener(OPEN, then)
  return () => window.removeEventListener(OPEN, then)
}
