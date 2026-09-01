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
}
