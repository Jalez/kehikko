import type { ContentChange } from 'kehikot-module-protocol'

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
 * door — `create_epic` in `mcp.ts` — is a file in that project's `.kehikot/host/epics`,
 * which the page reads once per project switch and never again, so an agent's
 * new epic would not be in the dropdown until the person changed project and
 * came back. That is the sitting-still-and-watching case the essay above is
 * about, one more time.
 *
 * It carries the project rather than nothing because two windows can be
 * standing in two projects, and a page in the thesis folder re-reading its
 * epics because something happened in another project's would be a read for no
 * reason — cheap, and still a read the page cannot explain. The `registry`
 * kind carries nothing because there is one registry; there is not one project.
 *
 * Still not the news itself: not the epic, not its title. `/host/epics` is the
 * one reading, and a stream that shipped a summary would be a second, older one.
 *
 * ## The fourth kind, a project's dispositions
 *
 * `dispositions` names a project for `epics`' reason: a mark is kept per
 * project (see `server/dispositions.ts`), and a page standing somewhere else
 * has nothing to re-read. What it does on hearing it is fetch the marks and
 * re-send the context — `context.dispositions` is how every framed module,
 * and in particular one that `reacts` to `dispositions`, learns that somebody
 * has said why a ref closed. Still not the marks themselves, for the reason
 * above.
 */
export type News =
  /* `folded` rides on the first kind and is the one thing here that says WHO:
     see `FoldNote`. A page that does not know the field re-reads the kehikko,
     which is all the first kind ever asked of it. */
  | { kehikko: number; folded?: FoldNote }
  | { registry: true }
  | { epics: number }
  | { dispositions: number }
  /* The inbox of a project: what its modules said they are doing, or what a
     person did with it, is not what a page last read. Carries the project and
     the record's revision, so a page that already holds it need not ask; the
     page re-reads `/host/inbox`. */
  | { inbox: number; rev: number }
  /* The fifth kind: a project's tracker reading started or landed. Carries
     the signal itself — `context.tracker` is two small facts, and making every
     page fetch them back would be a round trip per page per read. */
  | { tracker: number; at: string | null; refreshing: boolean }
  /* The sixth kind: material kept for a project's epics changed. Carries the
     signal for `tracker`'s reason — `context.content` is a short list of who
     and when, and it is all a page would fetch. Never the material. */
  | { content: number; changes: ContentChange[] }
  /* The seventh kind, and the first that is not news: an ORDER, for one page.
     See `PressOrder`. */
  | { press: PressOrder }
  /* The ninth kind, an order like `press`: an agent's `open_address`, for the
     one page that has the kehikko open. See `AddressOrder`. */
  | { address: AddressOrder }
  /* The eighth kind: the list of projects is not what a page last read — a
     project was found again where its folder went ("Locate…", or adding the
     moved folder). Carries nothing; the page re-reads `/host/projects`. */
  | { projects: true }
  /* The tenth kind: an automatic module update began, ended or now waits for
     something (`autoUpdates.ts`). Carries nothing; the page re-reads
     `/host/updates` (without asking GitHub) and What's new. */
  | { updates: true }

/**
 * One item of a module's header to press, handed to the page that has the
 * module's frame.
 *
 * Everything else on this stream says "there is news, read it". This says
 * "do this", and it has to: an agent's `press_item` arrives at the server,
 * the module's frame is in a browser, and `kehikot.press` can only be posted
 * from the document that framed it. The fold note (`FoldNote`) was the first
 * thing here to carry more than an id, for the same shape of reason — the
 * server knows something the page cannot read anywhere — and this is the
 * same road taken one step further rather than a second connection beside it.
 *
 * It differs from every other kind in two ways, both deliberate:
 *
 *  - It goes to ONE page, the one named in `page`, and not to every listener.
 *    Two windows on the same kehikko would otherwise each press, and a
 *    compile would run twice. `Wakes.press` sends it only down that page's
 *    streams, and the page checks the name again before acting.
 *  - It is answered. The page posts what became of it to `/host/pressed`
 *    with `id`, and the tool call waits for that; see `server/headers.ts`.
 *
 * It carries no label and nothing the module wrote: an item id, and the
 * option or state wanted. The page looks the item up in what the frame
 * declared to IT, and judges the press there again.
 */
export interface PressOrder {
  /** The server's, unguessable, and what the page's answer is paired by. */
  id: string
  /** Which page is to press. See `pageId` in `src/host/canvases.ts`. */
  page: string
  kehikko: number
  module: string
  item: string
  value?: string | boolean
}

/**
 * A web address an agent asked to have shown (protocol 2.16.0), handed to the
 * page that has the kehikko open: `context.address` lives in that page, and
 * only it knows which of its containers show pages. Addressed and answered
 * like `PressOrder`, through `/host/pressed`. The page takes it only into a
 * container that shows pages, never out into the person's browser.
 */
export interface AddressOrder {
  id: string
  page: string
  kehikko: number
  url: string
  title?: string
}

/**
 * Who folded or unfolded which containers, when it was not the person.
 *
 * The arrangement says THAT a container is folded and the page reads that
 * where it reads everything else. What it cannot read anywhere is who did it,
 * because nothing stores that — on purpose: `kehikot.json` travels with the
 * project, and "an agent folded this" is a fact about one moment on one
 * screen, not about the arrangement. So it is said once, here, to the pages
 * that are open, and each marks the fold control with it until the person
 * presses it. See `src/host/folds.ts`.
 *
 * `by` is read in a sentence — "folded by an agent", "unfolded by Screenplay".
 */
export interface FoldNote {
  by: string
  fold: string[]
  unfold: string[]
}

/** A listener that has been handed one piece of news. */
type Woken = (news: News) => void

export class Wakes {
  #listeners = new Set<Woken>()
  /** Which page each stream said it is, for the one kind that is addressed. Absent for a stream that named none. */
  #pages = new Map<Woken, string>()

  /**
   * Start hearing about changed kehikot. Call what comes back to stop.
   *
   * `page` is who is listening, when the stream said — the same id a page
   * reports what it has open under. It is not a credential: it decides which
   * streams an order is written to, and nothing is trusted on the strength
   * of it.
   */
  listen(woken: Woken, page: string | null = null): () => void {
    this.#listeners.add(woken)
    if (page !== null) this.#pages.set(woken, page)
    return () => {
      this.#listeners.delete(woken)
      this.#pages.delete(woken)
    }
  }

  /** Whether a stream of this page is open right now — whether anything said to it would be heard. */
  hears(page: string): boolean {
    for (const listening of this.#pages.values()) if (listening === page) return true
    return false
  }

  /**
   * Hand one page a press to make. Answers whether any stream of that page
   * was written to; `false` is "that page is not listening", which the
   * caller says rather than waits out.
   *
   * Only that page's streams. Every other listener hears nothing at all —
   * not even that a press happened.
   */
  press(order: PressOrder): boolean {
    return this.#order(order.page, { press: order })
  }

  /** Hand one page an address an agent asked to have shown. The rule `press` keeps: that page's streams only. */
  address(order: AddressOrder): boolean {
    return this.#order(order.page, { address: order })
  }

  #order(to: string, news: News): boolean {
    let told = false
    for (const [listener, page] of [...this.#pages]) {
      if (page !== to) continue
      try {
        listener(news)
        told = true
      } catch {
        /* A closed stream; see `#tell`. */
      }
    }
    return told
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
   * Say that a kehikko changed because something other than the person folded
   * or unfolded containers on it, and who. One message, so the page re-reads
   * and signs the fold in the same breath.
   */
  folded(kehikko: number, note: FoldNote): void {
    this.#tell({ kehikko, folded: note })
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
   * Say that what the automatic module updates did or wait for changed: one
   * began, finished or failed, or one now waits to be off screen. Sent by
   * `AutoUpdates` only, never on a tick.
   */
  updatesChanged(): void {
    this.#tell({ updates: true })
  }

  /**
   * Say that the list of projects changed under the pages: a project was
   * pointed at the folder it moved to. Sent by the route that did it.
   */
  projectsChanged(): void {
    this.#tell({ projects: true })
  }

  /**
   * Say that a project's `.kehikot/host/epics` has a file in it that it did not have.
   *
   * Sent by whatever wrote the file — the route the page's `+` posts to and
   * the door's `create_epic` both do — and never by watching the directory.
   * A refresh rewrites `.kehikot/host/` under a running host, and a
   * watcher would have the page re-reading its epics on every one of those,
   * which is the tick-driven read this file refuses. What this host wrote,
   * this host says; what something else wrote is read on the next project
   * switch, as before.
   *
   * That is still true of the DROPDOWN. What an epic holds is another matter
   * and is watched — `ContentWatch` in `content.ts` says why, and what it does
   * about the objection above.
   */
  epicsChanged(project: number): void {
    this.#tell({ epics: project })
  }

  /**
   * Say that a project's dispositions are not what the pages last read.
   *
   * Sent by whatever wrote the file — a module's `disposition.set` relayed
   * through `/host/call`, or the door's `mark_disposition` — and only when the
   * file changed. A hand-edit is read on the next project switch, as epics are.
   */
  dispositionsChanged(project: number): void {
    this.#tell({ dispositions: project })
  }

  /**
   * Say that a project's inbox changed: a module's list was taken, a line was
   * kept, or a person saw, dismissed or forgot something. See `server/inbox.ts`.
   */
  inboxChanged(project: number, rev: number): void {
    this.#tell({ inbox: project, rev })
  }

  /**
   * Say that a project's shared tracker reading started a read, or landed one.
   *
   * Sent by the reader itself (`server/trackers/reading.ts`) and only then:
   * a person's "Refresh all", a module's `tracker.refresh`, the project's
   * schedule, or a module asking about a ref nobody had read. The page puts it
   * in `context.tracker`, and every module that `reacts` to `tracker` re-asks.
   */
  trackerChanged(project: number, signal: { at: string | null; refreshing: boolean }): void {
    this.#tell({ tracker: project, at: signal.at, refreshing: signal.refreshing })
  }

  /**
   * Say that the material kept for a project's epics changed: an epic the
   * host wrote, a module's report of its own write, or an edit to the
   * project's `.kehikot/` by something else. See `server/content.ts`. The
   * page puts the list in `context.content`, and every module that `reacts`
   * to `content` re-reads what it shows.
   */
  contentChanged(project: number, changes: ContentChange[]): void {
    this.#tell({ content: project, changes })
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
