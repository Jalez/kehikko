import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ContentChange } from 'kehikot-module-protocol'
import {
  chooseOpen,
  editCanvas,
  fetchCanvases,
  readOpen,
  reportOpen,
  watchCanvases,
  writeOpen,
  type AddressOrder,
  type Canvas,
  type JumpOrder,
  type Placement,
  type PressOrder,
} from '@/host/canvases.ts'
import type { ArrangeNote } from '@/host/arrange.ts'
import { forgetRead, hostRead } from '@/host/hostRead.ts'
import { reread, type FoldNote } from '@/host/folds.ts'
import { arrive } from '@/host/looks.ts'
import { chooseProject, fetchEpics, readOpenProject, writeOpenProject, type Epics as HeldEpics, type Project } from '@/host/projects.ts'
import type { RegistryView } from '@/host/registry.ts'
import type { Subjects } from '@/host/subject.ts'
import { Writer } from '@/host/writer.ts'

export interface CanvasInputs {
  openId: number | null
  projectId: number | null
  setCanvases: Dispatch<SetStateAction<Canvas[]>>
  setSubjects: Dispatch<SetStateAction<Subjects>>
  setProjects: Dispatch<SetStateAction<Project[]>>
  setProjectId: Dispatch<SetStateAction<number | null>>
  /** The page's own `setOpenId`, which looks at the kehikko being left before it goes. */
  setOpenId: (next: number | null) => void
  setTrouble: Dispatch<SetStateAction<string | null>>
  setAskedFor: Dispatch<SetStateAction<number | null>>
  setHeld: Dispatch<SetStateAction<HeldEpics | null>>
  /* What the stream hands this page to do, assigned where the page can do it. */
  orderedRef: MutableRefObject<((order: PressOrder) => void) | null>
  addressedRef: MutableRefObject<((order: AddressOrder) => void) | null>
  jumpedRef: MutableRefObject<((order: JumpOrder) => void) | null>
  repostRef: MutableRefObject<(() => void) | null>
  inboxWokeRef: MutableRefObject<((project: number, rev: number | null) => void) | null>
  relistRef: MutableRefObject<(() => Promise<void>) | null>
  /**
   * What the page declares further down — the sweep, the reading taken, the open project, the
   * agent marks and the tracker reading — each read when it is called, as the effects read
   * them when they lived in `App.tsx` (`lookRef`'s arrangement).
   */
  later: {
    look: () => Promise<void> | undefined
    take: (reading: RegistryView) => void
    projectNow: () => number | null
    noteFold: (kehikko: number, note: FoldNote) => void
    noteArranged: (kehikko: number, note: ArrangeNote) => void
    heard: {
      marked: (project: number) => void
      read: (project: number, signal: { at: string | null; refreshing: boolean }) => void
      rewritten: (project: number, changes: ContentChange[]) => void
    }
  }
}

/**
 * The kehikot, from the server and back to it: the first read, the writes
 * (`Writer`), which kehikko and project this browser has open, the report of
 * it to the server and the sweep that follows, and the stream of news that
 * says something changed elsewhere.
 *
 * Moved out of `App.tsx` as it was, and called where it stood among the page's
 * effects, so they run in the same order: the flush on `pagehide`, the first
 * read, the open kehikko remembered, reported and swept, the stream, the open
 * project remembered. The state they write is the page's and stays there.
 *
 * Where the comments below say `lookRef`, `takeRef` or `projectRef`, those are
 * the page's refs, reached here through `later` and read at the moment of the
 * call exactly as before.
 */
export function useCanvases({
  openId,
  projectId,
  setCanvases,
  setSubjects,
  setProjects,
  setProjectId,
  setOpenId,
  setTrouble,
  setAskedFor,
  setHeld,
  orderedRef,
  addressedRef,
  jumpedRef,
  repostRef,
  inboxWokeRef,
  relistRef,
  later,
}: CanvasInputs) {
  /* Whether the canvases have been read from the server yet. Nothing is written
     before they have been, or the first render would save an empty canvas over
     a person's arrangement. */
  const loaded = useRef(false)
  /* The same, as state: what waits for the canvases' first read — the report of what is open and
     the stream — so a load says it once, about the kehikko it opens, and not first about none. */
  const [settled, setSettled] = useState(false)
  /* Whether this browser has never opened this host — see the effect below. */
  const firstVisit = useRef(false)

  const writer = useMemo(() => new Writer(editCanvas, setTrouble), [])
  /* A page being closed mid-drag still has an unsent arrangement. This is the
     one place where "send it now" is worth more than "send it once". */
  useEffect(() => {
    const flush = () => writer.flushAll()
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [writer])

  /* The canvases, once, before anything is drawn. */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        /* Read before the request, because the server wants it: on the first
           load after the epic moved off the kehikot, the kehikko this browser
           was last on is the best answer to "which epic was this project on".
           See `hintSubject` in `server/canvases.ts`. */
        const remembered = readOpen(window.localStorage)
        /* Joined: StrictMode runs this twice in development, and one read serves both. */
        const found = await hostRead('canvases:first', () => fetchCanvases(undefined, remembered), { keep: false })
        if (cancelled) return
        firstVisit.current = remembered === null
        const project = chooseProject(found.projects, readOpenProject(window.localStorage))
        setProjects(found.projects)
        setProjectId(project)
        setCanvases(found.canvases)
        setSubjects(found.subjects)
        /* Within the project, and only within it. A remembered kehikko that
           belongs to another project is not the one to open: the switcher
           beside it would not list it, and a canvas its own switcher cannot see
           is one nobody can get back to. */
        setOpenId(chooseOpen(found.canvases, remembered, project))
        loaded.current = true
        setSettled(true)
        /* A project's `kehikot.json` that would not read. Said in the header's error line,
           where the host's own line is, because the person who edited that
           file is the person looking at this page, and it stays until a load
           finds the file reads again. See `server/kehikot.ts`. */
        if (found.trouble.length) setTrouble(found.trouble.join(' '))
      } catch (error) {
        if (cancelled) return
        setSettled(true)
        setTrouble(
          `Your kehikot could not be read: ${(error as Error).message}. Reload the window to try again.`,
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* Which canvas is open, remembered per browser rather than per person. See
     `canvases.ts` for why this one fact is not on the server with the rest. */
  useEffect(() => {
    if (openId !== null) writeOpen(window.localStorage, openId)
  }, [openId])

  /**
   * And said out loud to the server, which is not the same as storing it there.
   *
   * The paragraph above is still true: which kehikko is open belongs to this
   * tab, and a server that STORED it would make two windows fight over it. What
   * the server keeps is a report, per page, in memory, withdrawn when this page
   * goes away — and the only thing that reads it is the host's own MCP door,
   * which has to answer "which kehikko did you mean" for an agent that named
   * none. Two pages reporting two kehikot is not a fight; it is a refusal with
   * both ids in it. See `server/open.ts`.
   *
   * Withdrawn on `pagehide` rather than only on unmount, because a tab being
   * closed does not unmount anything — and a report left standing by a browser
   * that is no longer running would have an agent told a kehikko is on somebody's
   * screen when there is no screen.
   *
   * The report is followed by a sweep, and the ORDER is the whole of that. The
   * server now decides which modules to have running from what pages say they
   * have open — see `server/lifecycle.ts` — so a sweep sent before the report
   * is a sweep asking about a kehikko the server has not heard of yet. The two
   * requests are otherwise unordered, so they are ordered here rather than
   * hoped about. Switching kehikko is exactly the moment "which modules matter"
   * changes, which makes it exactly the moment worth asking again — the same
   * argument the sweep-on-focus below makes, about a different act of attention.
   *
   * `lookRef` rather than `look` itself, because `look` is declared further down
   * and this effect is where the report belongs. What is wanted is "whatever
   * looking means right now", which is what a ref holds and a stale closure
   * does not.
   */
  useEffect(() => {
    if (!settled) return
    let here = true
    /* On arriving, and on nothing else: not focus, not visibility, not a
       frame. See `arrive`. */
    void arrive(openId, async () => {
      if (here) await later.look()
    }).then(() => {
      /* The server has now been asked knowing what this page has open. Until
         then a module that is not running may only be one it has not been
         asked to start — see `asked` in `host/standing.ts`. */
      if (here) setAskedFor(openId)
    })
    const gone = () => void reportOpen(null)
    window.addEventListener('pagehide', gone)

    /*
     * And said AGAIN whenever this page comes back.
     *
     * `pagehide` withdraws unconditionally, which is right for a tab that is
     * closing — the page is the authority on its own going away. But macOS does
     * not fire it only for that. Switching to a full-screen app occludes this
     * window, the webview hides the page, and the report is withdrawn for a
     * screen that still exists and is still showing its containers. Nothing
     * restored it: `openId` had not changed, so this effect never re-ran.
     *
     * What that cost is the whole of `server/lifecycle.ts`. The host decides
     * which modules to keep running from these reports, so a withdrawn report
     * makes every container on the canvas unneeded, and five minutes later
     * everything the host started is stopped — while somebody is looking at it.
     * The only modules that survived were the ones the host cannot stop because
     * it did not start them, which made it look like one module was special
     * rather than like the report was gone.
     *
     * Re-asserting is one POST on the same events the sweep below uses, and
     * deliberately NOT behind that sweep's quiet floor. A sweep is N requests to
     * N programs and is worth rate-limiting; this is one request that decides
     * whether those programs keep running at all, and a saved request that
     * stops a module somebody is looking at is not a saving.
     */
    const back = () => {
      if (document.visibilityState !== 'visible') return
      void reportOpen(openId)
    }
    window.addEventListener('pageshow', back)
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)

    return () => {
      here = false
      window.removeEventListener('pagehide', gone)
      window.removeEventListener('pageshow', back)
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [openId, settled])

  /**
   * Something other than this page changed a kehikko: read it again.
   *
   * The sweep-on-focus below is deliberately tied to attention, and that is
   * exactly why it cannot serve here. An agent selecting containers through the
   * host's MCP door does it while somebody WATCHES — the tab is focused the
   * whole time, no `focus` or `visibilitychange` ever fires, and the ring on the
   * container would appear whenever the person next happened to alt-tab away and
   * back. The one moment that mechanism cannot catch is the only moment this
   * needs, so it gets its own path: see `server/wake.ts`.
   *
   * Everything is re-read rather than the one kehikko patched, and pending
   * writes are flushed first. The flush is the ordering that matters: an
   * arrangement still sitting in the `Writer` would be sent AFTER this re-read
   * and would overwrite it with what the page thought a moment ago, which is
   * the tool call being silently undone half a second later.
   *
   * ## The second callback: a module died while somebody was watching it
   *
   * The paragraph above turns out to describe a whole family of faults rather
   * than one, and this is the second member of it. A module's server can go
   * away — a crash, a stray kill, a terminal closed — and every mechanism this
   * page has for finding that out is tied to an act of attention that does not
   * happen: the person is already looking. Focus never fires, nothing is
   * `starting`, and the container kept its green light while the module's own
   * page inside the frame said the connection had ended. The host and the frame
   * disagreeing about the same program is the exact shape this workspace keeps
   * having to fix.
   *
   * The answer is the same one `wake.ts` already is: the half that CAN notice
   * says so, and this page sweeps when told. Nothing here polls. The host asks
   * about the containers on the open kehikko and nothing else — see
   * `WATCH_EVERY_MS` in `server/lifecycle.ts` for why that is a check rather
   * than a heartbeat — and sends this only when an answer came back different.
   * The container then draws whatever it already draws for a module that is not
   * answering: `silent`, or `starting` if the host has just run it again.
   *
   * Through `lookRef` rather than `look` itself, so that this effect does not
   * list the sweep among its dependencies. What is wanted is "whatever looking
   * means right now", and a dependency here would mean tearing down and
   * reopening the SSE connection — and with it the report `open.ts` reads off
   * it — for a reason that has nothing to do with what this page has open.
   */
  useEffect(() => {
    if (!settled) return
    const stop = watchCanvases(openId, {
      woke: (kehikko, note, arrangedNote) => {
        void (async () => {
          if (!loaded.current) return
          /* Awaited: the re-read has to be of what the pending writes LEFT. Two
             requests sent one after the other are not two requests answered in
             that order, and a re-read that overtook the write would put the
             older arrangement on screen over the one just stored. */
          const saved = writer.pending(kehikko)
          await writer.flushAll()
          const before = writer.stamp()
          try {
            const found = await fetchCanvases()
            /* What the person changed while that read was out is not in it, and
               is on its way to the server as a whole arrangement — or has
               already arrived there, after the read was taken. Their kehikko
               is left as they have it, so that what is on screen and what is
               about to be stored are the same thing: their press wins, and is
               not briefly undone in front of them. A fold from the door that
               their arrangement crossed is put onto it — see `reread`. */
            const theirs = new Set(
              found.canvases.filter((c) => writer.edits(c.id) !== (before.get(c.id) ?? 0)).map((c) => c.id),
            )
            setCanvases((was) => {
              const next = reread<Placement, Canvas>(was, found.canvases, theirs, note ? { kehikko, note, saved } : null)
              /* A write from inside an updater, as the first-visit fill below
                 does it: merged per kehikko, so being run twice is one write. */
              if (next.write) writer.write(next.write.kehikko, { placements: next.write.placements })
              return next.canvases
            })
            setSubjects(found.subjects)
            /* Signed in the same breath as the arrangement it is about, so the
               fold and who made it are drawn together. Only for the kehikko on
               this screen: a mark is about what somebody watched happen. */
            if (note && kehikko === openId) later.noteFold(kehikko, note)
            /* An agent's arrangement, marked with Undo. If the person's own change crossed it, theirs
               is what stands, and the mark does not (`arrangeStands`, below). */
            if (arrangedNote && kehikko === openId) later.noteArranged(kehikko, arrangedNote)
          } catch {
            /* The next wake, or the next load, will do. A canvas that could not
               be re-read is the arrangement the person already has on screen. */
          }
        })()
      },
      /* With the reading, when the host sent it with the news: taken, not asked for again. */
      looked: (reading) => (reading ? later.take(reading) : void later.look()),
      /* A project's epics changed — an agent's `create_epic`, or a `+` in
         another window. Re-read only when it is THIS page's project: the
         dropdown of a page standing in the thesis folder has nothing to learn
         from an epic made in another project's. Through `projectRef`, for the
         reason `lookRef` is a ref: the stream must not be reopened because the
         open project changed. `held` is not cleared first, as `onRetitleEpic`
         explains — the list stays until the new one lands. */
      wrote: (project) => {
        if (project !== later.projectNow()) return
        void (async () => {
          try {
            setHeld(await fetchEpics(project))
          } catch {
            /* The list the page has is the list it had. Nothing was lost. */
          }
        })()
      },
      /* A mark changed — a module's press, or an agent at the door — and the
         project's tracker reading started or landed a read: `useTrackerReading`
         re-reads, for `epics`' reason only when it is this page's project. */
      marked: (project) => later.heard.marked(project),
      read: (project, signal) => later.heard.read(project, signal),
      /* Material kept for the project's epics changed — the host's own write,
         a module's report, or an edit to the project's files. The list came
         with the news and goes straight into the context. */
      rewritten: (project, changes) => {
        later.heard.rewritten(project, changes)
        if (project !== later.projectNow()) return
        /* And the list of epics is read again, because the parts of an epic
           are read off it — the list in the epic's own file, and for each
           part what the modules hold. Somebody who has just added a part, or
           tied a chapter to one in a module, is looking at the bar to see it
           arrive. On a change from ANY source, not only the host's: what a
           module holds for a part is published from that module's own folder
           (`parts.json`), and its change is the only news of it there is. The
           read is a few small local files, and a list that says what the last
           one said is kept as the same object, so nothing downstream moves. */
        void (async () => {
          try {
            const found = await fetchEpics(project)
            if (project === later.projectNow()) setHeld((was) => (was && JSON.stringify(was) === JSON.stringify(found) ? was : found))
          } catch {
            /* The list the page has is the list it had. */
          }
        })()
      },
      /* An agent's `press_item`, handed to this page to make. */
      ordered: (order) => orderedRef.current?.(order),
      /* The stream opened, or reopened after the server went away: say again
         what the modules here have declared — and, on a reopening, which
         kehikko this page has open. The stream's own url says it too, but a
         server that restarted has also forgotten the page's word, and the
         word is what outlives a stream that drops again. */
      opened: (again) => {
        /* The first opening follows the page's own reads and reports by a moment, and a server
           that has not restarted still holds them: only a reopening says them again. */
        if (!again) return
        /* A host that restarted may be another version. */
        forgetRead('health')
        void reportOpen(openId, { again: true })
        repostRef.current?.()
        inboxWokeRef.current?.(-1, null)
      },
      inboxed: (project, rev) => inboxWokeRef.current?.(project, rev),
      /* A project was found again where its folder went, in this window or
         another: the list, and the kehikot read from the file where it is now. */
      relisted: () => void relistRef.current?.(),
      /* An agent's `open_address`, handed to this page to show. */
      addressed: (order) => addressedRef.current?.(order),
      /* An agent's `jump`, handed to this page, the one on screen. */
      jumped: (order) => jumpedRef.current?.(order),
    })
    return stop
    /* `openId` too, so the stream is reopened when the open kehikko changes.
       The stream's URL carries what this page has open — see `watchCanvases` —
       and a socket left open on a stale kehikko would tell the server the wrong
       thing for as long as it lived. Reopening it costs one request. */
  }, [writer, openId, settled])

  /* Which project is open, remembered the same way and for the same reason: two
     windows on two screens showing two projects is a reasonable thing to do,
     and a server storing "the current project" would make them fight over it. */
  useEffect(() => {
    if (projectId !== null) writeOpenProject(window.localStorage, projectId)
  }, [projectId])

  return { loaded, firstVisit, writer }
}
