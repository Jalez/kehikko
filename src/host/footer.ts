/**
 * What each module last declared for its container's footer, held by the page.
 *
 * `kehikot.footer` (protocol 2.38.0) is the header's grammar at the bottom
 * edge: a module says what its status row shows — a line of text, a count, a
 * meter — and offers — a run, a toggle, a switch, a jump — and the host draws
 * it as one row in the header's look (`canvas/FooterBar.tsx`). The module owns
 * every piece of state; the page holds the latest list per module and nothing
 * else. Every RULE about that row is in this file, so it can be tested
 * without a browser: what is drawn at a width (`footerRow`), whether a press
 * may be sent (`footerPressing`), and what an agent may press
 * (`agentFooterRefusal`).
 *
 * ## When it goes
 *
 * As the header: with the document that declared it. `[]` is a module taking
 * its footer away, and draws no row, exactly as a module that never declared
 * one draws none — there is no empty footer.
 *
 * ## Folded
 *
 * A folded container is its header and nothing else: no body and no footer.
 * A status row for a page nobody can see is a row of numbers about nothing,
 * and a button in it a press with no visible effect. The footer comes back
 * with the body on unfold, as the module declared it last.
 */

import {
  footerLayout,
  footerPressRefusal,
  pressableFooterItem,
  type FooterItem,
  type FooterLayout,
  type HeaderItem,
  type PressableFooterItem,
} from 'kehikot-module-protocol'

import { agentStanding, notStanding, type Pressed, type Pressing } from './header.ts'

/** The latest footer by module id. */
export type Footers = Readonly<Record<string, readonly FooterItem[]>>

export const NO_FOOTERS: Footers = {}

/** What a module that has declared nothing is drawn with: no row at all. */
export const NO_FOOTER: readonly FooterItem[] = []

/** The footers after one module declared: its list replaced whole, never merged. Same object when nothing changed. */
export function footerDeclared(held: Footers, id: string, items: readonly FooterItem[]): Footers {
  const was = held[id]
  if (was && JSON.stringify(was) === JSON.stringify(items)) return held
  return { ...held, [id]: items }
}

/** The footers without one module's: its document is gone, and so is what it declared. */
export function footerWithdrawn(held: Footers, id: string): Footers {
  if (!Object.hasOwn(held, id)) return held
  const { [id]: _gone, ...rest } = held
  return rest
}

/**
 * Whether a container draws a footer row at all: only for a module that
 * declared at least one item, whose page is the thing showing, on a container
 * that is not folded. Anything else draws nothing — never an empty row.
 */
export function drawsFooter(items: readonly FooterItem[], showingPage: boolean, folded: boolean): boolean {
  return items.length > 0 && showingPage && !folded
}

/**
 * The row at a width: the protocol's `footerLayout`, the one rule every host
 * shares (one row; under 300 px optional items go and runs become icons;
 * under 220 px every pressable item is in one "⋯"). A run is drawn as its
 * icon only when it HAS one this host draws; one without keeps its words,
 * cut with an ellipsis like any text.
 */
export function footerRow(items: readonly FooterItem[], width: number | null): FooterLayout {
  return footerLayout(items, width)
}

/* ------------------------------------------------------------------ *
 * A press
 * ------------------------------------------------------------------ */

/**
 * Send one press on a footer item, if the footer as it is declared NOW can
 * take it. The header's `pressing`, judged by `footerPressRefusal` (a text or
 * a meter cannot be pressed), and sent with `place: 'footer'` so the module
 * judges it against its footer and not its header.
 */
export async function footerPressing(
  items: readonly FooterItem[],
  press: Pressing,
  name: string,
  send: (press: Pressing) => Promise<Pressed> | null,
): Promise<Pressed> {
  const refusal = footerPressRefusal(items, press)
  if (refusal) return { ok: false, why: refusal }
  const asked = send({ ...press, place: 'footer' })
  if (!asked) return { ok: false, why: notStanding(name) }
  const said = await asked
  return said.ok || said.why ? said : { ok: false, why: `${name} did not take that, and did not say why.` }
}

/* ------------------------------------------------------------------ *
 * An agent's press
 * ------------------------------------------------------------------ */

/** The footer's items an agent may press. */
export function agentFooterPressable(items: readonly FooterItem[]): string[] {
  return items
    .filter(pressableFooterItem)
    .filter((item) => agentStanding(item as unknown as HeaderItem) === 'agents')
    .map((item) => item.id)
}

/**
 * Why an agent's press on a footer item is refused, or `null` when it may be
 * sent. The header's three cases (`agents`, `tool`, the person's), in the
 * header's words, with "footer" for "header"; a text or a meter is refused by
 * saying it only says something.
 */
export function agentFooterRefusal(items: readonly FooterItem[], press: Pressing, module: string): string | null {
  const item = items.find((one) => one.id === press.item)
  const may = agentFooterPressable(items)
  const offered = may.length
    ? `What an agent may press in ${module}'s footer: ${may.join(', ')}.`
    : `Nothing in ${module}'s footer is for an agent to press.`
  if (!item) return `${module} has no "${shown(press.item)}" in its footer now. ${offered}`
  if (!pressableFooterItem(item)) return `"${item.id}" in ${module}'s footer only says something; it cannot be pressed. ${offered}`
  const standing = agentStanding(item as unknown as HeaderItem)
  if (standing === 'tool') {
    return (
      `"${item.id}" is not pressed through this door: ${module}'s own MCP door has the tool ${item.tool}, which does `
      + `the same thing. Call ${item.tool} there. ${offered}`
    )
  }
  if (item.kind === 'run' && item.confirm) {
    return `"${item.id}" takes a person's second press to confirm it, so an agent does not press it. Ask the person. ${offered}`
  }
  if (standing === 'person') return `"${item.id}" is the person's: ${module} has not marked it for agents. ${offered}`
  return footerPressRefusal(items, press)
}

/** A footer item that can be pressed, narrowed. */
export type FooterPressable = PressableFooterItem

function shown(id: string): string {
  return id.length > 64 ? `${id.slice(0, 64)}…` : id
}
