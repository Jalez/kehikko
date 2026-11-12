/**
 * Whether the person is arranging a kehikko right now: a hand on a container's grip or corner, or
 * the arrangement it left not yet stored.
 *
 * An agent's `arrange_modules` (`server/mcp.ts`) is refused while this says so. The grid owns the
 * layout for the whole of a drag and stores what the hand left a moment after it lets go, as a
 * whole arrangement; an agent's change written in between would be overwritten by that save, or —
 * worse — would move a container out from under the pointer. So the page says when a drag or a
 * resize starts and, once what it left is stored, that it ended (`POST /host/arranging`, which is
 * `PAGE_ONLY`), and the door asks here.
 *
 * Held per page, and only for `ARRANGING_HOLD_MS`: a page that closed mid-drag, or whose "ended"
 * never arrived, must not keep every agent out of a kehikko for good.
 */

/** How long a "started" holds without being said again or ended. Longer than any drag. */
export const ARRANGING_HOLD_MS = 30_000

/** What the door says when it refuses. */
export const ARRANGING_SAID =
  'the person is arranging this kehikko — a container is being moved or resized, or what they left is not stored yet'

export class Arranging {
  #by = new Map<string, { kehikko: number; until: number }>()

  constructor(private readonly hold = ARRANGING_HOLD_MS) {}

  /** A page said it started (or is still at) arranging `kehikko`, or that it stopped. */
  report(page: string, kehikko: number, arranging: boolean, now = Date.now()): void {
    if (arranging) this.#by.set(page, { kehikko, until: now + this.hold })
    else this.#by.delete(page)
  }

  /** Whether any page has a hand in `kehikko`'s arrangement now. */
  busy(kehikko: number, now = Date.now()): boolean {
    for (const [page, held] of this.#by) {
      if (held.until <= now) this.#by.delete(page)
      else if (held.kehikko === kehikko) return true
    }
    return false
  }

  /** A page that went away holds nothing. */
  forget(page: string): void {
    this.#by.delete(page)
  }
}

/**
 * `POST /host/arranging` `{ page, kehikko, arranging }`. Anything that is not this host's own page
 * was refused before it got here (`PAGE_ONLY` in `guard.ts`).
 */
export async function arrangingRoute(request: Request, url: URL, held: Arranging): Promise<Response | null> {
  if (url.pathname !== '/host/arranging' || request.method !== 'POST') return null
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const text = await request.text().catch(() => '')
  if (text.length > 1024) return reply({ ok: false, why: 'That is more than a word about arranging comes to.' }, 413)
  let body: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch {
    /* Not JSON: refused below. */
  }
  const page = body?.page
  const kehikko = body?.kehikko
  if (!body || typeof page !== 'string' || !page.length || page.length > 64) return reply({ ok: false, why: 'A word about arranging names the page saying it.' }, 400)
  if (typeof kehikko !== 'number' || !Number.isInteger(kehikko) || kehikko <= 0 || typeof body.arranging !== 'boolean') {
    return reply({ ok: false, why: 'A word about arranging names the kehikko and says whether the person is arranging it.' }, 400)
  }
  held.report(page, kehikko, body.arranging)
  return reply({ ok: true })
}
