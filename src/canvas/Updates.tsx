import { CloudDownload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import {
  ago,
  applyUpdate,
  fetchUpdates,
  isCheckout,
  restartModule,
  waiting,
  type Check,
  type Checkout,
  type Reading,
} from '@/host/updates.ts'
import { Hint } from './Hint.tsx'
import { KehikkoMark } from './Mark.tsx'

/**
 * Whether what this app runs is behind GitHub, and catching it up.
 *
 * ## Two ways a check happens
 *
 * Quietly, in the background: shortly after the page loads, every half hour,
 * and when the window comes back into focus after ten minutes away. A quiet
 * check only moves the dot on the button and the time in its tooltip.
 *
 * Out loud, when the button is pressed: the modal opens and checks at once,
 * with the kehikko mark drawing itself while it waits, and shows what is
 * behind and what can be done about it. Everything slow in it — the check and
 * each update — can be cancelled, and Cancel closes the request, which stops
 * the git the server was running for it. `server/updates.ts` says what a
 * cancel can and cannot undo.
 *
 * ## What the tooltip says
 *
 * When the last check was, because "is this up to date" is only as good as
 * when somebody last looked — and what it found.
 */

const BACKGROUND_EVERY_MS = 30 * 60_000
const ON_FOCUS_AFTER_MS = 10 * 60_000
const FIRST_CHECK_AFTER_MS = 5_000

type Phase = { kind: 'idle' } | { kind: 'checking' } | { kind: 'updating'; ids: string[]; at: number }

type Outcome =
  | { kind: 'updated'; note: string; restart: 'host' | 'module' | null; installFailed: string | null }
  | { kind: 'failed'; why: string }
  | { kind: 'restarted' }

export function Updates() {
  const [check, setCheck] = useState<Check | null>(null)
  const [failed, setFailed] = useState<{ at: Date; why: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())
  const controller = useRef<AbortController | null>(null)
  const busy = useRef(false)
  /** The job in flight, so a press can stop a quiet check and wait it out. */
  const pending = useRef<Promise<void> | null>(null)

  /* The tooltip's "4 minutes ago" has to move while nobody is touching it. */
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(tick)
  }, [])

  const run = useCallback(async (loud: boolean): Promise<void> => {
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
    }
    try {
      const found = await fetchUpdates(true, abort.signal)
      setCheck(found)
      setFailed(null)
    } catch (error) {
      if (abort.signal.aborted) {
        if (loud) setNotice('Check cancelled. What is shown is from the last check that finished.')
      } else {
        setFailed({ at: new Date(), why: (error as Error).message })
      }
    } finally {
      busy.current = false
      controller.current = null
      pending.current = null
      finish()
      setNow(new Date())
      if (loud) setPhase({ kind: 'idle' })
    }
  }, [])

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

  const press = () => {
    setOpen(true)
    setOutcomes({})
    void run(true)
  }

  const cancel = () => controller.current?.abort()

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
      try {
        const done = await applyUpdate(id, abort.signal)
        replace(done.checkout)
        setOutcomes((was) => ({
          ...was,
          [id]: {
            kind: 'updated',
            note: noteFor(id, done.changed.length, done.installed, done.restart),
            restart: done.restart,
            installFailed: done.installFailed,
          },
        }))
      } catch (error) {
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

  const count = check ? waiting(check.checkouts) : 0
  const label = tooltipFor(check, failed, count, now, phase.kind === 'checking' && !open)
  const checkouts = check?.checkouts ?? []
  /* What needs a person first: new commits, then what could not be read, then
     the quiet majority that is level. */
  const sorted = [...checkouts].sort((a, b) => weight(b) - weight(a))
  const ready = checkouts.filter((one): one is Checkout => isCheckout(one) && one.blocked === null)
  const working = phase.kind !== 'idle'

  return (
    <>
      <Hint label={label} align="end">
        <Button
          variant="ghost"
          size="icon"
          aria-label={count ? `updates — ${count} new commits` : 'check for updates'}
          className={`relative size-6 ${count ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={press}
        >
          <CloudDownload className="size-3" />
          {count ? <span className="bg-primary absolute top-0.5 right-0.5 size-1.5 rounded-full" /> : null}
        </Button>
      </Hint>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          /* Closing while something runs cancels it — a modal that closes on a
             job that carries on unseen is a job nobody can see finish. */
          if (!next) cancel()
          setOpen(next)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Updates</DialogTitle>
            <DialogDescription>
              {phase.kind === 'checking'
                ? 'Asking GitHub what is new for the host and each module…'
                : phase.kind === 'updating'
                  ? `Updating ${nameOf(checkouts, phase.ids[phase.at] ?? '')}${phase.ids.length > 1 ? ` (${phase.at + 1} of ${phase.ids.length})` : ''}…`
                  : summaryOf(check, failed, count)}
            </DialogDescription>
          </DialogHeader>

          {working ? (
            <div className="flex flex-col items-center gap-4 py-6">
              <KehikkoMark
                key={phase.kind === 'updating' ? `u${phase.at}` : 'c'}
                working
                className="text-foreground size-24"
              />
              <p className="text-muted-foreground max-w-sm text-center text-xs leading-relaxed">
                {phase.kind === 'checking'
                  ? 'This fetches from each repository’s remote. It can take a few seconds per repository.'
                  : 'Cancelling before the code moves leaves it exactly as it was. If the code has already moved, cancelling stops the dependency install and says so.'}
              </p>
              <Button variant="outline" size="sm" onClick={cancel}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex max-h-[55vh] flex-col gap-2 overflow-auto">
              {notice ? <p className="text-muted-foreground text-xs">{notice}</p> : null}
              {failed && !check ? <p className="text-destructive text-xs">{failed.why}</p> : null}
              {sorted.map((one) => (
                <Row
                  key={one.id}
                  reading={one}
                  outcome={outcomes[one.id] ?? null}
                  onUpdate={() => void updateAll([one.id])}
                  onRestart={() => void restart(one.id)}
                />
              ))}
              <div className="flex items-center justify-between gap-2 pt-2">
                <Button variant="ghost" size="sm" onClick={() => void run(true)}>
                  Check again
                </Button>
                {ready.length > 1 ? (
                  <Button size="sm" onClick={() => void updateAll(ready.map((one) => one.id))}>
                    Update all ({ready.length})
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** One checkout: where it is, how far behind, what is coming, and what can be done. */
function Row({
  reading,
  outcome,
  onUpdate,
  onRestart,
}: {
  reading: Reading
  outcome: Outcome | null
  onUpdate(): void
  onRestart(): void
}) {
  if (!isCheckout(reading)) {
    return (
      <div className="rounded-md border px-3 py-2 text-xs">
        <p className="font-medium">{reading.name}</p>
        <p className="text-muted-foreground">{reading.error}</p>
      </div>
    )
  }
  const one = reading
  /* Level and nothing to say: one quiet line, so fifteen of them do not bury
     the one that needs attention. */
  if (!outcome && one.behind === 0 && !one.fetchFailed) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 px-3 py-0.5 text-xs">
        <span className="text-foreground min-w-0 flex-1 truncate">{one.name}</span>
        <span className="shrink-0 font-mono text-[11px]">
          {one.branch ?? 'detached'} @ {one.commit}
        </span>
        <span className="w-20 shrink-0 text-right">up to date</span>
      </div>
    )
  }
  return (
    <div className="rounded-md border px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{one.name}</span>
        <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
          {one.branch ?? 'detached'} @ {one.commit}
        </span>
      </div>
      <p className={one.behind ? 'text-foreground pt-1' : 'text-muted-foreground pt-1'}>
        {one.behind ? `${one.behind} new commit${one.behind === 1 ? '' : 's'} on ${one.upstream}` : 'Up to date'}
        {one.fetchFailed ? <span className="text-muted-foreground"> — GitHub could not be reached: {one.fetchFailed}</span> : null}
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

      {outcome?.kind === 'updated' ? (
        <div className="pt-1.5">
          <p className="text-foreground">{outcome.note}</p>
          {outcome.installFailed ? <p className="text-destructive">{outcome.installFailed}</p> : null}
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
      ) : one.blocked === null ? (
        <div className="flex justify-end pt-1.5">
          <Button size="sm" className="h-6 px-2 text-xs" onClick={onUpdate}>
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

function noteFor(id: string, changed: number, installed: boolean, restart: 'host' | 'module' | null): string {
  const files = `${changed} file${changed === 1 ? '' : 's'} changed${installed ? ', dependencies installed' : ''}.`
  if (id === 'host') {
    return restart === 'host'
      ? `Updated — ${files} The page reloads itself, but the host’s server changed too: quit and reopen Kehikot to run it.`
      : `Updated — ${files} The page reloads itself with the new code.`
  }
  return restart === 'module' ? `Updated — ${files} Restart it to run the new code.` : `Updated — ${files}`
}

function weight(one: Reading): number {
  if (!isCheckout(one)) return 1
  if (one.behind > 0) return 3
  return one.fetchFailed ? 2 : 0
}

function nameOf(checkouts: readonly Reading[], id: string): string {
  return checkouts.find((one) => one.id === id)?.name ?? id
}

function summaryOf(check: Check | null, failed: { why: string } | null, count: number): string {
  if (!check) return failed ? 'The check did not finish.' : 'Not checked yet.'
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
