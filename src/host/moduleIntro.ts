import { z } from 'zod'
import { introOf, introSeconds, type Help, type Intro, type IntroArt } from 'kehikot-module-protocol'

/**
 * A module's own introduction (protocol 2.57.0), as the host offers it. Pure, shared by the page and
 * the server, so the "?", the Container menu, the offer on a container and the dialog cannot disagree.
 *
 * The module WRITES it — slides of plain text and pictures said as shapes — and the host shows it in
 * its own introduction dialog (`IntroModal`). The host's words here name no module: a module is its
 * registered name, inside fixed phrases.
 */

/** One slide as the dialog draws it: the app's own slides and a module's both come to this. */
export interface ShownSlide {
  id: string
  title: string
  body: string
  /** Points drawn as a list under the body: a module's "How to use" sections. */
  points?: readonly string[]
  /** A module's picture, drawn by the host (`ModuleArt`). */
  art?: IntroArt
}

/** A module's introduction from its manifest, as the sweep read it; null for none. */
export function introFor(manifest: { intro?: unknown } | null | undefined): Intro | null {
  return introOf(manifest)
}

/** A module's slides, numbered. */
export function slidesOfIntro(intro: Intro): ShownSlide[] {
  return intro.slides.map((slide, at) => ({ id: `slide-${at + 1}`, title: slide.title, body: slide.body, ...(slide.art ? { art: slide.art } : {}) }))
}

/**
 * A module with no introduction but a "How to use" (protocol 2.52.0) is shown that in the same
 * dialog: its summary first, then a slide per section, the points as a list.
 */
export function slidesOfHelp(name: string, help: Help): ShownSlide[] {
  return [
    { id: 'help', title: helpSlideTitle(name), body: help.summary },
    ...help.sections.map((section, at) => ({ id: `help-${at + 1}`, title: section.title, body: '', points: section.points })),
  ]
}

/** With neither, the one line it says about itself. */
export function slidesOfSummary(name: string, summary: string | null | undefined): ShownSlide[] {
  return [{ id: 'summary', title: name, body: summary?.trim() || 'This module says nothing more about itself.' }]
}

export function helpSlideTitle(name: string): string {
  return `How to use ${name}`
}

/** The dialog's accessible name, and the "?"'s, for a module. */
export function introTitle(name: string): string {
  return `Introduction to ${name}`
}

/** The offer on a container: about how long, in the host's own words. */
export function offerSaid(intro: Intro): string {
  return `Watch a ${introSeconds(intro)}-second introduction`
}

/* ------------------------------------------------------------------ *
 * Adding the module from the dialog
 * ------------------------------------------------------------------ */

/**
 * What the dialog's add button says and does, from where the module is now:
 *
 *  - `placed`: on this kehikko already — disabled.
 *  - `newer`: it needs a newer Kehikot than this one — disabled, the app version when it is known.
 *  - `installing`: an install is on its way — disabled, with its step.
 *  - `install`: on a list and not installed — "Install and add", the existing install path.
 *  - `add`: registered here — "Add to this kehikko".
 *  - `none`: no kehikko is open, or nothing is known of it — no button.
 */
export type AddState =
  | { kind: 'add' }
  | { kind: 'install' }
  | { kind: 'installing'; step: string }
  | { kind: 'placed' }
  | { kind: 'newer'; app: string | null }
  | { kind: 'none' }

export interface AddFacts {
  /** A kehikko is open to add it to. */
  open: boolean
  placed: boolean
  registered: boolean
  /** Its list entry, when it is on one and not installed. */
  listed?: { installing?: string | null; newer?: { app: string | null } | null } | null
}

export function addStateOf(facts: AddFacts): AddState {
  if (!facts.open) return { kind: 'none' }
  if (facts.placed) return { kind: 'placed' }
  if (facts.registered) return { kind: 'add' }
  if (!facts.listed) return { kind: 'none' }
  if (facts.listed.newer) return { kind: 'newer', app: facts.listed.newer.app }
  if (facts.listed.installing) return { kind: 'installing', step: facts.listed.installing }
  return { kind: 'install' }
}

export function addSaid(state: AddState): string | null {
  switch (state.kind) {
    case 'add':
      return 'Add to this kehikko'
    case 'install':
      return 'Install and add'
    case 'installing':
      return `${state.step[0]?.toUpperCase() ?? ''}${state.step.slice(1)}…`
    case 'placed':
      return 'Already on this kehikko'
    case 'newer':
      return state.app ? `Needs Kehikot ${state.app} or later` : 'Needs a newer Kehikot'
    case 'none':
      return null
  }
}

export function addDisabled(state: AddState): boolean {
  return state.kind === 'placed' || state.kind === 'newer' || state.kind === 'installing'
}

/* ------------------------------------------------------------------ *
 * Watched or dismissed, machine-wide (`server/moduleIntros.ts`)
 * ------------------------------------------------------------------ */

export const moduleIntrosSchema = z.object({
  /** Module ids whose introduction the person watched or waved away: offered no more. */
  done: z.array(z.string().min(1).max(200)).max(1000).default([]),
})
export type ModuleIntros = z.infer<typeof moduleIntrosSchema>
export const NO_INTROS_SEEN: ModuleIntros = Object.freeze({ done: [] }) as ModuleIntros

export const moduleIntrosEditSchema = z.object({ done: z.string().min(1).max(200) })
export type ModuleIntrosEdit = z.infer<typeof moduleIntrosEditSchema>

/** One more id done; the same object when it already was. */
export function introsEdited(was: ModuleIntros, edit: ModuleIntrosEdit): ModuleIntros {
  if (was.done.includes(edit.done)) return was
  return { done: [...was.done, edit.done].slice(-1000) }
}

/** Whether a placed container offers its module's introduction: it has one, and the person has not watched or dismissed it. */
export function offersIntro(id: string, intro: Intro | null, seen: ModuleIntros | null): boolean {
  return intro !== null && seen !== null && !seen.done.includes(id)
}

/* ------------------------------------------------------------------ *
 * The page's side of the wire
 * ------------------------------------------------------------------ */

/** The introduction the server could read for a module, wherever it is (running, installed, or not yet). */
export async function fetchIntro(id: string, signal?: AbortSignal): Promise<Intro | null> {
  const response = await fetch(`/host/module-intro?module=${encodeURIComponent(id)}`, { signal, cache: 'no-store' })
  if (!response.ok) return null
  const body = (await response.json().catch(() => null)) as { intro?: unknown } | null
  return introOf({ intro: body?.intro })
}

export async function fetchIntrosSeen(signal?: AbortSignal): Promise<ModuleIntros | null> {
  const response = await fetch('/host/module-intros', { signal, cache: 'no-store' }).catch(() => null)
  if (!response?.ok) return null
  const parsed = moduleIntrosSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data : null
}

export async function markIntroDone(id: string): Promise<ModuleIntros | null> {
  const response = await fetch('/host/module-intros', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ done: id }),
  }).catch(() => null)
  if (!response?.ok) return null
  const parsed = moduleIntrosSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data : null
}
