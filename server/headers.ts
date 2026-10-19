import { headerItemsSchema, type HeaderItem } from 'kehikot-module-protocol'

import type { Pressed, Pressing } from '../src/host/header.ts'
import type { PressOrder } from './wake.ts'

/**
 * What the modules on an open kehikko have declared for their headers, as
 * the pages told the server — and the one way an agent's press reaches a
 * module's frame.
 *
 * ## Why the server has to be told
 *
 * A module declares its header (`kehikot.header`) to the document that
 * framed it, which is a page in a browser. The host's MCP door is here, on
 * the server, and has never heard any of it. So the page says it again:
 * `POST /host/headers`, the whole map for the kehikko it has open, every time
 * it changes. `read_canvas` lists a container's items from that, and
 * `press_item` judges a press against it before anything is sent anywhere.
 *
 * Held in memory, per page, and never written down. It is a fact about a
 * screen — which is why `kehikot.json` and the canvases database know
 * nothing of it — and it is gone when the process is; a page says it again
 * when its stream reopens.
 *
 * ## What a posting is trusted for, which is not much
 *
 * It is a browser's word about what a frame said. So:
 *
 *  - Both routes answer only a request this host's own page sent — JSON, with
 *    an `Origin` that is one of the page's (`PAGE_ONLY` in `guard.ts`, the
 *    check "Restart anyway" has, made there before a route is chosen and not
 *    again here). A module's frame is another origin, and so is any
 *    other site: neither can declare a header for somebody else, or answer a
 *    press it was not asked to make.
 *  - Every list is parsed with the protocol's own schema, which bounds every
 *    string and refuses `agents: true` beside `tool` or on a confirmed run.
 *    A list that does not parse is dropped whole, as the page's own
 *    conversation drops one.
 *  - A posting counts only while a stream of that page is open. A press
 *    travels down that stream, so a page that cannot be reached is not one
 *    whose word about its modules is worth anything.
 *  - And the page judges the press again, against what the frame declared to
 *    IT (`orderedRef` in `App.tsx`). What is held here decides what an agent
 *    is TOLD and what is refused early; it is never the last word on whether
 *    a module's item is pressed.
 *
 * ## The press
 *
 * `press` picks the page, hands it a `PressOrder` down its own stream
 * (`Wakes.press`), and waits for that page to post what the module said to
 * `/host/pressed`. No answer by the deadline is "not pressed", and says so.
 * The id is random and is the only thing that pairs an answer with a press:
 * an answer naming an id nobody is waiting on, or from another page than the
 * one that was asked, settles nothing.
 */

/** How many pages' postings are kept. The bound `open.ts` puts on pages. */
const PAGES_MAX = 64
/** How many modules one posting may name: `PLACEMENTS_MAX` in `canvases.ts`. */
const MODULES_MAX = 64
/** A posting is read as text first, and one longer than this is not read at all. */
const BODY_MAX = 1024 * 1024

/**
 * How long a `press_item` waits for the page's answer.
 *
 * Longer than the page waits for the module (`PRESSED_TIMEOUT_MS`, three
 * seconds), which is longer than the module's own client waits for its
 * listener (`PRESS_BACKSTOP_MS`, two): each side that is waiting on another
 * outlasts it, so the sentence an agent reads is the innermost one that
 * applies — the module's reason if it gave one, "did not answer" if it did
 * not, and "no page answered" only when the page itself is gone.
 */
export const PRESS_ANSWER_MS = 6000

interface Posting {
  kehikko: number
  /** When it was posted, by the page's own clock: an older one that arrives late does not replace a newer. */
  at: number
  headers: Map<string, HeaderItem[]>
}

interface Waiting {
  page: string
  resolve(came: Pressed): void
  timer: ReturnType<typeof setTimeout>
}

/** What a kehikko's containers have declared, and the page that said so. */
export interface Declared {
  page: string
  headers: ReadonlyMap<string, readonly HeaderItem[]>
}

export class Headers {
  #pages = new Map<string, Posting>()
  #waiting = new Map<string, Waiting>()

  /**
   * One page saying what the modules on its open kehikko have declared.
   *
   * The whole map, replacing what that page said before. Answers `null`, or
   * the sentence saying what was wrong with it.
   */
  posted(page: string, kehikko: number, at: number, raw: unknown): string | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'headers is an object of module id to its items.'
    const entries = Object.entries(raw as Record<string, unknown>)
    if (entries.length > MODULES_MAX) return `No kehikko holds more than ${MODULES_MAX} containers.`
    const headers = new Map<string, HeaderItem[]>()
    for (const [id, items] of entries) {
      if (!id || id.length > 64) continue
      /* A list that does not parse is a module the page should not have
         forwarded; dropped, and the rest of the posting stands. */
      const parsed = headerItemsSchema.safeParse(items)
      if (parsed.success) headers.set(id, parsed.data)
    }
    const held = this.#pages.get(page)
    if (held && held.at > at) return null
    if (!held && this.#pages.size >= PAGES_MAX) {
      const oldest = [...this.#pages.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) this.#pages.delete(oldest[0])
    }
    this.#pages.set(page, { kehikko, at, headers })
    return null
  }

  /** A page that has said it has nothing open any more. */
  forget(page: string): void {
    this.#pages.delete(page)
  }

  /**
   * What the containers on one kehikko have declared, from the page that can
   * be asked to press them — or `null` when no page that is listening has
   * that kehikko open.
   *
   * `hears` is whether a stream of a page is open (`Wakes.hears`). Two
   * windows on one kehikko are two postings of the same frames' words; the
   * later one is taken, and the press goes to that page alone.
   */
  on(kehikko: number, hears: (page: string) => boolean): Declared | null {
    let found: { page: string; posting: Posting } | null = null
    for (const [page, posting] of this.#pages) {
      if (posting.kehikko !== kehikko || !hears(page)) continue
      if (!found || posting.at > found.posting.at) found = { page, posting }
    }
    return found ? { page: found.page, headers: found.posting.headers } : null
  }

  /**
   * Ask one page to press, and wait for what it says came of it.
   *
   * `send` writes the order to that page's streams and answers whether there
   * was one to write to. `null` when there was not: the page went away
   * between being chosen and being asked.
   */
  /**
   * Ask one page to press, and wait for what it says came of it.
   *
   * `send` writes the order to that page's streams and answers whether there
   * was one to write to. `null` when there was not: the page went away
   * between being chosen and being asked.
   */
  press(
    page: string,
    order: Omit<PressOrder, 'id' | 'page'>,
    send: (order: PressOrder) => boolean,
    waitMs = PRESS_ANSWER_MS,
  ): Promise<Pressed | null> {
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id)
        resolve({
          ok: false,
          why:
            'The page that has this kehikko open did not say what came of the press in time, so it is not known '
            + 'whether it was pressed. read_canvas shows how the item stands now.',
        })
      }, waitMs)
      this.#waiting.set(id, { page, resolve, timer })
      if (!send({ ...order, id, page })) {
        clearTimeout(timer)
        this.#waiting.delete(id)
        resolve(null)
      }
    })
  }

  /** A page's answer to an order. `false` when nobody was waiting on that id from that page. */
  answered(page: string, id: string, came: Pressed): boolean {
    const waiting = this.#waiting.get(id)
    if (!waiting || waiting.page !== page) return false
    clearTimeout(waiting.timer)
    this.#waiting.delete(id)
    waiting.resolve(came)
    return true
  }

  /** How many presses are out. For tests. */
  get waiting(): number {
    return this.#waiting.size
  }
}

export interface HeadersDeps {
  /** Whether a stream of this page is open, and a way to write an order to it. See `Wakes`. */
  hears(page: string): boolean
  send(order: PressOrder): boolean
  /** Override `PRESS_ANSWER_MS`, for a test. */
  waitMs?: number
}

/**
 * The two routes the page reaches, and the two things the MCP door is given.
 *
 * `POST /host/headers` `{ page, kehikko, at?, headers }` and
 * `POST /host/pressed` `{ page, id, ok, why }`. Anything that is not this
 * host's own page was refused before it got here (`guard.ts`).
 */
export function headersDesk(deps: HeadersDeps, held = new Headers()) {
  const short = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64

  async function route(request: Request, url: URL): Promise<Response | null> {
    const which = url.pathname === '/host/headers' ? 'headers' : url.pathname === '/host/pressed' ? 'pressed' : null
    if (which === null || request.method !== 'POST') return null
    const text = await request.text().catch(() => '')
    if (text.length > BODY_MAX) return reply({ ok: false, why: 'That is more than any kehikko’s headers come to.' }, 413)
    let body: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      /* Not JSON: refused below. */
    }
    if (!body || !short(body.page)) return reply({ ok: false, why: 'A posting names the page making it.' }, 400)

    if (which === 'headers') {
      const kehikko = body.kehikko
      if (typeof kehikko !== 'number' || !Number.isInteger(kehikko) || kehikko <= 0) {
        return reply({ ok: false, why: 'A posting of headers names the kehikko the page has open.' }, 400)
      }
      const at = typeof body.at === 'number' && Number.isFinite(body.at) ? body.at : Date.now()
      const wrong = held.posted(body.page, kehikko, at, body.headers)
      return wrong ? reply({ ok: false, why: wrong }, 400) : reply({ ok: true })
    }

    if (!short(body.id) || typeof body.ok !== 'boolean') {
      return reply({ ok: false, why: 'An answer to a press names the press, and says whether it was taken.' }, 400)
    }
    const why = typeof body.why === 'string' ? body.why.slice(0, 600) : ''
    return reply({ ok: held.answered(body.page, body.id, { ok: body.ok, why }) })
  }

  return {
    route,
    held,
    /** What `mcp.ts` is handed: see `Door.headers` there. */
    door: {
      on: (kehikko: number): ReadonlyMap<string, readonly HeaderItem[]> | null =>
        held.on(kehikko, deps.hears)?.headers ?? null,
      press: (kehikko: number, module: string, press: Pressing): Promise<Pressed | null> => {
        const found = held.on(kehikko, deps.hears)
        if (!found) return Promise.resolve(null)
        return held.press(
          found.page,
          { kehikko, module, item: press.item, ...(press.value === undefined ? {} : { value: press.value }) },
          deps.send,
          deps.waitMs,
        )
      },
    },
  }
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
