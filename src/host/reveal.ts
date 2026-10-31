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

/*
 * ## Over, for a module that cannot afford a resize
 *
 * Pushing shrinks the module's frame, and for a terminal that is the one thing
 * a hover must not do: the emulator fits to fewer rows, the pty is resized
 * (SIGWINCH) and the program redraws for the smaller screen — and again the
 * other way when the pointer leaves. Two full redraws and two scroll jumps per
 * hover, in the place the person is reading. Waiting for the size to settle
 * does not help: the pointer rests over a terminal for as long as somebody
 * works in it, so the redraw only comes later.
 *
 * So a module may say `reveal: 'over'` in its manifest (protocol 2.42.0). Its
 * container's rows are then drawn OVER the frame (`[data-reveal='over']` in
 * `index.css`): the body keeps its height, the page keeps its rectangle, and
 * nothing in the module is resized. What the rows cover is told to the page in
 * `kehikot.covered` (`coveredBy`, `Conversation.sendCovered`), and the page
 * moves its last line out from under them with a transform. Every other
 * module keeps the push.
 */

/** The height of a revealed header or footer row: `h-8`, and the `2rem` the rows grow to in `index.css`. */
export const REVEAL_ROW_PX = 32

/**
 * Which of a container's rows hide in focus mode and reveal over its page, for a
 * module that says `reveal: 'over'`; `null` for one that is pushed. A selected
 * container keeps its header in the column (it never hides), so it covers
 * nothing; a container with no footer has none to cover with.
 */
export interface Covers {
  header: boolean
  footer: boolean
}

/** How much of the page the rows cover now: what `kehikot.covered` says. Nothing for a pushed module or a hidden reveal. */
export function coveredBy(covers: Covers | null, revealed: boolean): { top: number; bottom: number } {
  if (!covers || !revealed) return { top: 0, bottom: 0 }
  return { top: covers.header ? REVEAL_ROW_PX : 0, bottom: covers.footer ? REVEAL_ROW_PX : 0 }
}
