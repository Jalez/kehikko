import { STATE_WORDS, byLine, byPressing, isLive, type Entry } from './inbox.ts'

/**
 * The bar's small count of what needs the person, and what pressing it, or the "Next that needs me"
 * chord, does. The Inbox itself is drawn by a module the person places on a kehikko (protocol
 * 2.79.0, `inbox:person`); the bar keeps only this. Pure: the count, the words, which way a press
 * goes, the top items. Drawn by `canvas/InboxCount.tsx`.
 *
 * The module that shows the Inbox is not named here: it is whichever registered module's manifest
 * declares `inbox:person`, or, before one is installed, the official list's entry whose `role` is
 * `inbox` (`inboxModuleOf`). Its name and icon are the registry's and the list's words.
 */

/** The capability a module declares to show the person's Inbox. */
export const INBOX_CAPABILITY = 'inbox:person'
/** The official list's word for the module that shows the Inbox (`role` on its entry). */
export const INBOX_ROLE = 'inbox'

/** How many things need the person: the open project's live `attention` entries, and the other projects'. */
export function needingCount(entries: readonly Entry[], elsewhere: readonly { entries: readonly Entry[] }[] = []): number {
  const here = entries.filter((one) => isLive(one) && one.state === 'attention').length
  return here + elsewhere.reduce((sum, one) => sum + one.entries.filter((entry) => entry.state === 'attention').length, 0)
}

/** What the count looks like. `number` is null when nothing is drawn beside the icon. */
export interface CountLook {
  /** The number beside the icon, or null. Never the colour without it. */
  number: string | null
  /** Whether the icon and number take the attention colour. Only ever with a number. */
  attention: boolean
  /** The accessible name and tooltip: the count in words, whatever is drawn. */
  label: string
}

/**
 * The look of the count. With "Show notification colour and number" on, a count above zero is drawn
 * as a number in the attention colour; off, the plain icon and nothing else. The label says the count
 * either way: colour is never the only signal, and neither is the number.
 */
export function countLook(needing: number, showColour: boolean, shortcut = 'Alt+Shift+N'): CountLook {
  const said = needing === 0 ? 'nothing needs you' : `${needing} ${needing === 1 ? 'needs' : 'need'} you`
  const label = `Inbox — ${said} (${shortcut} for the next that needs you)`
  if (!showColour || needing === 0) return { number: null, attention: false, label }
  return { number: needing > 99 ? '99+' : String(needing), attention: true, label }
}

/**
 * Where pressing the count goes: to the Inbox's container when one is on this kehikko (it is focused
 * and lit), else the small popover.
 */
export const pressGoes = (placedHere: boolean): 'focus' | 'popover' => (placedHere ? 'focus' : 'popover')

/**
 * What Alt+Shift+N does: the host keeps the chord and asks the Inbox module on this kehikko to go to
 * the next thing that needs the person (`kehikot.inbox` with `next`); with none placed, the popover.
 */
export const chordGoes = (placedHere: boolean): 'tell' | 'popover' => (placedHere ? 'tell' : 'popover')

/** How many items the popover lists. */
export const TOP_ITEMS = 3

/**
 * The popover's items: what needs the person first (urgent, then longest waiting), then what is
 * working, then what finished — at most `TOP_ITEMS`, each one line of plain text.
 */
export function topItems(entries: readonly Entry[], max = TOP_ITEMS): { key: string; text: string }[] {
  const order: Record<Entry['state'], number> = { attention: 0, working: 1, done: 2 }
  return entries
    .filter(isLive)
    .sort((a, b) => order[a.state] - order[b.state] || (a.state === 'attention' ? byPressing(a, b) : b.entered - a.entered))
    .slice(0, max)
    .map((one) => ({ key: `${one.module}\u0000${one.id}`, text: `${byLine(one)} · ${one.named?.says ?? STATE_WORDS[one.state]}: ${one.label}` }))
}

/** A registered module as the bar needs it. */
export interface InboxCandidate {
  id: string
  name: string
  icon?: string | null
  uses?: readonly string[]
}
/** An official list entry as the bar needs it. */
export interface InboxListed {
  id: string
  name: string
  icon?: string | null
  role?: string | null
  installed?: boolean
}

/** The module that shows the Inbox: a registered one declaring the capability, else the list's. */
export function inboxModuleOf(
  registered: readonly InboxCandidate[],
  listed: readonly InboxListed[] = [],
): { id: string; name: string; icon: string | null; registered: boolean } | null {
  const mine = registered.find((one) => one.uses?.includes(INBOX_CAPABILITY))
  if (mine) return { id: mine.id, name: mine.name, icon: mine.icon ?? listed.find((one) => one.id === mine.id)?.icon ?? null, registered: true }
  const theirs = listed.find((one) => one.role === INBOX_ROLE)
  if (theirs) return { id: theirs.id, name: theirs.name, icon: theirs.icon ?? null, registered: registered.some((one) => one.id === theirs.id) }
  return null
}

/** The popover's offer to place it. */
export const addWords = (name: string): string => `Add ${name} to this kehikko`
/** The checkbox's words. */
export const COLOUR_WORDS = 'Show notification colour and number'
