import { frameFocused, type ClickEvent } from './rows.ts'

/**
 * Whether the person has just pressed something in this page or in a frame
 * inside it (protocol 2.50.0, `messages.say`; 2.58.0, `view.expand`).
 *
 * Two witnesses, either enough:
 *
 * ## The browser's activation
 *
 * `navigator.userActivation.isActive` is the browser's own word for a fresh
 * press — a click, a key, a tap — and it is TRANSIENT: true for a few seconds
 * after one, then false. A press inside a module's frame activates this
 * document too where the engine propagates activation to the ancestors of the
 * frame that was pressed. A module cannot make one: a script's events, a
 * message, a timer or an agent's relayed header press activate nothing.
 *
 * It is not enough alone. An engine that keeps a cross-origin frame in another
 * process, one that does not propagate activation across origins, or a webview
 * without the API leaves this document unactivated after a real press in the
 * frame, and every press there would be refused, silently.
 *
 * ## What this page saw itself
 *
 * The page sees a press INTO a container's frame without the frame's help:
 * the window's blur with that frame left as the active element, the active
 * element moving to it while the window is blurred, and a press on the
 * container's own chrome (`watchClicks` in `host/rows.ts`, the same events
 * reveal on click reads). `FramePresses` keeps when each container was last
 * pressed into, and a request from that frame within `FRESH_PRESS_MS` of it is
 * fresh. None of those can be made by the module: they are this document's own
 * focus and pointer events.
 *
 * What the page is TOLD — a module's `kehikot.pointer` — never counts: any
 * module can post one whenever it likes. `sawPress` takes only the kinds this
 * document observed.
 *
 * Read synchronously, when the frame's request arrives (`Conversation.receive`),
 * before anything is awaited. Fails closed: with neither witness the request
 * is refused, and the refusal says why.
 */
export function pressFresh(nav: unknown = globalThis.navigator): boolean {
  const activation = (nav as { userActivation?: { isActive?: unknown } } | undefined)?.userActivation
  return activation?.isActive === true
}

/** How long a press this page saw into a frame stays fresh for a request from that frame. */
export const FRESH_PRESS_MS = 2000

/** When each container's frame was last pressed into, as this page saw it. Never stored. */
export class FramePresses {
  readonly #at = new Map<string, number>()
  readonly #ms: number

  constructor(ms = FRESH_PRESS_MS) {
    this.#ms = ms
  }

  /** This page saw a press into `id`'s frame, or on its chrome, at `at`. */
  saw(id: string, at: number = Date.now()): void {
    this.#at.set(id, at)
  }

  /** Whether a request from `id`'s frame at `now` follows a press this page saw closely enough. */
  freshFor(id: string, now: number = Date.now()): boolean {
    const at = this.#at.get(id)
    return at !== undefined && now >= at && now - at <= this.#ms
  }

  forget(id: string): void {
    this.#at.delete(id)
  }
}

/** The page's one record. */
export const framePresses = new FramePresses()

/**
 * Record what moves the click if, and only if, this document observed it: a
 * press into a frame (`frame`) or on a container's chrome (`chrome`). A page's
 * own claim (`press`, from `kehikot.pointer`) is forgeable and is not taken.
 */
export function sawPress(event: ClickEvent, presses: FramePresses = framePresses, now: number = Date.now()): void {
  if (event.kind === 'frame' || event.kind === 'chrome') presses.saw(event.id, now)
}

/** Whether a request from the frame of `id` comes on the person's fresh press: either witness. */
export function pressFreshFor(
  id: string,
  { nav = globalThis.navigator, presses = framePresses, now = Date.now() }: { nav?: unknown; presses?: FramePresses; now?: number } = {},
): boolean {
  return pressFresh(nav) || presses.freshFor(id, now)
}

/**
 * After a request was refused for want of a press: take the keyboard back from `id`'s frame if it
 * holds it, so the person's next press into the frame is a blur this page sees. A press into a frame
 * that already has the keyboard moves no focus, and is invisible here. Answers whether it let go.
 */
export function letGoOfFrame(doc: Pick<Document, 'activeElement'>, id: string): boolean {
  if (frameFocused(doc) !== id) return false
  ;(doc.activeElement as (Element & { blur?(): void }) | null)?.blur?.()
  return true
}
