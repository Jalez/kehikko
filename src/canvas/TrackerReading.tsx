import { Plus, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { editTrackers, type TrackerState } from '@/host/projects.ts'
import {
  ago,
  boardSaid,
  EVERY_CHOICES,
  readSaid,
  rolesOf,
  sourceName,
  TRACKERS_ARE_FOR,
  type ListedSource,
  type TrackerEdit,
  type TrackerEdited,
  type TrackerListing,
} from '@/host/trackerSources.ts'
import { Hint } from './Hint.tsx'

export { ago }

/**
 * The open project's tracker reading, in the bar: how old it is, whether a
 * read is running, which source failed — and "Refresh all".
 *
 * ## One press for every container
 *
 * The host reads GitHub and GitLab once per project and every module reads
 * that one reading (`tracker.get`). So the refresh that matters is this one:
 * it reads every source again, and when it lands every container standing in
 * the project is told through `context.tracker`, and every module that reacts
 * to it re-reads. A container's own ↻ refreshes what that module shows; this
 * refreshes what all of them are shown.
 *
 * ## The age is the point
 *
 * Tracker state with no date on it is last week presented as now. So the
 * strip always says how old the reading is, and a failed source shows on the
 * strip itself — never only inside the popover — because a reading that
 * quietly stopped updating looks exactly like one that is current.
 *
 * ## The popover says what the sources are, and changes them
 *
 * A person is never sent to a file: what a source is for is said in words
 * (`rolesOf`), and add, switch and remove are controls here, written by the
 * host (`POST /host/trackers`). With no source at all the strip says
 * "+ add a tracker" and the popover opens on the add row.
 */
export function TrackerReading({ tracker, onRefresh }: { tracker: TrackerState; onRefresh(): void }) {
  const now = useNow(30_000)
  /* What the last edit answered, until the page's own reading catches up. */
  const [own, setOwn] = useState<TrackerListing | null>(null)
  useEffect(() => setOwn(null), [tracker.listing, tracker.at, tracker.project])
  const listing = own ?? tracker.listing ?? null

  const failed = tracker.sources.filter((s) => s.error)
  const age = tracker.at ? ago(Date.parse(tracker.at), now) : null
  const empty = listing !== null && listing.sources.length === 0 && !listing.broken
  const broken = listing?.broken ?? null
  const label = tracker.refreshing
    ? 'reading the trackers…'
    : broken
      ? 'tracker file will not read'
      : empty
        ? '+ add a tracker'
        : failed.length
          ? `${failed.length === tracker.sources.length ? 'trackers' : `${failed.length} tracker${failed.length === 1 ? '' : 's'}`} not read`
          : age
            ? `trackers read ${age}`
            : tracker.sources.length
              ? 'trackers not read yet'
              : 'no trackers'
  const tooltip = empty
    ? 'no trackers — this project has no GitHub or GitLab remote; press to add one'
    : 'the GitHub and GitLab reading every module on this project shows — press for its sources and Refresh all'

  return (
    <Popover>
      <Hint label={tooltip}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            className={`h-6 gap-1 px-1.5 text-[11px] font-normal ${failed.length || broken ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {empty ? <Plus className="size-3" /> : <RefreshCw className={`size-3 ${tracker.refreshing ? 'animate-spin' : ''}`} />}
            {/* Words go from sight, not from the control, under 640px: the bar must not outgrow the window. */}
            <span className="max-[640px]:sr-only">{label}</span>
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="max-h-[80vh] w-96 max-w-[calc(100vw-1rem)] space-y-2 overflow-y-auto p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">
            {empty ? 'Trackers' : `Trackers${tracker.at ? `, read ${new Date(tracker.at).toLocaleString()}` : ', never read'}`}
          </span>
          {empty ? null : (
            <Button size="sm" className="h-6 px-2 text-xs" disabled={tracker.refreshing} onClick={onRefresh}>
              <RefreshCw className={`size-3 ${tracker.refreshing ? 'animate-spin' : ''}`} />
              {tracker.refreshing ? 'Reading…' : 'Refresh all'}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground">{TRACKERS_ARE_FOR}</p>
        <Sources tracker={tracker} listing={listing} now={now} onListing={setOwn} startOpen={empty} />
      </PopoverContent>
    </Popover>
  )
}

/** What "Check" and an edit say back, as a line under the control that asked. */
interface Said {
  tone: 'ok' | 'bad' | 'plain'
  text: string
}

function Sources({
  tracker,
  listing,
  now,
  onListing,
  startOpen,
}: {
  tracker: TrackerState
  listing: TrackerListing | null
  now: number
  onListing(listing: TrackerListing): void
  startOpen: boolean
}) {
  const project = tracker.project ?? null
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<Said | null>(null)

  /** One edit, and what it answered; the listing it returns replaces the panel's. */
  async function send(edit: TrackerEdit): Promise<TrackerEdited | null> {
    if (project === null) return null
    setBusy(true)
    try {
      const done = await editTrackers(project, edit)
      if (done.listing) onListing(done.listing)
      setSaid(
        done.outcome === 'declined' || done.outcome === 'failed'
          ? { tone: 'bad', text: done.why }
          : { tone: done.outcome === 'read' ? 'ok' : 'plain', text: done.said },
      )
      return done
    } catch (error) {
      setSaid({ tone: 'bad', text: `The host did not answer: ${(error as Error).message}` })
      return null
    } finally {
      setBusy(false)
    }
  }

  if (!listing) {
    /* A host that does not say what its sources are for: the strip's older list. */
    return (
      <ul className="space-y-1">
        {tracker.sources.map((s) => (
          <li key={`${s.tracker}|${s.host}|${s.repo}`} className="leading-snug">
            <span className="font-mono">{sourceName(s)}</span>
            <span className="text-muted-foreground">
              {' '}
              {s.tracker}
              {s.default ? ', default' : ''}
              {s.listed ? ', listed' : ''}
              {' — '}
              {s.at ? `read ${ago(Date.parse(s.at), now)}` : 'never read'}
            </span>
            {s.error ? <div className="text-destructive">{s.error}</div> : null}
          </li>
        ))}
      </ul>
    )
  }

  const reading = tracker.refreshing
  return (
    <div className="space-y-2">
      {listing.broken ? <Broken listing={listing} busy={busy} onFresh={() => void send({ kind: 'fresh' })} /> : null}
      {listing.sources.length ? (
        <ul className="space-y-2">
          {listing.sources.map((s) => (
            <SourceRow key={`${s.tracker}|${s.host}|${s.repo}`} source={s} now={now} busy={busy || reading} send={send} />
          ))}
        </ul>
      ) : null}
      {listing.boardsNote && !listing.broken ? <p className="text-muted-foreground">{listing.boardsNote}</p> : null}
      {listing.peopleNote && !listing.broken ? <p className="text-muted-foreground">{listing.peopleNote}</p> : null}
      {listing.broken ? null : <AddRow busy={busy} send={send} startOpen={startOpen} setSaid={setSaid} />}
      {said ? (
        <p role="status" className={said.tone === 'bad' ? 'text-destructive' : said.tone === 'ok' ? 'text-foreground' : 'text-muted-foreground'}>
          {said.text}
        </p>
      ) : null}
      {listing.broken ? null : (
        <div className="space-y-1 border-t pt-2 text-muted-foreground">
          <label className="flex items-center gap-1.5">
            Read again every
            <select
              aria-label="Read again every N minutes while somebody is looking"
              className="h-5 rounded border bg-background px-1 text-foreground"
              disabled={busy}
              value={listing.every}
              onChange={(e) => void send({ kind: 'schedule', every: Number(e.target.value) })}
            >
              {[...new Set([...EVERY_CHOICES, listing.every])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'never' : `${n} minutes`}
                  </option>
                ))}
            </select>
            while looking
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={listing.remotes}
              disabled={busy}
              onChange={(e) => void send({ kind: 'remotes', on: e.target.checked })}
            />
            Use this project&apos;s git remotes
          </label>
          <p>
            Read with your own logged-in <span className="font-mono">gh</span> and <span className="font-mono">glab</span>.
            Every container on this project is told when a read lands.
          </p>
        </div>
      )}
    </div>
  )
}

function Broken({ listing, busy, onFresh }: { listing: TrackerListing; busy: boolean; onFresh(): void }) {
  return (
    <div className="space-y-1 rounded border border-destructive/40 p-2">
      <p className="text-destructive">
        This project&apos;s tracker file will not read: {listing.broken?.why}. Nothing is read from it, and nothing
        will be written over it.
      </p>
      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} onClick={onFresh}>
        Start fresh
      </Button>
      <span className="text-muted-foreground"> keeps the old file beside it as trackers.json.broken.</span>
    </div>
  )
}

function SourceRow({
  source: s,
  now,
  busy,
  send,
}: {
  source: ListedSource
  now: number
  busy: boolean
  send(edit: TrackerEdit): Promise<TrackerEdited | null>
}) {
  const key = { tracker: s.tracker, host: s.host, repo: s.repo }
  const link = 'h-5 rounded px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50'
  return (
    <li className={`leading-snug ${s.off ? 'opacity-70' : ''}`}>
      <div>
        <span className="font-mono">{sourceName(s)}</span>
        <span className="text-muted-foreground"> {s.tracker === 'github' ? 'GitHub' : 'GitLab'}</span>
      </div>
      <div className="text-muted-foreground">{rolesOf(s).join(' · ')}</div>
      {s.off ? null : (
        <div className={s.error ? 'text-destructive' : 'text-muted-foreground'}>
          {s.error ?? readSaid(s, now)}
        </div>
      )}
      {!s.off && s.boards?.length
        ? s.boards.map((b) => (
            <div key={b.board} className="text-muted-foreground">
              Board {boardSaid(b)}
            </div>
          ))
        : null}
      <div className="flex flex-wrap gap-x-2">
        {s.off ? (
          <button type="button" className={link} disabled={busy} onClick={() => void send({ kind: 'set', ...key, off: false })}>
            turn back on
          </button>
        ) : (
          <>
            {s.default ? null : (
              <button type="button" className={link} disabled={busy} onClick={() => void send({ kind: 'set', ...key, default: true })}>
                make default
              </button>
            )}
            <button type="button" className={link} disabled={busy} onClick={() => void send({ kind: 'set', ...key, list: !s.listed })}>
              {s.listed ? 'stop listing recent' : 'list recent'}
            </button>
            {s.origin === 'remote' ? (
              <button type="button" className={link} disabled={busy} onClick={() => void send({ kind: 'set', ...key, off: true })}>
                turn off
              </button>
            ) : (
              <button type="button" className={link} disabled={busy} onClick={() => void send({ kind: 'remove', ...key })}>
                remove
              </button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

/** A repository link, or owner/repo with its tracker; Check reads it once before it is kept. */
function AddRow({
  busy,
  send,
  startOpen,
  setSaid,
}: {
  busy: boolean
  send(edit: TrackerEdit): Promise<TrackerEdited | null>
  startOpen: boolean
  setSaid(said: Said | null): void
}) {
  const [open, setOpen] = useState(startOpen)
  const [input, setInput] = useState('')
  const [tracker, setTracker] = useState<'github' | 'gitlab'>('github')
  const [host, setHost] = useState('')
  const [asking, setAsking] = useState(false)
  /* A link says its tracker by its host; a bare name cannot. */
  const plain = input.trim() !== '' && !/^(?:https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(input.trim())
  const link = /^(?:https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(input.trim())
  const known = link && /(?:^|[/@.])(?:github\.com|gitlab[\w.-]*)(?:[:/]|$)/i.test(input.trim())
  const needsTracker = plain || (link && !known)
  const rest = needsTracker
    ? { tracker, ...(tracker === 'gitlab' && host.trim() ? { host: host.trim() } : {}) }
    : {}

  if (!open) {
    return (
      <button
        type="button"
        className="flex h-6 items-center gap-1 rounded px-1 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3" /> source
      </button>
    )
  }

  async function check() {
    setAsking(true)
    setSaid({ tone: 'plain', text: 'Checking…' })
    try {
      await send({ kind: 'check', input, ...rest })
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="space-y-1 rounded border p-2">
      <input
        aria-label="A repository link, or owner/repo"
        className="h-6 w-full rounded border bg-background px-1.5 font-mono text-[11px]"
        placeholder="https://github.com/owner/repo, or owner/repo"
        value={input}
        autoFocus={startOpen}
        onChange={(e) => {
          setInput(e.target.value)
          setSaid(null)
        }}
      />
      {needsTracker ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Which tracker it is on"
            className="h-5 rounded border bg-background px-1"
            value={tracker}
            onChange={(e) => setTracker(e.target.value as 'github' | 'gitlab')}
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
          {tracker === 'gitlab' && plain ? (
            <input
              aria-label="Its host, when it is not gitlab.com"
              className="h-5 min-w-0 flex-1 rounded border bg-background px-1 font-mono text-[11px]"
              placeholder="gitlab.example.org (blank is gitlab.com)"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy || asking || !input.trim()} onClick={() => void check()}>
          Check
        </Button>
        <Button
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={busy || asking || !input.trim()}
          onClick={async () => {
            const done = await send({ kind: 'add', input, ...rest })
            if (done?.outcome === 'changed') {
              setInput('')
              setHost('')
              setOpen(false)
            }
          }}
        >
          Add
        </Button>
      </div>
    </div>
  )
}

/** The time, re-read every `every` ms, so "read 3 minutes ago" moves while nobody touches anything. */
function useNow(every: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}
