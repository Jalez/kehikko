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
 * Which connection a report came from, so a stale withdrawal can be refused.
 *
 * Reports are keyed by PAGE, deliberately — a reload replacing its own report
 * rather than adding a second one is the whole reason for that. But a page has
 * more than one connection over its life: it reopens `/host/watch` whenever the
 * open kehikko changes, and for a moment the old stream and the new one both
 * exist under the same page id.
 *
 * The old stream's cancel then arrives AFTER the new stream's start and deletes
 * the LIVE stream's report. Nothing errors. The page is still on screen, still
 * streaming, still showing its modules — and the server now believes nobody has
 * anything open, so five minutes later the lifecycle policy stops every module
 * the host started for a canvas somebody is looking at.
 *
 * A token per connection is enough to tell those apart. Whoever wrote last owns
 * the entry, and a cancel that no longer matches is a cancel for a connection
 * that has already been replaced: it has nothing left to withdraw.
 */
let connections = 0

/** A fresh identity for one stream, to be handed back when it closes. */
export function nextConnection(): string {
  connections += 1
  return `c${connections}`
}

export class Openness {
  #reports = new Map<string, { kehikko: number; at: number; by: string | null }>()

  /**
   * One page saying what it has open, or that it has nothing open any more.
   *
   * `null` withdraws. A page sends it on the way out, so that closing a tab
   * stops it answering for a screen that is not there — which is the difference
   * between this and a cache.
   *
   * `by` names the connection the report came from, when there is one. A report
   * with no connection — the `/host/open` POST — deliberately clears it: the
   * page has spoken more recently than any stream, and a stream that closes
   * afterwards must not undo what the page just said.
   */
  reported(page: string, kehikko: number | null, now = Date.now(), by: string | null = null): void {
    if (kehikko === null) {
      this.#reports.delete(page)
      return
    }
    /* Not an unbounded map keyed by whatever a caller put in the field. The
       oldest report goes, which is the one least likely to be a tab somebody is
       looking at. */
    if (!this.#reports.has(page) && this.#reports.size >= PAGES_MAX) {
      const oldest = [...this.#reports.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) this.#reports.delete(oldest[0])
    }
    this.#reports.set(page, { kehikko, at: now, by })
  }

  /**
   * One STREAM saying it has closed.
   *
   * Refused unless the report is still the one this connection wrote. See the
   * essay above `nextConnection`: a page that reopened its stream has two of
   * them alive for a moment, and the one that closes is not always the one
   * holding the report.
   *
   * Not the same act as `reported(page, null)`, which is a page saying it is
   * going away and is believed unconditionally — the page is the authority on
   * that, and a connection is only ever evidence.
   */
  withdrew(page: string, by: string): void {
    const held = this.#reports.get(page)
    if (!held) return
    if (held.by !== by) return
    this.#reports.delete(page)
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

  #fresh(now: number): number[] {
    const ids = new Set<number>()
    for (const [page, report] of this.#reports) {
      if (now - report.at > STALE_MS) {
        this.#reports.delete(page)
        continue
      }
      ids.add(report.kehikko)
    }
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
