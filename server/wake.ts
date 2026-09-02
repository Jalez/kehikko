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
 *
 * ## Why there are now two kinds of it, and why that is still one stream
 *
 * A kehikko changing underneath somebody is not the only thing that happens
 * while nobody moves the mouse. A module's server can die — and did: a terminal
 * whose process was gone while its container went on showing a green light,
 * because the page had stopped asking and nothing was left to tell it to start
 * again. See `watch` in `server.ts` for who notices and `toWatch` in
 * `lifecycle.ts` for which modules are worth noticing about.
 *
 * The second kind carries even less than the first: no id, no condition, no
 * list of what changed. Just `registry`, meaning "what is registered, or what
 * is answering, is not what you were last told — look again". Everything above
 * about the first kind applies to it unchanged, and applies harder: the page's
 * sweep is the one true reading of that, and a stream that shipped a condition
 * would be a second, older one.
 *
 * They share a stream because they share a purpose and a lifetime. The socket
 * is already open, it already ends exactly when the screen does, and a second
 * `EventSource` would be a second connection, a second reconnect policy, and a
 * second place for the evidence `open.ts` reads off this one to be
 * half-withdrawn.
 */

/**
 * What a page is told. Never the news itself — only that there is some.
 *
 * ## The third kind, and why it is an id after all
 *
 * `epics` names a PROJECT, by this machine's id for it. An epic created at the
 * door — `create_epic` in `mcp.ts` — is a file in that project's `data/epics`,
 * which the page reads once per project switch and never again, so an agent's
 * new epic would not be in the dropdown until the person changed project and
 * came back. That is the sitting-still-and-watching case the essay above is
 * about, one more time.
 *
 * It carries the project rather than nothing because two windows can be
 * standing in two projects, and a page in the thesis folder re-reading its
 * epics because something happened in the roadmap's would be a read for no
 * reason — cheap, and still a read the page cannot explain. The `registry`
 * kind carries nothing because there is one registry; there is not one project.
 *
 * Still not the news itself: not the epic, not its title. `/host/epics` is the
 * one reading, and a stream that shipped a summary would be a second, older one.
 */
export type News = { kehikko: number } | { registry: true } | { epics: number }

/** A listener that has been handed one piece of news. */
type Woken = (news: News) => void

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
    this.#tell({ kehikko })
  }

  /**
   * Say that what is registered, or what is answering, is no longer what the
   * pages were last told.
   *
   * Only ever sent because the host FOUND SOMETHING OUT — a module that was
   * answering and is not, or one that was not and now is. Never on a tick that
   * merely elapsed. That restraint is the whole design: a page told on every
   * tick would sweep on every tick, and the interval this exists to avoid would
   * have moved into a different process rather than gone away.
   */
  registryChanged(): void {
    this.#tell({ registry: true })
  }

  /**
   * Say that a project's `data/epics` has a file in it that it did not have.
   *
   * Sent by whatever wrote the file — the route the page's `+` posts to and
   * the door's `create_epic` both do — and never by watching the directory.
   * The roadmap rewrites `data/` under a running host on every refresh, and a
   * watcher would have the page re-reading its epics on every one of those,
   * which is the tick-driven read this file refuses. What this host wrote,
   * this host says; what something else wrote is read on the next project
   * switch, as before.
   */
  epicsChanged(project: number): void {
    this.#tell({ epics: project })
  }

  #tell(news: News): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(news)
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
