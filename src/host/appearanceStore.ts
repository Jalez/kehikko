import { useSyncExternalStore } from 'react'

import {
  APPEARANCE_DEFAULT,
  BACKGROUND_ATTR,
  BORDER_ATTR,
  LOOK_COOKIE,
  appearanceIn,
  fromCookies,
  lookCookie,
  themeOf,
  type Appearance,
  type AppearanceAnswer,
} from './appearance.ts'
import { apply as applyTheme, type Theme } from './theme.ts'

/**
 * Settings › Appearance on the page: drawn as attributes on `<html>` and the
 * theme's class, kept in the cookies the pre-paint script reads, and read by
 * React. `host/appearance.ts` has the shape, the words and the argument.
 */

const A_YEAR = 60 * 60 * 24 * 365

/** The attributes on `<html>` that draw it. */
export function paint(appearance: Appearance, root: Element): void {
  root.setAttribute(BORDER_ATTR, appearance.border)
  root.setAttribute(BACKGROUND_ATTR, appearance.background ? 'on' : 'off')
}

const prefersDark = (): boolean => {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/**
 * The appearance the page draws in, and every change of it. One per page.
 * React reads it with `useAppearance`; the Settings tab changes it with `set`
 * (drawn at once) and the server's answer is `adopt`ed.
 */
export class AppearanceStore {
  #now: Appearance
  #theme: Theme
  readonly #hearers = new Set<() => void>()
  #unwatch: (() => void) | null = null

  constructor(initial: Appearance = APPEARANCE_DEFAULT) {
    this.#now = initial
    this.#theme = themeOf(initial.theme, prefersDark())
  }

  get = (): Appearance => this.#now
  /** The theme drawn now: the choice, with `system` resolved. */
  theme = (): Theme => this.#theme

  /** Draw this appearance, and remember it in the cookies. Nothing is told when nothing changed. */
  set(next: Appearance): void {
    const was = this.#now
    this.#now = next
    this.#draw()
    if (JSON.stringify(was) !== JSON.stringify(next)) this.#tell()
  }

  /** What the server says it holds. */
  adopt(stored: unknown): void {
    this.set(appearanceIn(stored))
  }

  subscribe = (hearer: () => void): (() => void) => {
    this.#hearers.add(hearer)
    return () => this.#hearers.delete(hearer)
  }

  #draw(): void {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    paint(this.#now, root)
    const theme = themeOf(this.#now.theme, prefersDark())
    const themeChanged = theme !== this.#theme
    this.#theme = theme
    applyTheme(theme, root, this.#now.theme)
    try {
      document.cookie = `${LOOK_COOKIE}=${lookCookie(this.#now)}; path=/; max-age=${A_YEAR}; samesite=lax`
    } catch {
      /* Cookies refused: drawn until the page is reloaded. */
    }
    this.#watchSystem()
    if (themeChanged) this.#tell()
  }

  /* While the choice is `system`, a change of the operating system's theme is drawn. */
  #watchSystem(): void {
    const wanted = this.#now.theme === 'system'
    if (!wanted) {
      this.#unwatch?.()
      this.#unwatch = null
      return
    }
    if (this.#unwatch || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    try {
      const query = window.matchMedia('(prefers-color-scheme: dark)')
      const changed = () => this.#draw()
      query.addEventListener('change', changed)
      this.#unwatch = () => query.removeEventListener('change', changed)
    } catch {
      /* No media queries: the theme is what it was at load. */
    }
  }

  #tell(): void {
    for (const hearer of this.#hearers) hearer()
  }
}

function initial(): Appearance {
  try {
    return typeof document === 'undefined' ? APPEARANCE_DEFAULT : fromCookies(document.cookie)
  } catch {
    return APPEARANCE_DEFAULT
  }
}

/** The page's one store. */
export const appearance = new AppearanceStore(initial())

export function useAppearance(store: AppearanceStore = appearance): Appearance {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

export function useDrawnTheme(store: AppearanceStore = appearance): Theme {
  return useSyncExternalStore(store.subscribe, store.theme, store.theme)
}

/**
 * The server's answer, adopted. A server with no row yet (an upgrade) is given
 * what the cookies said — the bar's old Headers and theme choices — once, so
 * nobody's look changes under them on the day the bar's buttons went away.
 */
export function adoptAppearance(given: AppearanceAnswer | undefined, migrate: (now: Appearance) => void, store: AppearanceStore = appearance): void {
  if (!given) return
  if (given.stored) store.adopt(given)
  else migrate(store.get())
}

