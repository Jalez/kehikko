/**
 * One start of a module at a time.
 *
 * A module could be started several times within seconds: Start is drawn in
 * every container of the module and in its folded header, each press its own
 * request, and the host's own rule starts a module the moment a kehikko that
 * has it is open. `restart` stops whatever is there before it starts, so a
 * second press half a second after the first stopped the copy the first had
 * just started and started another; and a press while the host's own start was
 * still compiling stopped that one too.
 *
 * So a start is idempotent per module while one is in flight: a press while a
 * press is in flight is given the same answer (`InFlight`), and a press while
 * the host's own start is still coming up waits for that one (`joinsStart`)
 * instead of stopping it.
 */

/** Concurrent calls for one key share the one in flight; the next call after it settles runs again. */
export class InFlight<T> {
  readonly #going = new Map<string, Promise<T>>()

  run(key: string, work: () => Promise<T>): Promise<T> {
    const going = this.#going.get(key)
    if (going) return going
    const started = (async () => work())().finally(() => {
      if (this.#going.get(key) === started) this.#going.delete(key)
    })
    this.#going.set(key, started)
    return started
  }

  has(key: string): boolean {
    return this.#going.has(key)
  }
}

/**
 * Whether a press finds a start of the host's own still coming up, and waits
 * for it instead of stopping it: the host holds a live process for the module
 * that has not answered since it was run (`starting`), and no update or
 * restart has it in hand (those decide for themselves).
 */
export function joinsStart(at: { held: boolean; starting: boolean; inHand: boolean }): boolean {
  return at.held && at.starting && !at.inHand
}
