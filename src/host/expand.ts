import type { ExpandResult } from 'kehikot-module-protocol'

/**
 * A container shown LARGE over the canvas for a while, and put back (protocol 2.58.0, `view.expand`).
 *
 * The person's own words for why: a module kept in a small square on the canvas "doesn't look like
 * much and isn't usable" — a terminal in two hundred pixels is unreadable — so the square is left as
 * it is, and pressing it shows the container large, over the canvas, until it is put back.
 *
 * ## Nothing in the arrangement changes
 *
 * Which container is expanded is the page's, and nothing else: it is not a placement, not a size,
 * not a fold, and it is never written. Switching kehikko, removing the container or folding it puts
 * it back; so do Escape (from the host's own page — a key pressed inside the module's page is the
 * module's, and a terminal needs its Escape), a press outside it and "Shrink back".
 *
 * ## The page is moved, never reloaded
 *
 * A module's page lives in the frames layer and is positioned over its container's body by a
 * measured rectangle (`Frames.tsx`, `host/rects.ts`). Expanding gives it ANOTHER body to be measured
 * against — the large panel's, under `EXPANDED_BODY` — and raises it over the canvas; the iframe is
 * the same element in the same place in the DOM, so the document in it, and a terminal session in
 * that, is not disturbed. The frame is resized once each way, and nothing is drawn over it: a
 * module's revealed rows (`reveal: 'over'`) cover nothing while it is large.
 *
 * ## Who may ask
 *
 * The person, from the container's menu ("Expand"), and the module's own page with `view.expand` —
 * only for its own container, only on the kehikko that is open, and, to expand, only on the person's
 * fresh press in that page (`pressFreshFor` in `host/gesture.ts`: the browser's activation, or a press
 * into the frame this page saw itself). A module may always ask to be put back. The person's own
 * "Expand" in the Container menu is the host's press, and asks no witness.
 */

/** The key the large panel's body is measured under, beside the containers' (`useRects().body`). Never a module id. */
export const EXPANDED_BODY = '#expanded'

/** Why a module's `view.expand` was declined without the person's press: said on the module's tile. */
export const EXPAND_NO_PRESS = 'Shown large only on your own press, and the host did not see one. Press again, or choose Expand in the Container menu.'

/** What the row and the button say. */
export const EXPAND_WORD = 'Expand'
export const SHRINK_WORD = 'Shrink back'

/** How much of the canvas the large panel takes, each way. */
export const EXPANDED_SHARE = 0.8

/** Which container is shown large, and on which kehikko; null when none is. */
export interface Expanded {
  kehikko: string | number
  id: string
}

/**
 * What a module's `view.expand` comes to, and what is expanded after it. `onOpen` is whether the
 * asker's container is on the kehikko that is open and showing its page; `busy` a sentence when the
 * canvas will not now (a drag in hand). `pressed` is whether the person's press in the page was fresh.
 */
export function expandAsked(
  now: Expanded | null,
  call: { from: string; expand: boolean; pressed: boolean; kehikko: string | number | null; onOpen: boolean; busy?: string | null },
): { result: ExpandResult; next: Expanded | null } {
  const mine = now !== null && now.id === call.from && now.kehikko === call.kehikko
  if (!call.expand) {
    if (!mine) return { result: { outcome: 'unchanged', why: '' }, next: now }
    return { result: { outcome: 'shrunk', why: '' }, next: null }
  }
  if (mine) return { result: { outcome: 'unchanged', why: '' }, next: now }
  if (call.kehikko === null || !call.onOpen) {
    return { result: { outcome: 'declined', why: 'This container is not showing on the kehikko that is open.' }, next: now }
  }
  if (!call.pressed) {
    return { result: { outcome: 'declined', why: EXPAND_NO_PRESS }, next: now }
  }
  if (call.busy) return { result: { outcome: 'declined', why: call.busy }, next: now }
  return { result: { outcome: 'expanded', why: '' }, next: { kehikko: call.kehikko, id: call.from } }
}

/**
 * The container that is expanded on this kehikko, or null: one expanded on another kehikko, one no
 * longer placed here, one folded and one whose page is not what is showing are all put back.
 */
export function expandedHere(
  now: Expanded | null,
  kehikko: string | number | null,
  placements: readonly { i: string; collapsed?: boolean }[],
  showsPage: (id: string) => boolean,
): string | null {
  if (!now || kehikko === null || now.kehikko !== kehikko) return null
  const placed = placements.find((one) => one.i === now.id)
  if (!placed || placed.collapsed || !showsPage(now.id)) return null
  return now.id
}

/** Whether a key pressed on the host's page puts the large container back. */
export function shrinksOn(key: string): boolean {
  return key === 'Escape'
}
