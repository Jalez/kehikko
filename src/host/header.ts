/**
 * What each module last declared for its container's menus, held by the page.
 *
 * `kehikot.header` (protocol 1.1.0) is a module saying which view switches,
 * toggles, jumps and runs it has, so a host can draw them in the container's
 * header instead of the module drawing a toolbar of its own. The module owns
 * every piece of state in it — which option a switch is on, whether a run is
 * busy — and declares the whole list again after every change, so all a host
 * holds is the latest list per module.
 *
 * ## Held here, drawn elsewhere
 *
 * The page keeps what each module said; `canvas/HeaderMenus.tsx` draws it as
 * the container's View, Go and Run menus, and everything that is a RULE about
 * those menus is in this file so that it can be tested without a browser:
 * which menu an item is in (`menusOf`), when its options are drawn in a
 * sub-menu (`nested`), whether a press may be sent and what is said when it
 * may not (`pressing`), and what an agent may press (`agentRefusal`).
 *
 * ## When it goes
 *
 * With the document that declared it: a frame replaced, taken off, or gone
 * silent has declared nothing, and its successor declares again after its own
 * greeting — the protocol's client replays the last header after every
 * `ready`. `[]` is a module taking its menus away, and is kept as said: it is
 * a declaration, where an absent entry is a module that has said nothing.
 *
 * Both functions hand back the same object when nothing changed, so a caller
 * can hold it in state without causing a render.
 */

import {
  HEADER_MENUS,
  HEADER_MENU_NAMES,
  pinnedRuns,
  pressRefusal,
  type HeaderItem,
  type HeaderMenu,
  type PressValue,
} from 'kehikot-module-protocol'

/** The latest header by module id. */
export type Headers = Readonly<Record<string, readonly HeaderItem[]>>

export const NO_HEADERS: Headers = {}

/** What a module that has declared nothing is drawn with. */
export const NO_HEADER: readonly HeaderItem[] = []

/** The headers after one module declared: its list replaced whole, never merged. */
export function declared(held: Headers, id: string, items: readonly HeaderItem[]): Headers {
  const was = held[id]
  if (was && JSON.stringify(was) === JSON.stringify(items)) return held
  return { ...held, [id]: items }
}

/** The headers without one module's: its document is gone, and so is what it declared. */
export function withdrawn(held: Headers, id: string): Headers {
  if (!Object.hasOwn(held, id)) return held
  const { [id]: _gone, ...rest } = held
  return rest
}

/* ------------------------------------------------------------------ *
 * The menus
 * ------------------------------------------------------------------ */

/** What each module menu is called. The names are the protocol's; the words are the host's. */
export const MENU_TITLES: Readonly<Record<HeaderMenu, string>> = { view: 'View', go: 'Go', run: 'Run' }

/** A `run` item, narrowed. */
export type RunItem = Extract<HeaderItem, { kind: 'run' }>

/**
 * The runs drawn as icon buttons in the header (protocol 1.6.0): the protocol's
 * `pinnedRuns`, in declaration order, at most `LIMITS.PINNED_MAX`. Each is
 * ALSO in the Run menu: `menusOf` is not told about pinning.
 */
export function pinnedOf(items: readonly HeaderItem[]): RunItem[] {
  return pinnedRuns(items).filter((item): item is RunItem => item.kind === 'run')
}

/** Items that named the same `group`, in the order the first of each group came. `null` is "no group". */
export interface MenuGroup {
  name: string | null
  items: HeaderItem[]
}

/** One module menu as it is drawn: its items by group, and what its trigger says without being opened. */
export interface ModuleMenu {
  menu: HeaderMenu
  title: string
  groups: MenuGroup[]
  /** How many items, over every group. One item alone has its options drawn in the menu itself. */
  count: number
  /** A run in it is in flight. Shown on the trigger. */
  busy: boolean
  /** A run in it failed last time, and none is in flight. Shown on the trigger. */
  failed: boolean
}

/**
 * A module's items as its menus: View, Go, Run, in that order, and only the
 * ones that have something in them.
 *
 * The item's KIND decides the menu (`HEADER_MENUS`, the protocol's) — there is
 * no field by which a module could put a run under View — so a module that
 * declares nothing, or `[]`, has no menus at all and its header is the header
 * it had before any of this existed.
 */
export function menusOf(items: readonly HeaderItem[]): ModuleMenu[] {
  const menus: ModuleMenu[] = []
  for (const menu of HEADER_MENU_NAMES) {
    const mine = items.filter((item) => HEADER_MENUS[item.kind] === menu)
    if (!mine.length) continue
    const groups: MenuGroup[] = []
    for (const item of mine) {
      const name = item.group ?? null
      const group = groups.find((one) => one.name === name)
      if (group) group.items.push(item)
      else groups.push({ name, items: [item] })
    }
    const busy = mine.some((item) => item.kind === 'run' && item.state === 'busy')
    menus.push({
      menu,
      title: MENU_TITLES[menu],
      groups,
      count: mine.length,
      busy,
      failed: !busy && mine.some((item) => item.kind === 'run' && item.state === 'failed'),
    })
  }
  return menus
}

/** Up to this many options are drawn in the menu itself, under the item's label. */
export const INLINE_OPTIONS = 6

/**
 * Whether a switch's or a go item's options are drawn in a sub-menu.
 *
 * A paper's forty sections drawn in the menu itself would push every item
 * after them off the screen, so a long list opens beside the menu from one
 * row carrying the item's label. A short one — Source / PDF — is drawn where
 * it is, because a sub-menu for two options is two presses for one choice.
 * An item that is ALONE in its menu is drawn in the menu however long it is:
 * there is nothing after it to push away, and the menu scrolls.
 */
export function nested(item: HeaderItem, alone: boolean): boolean {
  if (item.kind !== 'switch' && item.kind !== 'go') return false
  return !alone && item.options.length > INLINE_OPTIONS
}

/**
 * Whether a menu stays open after this kind of item is chosen.
 *
 * A toggle and a switch are settings somebody may set two of, and the menu
 * shows the new state the moment the module declares it: it stays. A jump and
 * a run are an act that happens in the module's page, which the menu is
 * standing over: it closes, as a shadcn menu does on an ordinary item. A run
 * being ARMED is the exception and is the menu's own business.
 */
export function staysOpen(kind: HeaderItem['kind']): boolean {
  return kind === 'toggle' || kind === 'switch'
}

/* ------------------------------------------------------------------ *
 * Where the keyboard is after a menu closes
 * ------------------------------------------------------------------ */

/**
 * How a menu came to close.
 *
 * `dismissed`: Escape, or its trigger pressed again — nothing was chosen.
 * `pressed`: a jump or a run was chosen, the press was sent, and nothing has
 * refused it by the time the menu is gone. `refused`: one was chosen and the
 * press was not taken — the header as it stands could not take it, the
 * module's page is not on this screen, or the module said no before the menu
 * had finished closing. `away`: focus left this document for a module's page
 * while the menu was open (somebody clicked into the module).
 */
export type Closing = 'dismissed' | 'pressed' | 'refused' | 'away'

/** Where focus is put when a menu has closed. `nowhere` is "left where it is". */
export type FocusAfter = 'trigger' | 'module' | 'nowhere'

/**
 * Where the keyboard goes when a container's menu closes.
 *
 * A menu puts focus back on its trigger when it closes, which is right for a
 * menu somebody backed out of and wrong for one they acted through: a jump
 * and a run act on the module's page, and what a person does next — type at
 * the section they jumped to, press the arrow keys in the deck they told to
 * present — is done there. With focus on the trigger those keys went to the
 * host, and a module that needed them had to take focus back on a timer,
 * after the menu had returned it.
 *
 * So, for somebody using only the keyboard:
 *
 * - Escape (or the trigger again) leaves focus on the trigger, as any menu
 *   does. Nothing happened in the module; they are still in the header.
 * - A press that was sent puts focus in the module's page: its window, with
 *   whichever element the module has or takes focus on. The keys are the
 *   module's from then on, as if the person had clicked into it.
 * - A press that was NOT taken leaves focus on the trigger, which is where
 *   the reason is said. Nothing happened in the module to go and look at.
 * - A menu closed because focus already went to a module is not answered by
 *   pulling focus back out of it. That is judged by where focus IS when the
 *   menu has closed (`focusIsInModule`), not only by having heard the window
 *   blur: the content's own blur comes first and closes the menu.
 *
 * A toggle and a switch do not close the menu (`staysOpen`), so they are
 * never the reason one closed: after setting two of them, Escape is the
 * first case.
 */
export function focusAfter(closing: Closing, inModule = false): FocusAfter {
  /* Focus is in a module's page already, whatever closed the menu: in Chromium
     the menu's own content blurs a moment BEFORE the window does, so the menu
     can be closed as an ordinary dismissal first and the "away" is never
     heard. The page holding the keyboard is the fact; the trigger does not
     take it back. */
  if (inModule) return 'nowhere'
  if (closing === 'pressed') return 'module'
  return closing === 'away' ? 'nowhere' : 'trigger'
}

/** Whether the keyboard is in a module's page now: the host's active element is the frame that holds it. */
export function focusIsInModule(active: Element | null): boolean {
  return active?.tagName === 'IFRAME'
}

/* ------------------------------------------------------------------ *
 * A press
 * ------------------------------------------------------------------ */

/** One item chosen: which, and the option or the state wanted. A run carries nothing. */
export interface Pressing {
  item: string
  value?: PressValue
}

/** What became of a press: taken, or not — and then `why` is a sentence a person can read. */
export interface Pressed {
  ok: boolean
  why: string
}

/**
 * Send one press, if the header as it is declared NOW can take it.
 *
 * The protocol's rule for a host: only for an item in the module's last
 * header, and only when `pressRefusal` says nothing. Between a menu being
 * drawn and a row in it being pressed the module may have declared again — a
 * run went busy, a section was deleted — so the list judged here is the one
 * held at the moment of the press, never the one the menu was drawn from.
 *
 * `send` is the frame (`Presses.item`), and `null` from it is a module whose
 * page is not standing on this screen: said, rather than a press that
 * vanishes. A module that answers `ok: false` without a reason gets one.
 */
export async function pressing(
  items: readonly HeaderItem[],
  press: Pressing,
  name: string,
  send: (press: Pressing) => Promise<Pressed> | null,
): Promise<Pressed> {
  const refusal = pressRefusal(items, press)
  if (refusal) return { ok: false, why: refusal }
  const asked = send(press)
  if (!asked) return { ok: false, why: notStanding(name) }
  const said = await asked
  return said.ok || said.why ? said : { ok: false, why: `${name} did not take that, and did not say why.` }
}

/** What a press says when the module's page is not on this screen to receive it. */
export function notStanding(name: string): string {
  return `${name}'s page is not open here, so nothing was pressed.`
}

/* ------------------------------------------------------------------ *
 * An agent's press
 * ------------------------------------------------------------------ */

/** What an agent may do about one item, in the three cases the protocol gives. */
export type AgentStanding = 'agents' | 'tool' | 'person'

/**
 * Whether an agent may press an item, is sent to a tool instead, or may not.
 *
 * Only what the module said: `agents: true` opts one item in, `tool` names the
 * tool at the module's own door that does the same thing, and anything else is
 * a person's. A run that has to be confirmed is a person's whatever else it
 * says — the protocol's schema refuses `agents` on one, and this does not rely
 * on the schema having been asked.
 */
export function agentStanding(item: HeaderItem): AgentStanding {
  if (item.tool !== undefined) return 'tool'
  if (item.kind === 'run' && item.confirm) return 'person'
  return item.agents === true ? 'agents' : 'person'
}

/** The ids an agent may press, for a refusal that names what exists. */
export function agentPressable(items: readonly HeaderItem[]): string[] {
  return items.filter((item) => agentStanding(item) === 'agents').map((item) => item.id)
}

/**
 * Why an agent's press is refused, or `null` when it may be sent.
 *
 * The same answer on both sides of the wire: the host's server asks it of the
 * declaration the page posted (`server/headers.ts`), and the page asks it
 * again of what the frame last declared, which is the only copy a module
 * itself wrote. Every sentence names what exists, so the next call is the
 * right one.
 */
export function agentRefusal(items: readonly HeaderItem[], press: Pressing, module: string): string | null {
  const item = items.find((one) => one.id === press.item)
  const may = agentPressable(items)
  const offered = may.length
    ? `What an agent may press in ${module}: ${may.join(', ')}.`
    : `Nothing in ${module}'s header is for an agent to press.`
  if (!item) return `${module} has no "${shown(press.item)}" in its header now. ${offered}`
  const standing = agentStanding(item)
  if (standing === 'tool') {
    return (
      `"${item.id}" is not pressed through this door: ${module}'s own MCP door has the tool ${item.tool}, which does `
      + `the same thing. Call ${item.tool} there. ${offered}`
    )
  }
  if (item.kind === 'run' && item.confirm) {
    return `"${item.id}" takes a person's second press to confirm it, so an agent does not press it. Ask the person. ${offered}`
  }
  if (standing === 'person') {
    return `"${item.id}" is the person's: ${module} has not marked it for agents. ${offered}`
  }
  return pressRefusal(items, press)
}

/** An id out of a caller's argument, cut for a sentence. */
function shown(id: string): string {
  return id.length > 64 ? `${id.slice(0, 64)}…` : id
}
