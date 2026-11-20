import { CloudDownload, ScrollText } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type Dispatch, type ReactNode } from 'react'
import { Loading } from '@/components/ui/loading.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

import { Button } from '@/components/ui/button.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { AUTO_UPDATES, changelogLabel, doneSaid, type AutoTold } from '@/host/autoUpdates.ts'
import { cn } from '@/lib/utils'
import { isGitReason } from '@/host/gitSaid.ts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import {
  ago,
  applyUpdate,
  cancelUpdate,
  armRestartAnyway,
  askedModule,
  confirmRestartAnyway,
  fetchUpdates,
  hasUpdate,
  isCheckout,
  LeftRunning,
  offersAppRestart,
  onUpdatesChanged,
  OPEN_UPDATES,
  postAutoUpdates,
  requestRestart,
  restartModule,
  type Checkout,
  type NotRestarted,
  type Outcome,
  type Preview,
  type Reading,
} from '@/host/updates.ts'
import { derive, idsToUpdate, initialState, outcomeOf, updatesReducer, type EngineAction, type Next } from '@/host/updatesEngine.ts'
import { watchApp, type AppEngine, type AppUpdateStatus } from '@/host/appUpdate.ts'
import { openModuleList } from '@/host/moduleList.ts'
import { askRestart, heldSaid, onRestartChanged, restartNow, restartState, type HeldRestart } from '@/host/restartQueue.ts'
import {
  appNotes,
  moduleRow,
  previewText,
  restartNowWord,
  RESTART_ANYWAY_ARMED,
  RESTART_THE_HOST,
  RESTART_TO_UPDATE,
  ON_FOCUS_AFTER_MS,
  shouldCheckOnOpen,
  stateText,
  type UpdateRow,
} from '@/host/updateModel.ts'
import { GitSaid } from './GitSaid.tsx'
import { CompatBadgeView, UpdateSummaries, useAppTags } from './UpdateSummaries.tsx'
import { compatBadge, summaryTags } from '@/host/updateSummaries.ts'
import { Hint } from './Hint.tsx'
import { KehikkoMark } from './Mark.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'
import { MovedNotesDialog, NotesButton, useModuleNotes, useReleaseNotes } from './ReleaseNotes.tsx'
import { APP_NAME, APP_REPO, tagFor } from '@/host/releaseNotes.ts'
import { needsNewerSaid, needsNewerTip, releaseInView, releaseSaid, stepBackAsked, worksSaid, type ModuleRelease } from '@/host/moduleReleases.ts'
import { openWhatsNew, pokeWhatsNew, readInUpdates } from '@/host/whatsNew.ts'
import type { JobSaid } from '@/host/jobSteps.ts'
import { StepList, StepProgress, useJobSteps } from './StepProgress.tsx'

/**
 * One update system: the desktop app itself and every module, in one menu and
 * one header indicator.
 *
 * ## The app and the modules, together
 *
 * Inside the desktop app the shell's updater (kehikko-desktop#8) checks,
 * downloads and verifies new versions of the app on its own; this page is its
 * only UI (`host/appUpdate.ts`). Its status and the module checkouts are read
 * into the same rows with the same states (`host/updateModel.ts`), so the menu
 * lists "Kehikot app" first and then the modules, "Check now" checks both, and
 * the header shows one line about all of it — "Downloading Kehikot 0.1.2 · 45%",
 * "Restart to update", "3 updates" — or only the quiet icon when there is
 * nothing to say. Outside the app (a browser tab, a dev host) there is no app
 * row at all. The app row moves live from the shell's push; the module rows
 * move with the checks below.
 *
 * ## Who restarts what
 *
 * Updating a module restarts it when that is needed, as part of the update:
 * the server decides from what changed (`server/restart.ts`) and does it, and
 * the row moves through "Updating…", "Installing what changed…" and
 * "Restarting…" to "Updated and restarted". No row asks for a restart
 * of a module. "Restart to update" is the desktop app's own update and nothing
 * else; the host's own checkout, which only a development host has, says
 * "Restart the host".
 *
 * Nothing about that is kept only in this page. An update still running and a
 * module the host could not restart both come back from the server with every
 * check (`Check.progress`, `Check.stale`), so a reload mid-update shows the
 * same row.
 *
 * ## A module that is kept
 *
 * A module whose registration says `keep` is never stopped by the host on its
 * own, so its restart is refused and its row says so. That row has a second
 * button, "Restart anyway", and it takes two presses (the arm `Clearing.tsx`
 * argues for, and for its reasons: no modal, no browser dialog). The first
 * asks the server what it would stop; the row then says that, and what ends
 * with it, in the server's words. The second, on the same button, does it.
 * An arm left alone comes down by itself after `DISARM_ANYWAY_AFTER_MS`, and
 * when the panel closes. `server/anyway.ts` has the rest.
 *
 * ## Whether what this app runs is behind GitHub, and catching it up
 *
 * An installed module runs its releases (`server/moduleReleases.ts`), so its
 * row says releases, not commits: "Journeys 1.5.0 → 1.6.0", "up to date ·
 * 1.6.0", "following main · no releases yet" (no release yet: it follows
 * `main` and its row counts commits as before) or "running main ahead of
 * 1.6.0". "What's new" beside it opens the notes of every release since the
 * one it runs, newest first (`ModuleNotesDialog`). Update moves it to the
 * newer release, with the same restart rules as a fast-forward.
 *
 * ## Two ways a check happens
 *
 * Quietly, in the background: shortly after the page loads, every half hour,
 * and when the window comes back into focus after ten minutes away. A quiet
 * check only moves the dot on the button and the time in its tooltip.
 *
 * Out loud, when the menu opens on a check older than ten minutes, or on
 * "Check now": the panel checks at once, with the kehikko mark drawing itself while it
 * waits, and then shows — in the same panel, which never gives way to a second
 * one — what is behind and what can be done about it. Everything slow in it —
 * the check and each update — can be cancelled, and Cancel closes the request,
 * which stops the git the server was running for it. `server/updates.ts` says
 * what a cancel can and cannot undo. Closing the panel cancels a check, but never an
 * update: the server runs that to its end, the header chip says "Updating…"
 * and the reopened panel shows it. Cancel (`POST /host/updates/cancel`) is the only way to stop one.
 *
 * ## What the panel lists
 *
 * Only what needs a person (`needsAttention` in `host/updates.ts`): behind,
 * unreadable, unreachable, or just acted on. The level rest is one quiet line,
 * "N others up to date", which can be opened; and when nothing needs anyone the
 * panel says so in one calm sentence instead of a list of fifteen "up to date"s.
 *
 * ## What the tooltip says
 *
 * When the last check was, because "is this up to date" is only as good as
 * when somebody last looked — and what it found.
 */

const BACKGROUND_EVERY_MS = 30 * 60_000
const FIRST_CHECK_AFTER_MS = 5_000
/**
 * How long the mark takes to draw itself once — the last strut starts at 1.8s
 * and draws for 0.4s (`.strut` in `index.css`). A result that arrives sooner
 * waits for it, so a fast check is a finished cube and not a flicker of half
 * of one. Cancel does not wait.
 */
export const MARK_DRAWN_MS = 2_300

/** Resolves once the mark has drawn since `since`, or at once on a cancel. */
function drawn(since: number, signal: AbortSignal, markMs: number): Promise<void> {
  const left = markMs - (Date.now() - since)
  if (left <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, left)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** How many of an "Update all" this page runs at once. The server takes its own turns as well (`server/jobSteps.ts`). */
export const UPDATES_AT_ONCE = 2

/**
 * How long an armed "Restart anyway" stays armed in the page. Longer than the
 * four seconds a clear gets (`Clearing.tsx`): that one arms a label, and this
 * one a sentence somebody has to read first. The server holds its side for
 * longer still (`ARMED_FOR_MS`), so a press inside this is never late there.
 */
export const DISARM_ANYWAY_AFTER_MS = 10_000

/** How often a page that finds an update already running asks whether it has finished. */
const PROGRESS_EVERY_MS = 2_000

/** The release-notes dialogs the engine opens: the app's, a module's "What's new", and what an automatic update moved through. */
function useNotesDialogs() {
  const notes = useReleaseNotes()
  /* A module's "What's new": every release since the one it runs. */
  const moduleNotes = useModuleNotes()
  /* "Updated automatically" › changelog: what one update moved through. */
  const [moved, setMoved] = useState<{ one: AutoTold['updated'][number]; repo: string | null; opener: HTMLElement } | null>(null)
  const [movedOpen, setMovedOpen] = useState(false)
  useEffect(() => {
    if (moved) setMovedOpen(true)
  }, [moved])
  const notesOpen = notes.open || moduleNotes.open || movedOpen
  const showModuleNotes = (id: string, name: string, release: ModuleRelease, opener: HTMLElement) => {
    if (release.repo && release.notes.length) {
      /* Read here, they need not be told again after the update: "What's new" leaves them out. */
      readInUpdates(id, release.installed, release.notes[0]!)
      const works = Object.fromEntries(
        release.notes.flatMap((tag) => {
          const said = worksSaid(release, tag)
          return said ? [[tag, said]] : []
        }),
      )
      moduleNotes.show({ repo: release.repo, name, tags: release.notes, works, opener })
    }
  }
  return { notes, moduleNotes, moved, setMoved, movedOpen, setMovedOpen, notesOpen, showModuleNotes }
}

/**
 * The desktop app's updater: the shell's push, "Restart to update" and the
 * work queue that may hold it (`restartQueue.ts`). Its status goes to the
 * engine's state; `engine` is null outside the app.
 */
function useAppUpdater(dispatch: Dispatch<EngineAction>, version: string | null) {
  /** The desktop app's updater commands. Null outside the app. */
  const engine = useRef<AppEngine | null>(null)
  const tookApp = useCallback((status: AppUpdateStatus | null) => {
    if (status) dispatch({ type: 'appStatus', status })
  }, [dispatch])

  /* Listen to the shell's push, and ask once now — which is also what tells
     the shell this page draws updates, so it keeps its own alert to itself. */
  useEffect(() => {
    const link = watchApp(tookApp)
    engine.current = link.engine
    return () => link.stop()
  }, [tookApp])

  const installNow = () => {
    const link = engine.current
    if (!link) return
    /* The shell pushes `installing` and then relaunches; say so meanwhile. */
    dispatch({ type: 'appInstalling' })
    void link.apply()
  }

  /* "Restart to update": the host asks the work queue to hold it behind queued runs first; not held, it goes now. */
  const applyApp = () => {
    if (!engine.current) return
    void askRestart(version).then((asked) => {
      if (asked.held) dispatch({ type: 'held', held: asked.restart })
      else installNow()
    })
  }

  /* Restart now, past the hold. */
  const restartPastHold = () => {
    dispatch({ type: 'held', held: null })
    void restartNow(version).then(installNow)
  }

  /* The queue let it go, or it was cancelled there: read what is held, and apply an update it let go. */
  useEffect(() => {
    const read = () =>
      void restartState().then((state) => {
        dispatch({ type: 'held', held: state.held })
        if (state.go) installNow()
      })
    read()
    return onRestartChanged(read)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { engine, tookApp, applyApp, restartPastHold }
}

/** `markMs` is how long a result waits for the mark; tests pass 0. `disarmMs` is how long an arm stands. */
/**
 * The update engine: the desktop app's updater and every module's checkout — what was checked, what
 * is updating, what each update came to — held once for the page (`UpdatesProvider`) and read by the
 * Updates menu and by the module list, which draws each module's update in its own row. One source,
 * two views: the menu for the app and what moves the whole app, the list for each module.
 *
 * What it holds and how that moves is the pure reducer in `host/updatesEngine.ts`; this hook does the
 * I/O — checks, updates, restarts, timers — and says there what each came to.
 */
export function useUpdatesEngine({
  markMs = MARK_DRAWN_MS,
  disarmMs = DISARM_ANYWAY_AFTER_MS,
}: { markMs?: number; disarmMs?: number } = {}) {
  const [state, dispatch] = useReducer(updatesReducer, undefined, () => initialState(new Date()))
  const { check, open, phase, outcomes, notice, restarting, retryingIds, armed, armingId, showLevel, asked, now, skipped, autoTrouble, held, app } = state
  const controller = useRef<AbortController | null>(null)
  const busy = useRef(false)
  /** The checkouts whose updates this page started and has not seen end: closing the panel leaves them running. */
  const updateIds = useRef<Set<string>>(new Set())
  /** The job in flight, so a press can stop a quiet check and wait it out. */
  const pending = useRef<Promise<void> | null>(null)
  const appVersion = useRef<string | null>(null)
  appVersion.current = app?.current ?? null
  const { engine, tookApp, applyApp, restartPastHold } = useAppUpdater(dispatch, app?.version ?? null)
  const { notes, moduleNotes, moved, setMoved, movedOpen, setMovedOpen, notesOpen, showModuleNotes } = useNotesDialogs()

  /* The setters the engine hands out, as React's: a value, or what to make of the one held. */
  const setOpen = useCallback((next: Next<boolean>) => dispatch({ type: 'openSet', open: next }), [])
  const setAsked = useCallback((next: Next<string | null>) => dispatch({ type: 'askedSet', asked: next }), [])
  const setShowLevel = useCallback((next: Next<boolean>) => dispatch({ type: 'showLevelSet', showLevel: next }), [])

  /* The tooltip's "4 minutes ago" has to move while nobody is touching it. */
  useEffect(() => {
    const tick = setInterval(() => dispatch({ type: 'ticked', now: new Date() }), 30_000)
    return () => clearInterval(tick)
  }, [])

  const run = useCallback(
    async (loud: boolean): Promise<void> => {
      if (busy.current) {
        /* A press beats a quiet check that happens to be running: stop it and
           check out loud. A quiet check never interrupts anything. */
        if (!loud || !pending.current) return
        controller.current?.abort()
        await pending.current
      }
      busy.current = true
      let finish = () => {}
      pending.current = new Promise((resolve) => (finish = resolve))
      const abort = new AbortController()
      controller.current = abort
      dispatch({ type: 'checkStarted', loud })
      const since = Date.now()
      try {
        /* A press fetches; the automatic check only compares (`quiet`). */
        const found = await fetchUpdates(true, abort.signal, appVersion.current, !loud)
        if (loud) await drawn(since, abort.signal, markMs)
        dispatch({ type: 'checked', check: found })
      } catch (error) {
        if (abort.signal.aborted) {
          dispatch({ type: 'checkCancelled', loud })
        } else {
          if (loud) await drawn(since, abort.signal, markMs)
          dispatch({ type: 'checkFailed', at: new Date(), why: (error as Error).message })
        }
      } finally {
        busy.current = false
        controller.current = null
        pending.current = null
        finish()
        dispatch({ type: 'checkEnded', loud, now: new Date() })
      }
    },
    [markMs],
  )

  /* Quiet checks: soon after load, every half hour, and on coming back. */
  const lastAt = check?.checked.getTime() ?? 0
  const last = useRef(lastAt)
  last.current = lastAt
  useEffect(() => {
    const first = setTimeout(() => void run(false), FIRST_CHECK_AFTER_MS)
    const every = setInterval(() => void run(false), BACKGROUND_EVERY_MS)
    const onFocus = () => {
      if (Date.now() - last.current > ON_FOCUS_AFTER_MS) void run(false)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearTimeout(first)
      clearInterval(every)
      window.removeEventListener('focus', onFocus)
    }
  }, [run])

  /**
   * Cancel is the only thing that stops an update: it asks the server, which
   * runs the update itself. Closing the panel or reloading the page does not.
   * A check is the page's own request, so Cancel and closing still end that.
   */
  const cancel = () => {
    for (const id of updateIds.current) void cancelUpdate(id).catch(() => {})
    controller.current?.abort()
  }

  /* An arm nobody followed comes down by itself. */
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => dispatch({ type: 'disarmed' }), Math.min(armed.forMs, disarmMs))
    return () => clearTimeout(timer)
  }, [armed, disarmMs])

  /** "Check now": the app's updater and every module, at once. */
  const checkAll = () => {
    void engine.current?.check().then(tookApp)
    void run(true)
  }

  const onOpenChange = (next: boolean) => {
    if (next) {
      dispatch({ type: 'opened' })
      /* Opening shows what is known. A check older than the focus threshold
         is refreshed out loud; a fresh one is not asked again, so opening the
         menu to press "Restart to update" does not first wait on git. */
      const due = shouldCheckOnOpen(Date.now(), last.current, engine.current ? app : null)
      if (due.modules) void run(true)
      if (due.app) void engine.current?.check().then(tookApp)
    } else {
      /* Closing cancels a check this page is waiting on, never an update: that
         is the server's, the header chip and the reopened panel show it, and
         only Cancel stops it. */
      if (updateIds.current.size === 0) controller.current?.abort()
      dispatch({ type: 'closed' })
    }
  }

  /* A press elsewhere whose remedy is an update (`openUpdates`): the panel
     opens and checks out loud, whatever the age of the last check — somebody
     has just been told to update something. */
  useEffect(() => {
    const onAsked = (event: Event) => {
      const module = askedModule(event)
      /* A module's update is in its row of the module list: that opens, on its Updates, at the module. */
      openModuleList({ filter: 'updates', module })
      dispatch({ type: 'askedFor', module })
      void run(true)
    }
    window.addEventListener(OPEN_UPDATES, onAsked)
    return () => window.removeEventListener(OPEN_UPDATES, onAsked)
  }, [run])

  /** Read the checkouts as they are, without asking GitHub. */
  const reread = useCallback(async () => {
    try {
      dispatch({ type: 'read', check: await fetchUpdates(false) })
    } catch {
      /* The next check says so. */
    }
  }, [])

  /** One checkout's update, start to end: it says what it came to, and never throws. */
  const updateOne = async (id: string, ids: string[], abort: AbortController, back: Readonly<Record<string, string>>): Promise<void> => {
    dispatch({ type: 'updateStarted', ids, id })
    updateIds.current.add(id)
    try {
      /* No signal: the request is only where the page reads the update's steps. */
      const done = await applyUpdate(
        id,
        undefined,
        (reached) => dispatch({ type: 'phaseReached', id, phase: reached }),
        Object.hasOwn(back, id) ? back[id] : undefined,
      )
      dispatch({ type: 'updateDone', id, done })
      const outcome = outcomeOf(id, done)
      if (id !== 'host') pokeWhatsNew(outcome.kind === 'updated' && !outcome.installFailed ? { updated: id } : { failed: id })
    } catch (error) {
      if (error instanceof LeftRunning) {
        /* Closed after the checkout had moved: the server finishes it, and
           what is true is read back from there. */
        void reread()
        if (id !== 'host') pokeWhatsNew({ updated: id })
        return
      }
      const why = abort.signal.aborted ? 'Cancelled — it was not changed.' : (error as Error).message
      dispatch({ type: 'updateFailed', id, why })
      if (id !== 'host') pokeWhatsNew({ failed: id })
    } finally {
      updateIds.current.delete(id)
      dispatch({ type: 'updateEnded', id })
    }
  }

  /** One or several checkouts, one after another; a cancel stops the rest. */
  const updateAll = async (readyIds: string[], unfetchedIds: string[] = [], back: Readonly<Record<string, string>> = {}) => {
    if (busy.current) return
    busy.current = true
    const abort = new AbortController()
    controller.current = abort
    dispatch({ type: 'updateAllStarted', fetching: unfetchedIds.length > 0 })
    let ids = readyIds
    if (unfetchedIds.length > 0) {
      /* Checkouts somebody edits are fetched only by a press: this is it, the same fetch as Check now. */
      try {
        const found = await fetchUpdates(true, abort.signal, appVersion.current)
        dispatch({ type: 'fetchedForUpdate', check: found })
        ids = idsToUpdate(found, readyIds, unfetchedIds)
      } catch (error) {
        if (!abort.signal.aborted) dispatch({ type: 'fetchForUpdateFailed', why: (error as Error).message })
      }
    }
    /* A few at a time: each is a different module, and most of an update is waiting on a network or a start. */
    /* The host's own checkout alone, after the modules: it may ask for a restart of everything. */
    const queue = ids.filter((id) => id !== 'host')
    const workers = Array.from({ length: Math.min(UPDATES_AT_ONCE, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (abort.signal.aborted) return
        await updateOne(id, ids, abort, back)
      }
    })
    await Promise.all(workers)
    if (ids.includes('host') && !abort.signal.aborted) await updateOne('host', ids, abort, back)
    busy.current = false
    controller.current = null
    dispatch({ type: 'updatesEnded', cancelled: abort.signal.aborted })
  }

  /* The host's automatic updates moved (one began, ended, or now waits): read
     again, without asking GitHub. */
  useEffect(() => onUpdatesChanged(() => void reread()), [reread])

  /** "Keep modules up to date automatically", from the top of the panel: the same setting as Settings › Modules. */
  const setAuto = async (on: boolean) => {
    dispatch({ type: 'autoSet', on })
    try {
      await postAutoUpdates(on)
    } catch (error) {
      dispatch({ type: 'autoFailed', why: (error as Error).message })
    }
    void reread()
  }

  /* An update this page is not running is still running on the server — it
     was started before a reload, or the panel was closed over it. Ask until it
     is done; this ends by itself. */
  const elsewhere = phase.kind !== 'updating' && check !== null && Object.keys(check.progress).length > 0
  useEffect(() => {
    if (!elsewhere) return
    const again = setInterval(() => void reread(), PROGRESS_EVERY_MS)
    return () => clearInterval(again)
  }, [elsewhere, reread])

  /** What a restart from a row came to, as that row's outcome. */
  const restartedTo = (id: string, failed: NotRestarted | null) => {
    dispatch({ type: 'restarted', id, failed })
    void reread()
  }

  const unreached = (error: unknown): NotRestarted => ({ why: (error as Error).message, detail: [] })

  /** Start a module again after an update it did not come back from. */
  const retry = async (id: string) => {
    dispatch({ type: 'restartStarted', id })
    restartedTo(id, await restartModule(id).catch(unreached))
  }

  /**
   * "Restart anyway" on a module that is kept. The first press arms: the
   * server says what it would stop and the row shows that. The second, while
   * that still stands, is the one that restarts.
   */
  const restartAnyway = async (id: string) => {
    if (armed?.id === id) {
      const token = armed.token
      dispatch({ type: 'restartStarted', id })
      restartedTo(id, await confirmRestartAnyway(id, token).catch(unreached))
      return
    }
    if (armingId !== null) return
    dispatch({ type: 'arming', id })
    const said = await armRestartAnyway(id).catch(unreached)
    /* Refused before anything was stopped: the server's sentence, in the row. */
    dispatch('armed' in said ? { type: 'armed', id, armed: said.armed } : { type: 'anywayRefused', id, said })
  }

  const restartApp = async () => {
    dispatch({ type: 'appRestarting' })
    const why = await requestRestart()
    /* On success there is nothing more to do here: the app stops this page
       and comes back with the new server. A refusal goes back to the list. */
    if (why) dispatch({ type: 'appRestartRefused', why })
  }

  /* Every install and update the host is running, step by step (`StepProgress`). */
  const steps = useJobSteps()
  const { pins, count, checkouts, updating, mine, told, appOne, shown, checking, label, attention, level, askedDrawn, ready, unfetchedOnes, everything, endsAll, appCalm, lastFailed, status } = derive(state)

  /**
   * What a press on the header does while it names a restart.
   *
   * The header button is the panel's trigger, and a control is what it says on
   * it: "Restart to update" applies the desktop app's update, and "Restart the
   * host" restarts a host whose own checkout moved — both take this page with
   * them. A host the app cannot restart is the one thing left: the panel is
   * opened and says to quit and reopen. No module is restarted from here; an
   * update does that itself.
   */
  const restartWaiting = async () => {
    setOpen(true)
    if (appOne?.state === 'ready') applyApp()
    else if (offersAppRestart(outcomes.host, check?.restartable ?? false)) await restartApp()
  }

  /* The row a press elsewhere asked for, once it is drawn: brought into view
     and given focus, so "Update <Module>" lands on that module's Update. */
  useEffect(() => {
    if (!askedDrawn || asked === null) return
    /* Drawn in the module list, which opens in the same moment: looked for once it is there. */
    const timer = setTimeout(() => {
      const row = document.querySelector<HTMLElement>(`[data-updates-id="${CSS.escape(asked)}"]`)
      row?.scrollIntoView?.({ block: 'nearest' })
      row?.focus({ preventScroll: true })
    }, 50)
    return () => clearTimeout(timer)
  }, [askedDrawn, asked, showLevel])

  return { open, setOpen, onOpenChange, label, shown, restartWaiting, checking, updating, restarting, retryingIds, notesOpen, status, check, setAuto, autoTrouble, appOne, held, restartPastHold, applyApp, checkAll, notes, phase, cancel, notice, lastFailed, steps, attention, appCalm, now, outcomes, asked, setAsked, mine, pins, told, retry, armed, restartAnyway, restartApp, showModuleNotes, app, updateAll, level, showLevel, setShowLevel, setMoved, checkouts, ready, endsAll, skipped, everything, unfetchedOnes, moduleNotes, moved, movedOpen, setMovedOpen, count, run }
}

export type UpdatesEngine = ReturnType<typeof useUpdatesEngine>
/** The page's one engine; a test hands the module list a stand-in through it. */
export const UpdatesContext = createContext<UpdatesEngine | null>(null)

/** The one update engine for everything under it: the bar's Updates menu and its module list. */
export function UpdatesProvider({ children, markMs, disarmMs }: { children: ReactNode; markMs?: number; disarmMs?: number }) {
  const engine = useUpdatesEngine({ ...(markMs !== undefined ? { markMs } : {}), ...(disarmMs !== undefined ? { disarmMs } : {}) })
  return <UpdatesContext.Provider value={engine}>{children}</UpdatesContext.Provider>
}

/** The page's update engine, or null outside an `UpdatesProvider`. */
export function useUpdates(): UpdatesEngine | null {
  return useContext(UpdatesContext)
}

/** The Updates menu: the page's engine when there is one, else one of its own (a test that draws it alone). */
export function Updates({ markMs, disarmMs }: { markMs?: number; disarmMs?: number } = {}) {
  const shared = useUpdates()
  if (shared) return <UpdatesMenu engine={shared} />
  return (
    <UpdatesProvider {...(markMs !== undefined ? { markMs } : {})} {...(disarmMs !== undefined ? { disarmMs } : {})}>
      <UpdatesFromContext />
    </UpdatesProvider>
  )
}

function UpdatesFromContext() {
  return <UpdatesMenu engine={useUpdates()!} />
}

function UpdatesMenu({ engine }: { engine: UpdatesEngine }) {
  const { open, onOpenChange, restarting, notesOpen, status, check, setAuto, autoTrouble, appOne, held, restartPastHold, applyApp, checkAll, notes, phase, cancel, moved, movedOpen, setMovedOpen } = engine
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <UpdatesTrigger engine={engine} />

      <PopoverContent
        align="end"
        side="bottom"
        aria-label="Updates"
        className="updates-panel flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[22rem] flex-col p-0"
        /* The release-notes dialog is outside this panel: the panel stays
           open behind it, so focus has its button to come back to. */
        onFocusOutside={(event) => {
          if (notesOpen) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (notesOpen) event.preventDefault()
        }}
      >
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">Updates</p>
          <p className="text-muted-foreground text-xs" data-testid="updates-status">
            {status}
          </p>
          {check?.auto ? <AutoToggle on={check.auto.on} onChange={(on) => void setAuto(on)} trouble={autoTrouble} /> : null}
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {appOne && !restarting ? (
            <AppRow
              row={appOne}
              held={held}
              onRestartNow={restartPastHold}
              onApply={applyApp}
              onRetry={checkAll}
              onNotes={(version, opener) =>
                notes.show({ repo: APP_REPO, tag: tagFor(version), name: APP_NAME, version, opener })
              }
            />
          ) : null}
          {restarting || phase.kind === 'checking' ? <PanelWorking restarting={restarting} onCancel={cancel} /> : <PanelResults engine={engine} />}
        </div>
        {notes.dialog}
        {/* A module's "What's new" is opened from its row in the module list, which draws that dialog. */}
        {moved ? (
          <MovedNotesDialog key={`${moved.one.id}-${moved.one.at}`} repo={moved.repo} name={moved.one.name} from={moved.one.from} to={moved.one.to} open={movedOpen} onOpenChange={setMovedOpen} opener={moved.opener} />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** The header's Updates button: the quiet icon, or one line about everything — and while it names a restart, the restart. */
function UpdatesTrigger({ engine }: { engine: UpdatesEngine }) {
  const { open, label, shown, restartWaiting, checking, updating, restarting, retryingIds } = engine
  return (
    <Hint label={label} align="end">
      <PopoverTrigger
        asChild
        onClick={(event) => {
          /* While it names a restart it restarts; see `restartWaiting`.
             Prevented, so the same press does not also toggle the panel. */
          if (shown?.tone !== 'action') return
          event.preventDefault()
          void restartWaiting()
        }}
      >
        <Button
          variant="ghost"
          size={shown ? 'sm' : 'icon'}
          aria-label={shown ? `updates — ${shown.label}` : 'check for updates'}
          data-busy={checking || updating !== null || restarting || retryingIds.length > 0}
          data-testid="updates-indicator"
          data-tour="updates"
          data-tone={shown?.tone ?? 'none'}
          className={triggerClass(shown, open)}
        >
          <CloudDownload
            className={`size-3 ${checking || updating || restarting || shown?.tone === 'busy' ? 'animate-pulse' : ''}`}
          />
          {shown ? <span className="tabular-nums">{shown.label}</span> : null}
        </Button>
      </PopoverTrigger>
    </Hint>
  )
}

/** The button's look: a line in its tone's colour, or the quiet icon. */
function triggerClass(shown: UpdatesEngine['shown'], open: boolean): string {
  if (!shown) return `size-6 ${open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`
  const tone = shown.tone === 'error' ? 'text-destructive' : shown.tone === 'info' ? 'text-muted-foreground hover:text-foreground' : 'text-foreground'
  return `h-6 gap-1 px-1.5 text-xs font-normal ${tone}`
}

/** A check, or the app restarting: the kehikko mark drawing itself, with Cancel for a check. */
function PanelWorking({ restarting, onCancel }: { restarting: boolean; onCancel(): void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4" data-testid="updates-working">
      <KehikkoMark key={restarting ? 'r' : 'c'} working className="text-foreground size-12" />
      <p className="text-muted-foreground text-center text-xs">
        {restarting
          ? 'The window closes and Kehikot opens again in a moment, on the same kehikko.'
          : 'Fetching from each repository — a few seconds per repository.'}
      </p>
      {restarting ? null : (
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  )
}

/** What the last check found: what was said, the host's own row, the modules to see, what updated itself, and the actions. */
function PanelResults({ engine }: { engine: UpdatesEngine }) {
  const { onOpenChange, check, notice, lastFailed, steps, attention, appCalm, now, updating, checkAll, setMoved, checkouts } = engine
  return (
    <div className="flex flex-col gap-2" data-testid="updates-results">
      {notice ? <p className="text-muted-foreground text-xs">{notice}</p> : null}
      {lastFailed ? <p className="text-destructive text-xs">{lastFailed.why}</p> : null}
      {/* Installs and updates with no row of their own here (an install, an automatic update): each with its step. */}
      <StepList jobs={Object.values(steps).filter((job) => !attention.some((one) => one.id === job.id))} />

      {check && !lastFailed && attention.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-3 text-center" data-testid="updates-calm">
          <KehikkoMark working={false} className="text-muted-foreground size-12" />
          <p className="text-sm">{appCalm ? 'Everything is up to date' : 'Every module is up to date'}</p>
          <p className="text-muted-foreground text-xs">
            Last checked {ago(check.checked, now)} (
            {check.checked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
          </p>
        </div>
      ) : null}

      {/* The host's own checkout (a development host) stays here: it is the app's, not a module's. */}
      <UpdateRows engine={engine} only={(id) => id === 'host'} />
      {/* Each module's update is in its own row of the module list ("Kehikko modules"): said here, with Show. */}
      <ModulesToUpdate engine={engine} onShow={() => onOpenChange(false)} />

      {check?.auto?.updated.length ? <UpdatedAutomatically updated={check.auto.updated} now={now} onNotes={(one, opener) => setMoved({ one, repo: repoOf(checkouts, one.id), opener })} /> : null}

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          disabled={updating !== null}
          onClick={checkAll}
        >
          Check now
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground mr-auto h-7 text-xs"
          data-testid="updates-whats-new"
          disabled={updating !== null}
          onClick={() => {
            onOpenChange(false)
            setTimeout(openWhatsNew, 0)
          }}
        >
          What’s new
        </Button>
        <UpdateAllButton engine={engine} />
      </div>
    </div>
  )
}

/** "Update all (N)", while more than one waits or one needs fetching first, and nothing is updating. */
function UpdateAllButton({ engine }: { engine: UpdatesEngine }) {
  const { everything, unfetchedOnes, updating, updateAll, ready } = engine
  if (!((everything > 1 || unfetchedOnes.length > 0) && !updating)) return null
  return (
    <Button size="sm" className="h-7 text-xs" onClick={() => void updateAll(ready.map((one) => one.id), unfetchedOnes.map((one) => one.id))}>
      Update all ({everything})
    </Button>
  )
}

/**
 * Update rows as the menu always drew them — every state, every button (Update, step back, Cancel,
 * Try again, Restart anyway, What's new, pins, staleness, what waits) — for the checkouts `only` picks:
 * the host's own in the Updates menu, each module's in the module list.
 */
export function UpdateRows({ engine, only }: { engine: UpdatesEngine; only: (id: string) => boolean }) {
  const { outcomes, asked, updating, mine, pins, told, steps, check, retryingIds, updateAll, cancel, retry, armed, restartAnyway, restartApp, showModuleNotes, app, attention } = engine
  const shownRows = attention.filter((one) => only(one.id))
  return (
    <>
              {shownRows.map((one) => {
                const outcome = outcomes[one.id] ?? null
                return (
                  <div
                    key={one.id}
                    data-updates-id={one.id}
                    tabIndex={asked === one.id ? -1 : undefined}
                    className={asked === one.id ? 'ring-ring rounded-md ring-2 outline-none' : undefined}
                  >
                  <Row
                    row={moduleRow(
                      one,
                      outcome,
                      updating && mine(one.id) ? updating.running[one.id]! : null,
                      Object.hasOwn(pins, one.id) ? pins[one.id] : undefined,
                      Object.hasOwn(told, one.id) ? told[one.id] : undefined,
                    )}
                    reading={one}
                    job={Object.hasOwn(steps, one.id) && steps[one.id]!.kind === 'update' ? steps[one.id]! : null}
                    outcome={outcome}
                    preview={check && Object.hasOwn(check.previews, one.id) ? check.previews[one.id] : undefined}
                    retrying={retryingIds.includes(one.id)}
                    disabled={updating !== null}
                    onUpdate={() => void updateAll([one.id])}
                    onStepBack={(to) => void updateAll([one.id], [], { [one.id]: to })}
                    /* Only this page's own update, and only before the checkout
                       has moved: from then on nothing is cancelled. */
                    onCancel={updating && mine(one.id) && updating.running[one.id] === 'updating' ? cancel : null}
                    onRetry={() => void retry(one.id)}
                    armed={armed?.id === one.id ? armed.sentence : null}
                    onAnyway={() => void restartAnyway(one.id)}
                    onRestartApp={
                      offersAppRestart(outcome, check?.restartable ?? false) ? () => void restartApp() : null
                    }
                    onNotes={(release, opener) => showModuleNotes(one.id, one.name, release, opener)}
                    have={{ app: app?.current ?? null, protocol: check?.protocol ?? null }}
                  />
                  </div>
                )
              })}

    </>
  )
}

/** The modules with an update to see, as the Updates menu says them: names, and Show to open them in the module list. */
function ModulesToUpdate({ engine, onShow }: { engine: UpdatesEngine; onShow(): void }) {
  const modules = engine.attention.filter((one) => one.id !== 'host')
  if (!modules.length) return null
  const names = modules.map((one) => one.name)
  const said = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  return (
    <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs" data-testid="updates-modules">
      <span className="min-w-0 flex-1">
        {modules.length === 1 ? '1 module' : `${modules.length} modules`}: {said}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={() => {
          onShow()
          setTimeout(() => openModuleList({ filter: 'updates' }), 0)
        }}
      >
        Show
      </Button>
    </div>
  )
}

/**
 * The module list's Updates: every module's update row, the ones up to date with their versions,
 * what "Update all" restarts, what was not updated and why, Check now and Update all — what the Updates
 * menu held for modules, now beside the modules themselves.
 */
export function ModuleUpdates({ engine }: { engine: UpdatesEngine }) {
  const { attention, level: everyLevel, ready, updating, endsAll, skipped, checkAll, check, now, phase, notice, lastFailed, moduleNotes } = engine
  const modules = attention.filter((one) => one.id !== 'host')
  /* The host's own checkout is the app's, not a module's: said in the Updates menu, not here. */
  const level = everyLevel.filter((one) => one.id !== 'host')
  return (
    <div className="flex flex-col gap-2" data-testid="module-updates">
      {phase.kind === 'checking' ? <p className="text-muted-foreground text-xs">Asking GitHub what is new for each module…</p> : null}
      {notice ? <p className="text-muted-foreground text-xs">{notice}</p> : null}
      {lastFailed ? <p className="text-destructive text-xs">{lastFailed.why}</p> : null}
      {check && !lastFailed && modules.length === 0 && phase.kind !== 'checking' ? (
        <p className="text-muted-foreground text-xs" data-testid="module-updates-calm">
          Every module is up to date · last checked {ago(check.checked, now)}
        </p>
      ) : null}
      <UpdateRows engine={engine} only={(id) => id !== 'host'} />
      {level.length > 0 ? <LevelModules engine={engine} level={level} /> : null}

      {ready.length > 1 && !updating && endsAll ? (
        <p className="text-foreground px-1 text-xs" data-testid="updates-preview-all">
          {endsAll}
        </p>
      ) : null}
      {skipped.length > 0 && !updating ? <SkippedModules skipped={skipped} /> : null}
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={updating !== null || phase.kind === 'checking'} onClick={checkAll}>
          Check now
        </Button>
        <UpdateAllButton engine={engine} />
      </div>
      {moduleNotes.dialog}
    </div>
  )
}

/** "N others up to date", with show: each with its version, its pins and "What's new". */
function LevelModules({ engine, level }: { engine: UpdatesEngine; level: UpdatesEngine['level'] }) {
  const { showLevel, setShowLevel } = engine
  return (
    <div className="text-muted-foreground text-xs" data-testid="updates-level">
      <div className="flex items-center gap-2 px-1">
        <span className="flex-1">
          {level.length} other{level.length === 1 ? '' : 's'} up to date
        </span>
        <button
          type="button"
          className="hover:text-foreground underline-offset-2 hover:underline"
          aria-expanded={showLevel}
          onClick={() => setShowLevel((was) => !was)}
        >
          {showLevel ? 'hide' : 'show'}
        </button>
      </div>
      {showLevel ? (
        <ul className="mt-1 space-y-0.5 px-1">
          {level.map((one) => (
            <LevelModule key={one.id} engine={engine} one={one} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** One module that is up to date: its name, its pins, the release or commit it runs, and "What's new". */
function LevelModule({ engine, one }: { engine: UpdatesEngine; one: UpdatesEngine['level'][number] }) {
  const { asked, pins, showModuleNotes } = engine
  return (
    <li
      data-updates-id={one.id}
      tabIndex={asked === one.id ? -1 : undefined}
      className={cn('flex items-center gap-2', asked === one.id && 'ring-ring rounded-sm ring-2 outline-none')}
    >
      <ModuleIcon id={one.id} name={one.name} className="text-muted-foreground size-3" />
      <span className="text-foreground min-w-0 flex-1 truncate">{one.name}</span>
      {Object.hasOwn(pins, one.id) ? (
        <span className="shrink-0 text-[11px] text-amber-700 dark:text-amber-300" data-testid="updates-pinned">
          {pins[one.id]!.containers} pinned to {pins[one.id]!.versions.join(', ')}
        </span>
      ) : null}
      {one.release ? (
        <span className="shrink-0 text-[11px]" data-testid="updates-release">
          {releaseSaid(one.release)}
        </span>
      ) : (
        <span className="shrink-0 font-mono text-[11px]">
          {one.branch ?? 'detached'} @ {one.commit}
        </span>
      )}
      {one.release?.repo && one.release.notes.length ? (
        <WhatsNew release={one.release} onShow={(opener) => showModuleNotes(one.id, one.name, one.release!, opener)} />
      ) : null}
    </li>
  )
}

/** What "Update all" left alone, and why. */
function SkippedModules({ skipped }: { skipped: UpdatesEngine['skipped'] }) {
  return (
    <div className="text-foreground px-1 text-xs" data-testid="updates-skipped">
      <p className="font-medium">Not updated:</p>
      <ul className="space-y-0.5">
        {skipped.map((one) => (
          <li key={one.id} data-testid="updates-skipped-item" data-id={one.id}>
            {one.name} — {one.why}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The desktop app itself: always the first row inside the app, in the same
 * words as a module row. The engine downloads on its own, so the only action
 * is "Restart to update" once an update is ready, and "Try again" after a
 * failure.
 */
export function AppRow({
  row,
  held = null,
  onRestartNow = () => {},
  onApply,
  onRetry,
  onNotes,
}: {
  row: UpdateRow
  /** An app restart held behind queued work (protocol 2.110.0): said, with Restart now, instead of the button. */
  held?: HeldRestart | null
  onRestartNow?(): void
  onApply(): void
  onRetry(): void
  /** Show a version's release notes. See `appNotes`. */
  onNotes?(version: string, opener: HTMLElement): void
}) {
  const offered = appNotes(row)
  const running = offered.find((one) => !one.pending)
  const coming = offered.find((one) => one.pending)
  const comingTags = useAppTags(row.current ?? null, coming?.version ?? null)
  return (
    <div className="mb-2 rounded-md border px-3 py-2 text-xs" data-testid="updates-app" data-state={row.state}>
      <div className="flex items-center gap-2">
        <KehikkoMark working={false} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">Kehikot app</span>
        <span className="text-muted-foreground shrink-0 font-mono text-[11px]">{row.current}</span>
        {running && onNotes ? <NotesButton version={running.version} onShow={(opener) => onNotes(running.version, opener)} /> : null}
      </div>
      {row.state === 'checking' ? (
        <Loading className="pt-1 text-xs" label={stateText(row)} />
      ) : (
        <p className={row.state === 'failed' ? 'text-destructive pt-1' : row.state === 'uptodate' || row.state === 'unknown' ? 'text-muted-foreground pt-1' : 'text-foreground pt-1'}>
          {stateText(row)}
        </p>
      )}
      {row.state === 'updating' && row.activity === 'downloading' ? (
        <div
          className="bg-muted mt-1.5 h-1 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={row.progress === null ? undefined : Math.round(row.progress * 100)}
        >
          <div
            className={`bg-foreground/60 h-full ${row.progress === null ? 'w-1/3 animate-pulse' : ''}`}
            style={row.progress === null ? undefined : { width: `${Math.round(row.progress * 100)}%` }}
          />
        </div>
      ) : null}
      {coming && onNotes ? (
        <div className="text-muted-foreground flex items-center gap-1.5 pt-1" data-testid="updates-app-coming">
          <span className="min-w-0 flex-1 truncate">{coming.label}</span>
          <NotesButton version={coming.version} onShow={(opener) => onNotes(coming.version, opener)} />
        </div>
      ) : null}
      {coming ? <UpdateSummaries repo={APP_REPO} tags={comingTags} onMore={onNotes ? (opener) => onNotes(coming.version, opener) : undefined} /> : null}
      {row.state === 'ready' && held ? (
        <div className="flex items-center gap-2 pt-1.5" data-testid="updates-app-held">
          <span className="text-muted-foreground min-w-0 flex-1 text-xs">{heldSaid(held)}</span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRestartNow}>
            Restart now
          </Button>
        </div>
      ) : row.state === 'ready' ? (
        <div className="flex justify-end pt-1.5">
          <Button size="sm" className="h-6 px-2 text-xs" onClick={onApply}>
            {RESTART_TO_UPDATE}
          </Button>
        </div>
      ) : row.state === 'failed' ? (
        <div className="flex justify-end pt-1.5">
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  )
}

interface RowProps {
  /** The same state the app row and the header indicator read. */
  row: UpdateRow
  reading: Reading
  /** Its update as it goes, step by step: drawn inside this row, under its name. */
  job?: JobSaid | null
  outcome: Outcome | null
  /** What pressing Update would do to its running module, said first. Absent when it is not running. */
  preview?: Preview
  /** Its module is being started again from a failed row. */
  retrying: boolean
  /** Something else is being updated; this one waits. */
  disabled: boolean
  onUpdate(): void
  /** "Step back" on a step back that waits for the person (`release.back.ask`): the release it moves to. */
  onStepBack?(to: string): void
  /** Null once the update cannot be cancelled, or is not this page's to cancel. */
  onCancel: (() => void) | null
  onRetry(): void
  /** "Restart anyway" has had its first press: what the server says the second will stop and end. Null when it is not armed. */
  armed: string | null
  /** A press on "Restart anyway": the first arms, the second restarts. Drawn only when `row.anyway`. */
  onAnyway(): void
  /** Null unless the host's server changed and the app can restart it — then the note says to do it by hand. */
  onRestartApp: (() => void) | null
  /** "What's new" on a module that runs releases: the notes of `release.notes`, newest first. */
  onNotes?(release: ModuleRelease, opener: HTMLElement): void
  /** What this Kehikot is: the app's version inside the desktop app, and the host's protocol. For "you have …". */
  have?: { app: string | null; protocol: string | null }
}

/** One checkout that needs a person: where it is, what is coming, and what can be done. */
function Row(props: RowProps) {
  const { row, reading, job = null, onNotes, have } = props
  if (!isCheckout(reading)) return <UnreadableRow row={row} reading={reading} />
  const one = reading
  const release = one.release
  /* A copy that runs releases says them — "Journeys 1.5.0 → 1.6.0" — in place of commits. */
  const releases = release !== undefined && release.follows !== 'main'
  return (
    <div className="rounded-md border px-3 py-2 text-xs" data-testid="updates-row" data-state={row.state}>
      <RowTitle one={one} {...(onNotes ? { onNotes } : {})} {...(have ? { have } : {})} />
      {job ? <StepProgress job={job} className="pt-1" /> : null}
      {release && summaryTags(release).length ? (
        <UpdateSummaries repo={release.repo} tags={summaryTags(release)} onMore={onNotes ? (opener) => onNotes(release, opener) : undefined} />
      ) : null}
      <RowNotes row={row} release={release} {...(have ? { have } : {})} />
      {releases ? <ReleasesUnread one={one} /> : <CommitsBehind one={one} />}
      <RowAction {...props} one={one} />
    </div>
  )
}

/** A checkout that could not be read: its name, and why. */
function UnreadableRow({ row, reading }: { row: UpdateRow; reading: Exclude<Reading, Checkout> }) {
  return (
    <div className="rounded-md border px-3 py-2 text-xs" data-testid="updates-row" data-state={row.state}>
      <p className="flex items-center gap-2 font-medium">
        <ModuleIcon id={reading.id} name={reading.name} />
        {reading.name}
      </p>
      <p className="text-muted-foreground">{reading.error}</p>
    </div>
  )
}

/** The row's first line: the module, the release or commit it runs, which Kehikot that works with, and "What's new". */
function RowTitle({ one, onNotes, have }: { one: Checkout; onNotes?: RowProps['onNotes']; have?: RowProps['have'] }) {
  const release = one.release
  /* Which Kehikot the release in view works with, as a badge. Left out when that is the one installed and a newer one is said below: "up to date" already says it works. */
  const badge = release && !(needsNewerSaid(release, have) && !release.target) ? compatBadge(release, releaseInView(release), have) : null
  return (
    <div className="flex items-center gap-2">
      <ModuleIcon id={one.id} name={one.name} />
      <span className="min-w-0 flex-1 truncate font-medium" data-testid="updates-row-title">
        {one.name}
        {release ? <span className="text-muted-foreground pl-1.5 font-normal">{releaseSaid(release)}</span> : null}
      </span>
      {release ? null : (
        <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
          {one.branch ?? 'detached'} @ {one.commit}
        </span>
      )}
      {badge ? <CompatBadgeView badge={badge} /> : null}
      {release?.repo && release.notes.length && onNotes ? (
        <WhatsNew release={release} onShow={(opener) => onNotes(release, opener)} />
      ) : null}
    </div>
  )
}

/** What else is true of the module: a newer release it cannot take yet, running from source, pinned, what the switch waits on. */
function RowNotes({ row, release, have }: { row: UpdateRow; release: ModuleRelease | undefined; have?: RowProps['have'] }) {
  return (
    <>
      {release && !release.back && needsNewerSaid(release, have) ? (
        /* One sentence for the newer release's need, with the protocol in the tooltip. */
        <p className="text-muted-foreground pt-1" data-testid="updates-needs-newer" title={needsNewerTip(release, have) ?? undefined}>
          {needsNewerSaid(release, have)}
        </p>
      ) : null}
      {row.fromSource ? (
        /* Plain, and not an error: the module works. The log is in its details in the modules list. */
        <p className="text-muted-foreground pt-1" data-testid="updates-from-source">
          {row.fromSource}
        </p>
      ) : null}
      {row.state === 'pinned' ? (
        <p className="pt-1 text-amber-700 dark:text-amber-300" data-testid="updates-pinned">
          {row.reason}
        </p>
      ) : null}
      {row.autoSaid ? (
        <p className={row.autoFailed ? 'text-destructive pt-1' : 'text-foreground pt-1'} data-testid="updates-auto-waiting" data-until={row.autoFailed ? 'retry' : undefined}>
          {row.autoSaid}
        </p>
      ) : null}
    </>
  )
}

/** A copy that runs releases: said only when its releases could not be read. */
function ReleasesUnread({ one }: { one: Checkout }) {
  if (!one.fetchFailed) return null
  return (
    <p className="text-muted-foreground pt-1">
      {isGitReason(one.fetchFailed) ? <GitSaid said={one.fetchFailed} /> : `Its releases could not be read: ${one.fetchFailed}`}
    </p>
  )
}

/** A copy that follows a branch: how far behind it is, and the first commits coming. */
function CommitsBehind({ one }: { one: Checkout }) {
  return (
    <>
      <p className={one.behind ? 'text-foreground pt-1' : 'text-muted-foreground pt-1'}>
        {one.behind
          ? `${one.behind} new commit${one.behind === 1 ? '' : 's'} on ${one.upstream}`
          : one.waiting
            ? `New commits on ${one.upstream} — Check now fetches them`
            : 'Up to date'}
        {one.fetchFailed ? (
          <span className="text-muted-foreground">
            {' — '}
            {isGitReason(one.fetchFailed) ? <GitSaid said={one.fetchFailed} /> : `GitHub could not be reached: ${one.fetchFailed}`}
          </span>
        ) : null}
      </p>
      {one.incoming.length ? (
        <ul className="text-muted-foreground mt-1 space-y-0.5">
          {one.incoming.slice(0, 5).map((commit) => (
            <li key={commit.hash} className="truncate">
              <span className="font-mono">{commit.hash}</span> {commit.subject}
            </li>
          ))}
          {one.behind > 5 ? <li>and {one.behind - 5} more</li> : null}
        </ul>
      ) : null}
    </>
  )
}

/** What can be done about the row now, or what was just done: one of these at a time. */
function RowAction(props: RowProps & { one: Checkout }) {
  const { row, one, outcome, retrying } = props
  const release = one.release
  if (row.state === 'updating' || retrying) return <RowRunning row={row} retrying={retrying} onCancel={props.onCancel} />
  if (outcome?.kind === 'updated') return <RowUpdated outcome={outcome} onRestartApp={props.onRestartApp} />
  if (row.state === 'failed' && (outcome?.kind === 'failed' || row.retry)) {
    return <RowFailed row={row} outcome={outcome} armed={props.armed} onRetry={props.onRetry} onAnyway={props.onAnyway} />
  }
  if (hasUpdate(one) && one.blocked === null) return <RowUpdate preview={props.preview} disabled={props.disabled} onUpdate={props.onUpdate} />
  /* Behind, but not something this host will touch on its own. */
  if (hasUpdate(one)) return <p className="text-muted-foreground pt-1.5">Not updated automatically: {one.blocked}.</p>
  if (release?.back && stepBackAsked(release)) {
    return <RowStepBack release={release} disabled={props.disabled} {...(props.onStepBack ? { onStepBack: props.onStepBack } : {})} />
  }
  return null
}

/** One line for every step, in the row's own words: "Updating…", "Installing what changed…", "Restarting…". */
function RowRunning({ row, retrying, onCancel }: { row: UpdateRow; retrying: boolean; onCancel: (() => void) | null }) {
  return (
    <div className="flex items-center gap-2 pt-1.5" data-testid="updates-running">
      <KehikkoMark working className="text-foreground size-5 shrink-0" />
      <span className="text-muted-foreground flex-1">{retrying ? 'Restarting…' : stateText(row)}</span>
      {onCancel && !retrying ? (
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  )
}

function RowUpdated({ outcome, onRestartApp }: { outcome: Extract<Outcome, { kind: 'updated' }>; onRestartApp: (() => void) | null }) {
  return (
    <div className="pt-1.5">
      <p className="text-foreground">{outcome.note}</p>
      {outcome.installFailed ? <p className="text-destructive">{outcome.installFailed}</p> : null}
      {onRestartApp ? (
        <Button size="sm" className="mt-1.5 h-6 px-2 text-xs" onClick={onRestartApp}>
          {RESTART_THE_HOST}
        </Button>
      ) : null}
    </div>
  )
}

function RowFailed({
  row,
  outcome,
  armed,
  onRetry,
  onAnyway,
}: Pick<RowProps, 'row' | 'outcome' | 'armed' | 'onRetry' | 'onAnyway'>) {
  return (
    <div className="pt-1.5" data-testid="updates-failed">
      {/* Armed, the row says what the second press stops and ends, in
          place of why the first restart was refused. */}
      <p className="text-destructive" data-testid={armed !== null && row.anyway ? 'updates-armed' : undefined}>
        {armed !== null && row.anyway ? armed : <GitSaid said={outcome?.kind === 'failed' ? outcome.why : (row.reason ?? '')} />}
      </p>
      {outcome?.kind === 'failed' && outcome.detail?.length ? (
        <pre className="bg-muted text-muted-foreground mt-1 max-h-28 overflow-auto rounded px-2 py-1 font-mono text-[10px] leading-snug whitespace-pre-wrap">
          {outcome.detail.join('\n')}
        </pre>
      ) : null}
      {row.retry ? (
        <Button variant="outline" size="sm" className="mt-1.5 h-6 px-2 text-xs" onClick={onRetry}>
          {row.retryWord ?? 'Try again'}
        </Button>
      ) : null}
      {row.retry && row.anyway ? (
        /* One button for both presses, as `ClearButton` is: the words and
           `aria-pressed` say which of the two this press is. */
        <Button
          variant="outline"
          size="sm"
          aria-pressed={armed !== null}
          className={`mt-1.5 ml-1.5 h-6 px-2 text-xs ${armed !== null ? 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive' : ''}`}
          onClick={onAnyway}
        >
          {armed !== null ? RESTART_ANYWAY_ARMED : restartNowWord(row)}
        </Button>
      ) : null}
    </div>
  )
}

function RowUpdate({ preview, disabled, onUpdate }: { preview: Preview | undefined; disabled: boolean; onUpdate(): void }) {
  return (
    <div className="flex items-end gap-2 pt-1.5">
      {/* Said before the press: there is no second button to decline. */}
      <p className={`flex-1 ${preview === 'restart' || preview === 'self' ? 'text-foreground' : 'text-muted-foreground'}`} data-testid="updates-preview">
        {preview ? previewText(preview) : null}
      </p>
      <Button size="sm" className="h-6 shrink-0 px-2 text-xs" disabled={disabled} onClick={onUpdate}>
        Update
      </Button>
    </div>
  )
}

/** Its release needs a newer Kehikot, and the older one that works here might not suit what is on this machine: the person decides. */
function RowStepBack({ release, disabled, onStepBack }: { release: ModuleRelease; disabled: boolean; onStepBack?(to: string): void }) {
  return (
    <div className="pt-1.5" data-testid="updates-step-back">
      <p className="text-foreground font-medium">{stepBackAsked(release)}</p>
      <p className="text-muted-foreground">{release.back!.ask}</p>
      {onStepBack ? (
        <div className="flex justify-end pt-1">
          <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" disabled={disabled} onClick={() => onStepBack(release.back!.to)}>
            Step back
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * "Keep modules up to date automatically", at the top of the panel: the same
 * machine-wide setting as Settings › Modules. Off is exactly the panel as it
 * was before the switch: every update waits for a press.
 */
export function AutoToggle({ on, onChange, trouble = null }: { on: boolean; onChange(on: boolean): void; trouble?: string | null }) {
  return (
    <div className="pt-2" data-testid="updates-auto">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="updates-auto-switch" className="text-xs font-normal">
          {AUTO_UPDATES.short}
        </Label>
        <Switch id="updates-auto-switch" checked={on} onCheckedChange={onChange} aria-label={AUTO_UPDATES.label} data-testid="updates-auto-switch" />
      </div>
      {trouble ? <p className="text-destructive pt-1 text-xs">{trouble}</p> : null}
    </div>
  )
}

/** The updates the switch made since the host started, newest first: "Journeys 1.5.0 → 1.6.0 · 4 minutes ago". */
export function UpdatedAutomatically({
  updated,
  now,
  onNotes,
}: {
  updated: AutoTold['updated']
  now: Date
  onNotes?(one: AutoTold['updated'][number], opener: HTMLElement): void
}) {
  return (
    <section aria-label="Updated automatically" className="rounded-md border px-3 py-2 text-xs" data-testid="updates-auto-updated">
      <p className="text-muted-foreground pb-1">Updated automatically</p>
      <ul className="space-y-0.5">
        {updated.map((one) => (
          <li key={`${one.id}-${one.at}`} className="flex items-center gap-2" data-testid="updates-auto-row" data-module={one.id}>
            <ModuleIcon id={one.id} name={one.name} className="text-muted-foreground size-3" />
            <span className="min-w-0 flex-1 truncate">{doneSaid(one)}</span>
            {one.major ? (
              <span className="shrink-0 text-[11px] text-amber-700 dark:text-amber-300" data-major>
                major update
              </span>
            ) : null}
            {one.back ? (
              <span className="text-muted-foreground shrink-0 text-[11px]" data-back title="The release it was on needs a newer Kehikot">
                works with this Kehikot
              </span>
            ) : null}
            <span className="text-muted-foreground shrink-0 text-[11px]">{ago(new Date(one.at), now)}</span>
            <ChangelogButton name={one.name} disabled={!one.to || !onNotes} onShow={(opener) => onNotes?.(one, opener)} />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Where a module's releases are published, from its checkout. */
function repoOf(checkouts: readonly (Checkout | { id: string })[], id: string): string | null {
  const one = checkouts.find((c) => c.id === id)
  return one && 'release' in one ? (one.release?.repo ?? null) : null
}

/** The row's changelog icon: a scroll, "What changed in <name>", tooltip "Changelog". Shows notes and nothing else. */
function ChangelogButton({ name, disabled, onShow }: { name: string; disabled: boolean; onShow(opener: HTMLElement): void }) {
  const label = changelogLabel(name)
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          if ((event.currentTarget as HTMLElement).dataset.quietFocus) event.preventDefault()
        }}
      >
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          data-testid="updates-auto-changelog"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onShow(event.currentTarget)
          }}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring relative inline-flex size-4 shrink-0 cursor-default items-center justify-center rounded-sm outline-none after:absolute after:-inset-1 after:content-[''] focus-visible:ring-2 disabled:opacity-40"
        >
          <ScrollText className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Changelog</TooltipContent>
    </Tooltip>
  )
}

/**
 * "What's new" beside a module that runs releases: opens the notes of every
 * release since the one it runs (or of the one it runs, when up to date). The
 * press stops where it is, as `NotesButton`'s does.
 */
function WhatsNew({ release, onShow }: { release: ModuleRelease; onShow(opener: HTMLElement): void }) {
  const several = release.notes.length > 1
  return (
    <button
      type="button"
      data-testid="updates-whats-new"
      aria-label={several ? `What's new in the ${release.notes.length} releases since the one it runs` : "What's new"}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded-sm text-[11px] underline-offset-2 outline-none hover:underline focus-visible:ring-2"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onShow(event.currentTarget)
      }}
    >
      What's new
    </button>
  )
}

/* The engine's words, kept importable from here (`host/updatesEngine.ts` has them). */
export { summaryOf, tooltipFor, updatingStatus } from '@/host/updatesEngine.ts'
