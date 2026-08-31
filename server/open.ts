/**
 * Which kehikko is open, which the server does not otherwise know.
 *
 * ## The problem, which is not a small one
 *
 * The open kehikko is a fact about a browser TAB. It is deliberately the one
 * thing this host keeps in `localStorage` rather than in its database — see the
 * essay at the top of `canvases.ts` — because two windows on two screens
 * showing two kehikot is a reasonable thing to do, and a server that stored
 * "the current kehikko" would make them fight over it.
 *
 * That was fine while nothing but the page ever needed to know. An agent
 * arriving at the MCP door needs to know, and it cannot be told to look in
 * somebody's `localStorage`. So there are exactly two honest ways to answer
 * "which kehikko did you mean": the caller says, or the page says.
 *
 * ## Both, and neither of them guesses
 *
 * The page REPORTS. Each tab mints an id for itself and posts which kehikko it
 * has open whenever that changes, and withdraws the report when it goes away.
 * A tool with no `kehikko` argument reads that, and the answer is used only
 * when it is unambiguous.
 *
 * Unambiguous is the whole of this file. One page reporting one kehikko is an
 * answer. Two pages reporting two different kehikot is NOT an answer, and the
 * refusal names both — because a tool that picked the most recent of them would
 * silently select containers on the screen somebody is not looking at, and
 * nothing anywhere would say it had. A refusal costs an agent one round trip
 * and a sentence telling it to pass `kehikko`. A wrong guess costs somebody
 * their attention on a canvas they cannot see.
 *
 * Two pages reporting the SAME kehikko is fine and is the ordinary case of a
 * reload: the old tab's report is replaced, not added to, because reports are
 * keyed by page.
 *
 * ## Why reports go stale slowly, and why there is no heartbeat
 *
 * A tab that crashes or is killed never withdraws. The backstop is time — a
 * report older than `STALE_MS` is not an answer — and it is deliberately long,
 * because the alternative is the page polling to say "still here", and a host
 * that made a request every ten seconds to tell its own server nothing changed
 * is the thing this codebase has refused everywhere else. Half a day of
 * staleness is survivable: the failure it allows is an agent being told a
 * kehikko is open when the browser has been shut, and what happens then is that
 * a selection is written down and seen the next time somebody opens the page.
 * That is the same thing that happens when a tool call arrives while the person
 * is at lunch.
 *
 * This lives in memory and dies with the process, which is correct: it is a
 * claim about what is on somebody's screen right now, and a host that restarted
 * has no business asserting anything about that from a file.
 */

/** Half a day. See above for why it is this long rather than seconds. */
export const STALE_MS = 12 * 60 * 60 * 1000

/** As many tabs as anybody sanely has open, and a bound on a map keyed by a string from a request. */
const PAGES_MAX = 32

export type WhichKehikko = { ok: true; id: number } | { ok: false; why: string }

/**
 * A page speaks twice, and the two claims do not have the same lifetime.
 *
 * The POST to `/host/open` is the page SAYING what it has open. It is the
 * page's own word, it is believed while it stands, and the page withdraws it on
 * the way out. Its weakness is the one this file has always admitted: a tab
 * that is killed never withdraws, and nothing here polls.
 *
 * The `/host/watch` stream is EVIDENCE that a screen exists. Nobody has to
 * remember to end it; it ends when the browser does. Its weakness is that a
 * page has many streams over its life — it reopens one whenever the open
 * kehikko changes — so a stream is not a page and must not be mistaken for one.
 *
 * Keying both by page is what went wrong, twice.
 *
 * Once because two streams overlap during a switch: the old one's cancel
 * arrives after the new one's start and deleted the live stream's report.
 *
 * And once because `pagehide` fires when macOS occludes a window for a
 * full-screen app, so the page withdrew for a screen that was still there —
 * with the stream still open and unable to say so, because the POST had taken
 * ownership of the entry.
 *
 * Both disappear if each claim is keyed by the thing that actually owns it: a
 * post by its page, a stream by its connection. Then a stream closing removes
 * exactly its own evidence and nothing else's, a page withdrawing removes
 * exactly its own word, and neither can silence the other. There is no token to
 * match and no last-writer-wins to reason about.
 *
 * What a page has open is then its most RECENT claim across the two, which is
 * what keeps a kehikko switch from briefly looking like two open kehikot: the
 * post lands first and the stream reopens a moment later, and at every instant
 * the newest claim is the right one.
 */
let connections = 0

/** A fresh identity for one stream, handed back when it closes. */
export function nextConnection(): string {
  connections += 1
  return `c${connections}`
}

interface Claim {
  page: string
  kehikko: number
  at: number
}

export class Openness {
  /** What each page last SAID, keyed by page. */
  #posts = new Map<string, Claim>()
  /** What each open stream is EVIDENCE of, keyed by connection. */
  #streams = new Map<string, Claim>()

  /**
   * One page saying what it has open, or that it has nothing open any more.
   *
   * `null` withdraws, and is believed: the page is the authority on its own
   * going away. It withdraws only the page's word — a stream that is still open
   * still says a screen is there, which is exactly the case `pagehide` on an
   * occluded window used to get wrong.
   */
  reported(page: string, kehikko: number | null, now = Date.now()): void {
    if (kehikko === null) {
      this.#posts.delete(page)
      return
    }
    this.#bound(this.#posts)
    this.#posts.set(page, { page, kehikko, at: now })
  }

  /** One stream, open, as evidence that a screen exists. */
  streamed(connection: string, page: string, kehikko: number, now = Date.now()): void {
    this.#bound(this.#streams)
    this.#streams.set(connection, { page, kehikko, at: now })
  }

  /**
   * One stream, closed.
   *
   * Its own evidence and nothing else's — which is the whole reason streams are
   * keyed by connection. A page that reopened its stream has two alive for a
   * moment, and the one that closes is not the one to believe.
   */
  closed(connection: string): void {
    this.#streams.delete(connection)
  }

  /* Neither map may grow without bound: both are keyed by a string that came
     off a request. The oldest goes, being the one least likely to be a screen
     somebody is looking at. */
  #bound(map: Map<string, Claim>): void {
    if (map.size < PAGES_MAX) return
    const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) map.delete(oldest[0])
  }

  /** Every kehikko a live page says it has open, without duplicates. */
  /**
   * Every kehikko a live page says it has open.
   *
   * The same list `open` refuses to collapse into a single answer, handed over
   * uncollapsed — and that is the point. A tool asking "which kehikko did you
   * mean" must not be given a guess between two screens. The lifecycle policy
   * is asking a different question, "which modules is anybody looking at", and
   * for that one two open kehikot are not an ambiguity; they are two.
   * See `server/lifecycle.ts`.
   */
  every(now = Date.now()): number[] {
    return this.#fresh(now)
  }

  /**
   * What each page has open, one answer per page, newest claim winning.
   *
   * Per PAGE and not per claim, because a page mid-switch holds a post for the
   * kehikko it moved to and a stream for the one it moved from, and counting
   * both would make one screen look like two — which `open` would then refuse
   * to answer for, having been told there was an ambiguity that does not exist.
   */
  #fresh(now: number): number[] {
    const newest = new Map<string, Claim>()
    const consider = (map: Map<string, Claim>) => {
      for (const [key, claim] of map) {
        if (now - claim.at > STALE_MS) {
          map.delete(key)
          continue
        }
        const held = newest.get(claim.page)
        if (!held || claim.at >= held.at) newest.set(claim.page, claim)
      }
    }
    consider(this.#posts)
    consider(this.#streams)

    const ids = new Set<number>()
    for (const claim of newest.values()) ids.add(claim.kehikko)
    return [...ids].sort((a, b) => a - b)
  }

  /**
   * Which kehikko a tool that named none should act on — or why it cannot say.
   *
   * The refusals are sentences rather than nulls because they are the whole
   * value of this: an agent that reads "two pages have two different kehikot
   * open, say which with kehikko: 3 or kehikko: 7" can act. An agent that reads
   * `null` guesses.
   */
  open(now = Date.now()): WhichKehikko {
    const ids = this.#fresh(now)
    if (ids.length === 1 && ids[0] !== undefined) return { ok: true, id: ids[0] }
    if (ids.length === 0) {
      return {
        ok: false,
        why:
          'no page of this host has said which kehikko it has open, so there is no "the open kehikko" to act on. '
          + 'Which kehikko is open lives in the browser tab and not on this server — if the canvas is not open in a '
          + 'browser, nothing knows. Name the one you mean with kehikko: <id>.',
      }
    }
    return {
      ok: false,
      why:
        `${ids.length} pages of this host have different kehikot open (${ids.join(', ')}), so "the open kehikko" `
        + 'names two screens and acting on either would change one somebody is looking at without saying so. '
        + 'Name the one you mean with kehikko: <id>.',
    }
  }
}
