import { z } from 'zod'

import { forgetRead, hostRead, keepRead } from './hostRead.ts'

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

export const INTRO_VERSION = 3

/**
 * "Introducing: Spaces" — the card that tells a person who used the app before
 * that epics and parts became spaces. Where the person stands with it:
 *
 *   - `unseen`: not met yet. A person who has met the app before (`metBefore`)
 *     is shown the card once, by itself (`spacesDue`).
 *   - `news`: shown the card. The Introduction from Help keeps it as its first
 *     slide for them.
 *   - `taught`: met spaces in the regular introduction as a new user, which
 *     explains them; never shown the card.
 *
 * Additive: a row from before has no `spaces` and reads as `unseen`.
 */
export const SPACES_SEEN = ['news', 'taught'] as const
export type SpacesSeen = (typeof SPACES_SEEN)[number]

/** A tour step's id, as `src/host/tour.ts` names them. Kept as a string so a step added later reads in an older row. */
const stepId = z.string().regex(/^[a-z][a-z-]{0,39}$/)

export const tourStateSchema = z
  .object({
    /** The step the person is at, or left the tour at; null when not started or finished. */
    step: stepId.nullable().catch(null).default(null),
    /** Paused by "I've got this" (or Escape, or ✕): "Continue tour" in the Help menu picks it up at `step`. */
    paused: z.boolean().catch(false).default(false),
    finished: z.boolean().catch(false).default(false),
  })
  .catch({ step: null, paused: false, finished: false })
export type TourState = z.infer<typeof tourStateSchema>

export const onboardingSchema = z.object({
  /** The introduction last seen (or skipped), 0 for none. */
  intro: z.number().int().min(0).catch(0).default(0),
  /** "Introducing: Spaces": `unseen`, `news` (shown the card) or `taught` (a new user, told in the introduction). */
  spaces: z.enum(['unseen', ...SPACES_SEEN]).catch('unseen').default('unseen'),
  /* A row from the first tour (`{ at, finished }`) reads as not started: its
     stops were numbered, and the numbers mean nothing now. */
  tour: tourStateSchema.default({ step: null, paused: false, finished: false }),
})
export type Onboarding = z.infer<typeof onboardingSchema>

export const NOT_STARTED: Onboarding = { intro: 0, spaces: 'unseen', tour: { step: null, paused: false, finished: false } }

/** What may be changed in one POST: the introduction seen, and where the tour is. */
export const onboardingEditSchema = z
  .object({
    intro: z.literal('seen').optional(),
    spaces: z.enum(SPACES_SEEN).optional(),
    tour: z
      .object({ step: stepId.nullable(), paused: z.boolean().optional(), finished: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict()
export type OnboardingEdit = z.infer<typeof onboardingEditSchema>

/**
 * One edit applied. A tour edit says where the tour is now; `paused` and
 * `finished` are false unless it says otherwise — moving on is not paused,
 * and a step is not finished.
 */
export function edited(was: Onboarding, edit: OnboardingEdit): Onboarding {
  return {
    intro: edit.intro === 'seen' ? Math.max(was.intro, INTRO_VERSION) : was.intro,
    /* Once met it stays met; only being shown the card later makes it `news`. */
    spaces: edit.spaces === 'news' ? 'news' : was.spaces === 'unseen' && edit.spaces ? edit.spaces : was.spaces,
    tour: edit.tour
      ? { step: edit.tour.step, paused: edit.tour.paused ?? false, finished: edit.tour.finished ?? false }
      : was.tour,
  }
}

/** Can the tour be continued from where it was paused? */
export function continuable(state: Onboarding | null): boolean {
  return state !== null && state.tour.paused && state.tour.step !== null && !state.tour.finished
}

/** Was the tour left running (not paused, not finished) — a reload in the middle of it — so it picks up by itself? */
export function underway(state: Onboarding | null): boolean {
  return state !== null && state.tour.step !== null && !state.tour.paused && !state.tour.finished
}

/** Should the introduction open by itself? Only when this one has not been seen. */
export function introDue(state: Onboarding | null): boolean {
  return state !== null && state.intro < INTRO_VERSION
}

/**
 * Has this person met the app before? Judged from this record alone, which the
 * host has kept since the first introduction: they saw (or skipped) an
 * introduction of any version, or started or finished the tour. Not from
 * projects or epics on the machine — a fresh install can open on folders that
 * already hold a `.kehikot`, and a person can have used the app without making
 * either.
 */
export function metBefore(state: Onboarding | null): boolean {
  return state !== null && (state.intro > 0 || state.tour.step !== null || state.tour.finished)
}

/** Should "Introducing: Spaces" open by itself? Once, for a person who met the app before spaces. */
export function spacesDue(state: Onboarding | null): boolean {
  return state !== null && state.spaces === 'unseen' && metBefore(state)
}

/** Does the Introduction carry the "Introducing: Spaces" card: due now, or shown before (Help keeps it). */
export function spacesNews(state: Onboarding | null): boolean {
  return spacesDue(state) || state?.spaces === 'news'
}

/**
 * What closing the Introduction records: the introduction seen when it was due,
 * and spaces met — as `news` when the deck carried the card, `taught` when the
 * regular introduction told them. Null when there is nothing new to record.
 */
export function seenEdit(state: Onboarding | null, news: boolean): OnboardingEdit | null {
  if (state === null) return { intro: 'seen' }
  const edit: OnboardingEdit = {
    ...(introDue(state) ? { intro: 'seen' as const } : {}),
    ...(state.spaces === 'unseen' || (news && state.spaces !== 'news') ? { spaces: news ? ('news' as const) : ('taught' as const) } : {}),
  }
  return Object.keys(edit).length ? edit : null
}

/* The page's side. */

/** Read once per page load, whoever asks (`hostRead`); afresh with `fresh` — the Help menu opened. */
export async function fetchOnboarding(signal?: AbortSignal, fresh = false): Promise<Onboarding | null> {
  try {
    return await hostRead(
      'onboarding',
      async () => {
        const response = await fetch('/host/onboarding', { cache: 'no-store' })
        /* An older host has no such route: nothing is shown by itself, and nothing is kept. */
        if (!response.ok) throw new Error(`the host answered ${response.status}`)
        return onboardingSchema.parse(await response.json())
      },
      { signal, fresh },
    )
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
    const state = onboardingSchema.parse(await response.json())
    keepRead('onboarding', state)
    return state
  } catch {
    forgetRead('onboarding')
    return null
  }
}

/* Opening the introduction, the tour and the layout picker from anywhere —
   the help menu, the empty canvas, the introduction's last step — the way
   `openSettings` opens Settings. */

const OPEN_INTRO = 'kehikot:open-intro'
const OPEN_TOUR = 'kehikot:open-tour'
const OPEN_LAYOUTS = 'kehikot:open-layouts'

/** `resume`: from the step it was left at; `over`: from the first step not already done. */
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
