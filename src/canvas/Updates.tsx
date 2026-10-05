import { CloudDownload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import {
  ago,
  applyUpdate,
  fetchUpdates,
  isCheckout,
  offersAppRestart,
  requestRestart,
  restartModule,
  triage,
  waiting,
  type Check,
  type Checkout,
  type Outcome,
  type Reading,
} from '@/host/updates.ts'
import { connect, type AppEngine, type AppUpdateStatus } from '@/host/appUpdate.ts'
import { APP_ROW_ID, indicator, moduleRow, stateText, updateRows, type UpdateRow } from '@/host/updateModel.ts'
import { Hint } from './Hint.tsx'
import { KehikkoMark } from './Mark.tsx'

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
 * ## Whether what this app runs is behind GitHub, and catching it up
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
 * what a cancel can and cannot undo. Closing the panel cancels too: a job that
 * carries on unseen is a job nobody can see finish.
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
const ON_FOCUS_AFTER_MS = 10 * 60_000
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

type Phase = { kind: 'idle' } | { kind: 'checking' } | { kind: 'updating'; ids: string[]; at: number }

/** `markMs` is how long a result waits for the mark; tests pass 0. */
export function Updates({ markMs = MARK_DRAWN_MS }: { markMs?: number } = {}) {
  const [check, setCheck] = useState<Check | null>(null)
  const [failed, setFailed] = useState<{ at: Date; why: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /** A quiet check is running — the icon pulses, nothing else moves. */
  const [quietly, setQuietly] = useState(false)
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const [notice, setNotice] = useState<string | null>(null)
  /** Asked the app to restart; the window is about to go. */
  const [restarting, setRestarting] = useState(false)
  /** The level checkouts are listed, not just counted. */
  const [showLevel, setShowLevel] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const controller = useRef<AbortController | null>(null)
  const busy = useRef(false)
  /** The job in flight, so a press can stop a quiet check and wait it out. */
  const pending = useRef<Promise<void> | null>(null)
  /** The desktop app's updater: its last status, and the commands. Null outside the app. */
  const [app, setApp] = useState<AppUpdateStatus | null>(null)
  const engine = useRef<AppEngine | null>(null)

  /* Listen to the shell's push, and ask once now — which is also what tells
     the shell this page draws updates, so it keeps its own alert to itself. */
  useEffect(() => {
    const link = connect(setApp)
    engine.current = link.engine
    return () => link.stop()
  }, [])

  /* The tooltip's "4 minutes ago" has to move while nobody is touching it. */
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30_000)
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
      if (loud) {
        setPhase({ kind: 'checking' })
        setNotice(null)
      } else {
        setQuietly(true)
      }
      const since = Date.now()
      try {
        const found = await fetchUpdates(true, abort.signal)
        if (loud) await drawn(since, abort.signal, markMs)
        setCheck(found)
        setFailed(null)
      } catch (error) {
        if (abort.signal.aborted) {
          if (loud) setNotice('Check cancelled. What is shown is from the last check that finished.')
        } else {
          if (loud) await drawn(since, abort.signal, markMs)
          setFailed({ at: new Date(), why: (error as Error).message })
        }
      } finally {
        busy.current = false
        controller.current = null
        pending.current = null
        finish()
        setNow(new Date())
        if (loud) setPhase({ kind: 'idle' })
        else setQuietly(false)
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

  const cancel = () => controller.current?.abort()

  /** "Check now": the app's updater and every module, at once. */
  const checkAll = () => {
    const link = engine.current
    if (link) {
      void link.check().then((status) => {
        if (status) setApp(status)
      })
    }
    void run(true)
  }

  const applyApp = () => {
    const link = engine.current
    if (!link) return
    /* The shell pushes `installing` and then relaunches; say so meanwhile. */
    setApp((was) => (was && was.state === 'ready' ? { ...was, state: 'installing' } : was))
    void link.apply()
  }

  const onOpenChange = (next: boolean) => {
    if (next) {
      setOpen(true)
      setOutcomes({})
      setShowLevel(false)
      /* Opening shows what is known. A check older than the focus threshold
         is refreshed out loud; a fresh one is not asked again, so opening the
         menu to press "Restart to update" does not first wait on git. */
      if (Date.now() - last.current > ON_FOCUS_AFTER_MS) void run(true)
    } else {
      /* Closing while something runs cancels it — a panel that closes on a
         job that carries on unseen is a job nobody can see finish. */
      cancel()
      setOpen(false)
    }
  }

  /** One or several checkouts, one after another; a cancel stops the rest. */
  const updateAll = async (ids: string[]) => {
    if (busy.current) return
    busy.current = true
    const abort = new AbortController()
    controller.current = abort
    setNotice(null)
    for (const [at, id] of ids.entries()) {
      if (abort.signal.aborted) break
      setPhase({ kind: 'updating', ids, at })
      const since = Date.now()
      try {
        const done = await applyUpdate(id, abort.signal)
        await drawn(since, abort.signal, markMs)
        replace(done.checkout)
        setOutcomes((was) => ({
          ...was,
          [id]: {
            kind: 'updated',
            note: noteFor(id, done.changed.length, done.installed, done.restart, done.lockfileReset),
            restart: done.restart,
            installFailed: done.installFailed,
          },
        }))
      } catch (error) {
        await drawn(since, abort.signal, markMs)
        const why = abort.signal.aborted ? 'Cancelled — it was not changed.' : (error as Error).message
        setOutcomes((was) => ({ ...was, [id]: { kind: 'failed', why } }))
      }
    }
    if (abort.signal.aborted) setNotice('Update cancelled. Anything not marked as updated was left as it was.')
    busy.current = false
    controller.current = null
    setPhase({ kind: 'idle' })
  }

  const replace = (reading: Reading) =>
    setCheck((was) =>
      was ? { ...was, checkouts: was.checkouts.map((one) => (one.id === reading.id ? reading : one)) } : was,
    )

  const restart = async (id: string) => {
    const why = await restartModule(id)
    setOutcomes((was) => ({ ...was, [id]: why ? { kind: 'failed', why } : { kind: 'restarted' } }))
  }

  const restartApp = async () => {
    setRestarting(true)
    const why = await requestRestart()
    /* On success there is nothing more to do here: the app stops this page
       and comes back with the new server. A refusal goes back to the list. */
    if (why) {
      setRestarting(false)
      setNotice(why)
    }
  }

  const pins = check?.pins ?? {}
  const count = check ? waiting(check.checkouts, pins) : 0
  const checkouts = check?.checkouts ?? []
  const updating = phase.kind === 'updating' ? phase : null
  const rows = updateRows(app, checkouts, outcomes, updating ? (updating.ids[updating.at] ?? null) : null, pins)
  const appOne = rows[0]?.id === APP_ROW_ID && rows[0].source === 'app' ? rows[0] : null
  const shown = indicator(rows)
  const checking = phase.kind === 'checking' || quietly || appOne?.state === 'checking'
  const label = [tooltipFor(check, failed, count, now, checking && !open), appOne ? `Kehikot app ${appOne.current}: ${stateText(appOne).toLowerCase()}` : null]
    .filter(Boolean)
    .join(' · ')
  const { attention, level } = triage(checkouts, outcomes)
  const ready = attention.filter((one): one is Checkout => isCheckout(one) && one.behind > 0 && one.blocked === null)
  const appCalm = !appOne || ['uptodate', 'unknown', 'checking'].includes(appOne.state)
  const lastFailed = failed && (!check || failed.at > check.checked) ? failed : null
  const status = restarting
    ? 'Restarting Kehikot so the updated host runs…'
    : phase.kind === 'checking'
      ? 'Asking GitHub what is new for the host and each module…'
      : updating
        ? `Updating ${nameOf(checkouts, updating.ids[updating.at] ?? '')}${updating.ids.length > 1 ? ` (${updating.at + 1} of ${updating.ids.length})` : ''}…`
        : summaryOf(check, lastFailed, count)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Hint label={label} align="end">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size={shown ? 'sm' : 'icon'}
            aria-label={shown ? `updates — ${shown.label}` : 'check for updates'}
            data-busy={checking || updating !== null || restarting}
            data-testid="updates-indicator"
            data-tone={shown?.tone ?? 'none'}
            className={
              shown
                ? `h-6 gap-1 px-1.5 text-xs font-normal ${shown.tone === 'error' ? 'text-destructive' : shown.tone === 'info' ? 'text-muted-foreground hover:text-foreground' : 'text-foreground'}`
                : `size-6 ${open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`
            }
          >
            <CloudDownload
              className={`size-3 ${checking || updating || restarting || shown?.tone === 'busy' ? 'animate-pulse' : ''}`}
            />
            {shown ? <span className="tabular-nums">{shown.label}</span> : null}
          </Button>
        </PopoverTrigger>
      </Hint>

      <PopoverContent
        align="end"
        side="bottom"
        aria-label="Updates"
        className="updates-panel flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[22rem] flex-col p-0"
      >
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">Updates</p>
          <p className="text-muted-foreground text-xs" data-testid="updates-status">
            {status}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {appOne && !restarting ? <AppRow row={appOne} onApply={applyApp} onRetry={checkAll} /> : null}
          {restarting || phase.kind === 'checking' ? (
            <div className="flex flex-col items-center gap-3 py-4" data-testid="updates-working">
              <KehikkoMark key={restarting ? 'r' : 'c'} working className="text-foreground size-12" />
              <p className="text-muted-foreground text-center text-xs">
                {restarting
                  ? 'The window closes and Kehikot opens again in a moment, on the same kehikko.'
                  : 'Fetching from each repository — a few seconds per repository.'}
              </p>
              {restarting ? null : (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={cancel}>
                  Cancel
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-testid="updates-results">
              {notice ? <p className="text-muted-foreground text-xs">{notice}</p> : null}
              {lastFailed ? <p className="text-destructive text-xs">{lastFailed.why}</p> : null}

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

              {attention.map((one) => {
                const outcome = outcomes[one.id] ?? null
                return (
                  <Row
                    key={one.id}
                    row={moduleRow(
                      one,
                      outcome,
                      updating ? updating.ids[updating.at] === one.id : false,
                      Object.hasOwn(pins, one.id) ? pins[one.id] : undefined,
                    )}
                    reading={one}
                    outcome={outcome}
                    running={updating ? updating.ids[updating.at] === one.id : false}
                    disabled={updating !== null}
                    onUpdate={() => void updateAll([one.id])}
                    onCancel={cancel}
                    onRestart={() => void restart(one.id)}
                    onRestartApp={
                      offersAppRestart(outcome, check?.restartable ?? false) ? () => void restartApp() : null
                    }
                  />
                )
              })}

              {attention.length > 0 && level.length > 0 ? (
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
                        <li key={one.id} className="flex items-center gap-2">
                          <span className="text-foreground min-w-0 flex-1 truncate">{one.name}</span>
                          {Object.hasOwn(pins, one.id) ? (
                            <span className="shrink-0 text-[11px] text-amber-700 dark:text-amber-300" data-testid="updates-pinned">
                              {pins[one.id]!.containers} pinned to {pins[one.id]!.versions.join(', ')}
                            </span>
                          ) : null}
                          <span className="shrink-0 font-mono text-[11px]">
                            {one.branch ?? 'detached'} @ {one.commit}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

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
                {ready.length > 1 && !updating ? (
                  <Button size="sm" className="h-7 text-xs" onClick={() => void updateAll(ready.map((one) => one.id))}>
                    Update all ({ready.length})
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The desktop app itself: always the first row inside the app, in the same
 * words as a module row. The engine downloads on its own, so the only action
 * is "Restart to update" once an update is ready, and "Try again" after a
 * failure.
 */
function AppRow({ row, onApply, onRetry }: { row: UpdateRow; onApply(): void; onRetry(): void }) {
  return (
    <div className="mb-2 rounded-md border px-3 py-2 text-xs" data-testid="updates-app" data-state={row.state}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">Kehikot app</span>
        <span className="text-muted-foreground shrink-0 font-mono text-[11px]">{row.current}</span>
      </div>
      <p className={row.state === 'failed' ? 'text-destructive pt-1' : row.state === 'uptodate' || row.state === 'unknown' ? 'text-muted-foreground pt-1' : 'text-foreground pt-1'}>
        {stateText(row)}
      </p>
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
      {row.state === 'ready' ? (
        <div className="flex justify-end pt-1.5">
          <Button size="sm" className="h-6 px-2 text-xs" onClick={onApply}>
            Restart to update
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

/** One checkout that needs a person: where it is, what is coming, and what can be done. */
function Row({
  row,
  reading,
  outcome,
  running,
  disabled,
  onUpdate,
  onCancel,
  onRestart,
  onRestartApp,
}: {
  /** The same state the app row and the header indicator read. */
  row: UpdateRow
  reading: Reading
  outcome: Outcome | null
  /** This is the checkout being updated right now. */
  running: boolean
  /** Something else is being updated; this one waits. */
  disabled: boolean
  onUpdate(): void
  onCancel(): void
  onRestart(): void
  /** Null unless the host's server changed and the app can restart it — then the note says to do it by hand. */
  onRestartApp: (() => void) | null
}) {
  if (!isCheckout(reading)) {
    return (
      <div className="rounded-md border px-3 py-2 text-xs" data-testid="updates-row" data-state={row.state}>
        <p className="font-medium">{reading.name}</p>
        <p className="text-muted-foreground">{reading.error}</p>
      </div>
    )
  }
  const one = reading
  return (
    <div className="rounded-md border px-3 py-2 text-xs" data-testid="updates-row" data-state={row.state}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{one.name}</span>
        <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
          {one.branch ?? 'detached'} @ {one.commit}
        </span>
      </div>
      {row.state === 'pinned' ? (
        <p className="pt-1 text-amber-700 dark:text-amber-300" data-testid="updates-pinned">
          {row.reason}
        </p>
      ) : null}
      <p className={one.behind ? 'text-foreground pt-1' : 'text-muted-foreground pt-1'}>
        {one.behind ? `${one.behind} new commit${one.behind === 1 ? '' : 's'} on ${one.upstream}` : 'Up to date'}
        {one.fetchFailed ? (
          <span className="text-muted-foreground"> — GitHub could not be reached: {one.fetchFailed}</span>
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

      {running ? (
        <div className="flex items-center gap-2 pt-1.5" data-testid="updates-running">
          <KehikkoMark working className="text-foreground size-5 shrink-0" />
          <span className="text-muted-foreground flex-1">Updating…</span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      ) : outcome?.kind === 'updated' ? (
        <div className="pt-1.5">
          <p className="text-foreground">{outcome.note}</p>
          {outcome.installFailed ? <p className="text-destructive">{outcome.installFailed}</p> : null}
          {onRestartApp ? (
            <Button size="sm" className="mt-1.5 h-6 px-2 text-xs" onClick={onRestartApp}>
              Restart Kehikot
            </Button>
          ) : null}
          {outcome.restart === 'module' ? (
            <Button variant="outline" size="sm" className="mt-1.5 h-6 px-2 text-xs" onClick={onRestart}>
              Restart {one.name}
            </Button>
          ) : null}
        </div>
      ) : outcome?.kind === 'restarted' ? (
        <p className="text-foreground pt-1.5">Restarted — it is running the new code.</p>
      ) : outcome?.kind === 'failed' ? (
        <p className="text-destructive pt-1.5">{outcome.why}</p>
      ) : one.behind && one.blocked === null ? (
        <div className="flex justify-end pt-1.5">
          <Button size="sm" className="h-6 px-2 text-xs" disabled={disabled} onClick={onUpdate}>
            Update
          </Button>
        </div>
      ) : one.behind ? (
        /* Behind, but not something this host will touch on its own. */
        <p className="text-muted-foreground pt-1.5">Not updated automatically: {one.blocked}.</p>
      ) : null}
    </div>
  )
}

function noteFor(id: string, changed: number, installed: boolean, restart: 'host' | 'module' | null, lockfileReset = false): string {
  const files = `${changed} file${changed === 1 ? '' : 's'} changed${lockfileReset ? ', a stale bun.lock from an earlier install was reset' : ''}${installed ? ', dependencies installed' : ''}.`
  if (id === 'host') {
    return restart === 'host'
      ? `Updated — ${files} The page reloads itself, but the host’s server changed too: quit and reopen Kehikot to run it.`
      : `Updated — ${files} The page reloads itself with the new code.`
  }
  return restart === 'module' ? `Updated — ${files} Restart it to run the new code.` : `Updated — ${files}`
}

function nameOf(checkouts: readonly Reading[], id: string): string {
  return checkouts.find((one) => one.id === id)?.name ?? id
}

export function summaryOf(check: Check | null, failed: { why: string } | null, count: number): string {
  if (failed) return 'The last check did not finish.'
  if (!check) return 'Not checked yet.'
  if (count === 0) return 'Everything is up to date with GitHub.'
  const behind = check.checkouts.filter((one) => isCheckout(one) && one.behind > 0).length
  return `${count} new commit${count === 1 ? '' : 's'} across ${behind} repositor${behind === 1 ? 'y' : 'ies'}.`
}

export function tooltipFor(
  check: Check | null,
  failed: { at: Date; why: string } | null,
  count: number,
  now: Date,
  checking: boolean,
): string {
  if (checking) return 'checking for updates…'
  if (failed && (!check || failed.at > check.checked)) {
    return `the last check for updates failed ${ago(failed.at, now)}: ${failed.why}`
  }
  if (!check) return 'not checked for updates yet — press to check now'
  const when = `last checked for updates ${ago(check.checked, now)} (${check.checked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
  return count ? `${when} — ${count} new commit${count === 1 ? '' : 's'} waiting` : `${when} — everything is up to date`
}
