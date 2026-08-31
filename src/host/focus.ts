/**
 * Focus mode: the canvas without its container headers.
 *
 * ## What it is
 *
 * A container's header is a thin strip carrying the module's name, its condition
 * dot, and five controls. Useful, and on a canvas being READ rather than
 * arranged it is thirty-two pixels of chrome above every module, repeated eight
 * or eleven times. Focus mode takes those rows out of the layout and gives the
 * space to the modules.
 *
 * ## Why it hides and does not remove
 *
 * The header is not decoration and two things in it are load-bearing.
 *
 * It IS the drag handle — `.container-grip`, named as such in the grid's
 * configuration and argued for at the top of `Container.tsx`. A header permanently
 * gone is a canvas that cannot be rearranged, with nothing on screen saying
 * why, which is the same class of failure as the resize handle that spent a
 * week underneath an iframe: present, correct, unreachable.
 *
 * And it is the ONLY place a module's name appears. Modules were deliberately
 * stripped of their own titles and one-line descriptions, because a fixed strip
 * of prose at the top of a three-hundred-pixel container competes with the thing
 * somebody opened the module to look at; the host's header carries the name and
 * the summary instead. So a permanently hidden header is a canvas where nothing
 * says which container is which.
 *
 * Hover — and focus — put both back at the moment somebody reaches for them.
 * See `index.css` for how, and for the eight pixels that reveal costs.
 *
 * ## Why a cookie, and why it is read before the first paint
 *
 * The same reason the theme is, and the same mechanism rather than a second
 * one: a preference that is applied by React has already let one frame be
 * painted without it. For the theme that frame is a white flash; here it is a
 * row of headers that appear and then vanish, and every container on the canvas
 * jumping up thirty-two pixels as they go. That is the same defect wearing
 * different clothes, so it gets the same fix — a blocking script in
 * `index.html` puts the class on `<html>` before the body exists, and this file
 * READS BACK what that script decided rather than working it out again.
 *
 * One setting for the whole application, not one per kehikko. It is a statement
 * about how somebody is using the program right now — reading, or arranging —
 * and it would be a strange thing to have to set again on every canvas.
 *
 * ## What the modules are told about it
 *
 * Nothing. A module has no business knowing whether the host drew a header
 * above its frame, and `roadmap.context` deliberately does not grow a field for
 * it: every field in that context is something a module might reasonably behave
 * differently about, and this is not one. The frame is the same size either way
 * as far as the module is concerned — it is handed a rectangle and told how big
 * it is by the resize it already handles.
 */

export type Focus = 'on' | 'off'

/** Duplicated in the inline script in `index.html`, which cannot import it. */
export const FOCUS_COOKIE = 'kehikko.focus'

/** The class the blocking script writes and the stylesheet selects on. */
export const FOCUS_CLASS = 'focus-mode'

/** A year, like the theme. Long enough to feel kept, short enough to expire. */
const A_YEAR = 60 * 60 * 24 * 365

/**
 * Whether the canvas is in focus mode, read from the document itself.
 *
 * The class on `<html>` is the truth: it is what the stylesheet selects on, so
 * it is what a person is actually looking at. The cookie is only how it
 * survived the reload.
 */
export function focused(root: Element | null = document.documentElement): Focus {
  return root?.classList.contains(FOCUS_CLASS) ? 'on' : 'off'
}

/**
 * Put the canvas in or out of focus mode and remember it.
 *
 * The class first, then the cookie, for the reason `theme.ts` gives: if writing
 * the cookie fails — browsers do refuse storage — the mode still changes for as
 * long as this page is open, which is a smaller failure than a preference that
 * was remembered and never applied.
 */
export function applyFocus(focus: Focus, root: Element | null = document.documentElement): void {
  root?.classList.toggle(FOCUS_CLASS, focus === 'on')
  try {
    document.cookie = `${FOCUS_COOKIE}=${focus}; path=/; max-age=${A_YEAR}; samesite=lax`
  } catch {
    /* Cookies refused. The canvas is in the right mode until it is reloaded. */
  }
}

/** The other one. */
export function otherFocus(focus: Focus): Focus {
  return focus === 'on' ? 'off' : 'on'
}
