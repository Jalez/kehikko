import type { HelpEntry } from './headerOffer.ts'

/**
 * The words of the two Help menus — the app's ("?" in the bar, `canvas/Help.tsx`) and each
 * container's (`HELP_ENTRIES` in `host/headerOffer.ts`, drawn by `HelpRows` in
 * `canvas/HeaderMenus.tsx`) — spelled once, so the menus cannot drift apart. A person who found
 * "What's new…" under the app's "?" finds the module's under the container's "?", in the same place.
 *
 * Same title, same icon (the circled question mark), same order: Introduction first, then how to
 * learn your way around (the app's tour; a module's "How to use"), then What's new, then Feedback.
 * The host's words name no module; a module is its registered name, inside these fixed phrases.
 */

/** What both menus are called: the trigger's name, the menu's label, the overflow's section. */
export const HELP_TITLE = 'Help'

/** The rows both menus have, in their order. The app's tour stands where a module's "How to use" does. */
export const HELP_SAID: Record<HelpEntry, string> = {
  intro: 'Introduction…',
  help: 'How to use…',
  notes: "What's new…",
  feedback: 'Feedback',
}

/** The app's own rows, in order: the tour where a module has "How to use". */
export const APP_HELP_ROWS = ['intro', 'tour', 'notes', 'feedback'] as const
export type AppHelpRow = (typeof APP_HELP_ROWS)[number]

/** The app menu's tour rows: one of them stands in the tour's place. */
export const TOUR_SAID = { take: 'Take the tour', restart: 'Restart tour', resume: 'Continue tour' } as const

/** What each row is called in the trigger's tooltip. */
const HELP_HINTS: Record<HelpEntry, string> = {
  intro: 'introduction',
  help: 'how to use it',
  notes: "what's new",
  feedback: 'feedback',
}

/** A container's "?" tooltip: what its Help menu holds, in order. */
export function helpHint(name: string, entries: readonly HelpEntry[]): string {
  return `Help with ${name}: ${entries.map((entry) => HELP_HINTS[entry]).join(', ')}`
}

/** The app's "?" tooltip, in the same pattern. */
export const APP_HELP_HINT = "Help with Kehikot: introduction, the tour, what's new, feedback"
