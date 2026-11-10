import { compareVersions, findSaid, versionParts, type FindDirection } from 'kehikot-module-protocol'

/**
 * Find in a container (protocol 2.69.0): the rules of the bar the host draws over the top of a
 * module's page. The page does the searching — it is a cross-origin frame, so only it can see its
 * text — and this host draws one bar for every module: the input, `3 of 17`, previous and next,
 * case, close. What is sent is `kehikot.find`; what comes back is `kehikot.find.result`. ⌘F pressed
 * inside a page reaches the host as `kehikot.find.open`; pressed on the host's own page it is heard
 * here (`findKeyOf`).
 *
 * The bar's state is the host's own (it is the host's control, not a module's state): open or not,
 * the query, the case option, the id of the latest search and what it came to.
 */

/** The protocol version that has Find. A module built before it drops `kehikot.find` unread. */
export const FIND_SINCE = '2.69.0'

/** How long a module has to answer its first search before the bar says it cannot be searched. */
export const FIND_ANSWER_MS = 1500

/** What the bar says for a module that cannot search what it shows, or is too old to be asked. */
export const CANNOT_SEARCH = "This module can't be searched yet"

/** The keys of Find: ⌘F (Ctrl+F off a Mac) opens the bar, ⌘G and ⇧⌘G step. */
export type FindKey = 'open' | 'next' | 'prev'

export interface FindKeyEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/** Which key of Find this is, or `null`. The modifier is ⌘ on a Mac and Ctrl elsewhere, never both. */
export function findKeyOf(event: FindKeyEvent, mac: boolean): FindKey | null {
  if (event.altKey) return null
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null
  const key = event.key.toLowerCase()
  if (key === 'f') return event.shiftKey ? null : 'open'
  if (key === 'g') return event.shiftKey ? 'prev' : 'next'
  return null
}

/** What a key pressed in the bar's input does: Enter steps forward, ⇧Enter back, Escape closes. */
export function inputKeyOf(event: FindKeyEvent, mac: boolean): FindKey | 'close' | null {
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Enter') return event.shiftKey ? 'prev' : 'next'
  const key = findKeyOf(event, mac)
  return key === 'open' ? null : key
}

/** What a search came to, as this host holds it. */
export type FindResult = { total: number; current: number } | 'unsupported'

export interface FindBar {
  open: boolean
  query: string
  caseSensitive: boolean
  /** The id of the latest `kehikot.find` sent, or `null` when none has been. */
  asked: string | null
  /** What the latest search came to; `null` while it has not said. */
  result: FindResult | null
  /** Whether the page has ever answered a search since the bar opened: a slow page is not an unsearchable one. */
  heard: boolean
  /** Counts each request to put focus in the input, so asking again while open still moves it there. */
  focus: number
}

export const CLOSED_BAR: FindBar = { open: false, query: '', caseSensitive: false, asked: null, result: null, heard: false, focus: 0 }

/** What changes a bar. */
export type FindAct =
  | { kind: 'open'; query?: string }
  | { kind: 'query'; query: string }
  | { kind: 'case'; caseSensitive: boolean }
  | { kind: 'asked'; id: string | null }
  | { kind: 'result'; id: string; result: FindResult }
  | { kind: 'silent'; id: string }
  | { kind: 'close' }

/** The one rule for a bar's state. Pure. */
export function findBar(bar: FindBar, act: FindAct): FindBar {
  switch (act.kind) {
    case 'open':
      return {
        ...bar,
        open: true,
        query: act.query !== undefined && act.query !== '' ? act.query : bar.query,
        heard: bar.open ? bar.heard : false,
        result: bar.open ? bar.result : null,
        focus: bar.focus + 1,
      }
    case 'query':
      return { ...bar, query: act.query }
    case 'case':
      return { ...bar, caseSensitive: act.caseSensitive }
    case 'asked':
      /* `null`: nothing could be sent (no page standing, or one too old): it cannot be searched. */
      return act.id === null ? { ...bar, asked: null, result: 'unsupported' } : { ...bar, asked: act.id }
    case 'result':
      if (!bar.open || act.id !== bar.asked) return bar
      return { ...bar, result: act.result, heard: true }
    case 'silent':
      /* No answer to this search in time: unsearchable only if the page has never answered one. */
      if (!bar.open || act.id !== bar.asked || bar.heard || bar.result !== null) return bar
      return { ...bar, result: 'unsupported' }
    case 'close':
      return { ...bar, open: false, asked: null, result: null, heard: false }
  }
}

/** What a search of `query` sends: the direction the page is asked to go, with the bar's options. */
export function findAsk(bar: FindBar, direction: FindDirection) {
  return { query: bar.query, caseSensitive: bar.caseSensitive, wholeWord: false, direction }
}

/** What the bar says beside the input: `3 of 17`, `No results`, the sentence, or nothing. */
export function findCount(bar: FindBar): string {
  if (bar.result === 'unsupported') return CANNOT_SEARCH
  if (!bar.query || bar.result === null) return ''
  return findSaid(bar.result, bar.query)
}

/** The same, short, for a narrow bar: `3/17`, `0/0`. */
export function findCountShort(bar: FindBar): string {
  if (bar.result === 'unsupported') return CANNOT_SEARCH
  if (!bar.query || bar.result === null) return ''
  return `${bar.result.total === 0 ? 0 : Math.max(bar.result.current, 1)}/${bar.result.total}`
}

/**
 * How the bar is drawn at a container's width. `wide` (300 and up): input, `3 of 17`, previous,
 * next, case, close. `narrow` (220 to 299): the count short (`3/17`). `tight` (under 220): the case
 * button goes too — ⇧Enter, ⌘G and the case of what was typed still work.
 */
export type FindBarMode = 'wide' | 'narrow' | 'tight'

export function findBarMode(width: number | null): FindBarMode {
  if (width === null || width >= 300) return 'wide'
  return width >= 220 ? 'narrow' : 'tight'
}

/**
 * Whether a module can be asked at all, from the protocol it was built with (`build.protocol`):
 * `false` for one built before Find, `null` when it does not say (ask, and wait for an answer).
 */
export function canBeAsked(builtWith: string | null | undefined): boolean | null {
  if (!builtWith || !versionParts(builtWith)) return null
  return compareVersions(builtWith, FIND_SINCE) >= 0
}

/** The container (or the one shown large) that holds this element: what a key in the host's page is for. */
export function containerOf(element: Element | null): string | null {
  const holder = element?.closest('[data-module], [data-expanded]')
  return holder?.getAttribute('data-module') ?? holder?.getAttribute('data-expanded') ?? null
}

/** A dialog that takes the keys, which the panel of a container shown large is not. */
export const KEY_DIALOGS = '[role=dialog]:not([data-expanded])'
