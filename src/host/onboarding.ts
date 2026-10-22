import { z } from 'zod'

/**
 * The introduction and the tour: whether the person has seen the one, and
 * where they left the other.
 *
 * Kept by the host (`server/onboarding.ts`, one row of `settings` in
 * `frame.sqlite`), not in browser storage: the desktop window's storage is not
 * a record anybody can count on, and "shown once" has to mean once. Machine
 * level, because it is about the person meeting the app, not about a project.
 *
 * `INTRO_VERSION` is which introduction was seen. Everybody — a new install
 * and everybody who updates to the host that first had one — starts unseen
 * and is shown it once; a later introduction that says something new bumps
 * the number and is shown once again.
 */

export const INTRO_VERSION = 1

export const onboardingSchema = z.object({
  /** The introduction last seen (or skipped), 0 for none. */
  intro: z.number().int().min(0).catch(0).default(0),
  tour: z
    .object({
      /** The stop the person left the tour at, to resume from; null when not started or finished. */
      at: z.number().int().min(0).max(100).nullable().catch(null).default(null),
      finished: z.boolean().catch(false).default(false),
    })
    .catch({ at: null, finished: false })
    .default({ at: null, finished: false }),
})
export type Onboarding = z.infer<typeof onboardingSchema>

export const NOT_STARTED: Onboarding = { intro: 0, tour: { at: null, finished: false } }

/** What may be changed in one POST: the introduction seen, and where the tour is. */
export const onboardingEditSchema = z
  .object({
    intro: z.literal('seen').optional(),
    tour: z
      .object({ at: z.number().int().min(0).max(100).nullable(), finished: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict()
export type OnboardingEdit = z.infer<typeof onboardingEditSchema>

export function edited(was: Onboarding, edit: OnboardingEdit): Onboarding {
  return {
    intro: edit.intro === 'seen' ? Math.max(was.intro, INTRO_VERSION) : was.intro,
    tour: edit.tour ? { at: edit.tour.at, finished: edit.tour.finished ?? (edit.tour.at === null ? was.tour.finished : false) } : was.tour,
  }
}

/** Should the introduction open by itself? Only when this one has not been seen. */
export function introDue(state: Onboarding | null): boolean {
  return state !== null && state.intro < INTRO_VERSION
}

/* The page's side. */

export async function fetchOnboarding(signal?: AbortSignal): Promise<Onboarding | null> {
  try {
    const response = await fetch('/host/onboarding', { signal, cache: 'no-store' })
    /* An older host has no such route: nothing is shown by itself. */
    if (!response.ok) return null
    return onboardingSchema.parse(await response.json())
  } catch {
    return null
  }
}

export async function postOnboarding(edit: OnboardingEdit): Promise<Onboarding | null> {
  try {
    const response = await fetch('/host/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edit),
    })
    if (!response.ok) return null
    return onboardingSchema.parse(await response.json())
  } catch {
    return null
  }
}

/* Opening the introduction, the tour and the layout picker from anywhere —
   the help menu, the empty canvas, the introduction's last step — the way
   `openSettings` opens Settings. */

const OPEN_INTRO = 'kehikot:open-intro'
const OPEN_TOUR = 'kehikot:open-tour'
const OPEN_LAYOUTS = 'kehikot:open-layouts'

export type TourStart = 'resume' | 'over'

export function openIntro(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_INTRO))
}

export function openTour(from: TourStart = 'over'): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_TOUR, { detail: from }))
}

/** `fill`: put the layout on the open kehikko (it is empty); `new`: make a new kehikko from it. */
export type LayoutsMode = 'new' | 'fill'

export function openLayouts(mode: LayoutsMode = 'new'): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_LAYOUTS, { detail: mode }))
}

export function onOpenIntro(then: () => void): () => void {
  window.addEventListener(OPEN_INTRO, then)
  return () => window.removeEventListener(OPEN_INTRO, then)
}

export function onOpenTour(then: (from: TourStart) => void): () => void {
  const listener = (event: Event) => then(((event as CustomEvent).detail as TourStart) ?? 'over')
  window.addEventListener(OPEN_TOUR, listener)
  return () => window.removeEventListener(OPEN_TOUR, listener)
}

export function onOpenLayouts(then: (mode: LayoutsMode) => void): () => void {
  const listener = (event: Event) => then(((event as CustomEvent).detail as LayoutsMode) ?? 'new')
  window.addEventListener(OPEN_LAYOUTS, listener)
  return () => window.removeEventListener(OPEN_LAYOUTS, listener)
}

const OPEN_SAVE_LAYOUT = 'kehikot:open-save-layout'

/** "Save this kehikko as a layout…", for the kehikko that is open. */
export function openSaveLayout(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_SAVE_LAYOUT))
}

export function onOpenSaveLayout(then: () => void): () => void {
  window.addEventListener(OPEN_SAVE_LAYOUT, then)
  return () => window.removeEventListener(OPEN_SAVE_LAYOUT, then)
}
