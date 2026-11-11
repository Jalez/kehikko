/**
 * How much of the person's GitHub hourly limit Kehikot may spend on its own
 * background reads — the bounds, the words, the change the settings route
 * takes, and how a sentence that says the share is used up is recognised.
 * Pure; shared by the server (`server/githubShare.ts`, `server/githubAccount.ts`)
 * and the page (Settings › Trackers, and the Trackers menu's "Change limit").
 */

/** The share as a whole percent of each hourly limit. */
export const SHARE_PERCENT = { min: 5, max: 50, default: 20 } as const

export const GITHUB_SHARE = {
  label: 'Share of your GitHub limit Kehikot may use',
  description:
    'Kehikot reads GitHub as you, in the background, up to this part of your hourly limit. What is left stays yours; a read you press for may go past it. Kehikot always leaves the last 10% alone.',
} as const

/** The id of this control in Settings: what a link to it names (`SETTINGS_TARGETS`). */
export const GITHUB_SHARE_TARGET = 'github-share'

/** A percent as stored: a whole number inside the bounds, else null. */
export function sharePercentOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value >= SHARE_PERCENT.min && value <= SHARE_PERCENT.max ? value : null
}

/** A change the route takes: `{ share: <percent> }`, or null for anything else. */
export function shareChange(body: unknown): number | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'share') return null
  return sharePercentOf((body as { share?: unknown }).share)
}

/** What the person typed, as a percent inside the bounds (clamped), or null when it is not a number. */
export function shareFromInput(text: string): number | null {
  if (text.trim() === '') return null
  const n = Number(text)
  if (!Number.isFinite(n)) return null
  return Math.min(SHARE_PERCENT.max, Math.max(SHARE_PERCENT.min, Math.round(n)))
}

/** Whether a sentence says Kehikot's share of the account's limit is used up (`decide` in `server/githubAccount.ts`). */
export function isShareNotice(text: string | null | undefined): boolean {
  return typeof text === 'string' && /share of your GitHub (?:GraphQL )?limit is used/.test(text)
}
