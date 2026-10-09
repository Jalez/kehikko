/**
 * Whether a module is running older code than its checkout holds.
 *
 * ## What answers today
 *
 * Only what this host did. An update that needed a restart and could not give
 * it one — the registration says `keep`, the process is somebody else's, the
 * start failed — is recorded here with its sentence, and forgotten when the
 * module is next started or found not running. The record lives in the server,
 * so a page that reloads still reads it (`GET /host/updates`), and it is lost
 * with the host process: a host that restarted cannot tell what its
 * predecessor left running old code.
 *
 * ## The seam
 *
 * `staleness` is the one question — "is this module's server, or its page,
 * behind its checkout?" — and everything that asks goes through it. When the
 * protocol carries a build identity (the commit a server was started from, the
 * commit a page was built from), compare it with the checkout's HEAD here and
 * return the sentence; nothing that calls this needs to change, and the record
 * below becomes the fallback for modules that do not say.
 */
export class Staleness {
  #behind = new Map<string, string>()

  /** An update changed what this module's server runs, and it was not restarted: why. */
  leftBehind(id: string, why: string): void {
    this.#behind.set(id, why)
  }

  /** It was started, or is not running at all: whatever runs next runs the checkout. */
  fresh(id: string): void {
    this.#behind.delete(id)
  }

  /** Why this module is running old code, or null when nothing says it is. */
  staleness(id: string): string | null {
    return this.#behind.get(id) ?? null
  }

  /** Every module known to be behind its checkout, with its sentence. */
  all(): Record<string, string> {
    return Object.fromEntries(this.#behind)
  }

  forgetAllBut(ids: Iterable<string>): void {
    const keep = new Set(ids)
    for (const id of [...this.#behind.keys()]) if (!keep.has(id)) this.#behind.delete(id)
  }
}
