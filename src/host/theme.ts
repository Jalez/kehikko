/**
 * Light or dark, and where that fact lives.
 *
 * ## This file does not decide the theme on load
 *
 * A blocking script in `index.html` does, before the body exists, because
 * anything that runs after first paint has already let a page in the wrong
 * palette be shown for a frame — which is the flash, and it cannot be undone
 * afterwards. See the comment there; it is the long version.
 *
 * So `current()` READS BACK what that script decided rather than working it out
 * again from the cookie. Two implementations of one decision are two things
 * that can disagree, and they would disagree exactly in the cases hardest to
 * reproduce: no cookie, a browser refusing storage, a cookie with something
 * unexpected in it. There is one decision, made once, and this asks the DOM
 * what it was.
 *
 * ## Why a cookie
 *
 * Because a cookie is sent with the request for the document. Nothing here is
 * server-rendered today, and if it ever is, the palette is a thing the server
 * can know before it writes a byte. `localStorage` is invisible to a server and
 * choosing it would quietly close that door for a saving of nothing.
 *
 * It is not a session cookie and not a tracking one: same-site, no domain
 * widening, one word of a person's own preference about their own screen.
 */

export type Theme = 'light' | 'dark'

/** Duplicated in the inline script in `index.html`, which cannot import it. */
export const THEME_COOKIE = 'kehikko.theme'

/** A year. Long enough that a preference feels kept; short enough to expire. */
const A_YEAR = 60 * 60 * 24 * 365

/**
 * What the page is currently in, read from the document itself.
 *
 * The class on `<html>` is the truth: it is what the stylesheet selects on, so
 * it is what a person is actually looking at. Anything else — the cookie, a
 * media query, a React state — is a claim about it.
 */
export function current(root: Element | null = document.documentElement): Theme {
  return root?.classList.contains('dark') ? 'dark' : 'light'
}

/**
 * Put the page in a theme and remember it.
 *
 * The class first, then the cookie. The class is what a person sees and the
 * cookie is only how it survives a reload, so if writing the cookie fails —
 * a browser refusing storage, and they do — the theme still changes for as long
 * as this page is open. The reverse order would give somebody a remembered
 * preference that had not been applied.
 */
export function apply(theme: Theme, root: Element | null = document.documentElement): void {
  root?.classList.toggle('dark', theme === 'dark')
  try {
    document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${A_YEAR}; samesite=lax`
  } catch {
    /* Cookies refused. The page is in the right theme until it is reloaded,
       which is a smaller failure than an exception thrown out of a click. */
  }
}

/** The other one. */
export function other(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark'
}
