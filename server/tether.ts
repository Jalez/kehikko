import { connect as netConnect } from 'node:net'

/**
 * Hearing that a module this host did NOT start has gone, when it goes.
 *
 * ## The gap this closes
 *
 * A module the host started is a child it holds: the runtime says when it
 * exits, and the container changes at once (`ended` in `server.ts`). A module
 * somebody else started — in a terminal, or by a host before this one — is a
 * port and nothing more, and the only thing that asked whether it was still
 * there was the thirty-second watch. So its container stayed green for up to
 * half a minute over a page whose server had died.
 *
 * ## A held connection, not a faster poll
 *
 * One idle TCP connection to the module's port. The operating system closes
 * it the moment the process that accepted it dies — any death, including a
 * `kill -9` — and the close arrives here as an event. Nothing is sent on it
 * and nothing is asked on a timer, which is the cost `lifecycle.ts` refuses
 * (`WATCH_EVERY_MS`): a request per tick, per module, to be told nothing
 * changed.
 *
 * A close is a reason to look, not a finding. A server also closes a
 * connection that has sat idle (Node after about a minute, Bun after ten
 * seconds), so on every close the caller asks the module once and acts only
 * if what it finds differs from what it believed; the tether is then put
 * back. That is one small request per idle timeout per module, in place of
 * one per thirty seconds — and none at all for a module the host started, a
 * module that is not answering, or one no open kehikko has.
 *
 * What it does not hear: a process that is alive and hung. The watch still
 * runs for that, unchanged.
 */

/** A connection that closed sooner than this after it opened is not put straight back. */
export const SETTLED_AFTER_MS = 2_000

interface Socketish {
  on(event: 'connect' | 'close' | 'error' | 'end' | 'data', heard: () => void): unknown
  destroy(): void
  unref?(): void
  resume?(): void
}

export type Connect = (port: number, host: string) => Socketish

interface Tether {
  url: string
  socket: Socketish
  openedAt: number | null
}

export class Tethers {
  #held = new Map<string, Tether>()

  /**
   * `dropped(id, quick)` is told every time a tether closes while it was still
   * wanted. `quick` is a connection that never opened or closed almost at
   * once: the caller looks, and leaves putting it back to the next `sync`.
   */
  constructor(
    private readonly dropped: (id: string, quick: boolean) => void,
    private readonly connect: Connect = (port, host) => netConnect({ port, host }),
    private readonly now: () => number = Date.now,
  ) {}

  /** Which modules are tethered right now. */
  get ids(): string[] {
    return [...this.#held.keys()]
  }

  /**
   * Hold exactly these: id to the origin it answers on. One that is already
   * held at that address is left alone; one no longer wanted is let go
   * without a word.
   */
  sync(want: ReadonlyMap<string, string>): void {
    for (const [id, tether] of [...this.#held]) {
      if (want.get(id) === tether.url) continue
      this.#held.delete(id)
      tether.socket.destroy()
    }
    for (const [id, url] of want) if (!this.#held.has(id)) this.#open(id, url)
  }

  #open(id: string, url: string): void {
    let port: number
    let host: string
    try {
      const at = new URL(url)
      port = Number(at.port || (at.protocol === 'https:' ? 443 : 80))
      host = at.hostname.replace(/^\[|\]$/g, '')
    } catch {
      return
    }
    let socket: Socketish
    try {
      socket = this.connect(port, host)
    } catch {
      return
    }
    const tether: Tether = { url, socket, openedAt: null }
    this.#held.set(id, tether)
    /* Never a reason for this process to stay up. */
    socket.unref?.()
    socket.on('connect', () => {
      tether.openedAt = this.now()
    })
    /* An error is always followed by a close; it only must not be unhandled. */
    socket.on('error', () => {})
    /*
     * Read, and discard. A socket nobody reads never learns that the other end
     * has gone: the process dying sends an end-of-stream that sits unread, and
     * the connection stays half-open on this side for good (measured: the
     * host's end in CLOSE_WAIT, and no close, minutes after the module had
     * died). Flowing, the end arrives as `end`, and this side then closes too.
     * What a server says before closing an idle connection (a 408) is read and
     * dropped the same way.
     */
    socket.on('data', () => {})
    socket.on('end', () => socket.destroy())
    socket.resume?.()
    socket.on('close', () => {
      /* Let go on purpose, or replaced: not news. */
      if (this.#held.get(id) !== tether) return
      this.#held.delete(id)
      const quick = tether.openedAt === null || this.now() - tether.openedAt < SETTLED_AFTER_MS
      this.dropped(id, quick)
    })
  }
}
