import type { ActivityState, FooterItem } from 'kehikot-module-protocol'

/**
 * A container drawn as a TILE: what is in the square, decided here and drawn by `canvas/Tile.tsx`.
 *
 * Every module can be a tile, because the host guarantees one: a module that draws nothing of its
 * own for it gets the host's tile — its icon, its name, the crucial readouts of its footer and its
 * Inbox state. The geometry (a small square cell, the size it is restored to) is `host/columns.ts`;
 * whether the collapse button makes one is Settings › Appearance's (`host/appearance.ts`).
 *
 * ## A module's own tile wins
 *
 * A module whose page draws its own tile when its box is small (protocol 2.58.0: the agent modules'
 * tile, which asks the host to show the container large with `view.expand`) keeps it: in a tile
 * the host shows that module's page, in a box under the protocol's `TILE_BELOW`, so the page draws
 * the tile it already has. The host reads that from the manifest: a module that asks for
 * `view:expand` is one whose small view is a tile that expands. Every other module gets the host's.
 */

/** Room for the module's own tile: under the protocol's `TILE_BELOW` (220 by 160) each way, so a page that draws one draws it. */
export const OWN_TILE_BOX = { width: 208, height: 148 } as const

/** How many of the footer's readouts the host's tile says. */
export const TILE_READOUTS = 2

/** Whether this module's page draws its own tile when it is small. */
export function drawsOwnTile(module: { declares?: { uses?: readonly string[] } } | null | undefined): boolean {
  return module?.declares?.uses?.includes('view:expand') === true
}

export interface Readout {
  id: string
  text: string
  level: 'normal' | 'warn' | 'critical'
  tooltip?: string
}

/**
 * The footer's crucial readouts for the tile: its `text` items (the state, the counts — what is
 * going on now, by the protocol's header/footer rule), the ones the module did not mark optional
 * first, a warning or a critical one before a normal one, at most `TILE_READOUTS`.
 */
export function tileReadouts(footer: readonly FooterItem[]): Readout[] {
  const rank = { critical: 0, warn: 1, normal: 2 } as const
  return footer
    .flatMap((item, at) => (item.kind === 'text' ? [{ item, at }] : []))
    .sort((a, b) => Number(a.item.optional) - Number(b.item.optional) || rank[a.item.level] - rank[b.item.level] || a.at - b.at)
    .slice(0, TILE_READOUTS)
    .map(({ item }) => ({ id: item.id, text: item.text, level: item.level, ...(item.tooltip ? { tooltip: item.tooltip } : {}) }))
}

/** The Inbox state a tile says, in words, or null when the module holds none. */
export const TILE_INBOX: Readonly<Record<ActivityState, string>> = {
  attention: 'Needs you',
  working: 'Working',
  done: 'Finished',
}

/** What pressing the host's tile says it does. */
export function tileLabel(name: string): string {
  return `${name} — show it large`
}

/**
 * Whether a container's tile hides its module's page: the host's tile does (the page is kept,
 * hidden, as a folded one is), a module's own tile does not (its page draws it), and neither does a
 * tile shown large right now — pressing a tile shows the module's real page over the canvas
 * (`host/expand.ts`), so the large panel needs the page there.
 */
export function tileHidesPage(placement: { tiled?: boolean } | undefined, ownTile: boolean, large: boolean): boolean {
  return placement?.tiled === true && !ownTile && !large
}
