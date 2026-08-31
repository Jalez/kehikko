import type { CanvasEdit } from './canvases.ts'

/**
 * Writes to a canvas, gathered up and sent once the hand stops moving.
 *
 * ## Why this is not just a `setTimeout` at the call site
 *
 * Dragging a container across a twelve-column grid produces a layout change on every
 * mouse move that crosses a column boundary — tens of them in one gesture, each
 * a complete arrangement. Sending each one is a request storm for a result
 * nobody sees, and the intermediate ones are not merely wasteful: they are
 * arrangements the person never chose, and if the last one is lost the canvas is
 * left in the middle of a drag.
 *
 * So edits are merged rather than queued. A rename arriving during a drag does
 * not wait behind the drag, and does not cancel it either; both land in one
 * request. Merging is per canvas, because two canvases being edited at once —
 * one open, one being renamed from the switcher — are two different rows and
 * must not share a timer.
 *
 * ## What it does not do
 *
 * It does not retry, and it does not tell the caller when the write landed.
 * A failed write is reported once, through `onTrouble`, and the arrangement on
 * screen is left exactly as the person left it. Reconciling a failed write by
 * moving somebody's containers back would be the host taking a position on which of
 * the two arrangements was meant, and it does not have one.
 */
export class Writer {
  #pending = new Map<number, CanvasEdit>()
  #timers = new Map<number, ReturnType<typeof setTimeout>>()
  #send: (id: number, edit: CanvasEdit) => Promise<unknown>
  #onTrouble: (message: string) => void
  #delay: number

  constructor(
    send: (id: number, edit: CanvasEdit) => Promise<unknown>,
    onTrouble: (message: string) => void,
    /* Long enough that a drag is one write, short enough that a person who
       rearranges and immediately closes the tab keeps their arrangement. */
    delay = 400,
  ) {
    this.#send = send
    this.#onTrouble = onTrouble
    this.#delay = delay
  }

  write(id: number, edit: CanvasEdit): void {
    this.#pending.set(id, { ...this.#pending.get(id), ...edit })
    const existing = this.#timers.get(id)
    if (existing) clearTimeout(existing)
    this.#timers.set(
      id,
      setTimeout(() => void this.#flush(id), this.#delay),
    )
  }

  /** Send everything now, without waiting. For a page that is going away. */
  flushAll(): void {
    for (const id of [...this.#pending.keys()]) void this.#flush(id)
  }

  async #flush(id: number): Promise<void> {
    const timer = this.#timers.get(id)
    if (timer) clearTimeout(timer)
    this.#timers.delete(id)

    const edit = this.#pending.get(id)
    this.#pending.delete(id)
    if (!edit) return

    try {
      await this.#send(id, edit)
    } catch (error) {
      this.#onTrouble(
        `This canvas could not be saved: ${(error as Error).message}. What is on screen is unchanged; it is what is stored that is behind.`,
      )
    }
  }
}
