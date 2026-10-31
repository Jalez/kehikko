import { useSyncExternalStore } from 'react'

/**
 * In focus mode, which containers have their header and footer showing.
 *
 * ## What changed, and why it is JavaScript now
 *
 * Focus mode used to reveal a container's header from an eight-pixel strip
 * along its top edge, with the header hanging OVER the module's page from it.
 * Two complaints, both fair: a person had to find the strip, and the header,
 * once found, covered the top of the module — and a footer revealed the same
 * way at the bottom would have covered the bottom.
 *
 * So both now reveal when the pointer is anywhere over the container, and
 * they PUSH: they come back into the column, the body shrinks to make room,
 * and the module's page — positioned from the body's measured rectangle
 * (`host/rects.ts`) — shrinks with it. Nothing is covered, nothing
 * overflows, and when they hide the page has its full height back.
 *
 * "Anywhere over the container" cannot be a CSS `:hover`: the container is
 * `pointer-events: none` so the page beneath can be clicked, and the page is
 * an iframe in another layer (`Frames.tsx`) whose document keeps its pointer
 * events. What the host document DOES get is the iframe element's own
 * `pointerenter` and `pointerleave` — the boundary, not the moves inside — and
 * those of its own header and footer once they show. Each is a SOURCE here;
 * a container is revealed while any source holds it.
 *
 * ## No flicker, and no loop
 *
 * A reveal moves the page: the pointer that was near the top of the page is
 * now over the header that pushed it down. The page's `pointerleave` and the
 * header's `pointerenter` arrive together, so a hide is never decided on one
 * event: it waits `REVEAL_LEAVE_MS`, and any source taking hold in that time
 * cancels it. An enter waits `REVEAL_ENTER_MS`, so a pointer crossing a canvas
 * of containers on its way somewhere else reveals none of them and starts no
 * reflow. A state is only ever set when it differs, and each change is one
 * notification — the resize it causes cannot cause another.
 */

/** What can hold a container revealed: the pointer over its page, over its own header or footer, or the keyboard in them. */
export type RevealSource = 'frame' | 'chrome' | 'focus'

/** How long the pointer must stay before a reveal starts. Short enough not to feel late; long enough that a pointer passing through starts nothing. */
export const REVEAL_ENTER_MS = 60
/** How long a reveal outlives the last thing holding it. The window in which a page moved by the reveal hands the pointer to the header. */
export const REVEAL_LEAVE_MS = 220

type Timer = ReturnType<typeof setTimeout>

export class Reveals {
  readonly #held = new Map<string, Set<RevealSource>>()
  readonly #shown = new Set<string>()
  readonly #timers = new Map<string, Timer>()
  readonly #hearers = new Set<() => void>()
  readonly #enterMs: number
  readonly #leaveMs: number

  constructor(enterMs = REVEAL_ENTER_MS, leaveMs = REVEAL_LEAVE_MS) {
    this.#enterMs = enterMs
    this.#leaveMs = leaveMs
  }

  /** One source took hold of a container, or let it go. */
  hold(id: string, source: RevealSource, on: boolean): void {
    const sources = this.#held.get(id) ?? new Set<RevealSource>()
    if (on) sources.add(source)
    else sources.delete(source)
    if (sources.size) this.#held.set(id, sources)
    else this.#held.delete(id)
    this.#decide(id)
  }

  /** Whether a container's header and footer are showing now. */
  revealed(id: string): boolean {
    return this.#shown.has(id)
  }

  /** Let go of everything about a container that went away. */
  forget(id: string): void {
    this.#held.delete(id)
    const timer = this.#timers.get(id)
    if (timer) clearTimeout(timer)
    this.#timers.delete(id)
    if (this.#shown.delete(id)) this.#tell()
  }

  subscribe = (hearer: () => void): (() => void) => {
    this.#hearers.add(hearer)
    return () => this.#hearers.delete(hearer)
  }

  #decide(id: string): void {
    const wanted = this.#held.has(id)
    const pending = this.#timers.get(id)
    if (pending) {
      clearTimeout(pending)
      this.#timers.delete(id)
    }
    if (wanted === this.#shown.has(id)) return
    this.#timers.set(
      id,
      setTimeout(
        () => {
          this.#timers.delete(id)
          const now = this.#held.has(id)
          if (now === this.#shown.has(id)) return
          if (now) this.#shown.add(id)
          else this.#shown.delete(id)
          this.#tell()
        },
        wanted ? this.#enterMs : this.#leaveMs,
      ),
    )
  }

  #tell(): void {
    for (const hearer of this.#hearers) hearer()
  }
}

/** Whether one container is revealed, re-rendering only when that changes. */
export function useRevealed(reveals: Reveals | null, id: string): boolean {
  return useSyncExternalStore(
    reveals ? reveals.subscribe : noSubscribe,
    () => (reveals ? reveals.revealed(id) : false),
    () => false,
  )
}

/**
 * The handlers that make an element a source for one container: pointer in and
 * out, and — for the container's own header and footer — focus in and out.
 * `focusout` to an element still inside the same element keeps the hold.
 */
export function revealHandlers(reveals: Reveals | null, id: string, source: RevealSource) {
  if (!reveals) return {}
  return {
    onPointerEnter: () => reveals.hold(id, source, true),
    onPointerLeave: () => reveals.hold(id, source, false),
  }
}

export function focusHandlers(reveals: Reveals | null, id: string) {
  if (!reveals) return {}
  return {
    onFocus: () => reveals.hold(id, 'focus', true),
    onBlur: (event: { currentTarget: Element; relatedTarget: EventTarget | null }) => {
      const next = event.relatedTarget as Node | null
      if (next && event.currentTarget.contains(next)) return
      reveals.hold(id, 'focus', false)
    },
  }
}

const noSubscribe = () => () => {}
