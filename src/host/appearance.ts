import { FOLD_ROWS, SHOW_ROWS, type FoldRows, type ShowRows } from './rows.ts'
import type { Theme } from './theme.ts'

/**
 * How the app looks, settled once for every container: Settings › Appearance.
 *
 * ## One place, for the whole app
 *
 * When a container's header and footer show, how far a fold goes, the theme,
 * the containers' borders and whether they have a background. These used to
 * be spread over the bar (a Headers button, a light/dark button) and over every
 * container (its Container menu and the fold control's held menu each had a
 * reveal choice, and the fold control a one-row/two-row choice). People set
 * these once or twice, so they are one tab in Settings now, and the same for
 * every container: there is no per-container choice and no quick toggle.
 *
 * ## Where it is kept
 *
 * On this machine, one row of `settings` in `frame.sqlite` (`server/appearance.ts`),
 * changed only through `POST /host/settings` (`{ appearance: { … } }`), which
 * is `PAGE_ONLY`. No MCP tool changes it. It styles the host's own chrome
 * around a module's page, never the page — but every module is told the
 * background (`context.appearance`, protocol 2.82.0, `pageAppearance`), so its
 * page can leave its own surface off when the container has none.
 *
 * A copy is also kept in cookies, only so the blocking script in `index.html`
 * can draw the right theme and borders before the first paint (`theme.ts` has
 * the long argument for why that is a cookie). The server's row is the truth:
 * the page adopts it when it arrives and rewrites the cookies from it.
 *
 * ## How it is applied
 *
 * As attributes on `<html>` (`data-container-border`, `data-container-background`)
 * and the theme's class, selected on in `index.css` — never by re-rendering a
 * module's frame, so a change reloads nothing. The header and footer reveal
 * is the containers' `data-rows`, which React already sets.
 */

export const THEME_CHOICES = ['system', 'light', 'dark'] as const
export type ThemeChoice = (typeof THEME_CHOICES)[number]

export const BORDERS = ['none', 'solid', 'rounded', 'dotted', 'dashed'] as const
export type Border = (typeof BORDERS)[number]

/**
 * What the collapse button (^) in a container's header does: fold the container to its header, or
 * make it a tile — a small square with its module's icon, name and footer readout (`host/columns.ts`,
 * `canvas/Tile.tsx`). The app's default, the same for every container.
 */
export const COLLAPSES = ['fold', 'tile'] as const
export type Collapse = (typeof COLLAPSES)[number]

/** The choice itself: one answer for every container, or `each` — the module's own, in `collapseEach`. */
export const COLLAPSE_CHOICES = ['fold', 'tile', 'each'] as const
export type CollapseChoice = (typeof COLLAPSE_CHOICES)[number]

/** Each module's own answer, by module id. A module not in it takes `collapseBase`. */
export type CollapseEach = Readonly<Record<string, Collapse>>

export interface Appearance {
  /** When every container's header and footer show. */
  rows: ShowRows
  /** How far a fold goes: the header (1), or the header and the footer where the host draws one (2). */
  foldRows: FoldRows
  /** What the collapse button does: folds to the header, makes a tile, or is decided per module (`each`). */
  collapse: CollapseChoice
  /** With `collapse: 'each'`: each module's answer, by id. */
  collapseEach: CollapseEach
  /** Whichever of fold and tile was picked last (or fold): what a module not in `collapseEach` does. */
  collapseBase: Collapse
  theme: ThemeChoice
  border: Border
  /** On: the card surface behind the chrome and the module's page. Off: transparent over the canvas. */
  background: boolean
}

/** Headers drawn, dark, one-row folds, rounded borders, the card surface: what the app looked like before this tab. */
export const APPEARANCE_DEFAULT: Appearance = { rows: 'always', foldRows: 1, collapse: 'fold', collapseEach: {}, collapseBase: 'fold', theme: 'dark', border: 'rounded', background: true }

export type AppearancePatch = Partial<Appearance>

const one = <T extends string | number>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value)

const FIELDS: { [K in keyof Appearance]: (value: unknown) => value is Appearance[K] } = {
  rows: (value): value is ShowRows => one(SHOW_ROWS, value),
  foldRows: (value): value is FoldRows => one(FOLD_ROWS, value),
  collapse: (value): value is CollapseChoice => one(COLLAPSE_CHOICES, value),
  collapseEach: (value): value is CollapseEach =>
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((one_) => one(COLLAPSES, one_)),
  collapseBase: (value): value is Collapse => one(COLLAPSES, value),
  theme: (value): value is ThemeChoice => one(THEME_CHOICES, value),
  border: (value): value is Border => one(BORDERS, value),
  background: (value): value is boolean => typeof value === 'boolean',
}

/** What the ^ button makes of one module: the module's own answer under `each`, else the one answer. */
export function collapseFor(appearance: Pick<Appearance, 'collapse' | 'collapseEach' | 'collapseBase'>, moduleId: string | undefined): Collapse {
  if (appearance.collapse !== 'each') return appearance.collapse
  const own = moduleId === undefined || !Object.hasOwn(appearance.collapseEach, moduleId) ? undefined : appearance.collapseEach[moduleId]
  return own ?? appearance.collapseBase
}

/** A stored value, whole: each field it got right, the default for the rest. */
export function appearanceIn(value: unknown): Appearance {
  const out: Record<string, unknown> = { ...APPEARANCE_DEFAULT }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, valid] of Object.entries(FIELDS)) {
      const field = (value as Record<string, unknown>)[key]
      if ((valid as (v: unknown) => boolean)(field)) out[key] = field
    }
  }
  return out as unknown as Appearance
}

/** A change the route takes: one or more known fields, each valid. `null` for anything else. */
export function appearancePatched(was: Appearance, patch: unknown): Appearance | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null
  const entries = Object.entries(patch as Record<string, unknown>)
  if (entries.length === 0) return null
  const next: Record<string, unknown> = { ...was }
  for (const [key, value] of entries) {
    const valid = (FIELDS as Record<string, ((v: unknown) => boolean) | undefined>)[key]
    if (!valid || !valid(value)) return null
    next[key] = value
  }
  return next as unknown as Appearance
}

/**
 * What a module is told of it (protocol 2.82.0, `context.appearance`): whether the container draws its
 * card behind the page or nothing. The protocol's client makes the page transparent for `none`.
 */
export function pageAppearance(background: boolean): { background: 'card' | 'none' } {
  return { background: background ? 'card' : 'none' }
}

/**
 * The `color-scheme` of a module's frame element. With a card behind it, `light`, to match a document
 * that has not painted yet (see `ModuleFrame`): the card shows through, never a white flash. With no
 * background, the theme's — the page says the same on its `<html>`, and a frame whose scheme differs
 * from its document's is given an opaque backdrop by the browser, which is the background the person
 * switched off.
 */
export function frameScheme(background: boolean, theme: Theme): Theme {
  return background ? 'light' : theme
}

/** The theme a choice draws in: `system` follows the operating system. */
export function themeOf(choice: ThemeChoice, prefersDark: boolean): Theme {
  return choice === 'system' ? (prefersDark ? 'dark' : 'light') : choice
}

/* ------------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------------ */

/**
 * Every question in Settings › Appearance is a sentence that says what it controls, and every
 * option reads on its own after it: "Show container headers and footers: When I hover".
 */
export const ASKED = {
  rows: 'Show container headers and footers:',
  foldRows: 'When you fold a container, it keeps:',
  foldAbout: 'Folding shrinks a container to its top rows; the module keeps running.',
  collapse: 'The ^ button on a container:',
  theme: 'Theme:',
  border: 'Container border:',
  background: 'Container background:',
} as const

export const ROWS_SAID: Readonly<Record<ShowRows, { label: string; line: string }>> = {
  always: { label: 'Always', line: 'Every container’s header and footer stay in view.' },
  hover: { label: 'When I hover', line: 'They hide, and come back while the pointer is over the container.' },
  click: { label: 'When I click', line: 'They hide, and come back when you click inside the container. Escape or a click elsewhere hides them.' },
  longpress: {
    label: 'When I press and hold',
    line: 'They hide, and come back when you hold a press inside the container; a plain click does not. In a module too old to report presses, hold on the header.',
  },
}

export const FOLD_SAID: Readonly<Record<FoldRows, { label: string; line: string }>> = {
  1: { label: 'Just its header (one row)', line: 'Its name and controls.' },
  2: { label: 'Its header and footer (two rows)', line: 'Where the module has a footer, what is going on in it (status, usage) stays in view too.' },
}

export const COLLAPSE_SAID: Readonly<Record<Collapse, { label: string; line: string }>> = {
  fold: { label: 'Folds it', line: 'The container shrinks to its top rows. Press ^ again to open it.' },
  tile: {
    label: 'Makes it a tile',
    line: 'The container becomes a small square: its icon, its name and what its footer says. Restore puts it back as it was.',
  },
}

/** The third answer to "The ^ button on a container:", and the words over its list. */
export const EACH_SAID = {
  label: 'Decide per module',
  line: 'Each module gets its own choice, below: fold it, or make it a tile.',
  list: 'What ^ does in each module:',
} as const

export const THEME_SAID: Readonly<Record<ThemeChoice, string>> = { system: 'System', light: 'Light', dark: 'Dark' }

export const BORDER_SAID: Readonly<Record<Border, string>> = {
  none: 'None',
  solid: 'Solid',
  rounded: 'Rounded',
  dotted: 'Dotted',
  dashed: 'Dashed',
}

/** The background, as the two answers to "Container background:". `card` is `background: true`. */
export const BACKGROUNDS = ['card', 'transparent'] as const
export type BackgroundChoice = (typeof BACKGROUNDS)[number]
export const BACKGROUND_SAID: Readonly<Record<BackgroundChoice, { label: string; line: string }>> = {
  card: { label: 'Card', line: 'The header, the footer and the space behind each module’s page are the card surface.' },
  transparent: { label: 'Transparent', line: 'They are see-through over the canvas. A module that paints its own background still shows it.' },
}

/* ------------------------------------------------------------------------ *
 * On the page
 * ------------------------------------------------------------------------ */

/** Duplicated in the inline script in `index.html`, which cannot import it. */
export const LOOK_COOKIE = 'kehikko.look'
/** Read once, to carry a choice made with the bar's old Headers button over; never written again. */
export const OLD_FOCUS_COOKIE = 'kehikko.focus'
/** The class the tour puts on `<html>` to show hidden headers for a while, without changing the setting. */
export const TOUR_ROWS_CLASS = 'tour-rows'

export const BORDER_ATTR = 'data-container-border'
export const BACKGROUND_ATTR = 'data-container-background'

function cookieOf(cookies: string, name: string): string | null {
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name.replace('.', '\\.')}=([^;]*)`))
  return match ? decodeURIComponent(match[1] ?? '') : null
}

/**
 * What the cookies say, before the server has answered: the pre-paint copy,
 * and — for someone upgrading — the bar's old Headers and theme choices, so
 * the first answer of a server that has no row yet can be given them.
 */
export function fromCookies(cookies: string): Appearance {
  const theme = cookieOf(cookies, 'kehikko.theme')
  const look = cookieOf(cookies, LOOK_COOKIE)?.split('.') ?? []
  const [rows, fold, border, background] = look
  const oldFocus = cookieOf(cookies, OLD_FOCUS_COOKIE)
  return appearanceIn({
    rows: one(SHOW_ROWS, rows) ? rows : oldFocus === 'on' ? 'hover' : undefined,
    foldRows: fold === '2' ? 2 : 1,
    theme: one(THEME_CHOICES, theme) ? theme : undefined,
    border,
    background: background === 'off' ? false : background === 'on' ? true : undefined,
  })
}

/** The look cookie's value: the fields the pre-paint script reads, dot-separated. */
export function lookCookie(appearance: Appearance): string {
  return [appearance.rows, appearance.foldRows, appearance.border, appearance.background ? 'on' : 'off'].join('.')
}

/** What `GET /host/settings` says of it: the row, whole, and whether there is one yet. Absent from an older host. */
export type AppearanceAnswer = Appearance & { stored: boolean }

/** Where a link into Settings opens Appearance. */
export const APPEARANCE_TARGET = 'appearance-rows'
