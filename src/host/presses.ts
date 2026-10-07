/**
 * How a control in a container's header reaches the conversation inside the frame.
 *
 * ## The problem this solves, which is narrower than it looks
 *
 * Everything the host says to a module travels one way: `App.tsx` composes a
 * value, hands it to `Frames`, and `ModuleFrame` posts it in an effect when it
 * changes. The context, the pin, the prompt, the filter choice — all of them are
 * STATE, and state is exactly what that path carries well.
 *
 * A press is not state. "Clear what you are showing" happens at a moment,
 * happens again if pressed again, and has no value that could be re-sent on a
 * reload without deleting something twice. Carrying it as a prop means encoding
 * an event as a changing value — a counter, a nonce — and posting from an
 * effect when it changes.
 *
 * That is what this exists to avoid, and the reason is specific rather than
 * aesthetic. This host runs under `StrictMode`, which invokes effects twice on
 * mount in development. An effect that posts a destructive message is an effect
 * that deletes somebody's records twice, in development only, on a path nobody
 * tests by pressing twice. There is no version of the nonce that is safe by
 * construction — only versions that are careful.
 *
 * So a press is a CALL, made from the click handler, on the frame that is
 * standing right now. Nothing is stored, nothing is replayed, and a press that
 * arrives when the frame has gone does nothing at all.
 *
 * ## Why it is a registry and not a ref to one conversation
 *
 * The same shape as `EventBus.join`, deliberately, because it is the same
 * problem: the thing being addressed is a frame in a layer that outlives the
 * grid, there may be a dozen of them, and the one being addressed is named by
 * id rather than held. `ModuleFrame` joins in the SAME effect as the bus and
 * leaves in the same cleanup — see the essay there on why a receiver and a
 * conversation must share a lifetime exactly, and what it cost when they were
 * two effects.
 */

/** What one framed module offers the host to press. */
export interface Pressable {
  /** Tell this module to clear what it is showing. See `Conversation.sendClear`. */
  clear(): void
  /**
   * Tell this module to read its material again. See `Conversation.sendRefresh`.
   *
   * Here rather than as a prop for the reason `clear` is, and for one more of
   * its own: this press has a second caller that is not a person. An interval
   * fires it, and an interval encoded as a changing prop is a value that gets
   * re-sent on every remount — which under `StrictMode` is a refresh on every
   * mount in development, and after any reload of the canvas a burst of them
   * for every container that had a clock. A call made from the timer to the
   * frame standing right now cannot do that: where there is no frame there is
   * no call.
   */
  refresh(): void
  /**
   * Walk this module to something on its own page, and hear whether it found
   * it. See `Conversation.goto`.
   *
   * Here for the reason `clear` is: a walk is a press. It happens at a moment
   * and has no value that could be re-sent on a reload — a canvas that
   * scrolled a module to its parts box again every time the page was opened
   * would be a canvas with a mind of its own. It is the first press with an
   * ANSWER, which the protocol gives a walk and gives nothing else: found, or
   * not and why. The one caller is the parts control in the bar, sending a
   * person to where an epic is divided into parts; see `host/dividing.ts`.
   */
  walk(target: WalkTarget): Promise<Walked>
}

/** What a walk names: the triple `kehikot.goto` carries. */
export interface WalkTarget {
  ref?: string
  step?: number
  epic?: string
}

/** What a module answered a walk with. A module that never answers is `found: false`. */
export interface Walked {
  found: boolean
  why: string
}

/**
 * The frames that can currently be pressed, by module id.
 *
 * A plain class over a `Map` rather than a bare `Map`, so that the one thing a
 * caller must not do — hold on to a `Pressable` — is not the easy thing to do.
 * `press` looks up at the moment of the press, which is the whole point: a
 * container removed between a person's first press and their second is a module
 * that is no longer there, and the correct answer is silence.
 *
 * A `Map` and not an object, because the keys are module ids read out of a
 * manifest a stranger wrote — the protocol's note on `own()` is about exactly
 * this, and a `Map` has no prototype to collide with.
 */
export class Presses {
  private readonly frames = new Map<string, Pressable>()

  join(id: string, frame: Pressable): void {
    this.frames.set(id, frame)
  }

  leave(id: string): void {
    this.frames.delete(id)
  }

  /**
   * Press one module, if it is there.
   *
   * Answers whether anything was pressed, which is not for showing to anybody —
   * the host has nothing to report about a module's own data. It is here so a
   * test can tell "the press reached the frame" from "the press reached
   * nothing", which are the two outcomes and are otherwise indistinguishable
   * from outside.
   */
  press(id: string): boolean {
    const frame = this.frames.get(id)
    if (!frame) return false
    frame.clear()
    return true
  }

  /**
   * Ask one module to read again, if it is there.
   *
   * Separate from `press` rather than a parameter to it, because the two are
   * not the same kind of act and one of them is destructive. A single method
   * taking a verb would be one place where a wrong string deletes somebody's
   * records instead of refreshing them, and the compiler would not be able to
   * say so.
   *
   * Answers whether anything was asked, for the same reason `press` does: it is
   * how a test tells "the tick reached the frame" from "the tick reached
   * nothing", which is the whole of what the timer needs to be held to.
   */
  refresh(id: string): boolean {
    const frame = this.frames.get(id)
    if (!frame) return false
    frame.refresh()
    return true
  }

  /**
   * Walk one module, if it is there — or `null` when it is not, which is not
   * the same answer as a module that was there and found nothing: the caller
   * is waiting for a frame to arrive and has to be able to tell.
   */
  walk(id: string, target: WalkTarget): Promise<Walked> | null {
    const frame = this.frames.get(id)
    return frame ? frame.walk(target) : null
  }
}
