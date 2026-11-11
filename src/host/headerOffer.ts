/**
 * Everything a container's header offers, as ONE list, and where each entry is
 * drawn at a width.
 *
 * A header holds two kinds of menus: the module's own (View, Go, Run, from what
 * it declared — `menusOf` in `host/header.ts`) and the host's: Help (the app's
 * own Help menu, scoped to the module — `HELP_ENTRIES`) and the Container menu
 * (the container’s scope, the module’s settings, its tools, skills,
 * whether it uses the Inbox, whether its messages reach
 * agents, prompts). It was called
 * "Frame"; "container" is the word the rest of the host's text uses for a
 * placed module, so the menu says what it is about. They used to be decided in
 * three places — the module's menus by width, the settings gear by width
 * again, the Container menu by nothing —
 * and folding hid the module's menus outright. So the same container offered
 * different things at 380 pixels, at 200, and folded, and some things twice:
 * "Settings…" in the module's "⋯" AND in the Container menu under 220 pixels,
 * the gear AND the Container row above it.
 *
 * Now there is one rule, `layoutOf`, and every way the header is drawn comes
 * from it:
 *
 * - **Every entry is reachable at every width and fold state.** What does not
 *   fit in the row is in the overflow; nothing is dropped. Folding changes
 *   nothing here: a folded header is as wide as the open one, so it holds the
 *   same things (`Fold` is taken so that is stated, not assumed).
 * - **Every entry is in exactly one place.** A pinned run drawn as a button is
 *   not also a row in the Run menu; the settings gear in the row is not also a
 *   row in Container; under 220 pixels Settings is a row in Container and
 *   nowhere else.
 * - **The overflow keeps the order and the words.** Under `MERGE_BELOW`, there
 *   is ONE "⋯" holding View, Go and Run as sections, then the module's filter,
 *   clear and refresh (`CONTROLS`, as "Shown"), then Help, then Container as the last
 *   section — the same rows, labels and disabled reasons as the separate
 *   menus. Remove is a Container row there ("Remove from this kehikko", two
 *   presses). A module with no menus gets the same "⋯": the Container menu is
 *   never a trigger of its own when there is no room.
 *   Where the window has room the "⋯" stands those sections side by side
 *   (`columnsFor`, `columnsOf`), and is one list where it has not: where the
 *   sections stand, never which rows they hold.
 * - **What the row keeps is a list, in order** (`ROW_PRIORITY`): the selection
 *   checkbox, the module's icon, the overflow, the fold button and the name.
 *   Everything else gives way before those — pinned runs, the gear, the
 *   module's row controls and remove go into menus, the menus into the one
 *   "⋯", the version and branch words go
 *   (`host/headerFit.ts`) — and of the five the name gives way first, cut with
 *   an ellipsis.
 *
 * `reachable` and `placesOf` read a layout back as action keys, so a test can
 * compare what each width offers without a browser.
 */

import type { HeaderItem, HeaderMenu } from 'kehikot-module-protocol'

import { menusOf, pinnedOf, type ModuleMenu, type RunItem } from './header.ts'

/* ------------------------------------------------------------------ *
 * How wide
 * ------------------------------------------------------------------ */

/** How the module's menus are drawn at a width: as words, as icons, or as one "⋯". */
export type MenuMode = 'words' | 'icons' | 'merged'

/** Under this many pixels of header, a trigger is an icon. The width the header's own gaps close at. */
export const ICONS_BELOW = 300
/** Under this many, View, Go, Run and Container are one menu. */
export const MERGE_BELOW = 220
/**
 * Under this many pixels of container, pinned runs (protocol 1.6.0) are not
 * drawn as buttons and are rows of the Run menu instead. Measured on the
 * container's header, not the window.
 */
export const PINNED_BELOW = 360

/** The mode for a header this wide. `null` is "not measured yet", which is drawn as the widest. */
export function modeFor(width: number | null): MenuMode {
  if (width === null) return 'words'
  if (width < MERGE_BELOW) return 'merged'
  return width < ICONS_BELOW ? 'icons' : 'words'
}

/** Whether pinned runs are buttons at this width: words-wide AND 360 px of container. */
export function pinsFor(width: number | null): boolean {
  return modeFor(width) === 'words' && (width === null || width >= PINNED_BELOW)
}

/* ------------------------------------------------------------------ *
 * The offer
 * ------------------------------------------------------------------ */

/**
 * The host's own entries, in the order the Container menu draws them. `standing` is
 * the press a folded container's cover or notice would have offered in its body
 * (Start, Retry, Show details — `standingRows` in `canvas/Standing.tsx`): with
 * no body to hold it, it is the first rows of this menu, so it stays reachable.
 * `restart` is "Restart module", on every container whatever the module declared
 * (`host/restartModule.ts`): disabled with its reason, never left out.
 */
export const FRAME_ENTRIES = ['standing', 'expand', 'scope', 'settings', 'tools', 'skills', 'inbox', 'messages', 'prompts', 'restart', 'remove'] as const
export type FrameEntry = (typeof FRAME_ENTRIES)[number]

/**
 * What the host's per-container menu is called: the trigger's name and the overflow's last
 * section. "Container" is what the host's own text calls a placed module ("pick this container
 * out", "this container's header and footer"). The identifiers keep the older `frame` spelling.
 */
export const FRAME_TITLE = 'Container'

/** What each of the host's entries is called in the Container trigger's tooltip. */
export const FRAME_SAID: Record<FrameEntry, string> = {
  standing: 'its state',
  expand: 'show large',
  scope: 'scope',
  settings: 'settings',
  tools: 'tools',
  skills: 'skills',
  inbox: 'inbox',
  messages: 'messages to agents',
  prompts: 'prompts',
  restart: 'restart',
  remove: 'remove',
}

/**
 * The container's Help menu: the app's own Help menu ("?" in the bar, `canvas/Help.tsx`), scoped to
 * the module — the same icon, title, order and words (`host/helpMenu.ts`), so whatever a person
 * learned to find in one is in the other. Its introduction and "How to use" when it has them, the
 * notes of its releases, and feedback to its authors. A "?" trigger of its own while the header has
 * room; under `MERGE_BELOW` a "Help" section of the one "⋯", just before Container.
 */
export const HELP_ENTRIES = ['intro', 'help', 'notes', 'feedback'] as const
export type HelpEntry = (typeof HELP_ENTRIES)[number]

/**
 * The module's own row controls (`Filters.tsx`, `Clearing.tsx`, `Refreshing.tsx`), drawn only
 * because the module offered them. Buttons in the row while there is room; under `MERGE_BELOW`
 * a section of the one "⋯", after the module's menus and before Container.
 */
export const CONTROLS = ['filter', 'clear', 'refresh'] as const
export type Control = (typeof CONTROLS)[number]

/** What the controls' section of the "⋯" is called: they all act on what the module shows. */
export const CONTROLS_TITLE = 'Shown'

/** The Container trigger's tooltip: what this container's menu holds, in its order. */
export function frameHint(entries: readonly FrameEntry[]): string {
  return `This container: ${FRAME_ENTRIES.filter((entry) => entries.includes(entry)).map((entry) => FRAME_SAID[entry]).join(', ')}`
}

/**
 * What a header's row keeps however narrow the container is, most important first. The selection
 * checkbox and the module's icon say which container this is; the overflow (the "⋯" under
 * `MERGE_BELOW`, the Container trigger above it) holds every other action; the fold button is
 * pressed without thinking; the name gives way first of these, cut with an ellipsis and whole in
 * its tooltip. Everything not in this list gives way before any of it.
 */
export const ROW_PRIORITY = ['select', 'icon', 'overflow', 'fold', 'name'] as const
/** Something the row draws: one of `ROW_PRIORITY`, or what gives way before them. */
export type RowPart = (typeof ROW_PRIORITY)[number] | 'menus' | 'controls' | 'help' | 'gear' | 'remove' | 'pinned'

/** How far a container is folded: open, to its header, to its header and footer. */
export type Fold = 0 | 1 | 2

/** Everything one header offers: what the module declared, and which of the host's entries it has. */
export interface Offer {
  /** The module's last header. Empty while its page is not what is showing. */
  items: readonly HeaderItem[]
  /** The host's entries this container has, any order. */
  frame: readonly FrameEntry[]
  /** The Help menu's entries this container has, any order. Absent: none. */
  help?: readonly HelpEntry[]
  /** The module's own row controls it offers now, any order. Absent: none. */
  controls?: readonly Control[]
}

/** One section of a menu: a module menu, the module's row controls, the Help menu, or the host's Container entries. */
export type Section =
  | { kind: 'module'; menu: ModuleMenu }
  | { kind: 'controls'; controls: Control[] }
  | { kind: 'help'; entries: HelpEntry[] }
  | { kind: 'frame'; entries: FrameEntry[] }

/** One trigger in the row and what its menu holds, top to bottom. */
export interface Trigger {
  which: HeaderMenu | 'more' | 'help' | 'frame'
  sections: Section[]
}

export interface HeaderLayout {
  mode: MenuMode
  /** Runs drawn as buttons in the row (and so in no menu). */
  pinned: RunItem[]
  /** The settings gear is drawn in the row (and so is not a row in Container). */
  gear: boolean
  /** The module's row controls drawn as buttons in the row (and so in no menu). */
  controls: Control[]
  /** The remove button is drawn in the row (and so is not a row in Container). */
  remove: boolean
  /** The triggers, left to right. Module menus first, then Help, the overflow (the one holding Container) last. */
  triggers: Trigger[]
  /** What the row draws, most important first: `ROW_PRIORITY`, then what this mode has room for. */
  row: RowPart[]
}

/**
 * Where everything in `offer` is drawn, at a mode and with or without room for
 * pinned buttons. `fold` moves nothing — see the file's comment.
 */
export function layoutOf(offer: Offer, mode: MenuMode, pins: boolean, fold: Fold = 0): HeaderLayout {
  void fold
  const pinned = pins && mode === 'words' ? pinnedOf(offer.items) : []
  const inRow = new Set(pinned.map((item) => item.id))
  const menus = menusOf(offer.items.filter((item) => !inRow.has(item.id)))
  const has = new Set(offer.frame)
  const roomy = mode !== 'merged'
  const gear = roomy && has.has('settings')
  const remove = roomy && has.has('remove')
  const entries = FRAME_ENTRIES.filter((entry) => has.has(entry) && !(gear && entry === 'settings') && !(remove && entry === 'remove'))
  const frame: Section = { kind: 'frame', entries }
  const modules: Section[] = menus.map((menu) => ({ kind: 'module', menu }))
  const offered = CONTROLS.filter((control) => offer.controls?.includes(control))
  const controls = roomy ? offered : []
  const folded: Section[] = !roomy && offered.length ? [{ kind: 'controls', controls: offered }] : []
  const helped = HELP_ENTRIES.filter((entry) => offer.help?.includes(entry))
  const help: Section[] = helped.length ? [{ kind: 'help', entries: helped }] : []
  /* No room: ONE "⋯", module menus or not — the module's menus, its row controls, Help, then Container. */
  const triggers: Trigger[] = roomy
    ? [
        ...menus.map((menu): Trigger => ({ which: menu.menu, sections: [{ kind: 'module', menu }] })),
        ...help.map((section): Trigger => ({ which: 'help', sections: [section] })),
        { which: 'frame', sections: [frame] },
      ]
    : [{ which: 'more', sections: [...modules, ...folded, ...help, frame] }]
  const row: RowPart[] = [...ROW_PRIORITY]
  if (roomy && menus.length) row.push('menus')
  if (controls.length) row.push('controls')
  if (roomy && help.length) row.push('help')
  if (gear) row.push('gear')
  if (remove) row.push('remove')
  if (pinned.length) row.push('pinned')
  return { mode, pinned, gear, controls, remove, triggers, row }
}

/** The trigger that holds the Container rows: the overflow, last in the row. */
export function overflowOf(layout: HeaderLayout): Trigger {
  return layout.triggers.at(-1)!
}

/** Where one action is drawn: `row` for a button in the header, or the trigger whose menu holds it. */
export type Place = 'row' | Trigger['which']

/**
 * Every action in a layout with where it is, in drawn order: `item:<id>` for a
 * module's item, `control:<name>` for one of its row controls, `help:<entry>` for a Help row,
 * `frame:<entry>` for one of the host's Container rows. An action listed twice
 * is drawn twice.
 */
export function placesOf(layout: HeaderLayout): { key: string; place: Place }[] {
  const out: { key: string; place: Place }[] = layout.pinned.map((item) => ({ key: `item:${item.id}`, place: 'row' as const }))
  out.push(...layout.controls.map((control) => ({ key: `control:${control}`, place: 'row' as const })))
  if (layout.gear) out.push({ key: 'frame:settings', place: 'row' })
  if (layout.remove) out.push({ key: 'frame:remove', place: 'row' })
  for (const trigger of layout.triggers) {
    for (const section of trigger.sections) {
      if (section.kind === 'frame') out.push(...section.entries.map((entry) => ({ key: `frame:${entry}`, place: trigger.which })))
      else if (section.kind === 'help') out.push(...section.entries.map((entry) => ({ key: `help:${entry}`, place: trigger.which })))
      else if (section.kind === 'controls') out.push(...section.controls.map((control) => ({ key: `control:${control}`, place: trigger.which })))
      else out.push(...section.menu.groups.flatMap((group) => group.items.map((item) => ({ key: `item:${item.id}`, place: trigger.which }))))
    }
  }
  return out
}

/** What a layout lets a person reach, sorted. The same for every mode and fold of one offer. */
export function reachable(layout: HeaderLayout): string[] {
  return [...new Set(placesOf(layout).map((one) => one.key))].sort()
}

/* ------------------------------------------------------------------ *
 * The overflow's columns
 * ------------------------------------------------------------------ */

/*
 * The "⋯" is drawn under 220 pixels of CONTAINER, but it is a popover anchored to its trigger, so
 * it can be as wide as the WINDOW. Drawn as one list it held View, Go, Run, Shown and Container one
 * under another, and a person scrolled through all of it. Where the window has room, its sections
 * stand side by side instead — each column with its headings, Help and Container in columns of their own,
 * last — and each column scrolls on its own only when the window is too short for it. Narrow, it
 * is the one list it was. Same rows, same order, same words either way: only where they stand.
 */

/** How wide one column of the overflow is, in pixels: the one list's own width, give or take. */
export const COLUMN_WIDTH = 208
/** At most this many columns: the module's menus, Shown, Help, Container. */
export const COLUMNS_MAX = 4

/**
 * How many columns the overflow stands in, with `available` pixels of window for it and `sections`
 * sections to draw. One is the vertical list: under two columns' width, or with one section.
 * `null` is "not measured", which is the list.
 */
export function columnsFor(available: number | null, sections: number): number {
  if (available === null || !Number.isFinite(available)) return 1
  const fit = Math.floor(available / COLUMN_WIDTH)
  const count = Math.min(COLUMNS_MAX, sections, fit)
  return count >= 2 ? count : 1
}

/** How many rows a section draws, heading included: what the columns are balanced by. */
export function sizeOf(section: Section): number {
  if (section.kind === 'frame' || section.kind === 'help') return section.entries.length + 1
  if (section.kind === 'controls') return section.controls.length + 1
  return section.menu.groups.reduce((sum, group) => sum + group.items.length + (group.name ? 1 : 0), 1)
}

/** What `columnsOf` needs to know of a section: how many rows it draws, and what kind it is. */
export interface Sized {
  size: number
  kind: Section['kind']
}

/**
 * Which sections stand in which column, in order: the indexes of `sections` (in drawn order) for
 * each of up to `count` columns. The last section (Container) is a column of its own. Help, then
 * Shown, are columns of their own too when there is a column for each and something before it; what is left, the
 * module's menus, is cut in order into the remaining columns so the tallest is as short as it can
 * be — a section is never split. One column is every section, in order.
 */
export function columnsOf(sections: readonly Sized[], count: number): number[][] {
  const all = sections.map((_, index) => index)
  if (count <= 1 || sections.length <= 1) return [all]
  const last = all.at(-1)!
  let rest = all.slice(0, -1)
  let room = count - 1
  const tail: number[][] = [[last]]
  for (const kind of ['help', 'controls'] as const) {
    const own = rest.at(-1)
    if (own === undefined || sections[own]!.kind !== kind || rest.length <= 1 || room <= 1) continue
    tail.unshift([own])
    rest = rest.slice(0, -1)
    room -= 1
  }
  return [...balanced(rest, sections.map((one) => one.size), Math.min(room, rest.length)), ...tail]
}

/** `indexes` cut in order into `runs` runs, the tallest by `sizes` as short as it can be. */
function balanced(indexes: readonly number[], sizes: readonly number[], runs: number): number[][] {
  if (!indexes.length) return []
  /* Every way to cut; there are at most five sections before Container. */
  let best: number[][] = [[...indexes]]
  let tallest = Infinity
  const cut = (from: number, left: number, done: number[][]) => {
    if (left === 1) {
      const all = [...done, indexes.slice(from)]
      const height = Math.max(...all.map((run) => run.reduce((sum, index) => sum + sizes[index]!, 0)))
      if (height < tallest) {
        tallest = height
        best = all
      }
      return
    }
    for (let to = from + 1; to <= indexes.length - left + 1; to++) cut(to, left - 1, [...done, indexes.slice(from, to)])
  }
  cut(0, runs, [])
  return best
}

/** Where focus is among the overflow's columns: which column, and which of its rows that take focus. */
export interface Cell {
  column: number
  row: number
}

/**
 * Where a key moves focus in the overflow's columns, given how many rows that take focus each column
 * has. Up and Down stay in the column and stop at its ends (the one list does not wrap either); Home
 * and End go to its first and last row; Left and Right go to the column beside it, at the same row
 * or its last. `null` is "not this rule's key here": Right from the last column, Left from the
 * first, and any other key are left to the menu — so Right still opens a submenu where there is no
 * column to go to, and typing still finds a row by its first letters.
 */
export function stepIn(columns: readonly number[], at: Cell, key: string): Cell | null {
  const rows = columns[at.column] ?? 0
  if (rows === 0) return null
  const beside = (to: number): Cell | null => {
    for (let column = to; column >= 0 && column < columns.length; column += to > at.column ? 1 : -1) {
      const count = columns[column]!
      if (count > 0) return { column, row: Math.min(at.row, count - 1) }
    }
    return null
  }
  switch (key) {
    case 'ArrowDown':
      return { column: at.column, row: Math.min(at.row + 1, rows - 1) }
    case 'ArrowUp':
      return { column: at.column, row: Math.max(at.row - 1, 0) }
    case 'Home':
    case 'PageUp':
      return { column: at.column, row: 0 }
    case 'End':
    case 'PageDown':
      return { column: at.column, row: rows - 1 }
    case 'ArrowRight':
      return beside(at.column + 1)
    case 'ArrowLeft':
      return beside(at.column - 1)
    default:
      return null
  }
}
