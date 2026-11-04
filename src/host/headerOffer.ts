/**
 * Everything a container's header offers, as ONE list, and where each entry is
 * drawn at a width.
 *
 * A header holds two kinds of menus: the module's own (View, Go, Run, from what
 * it declared — `menusOf` in `host/header.ts`) and the host's Container menu
 * (the container's scope, the module's settings, its tools, skills, when its
 * header and footer show, how to use it, feedback, prompts). It was called
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
 *   is ONE "⋯" holding View, Go and Run as sections, then Container as the
 *   last section — the same rows, labels and disabled reasons as the separate
 *   menus. A module with no menus gets the same "⋯", holding Container alone:
 *   the Container menu is never a trigger of its own when there is no room.
 * - **What the row keeps is a list, in order** (`ROW_PRIORITY`): the selection
 *   checkbox, the module's icon, the overflow, the fold button and the name.
 *   Everything else gives way before those — pinned runs and the gear go into
 *   menus, the menus into the one "⋯", the version and branch words go
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
 */
export const FRAME_ENTRIES = ['standing', 'scope', 'settings', 'tools', 'skills', 'rows', 'help', 'feedback', 'prompts'] as const
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
  scope: 'scope',
  settings: 'settings',
  tools: 'tools',
  skills: 'skills',
  rows: 'header and footer',
  help: 'how to use it',
  feedback: 'feedback',
  prompts: 'prompts',
}

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
export type RowPart = (typeof ROW_PRIORITY)[number] | 'menus' | 'gear' | 'pinned'

/** How far a container is folded: open, to its header, to its header and footer. */
export type Fold = 0 | 1 | 2

/** Everything one header offers: what the module declared, and which of the host's entries it has. */
export interface Offer {
  /** The module's last header. Empty while its page is not what is showing. */
  items: readonly HeaderItem[]
  /** The host's entries this container has, any order. */
  frame: readonly FrameEntry[]
}

/** One section of a menu: a module menu, or the host's Container entries. */
export type Section = { kind: 'module'; menu: ModuleMenu } | { kind: 'frame'; entries: FrameEntry[] }

/** One trigger in the row and what its menu holds, top to bottom. */
export interface Trigger {
  which: HeaderMenu | 'more' | 'frame'
  sections: Section[]
}

export interface HeaderLayout {
  mode: MenuMode
  /** Runs drawn as buttons in the row (and so in no menu). */
  pinned: RunItem[]
  /** The settings gear is drawn in the row (and so is not a row in Container). */
  gear: boolean
  /** The triggers, left to right. Module menus first, the overflow (the one holding Container) last. */
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
  const gear = mode !== 'merged' && has.has('settings')
  const entries = FRAME_ENTRIES.filter((entry) => has.has(entry) && !(gear && entry === 'settings'))
  const frame: Section = { kind: 'frame', entries }
  const modules: Section[] = menus.map((menu) => ({ kind: 'module', menu }))
  /* No room: ONE "⋯", module menus or not, with Container as its last section. */
  const triggers: Trigger[] =
    mode === 'merged'
      ? [{ which: 'more', sections: [...modules, frame] }]
      : [...menus.map((menu): Trigger => ({ which: menu.menu, sections: [{ kind: 'module', menu }] })), { which: 'frame', sections: [frame] }]
  const row: RowPart[] = [...ROW_PRIORITY]
  if (mode !== 'merged' && menus.length) row.push('menus')
  if (gear) row.push('gear')
  if (pinned.length) row.push('pinned')
  return { mode, pinned, gear, triggers, row }
}

/** The trigger that holds the Container rows: the overflow, last in the row. */
export function overflowOf(layout: HeaderLayout): Trigger {
  return layout.triggers.at(-1)!
}

/** Where one action is drawn: `row` for a button in the header, or the trigger whose menu holds it. */
export type Place = 'row' | Trigger['which']

/**
 * Every action in a layout with where it is, in drawn order: `item:<id>` for a
 * module's item, `frame:<entry>` for one of the host's. An action listed twice
 * is drawn twice.
 */
export function placesOf(layout: HeaderLayout): { key: string; place: Place }[] {
  const out: { key: string; place: Place }[] = layout.pinned.map((item) => ({ key: `item:${item.id}`, place: 'row' as const }))
  if (layout.gear) out.push({ key: 'frame:settings', place: 'row' })
  for (const trigger of layout.triggers) {
    for (const section of trigger.sections) {
      if (section.kind === 'frame') out.push(...section.entries.map((entry) => ({ key: `frame:${entry}`, place: trigger.which })))
      else out.push(...section.menu.groups.flatMap((group) => group.items.map((item) => ({ key: `item:${item.id}`, place: trigger.which }))))
    }
  }
  return out
}

/** What a layout lets a person reach, sorted. The same for every mode and fold of one offer. */
export function reachable(layout: HeaderLayout): string[] {
  return [...new Set(placesOf(layout).map((one) => one.key))].sort()
}
