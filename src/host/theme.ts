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
 *
 * ## And why the desktop shell has to be told
 *
 * `kehikko-desktop` opens a native window on this page. That window is painted
 * by the operating system before any HTML has been parsed, and the page it
 * shows while the host is starting — its waiting room — is served from
 * `tauri://localhost`, which is a different origin from this one. A cookie set
 * here is invisible there. So the shell can neither read this preference nor
 * infer it, and left to itself it opened a white window and a white waiting
 * room in front of somebody whose canvas is black.
 *
 * `tell()` below closes that gap by pushing the word across once, whenever it
 * changes and once when the page loads. Note the direction: this page still
 * decides, alone, from the cookie, exactly as before — the shell is *informed*,
 * and keeps a copy only so that it has something to paint with before this page
 * exists to ask. If the copy ever goes stale, this page overrules it the moment
 * it loads and then corrects it. See `src-tauri/src/theme.rs` in that
 * repository for the long version of that argument.
 *
 * In a browser there is no shell, `tell()` finds nothing to call, and it is a
 * no-op — silent, not logged. This page runs in a plain tab far more often than
 * it runs in that window, and a tab is not missing anything.
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
  tell(theme)
}

/**
 * Say what this page decided, to a desktop shell if there is one.
 *
 * Called once at start-up, from `main.tsx`, so that a preference changed in a
 * browser tab while the app was closed is not stale in the shell's copy for
 * ever. Without it the shell's word only ever changes when somebody presses the
 * toggle *inside* the app, and a person who switches to light in a tab would
 * get a black window for one launch afterwards.
 *
 * It reports rather than decides, so it is not a second implementation of
 * anything: it reads the same class off `<html>` that `current()` does.
 */
export function announce(): void {
  tell(current())
}

/**
 * The one word, pushed to the native side, and nothing done about failure.
 *
 * `window.__TAURI_INTERNALS__.invoke` rather than `@tauri-apps/api`: this
 * repository does not depend on that package and should not acquire a
 * dependency to send one string, and the shell deliberately runs with
 * `withGlobalTauri` off — the internals object is what is actually there. It
 * was measured present on this page inside the shell, and absent inside module
 * iframes, which is the property that matters: no module can reach this.
 *
 * Every failure here is swallowed on purpose, and there are several worth
 * naming so nobody later mistakes the silence for carelessness:
 *
 * - **There is no shell.** The usual case. `__TAURI_INTERNALS__` is undefined
 *   in a browser tab, the function returns, and nothing is logged — a console
 *   warning on every theme toggle in the tab this project is developed in would
 *   be noise about a feature that is not missing.
 * - **The shell refuses the call.** Its capability grants this command to
 *   `http://127.0.0.1:4181` and `http://localhost:4181` only, so a host running
 *   on a different port gets a rejected promise. The shell then keeps whatever
 *   word it had, which is the same behaviour as never having been told.
 * - **The promise rejects for anything else.** Caught, because an unhandled
 *   rejection out of a click handler is a real defect for a preference that has
 *   already been applied to the page by the line above.
 *
 * Nothing is awaited. The theme has already changed on screen; whether the
 * shell wrote a file is a question about the next launch, not about this frame.
 */
function tell(theme: Theme): void {
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals })
      .__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return
    /* Called on the internals object rather than through a detached reference,
       so that `this` is whatever Tauri's own implementation expects it to be. */
    void internals.invoke('remember_theme', { theme }).catch(() => {})
  } catch {
    /* No shell, a frozen global, a bridge half-built. The page is in the right
       theme regardless; only the next cold start is any the worse. */
  }
}

/** The sliver of Tauri's injected globals this file uses, and no more. */
type TauriInternals = {
  invoke?: (cmd: string, payload?: unknown) => Promise<unknown>
}

/** The other one. */
export function other(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark'
}
