/**
 * Telling the page that something other than the page changed a kehikko.
 *
 * ## Why the sweep-on-focus mechanism does not fit
 *
 * `App.tsx` re-reads the registry when the tab is focused, and deliberately at
 * no other time: a sweep is N requests to N localhost programs, and paying for
 * it while nobody is looking is paying for nothing.
 *
 * That rule is exactly wrong for this. The case an agent's tool call exists for
 * is somebody watching the canvas while an agent works — the tab is focused
 * and STAYS focused, no event fires, and the page shows a selection that is no
 * longer true until the person happens to alt-tab away and back. The one moment
 * the existing mechanism cannot catch is the only moment this needs.
 *
 * ## So the server says so, and the page listens
 *
 * One `text/event-stream`, opened by the page for as long as it is open, over
 * which the server sends the id of a kehikko that has just been changed by
 * something that was not that page. The page re-reads the kehikot and shows
 * what is there.
 *
 * Server-sent events rather than a poll, for the reason above: a page asking
 * every two seconds whether anything happened is the request-per-tick this host
 * has refused everywhere else, and it would have to be fast enough to look
 * instant, which makes it worse. Rather than a socket, because nothing here is
 * bidirectional — the page already has HTTP for everything it says.
 *
 * ## What is on the stream, which is as little as possible
 *
 * An id and nothing else. Not the kehikko, not the placements, not what
 * changed. The page has a perfectly good way to read a kehikko and this stream
 * would otherwise become a second one — with its own shape to keep in step, its
 * own validation, and the ability to be subtly out of date. What is being sent
 * is not the news; it is that there IS news.
 */

/** A listener that has been handed one kehikko id. */
type Woken = (kehikko: number) => void

export class Wakes {
  #listeners = new Set<Woken>()

  /** Start hearing about changed kehikot. Call what comes back to stop. */
  listen(woken: Woken): () => void {
    this.#listeners.add(woken)
    return () => {
      this.#listeners.delete(woken)
    }
  }

  /**
   * Say that a kehikko has changed under somebody.
   *
   * Every listener is told, including the page that is not looking at that
   * kehikko — deciding here which pages care would mean this file knowing what
   * each page has open, which is `open.ts`'s business and is a claim that can be
   * stale. A page that hears about a kehikko it does not have open does
   * nothing, cheaply.
   *
   * A listener that throws does not stop the others. These are writes into
   * sockets and a socket closes whenever a browser feels like it; one dead tab
   * must not swallow the news for a live one.
   */
  woke(kehikko: number): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(kehikko)
      } catch {
        /* A closed stream. It will be removed when its own cleanup runs. */
      }
    }
  }

  /** How many streams are open. For tests, and for saying so at startup. */
  get watching(): number {
    return this.#listeners.size
  }
}
