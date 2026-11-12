import { Plus } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { cn } from '@/lib/utils'
import { SETTINGS_TARGETS, openSettings } from '@/host/agentSettings.ts'
import { editTrackers, type TrackerState } from '@/host/projects.ts'
import { TARGET_ATTR } from '@/host/settingsTarget.ts'
import {
  CLOSED_CHOICES,
  kindSaid,
  kindsFor,
  readsOf,
  READS_DEFAULT,
  readsSaid,
  writtenReads,
  type ReadKind,
  type Reads,
} from '@/host/trackerReads.ts'
import {
  ago,
  boardSaid,
  EVERY_CHOICES,
  readSaid,
  rolesOf,
  sourceName,
  type ListedSource,
  type TrackerEdit,
  type TrackerEdited,
  type TrackerListing,
} from '@/host/trackerSources.ts'
import { useNow, WithLimitLink } from './TrackerReading.tsx'

/**
 * Settings › Trackers, the open project's part: its sources and how they are read. Everything a
 * person can change about the project's trackers is here, and the bar's Trackers menu only says
 * what was read (`TrackerReading.tsx`).
 *
 * Every change is one edit sent to `POST /host/trackers` (`editTrackers`, the one writer of
 * `trackers.json`); the listing the edit answers replaces this one until the page's own reading
 * catches up. The controls a link may open Settings at mark themselves with `data-settings-target`
 * (`SETTINGS_TARGETS.tracker*`).
 */

/** "Tracker news to agents" in this project (`host/trackerNews.ts`): on unless the person turned it off. */
export interface TrackerNewsSwitch {
  on: boolean
  onChange(on: boolean): void
}

/** What Settings › Trackers is handed for the open project: its reading, "Refresh all", and the news switch. */
export interface TrackersDoor {
  tracker: TrackerState
  onRefresh(): void
  news: TrackerNewsSwitch | null
}

/** A row a link can land on, lit for a moment when it does. */
export const LIT_ROW = 'rounded-md transition-colors data-[lit=true]:bg-amber-500/10 data-[lit=true]:ring-2 data-[lit=true]:ring-amber-500/50'
const target = (id: string) => ({ [TARGET_ATTR]: id })

/** What "Check" and an edit say back, as a line under the control that asked. */
interface Said {
  tone: 'ok' | 'bad' | 'plain'
  text: string
}

export function TrackerSourcesSettings({ door }: { door: TrackersDoor }) {
  const { tracker, onRefresh } = door
  const now = useNow(30_000)
  const project = tracker.project ?? null
  /* What the last edit answered, until the page's own reading catches up. */
  const [own, setOwn] = useState<TrackerListing | null>(null)
  useEffect(() => setOwn(null), [tracker.listing, tracker.at, tracker.project])
  const listing = own ?? tracker.listing ?? null
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<Said | null>(null)
  const reading = tracker.refreshing

  /** One edit, and what it answered; the listing it returns replaces this one. */
  async function send(edit: TrackerEdit): Promise<TrackerEdited | null> {
    if (project === null) return null
    setBusy(true)
    try {
      const done = await editTrackers(project, edit)
      if (done.listing) setOwn(done.listing)
      setSaid(
        done.outcome === 'declined' || done.outcome === 'failed'
          ? { tone: 'bad', text: done.why }
          : { tone: done.outcome === 'read' ? 'ok' : 'plain', text: done.said },
      )
      return done
    } catch (error) {
      setSaid({ tone: 'bad', text: `Kehikot did not answer: ${(error as Error).message}. Try again.` })
      return null
    } finally {
      setBusy(false)
    }
  }

  if (!listing) {
    /* A host that does not say what its sources are for: what it does say, and nothing to change. */
    return (
      <section {...target(SETTINGS_TARGETS.trackerSources.target)} className={cn('min-w-0 space-y-2', LIT_ROW)} data-tracker-sources="plain">
        <h4 className="text-sm font-medium">Sources</h4>
        <ul className="divide-y rounded-lg border px-4">
          {tracker.sources.map((s) => (
            <li key={`${s.tracker}|${s.host}|${s.repo}`} className="py-2.5 text-xs leading-snug">
              <span className="font-mono">{sourceName(s)}</span>
              <span className="text-muted-foreground">
                {' '}
                {s.tracker}
                {s.default ? ', default' : ''}
                {s.listed ? ', listed' : ''}
                {' — '}
                {s.at ? `read ${ago(Date.parse(s.at), now)}` : 'never read'}
              </span>
              {s.error ? <WithLimitLink text={s.error} className="text-destructive" onRetry={reading ? undefined : onRefresh} /> : null}
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <>
      <section {...target(SETTINGS_TARGETS.trackerSources.target)} tabIndex={-1} className={cn('min-w-0 space-y-2 outline-none', LIT_ROW)} data-tracker-sources="listed">
        <h4 className="text-sm font-medium">Sources</h4>
        {listing.broken ? <Broken listing={listing} busy={busy} onFresh={() => void send({ kind: 'fresh' })} /> : null}
        {listing.sources.length ? (
          <ul className="divide-y rounded-lg border px-4">
            {listing.sources.map((s) => (
              <SourceRow
                key={`${s.tracker}|${s.host}|${s.repo}`}
                source={s}
                now={now}
                busy={busy || reading}
                send={send}
                onRetry={reading ? undefined : onRefresh}
              />
            ))}
          </ul>
        ) : listing.broken ? null : (
          <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-3 text-xs" data-tracker-sources-empty>
            No sources: this project has no GitHub or GitLab remote and nobody has added one.
          </p>
        )}
        {listing.boardsNote && !listing.broken ? <p className="text-muted-foreground text-xs leading-relaxed">{listing.boardsNote}</p> : null}
        {listing.peopleNote && !listing.broken ? <p className="text-muted-foreground text-xs leading-relaxed">{listing.peopleNote}</p> : null}
        {listing.broken ? null : <AddRow busy={busy} send={send} setSaid={setSaid} />}
        {said ? (
          <div role="status" className={cn('text-xs', said.tone === 'bad' ? 'text-destructive' : said.tone === 'ok' ? 'text-foreground' : 'text-muted-foreground')}>
            <WithLimitLink text={said.text} />
          </div>
        ) : null}
      </section>
      {listing.broken ? null : (
        <section className="min-w-0 space-y-2">
          <h4 className="text-sm font-medium">How they are read</h4>
          <div className="divide-y rounded-lg border px-4">
            <Schedule every={listing.every} busy={busy} onChange={(every) => void send({ kind: 'schedule', every })} />
            <RemotesRow on={listing.remotes} busy={busy} onChange={(on) => void send({ kind: 'remotes', on })} />
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Read with your own logged-in <span className="font-mono">gh</span> and <span className="font-mono">glab</span>. Every container on
            this project is told when a read lands.
          </p>
        </section>
      )}
    </>
  )
}

/** "Read again every … while looking". */
function Schedule({ every, busy, onChange }: { every: number; busy: boolean; onChange(every: number): void }) {
  const id = useId()
  return (
    <div {...target(SETTINGS_TARGETS.trackerSchedule.target)} className={cn('flex min-w-0 items-start justify-between gap-4 py-3.5', LIT_ROW)}>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id} className="text-sm leading-snug">
          Read again every
        </Label>
        <p id={`${id}-about`} className="text-muted-foreground text-xs leading-relaxed">
          While somebody is looking at this project. Never: only when somebody presses Refresh all, or a module asks.
        </p>
      </div>
      <div className="w-36 shrink-0">
        <NativeSelect
          id={id}
          aria-label="Read again every N minutes while somebody is looking"
          aria-describedby={`${id}-about`}
          disabled={busy}
          value={every}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {[...new Set([...EVERY_CHOICES, every])]
            .sort((a, b) => a - b)
            .map((n) => (
              <NativeSelectOption key={n} value={n}>
                {n === 0 ? 'never' : `${n} minutes`}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </div>
    </div>
  )
}

/** "Use this project's git remotes". */
function RemotesRow({ on, busy, onChange }: { on: boolean; busy: boolean; onChange(on: boolean): void }) {
  const id = useId()
  return (
    <div {...target(SETTINGS_TARGETS.trackerRemotes.target)} className={cn('flex min-w-0 items-start justify-between gap-4 py-3.5', LIT_ROW)}>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id} className="text-sm leading-snug">
          Use this project&apos;s git remotes
        </Label>
        <p id={`${id}-about`} className="text-muted-foreground text-xs leading-relaxed">
          A GitHub or GitLab remote of the project&apos;s repository is a source without being added. Off, only the sources added here are read.
        </p>
      </div>
      <Switch id={id} checked={on} disabled={busy} onCheckedChange={onChange} aria-describedby={`${id}-about`} className="mt-0.5" />
    </div>
  )
}

function Broken({ listing, busy, onFresh }: { listing: TrackerListing; busy: boolean; onFresh(): void }) {
  return (
    <div className="space-y-2 rounded-lg border border-destructive/40 px-4 py-3 text-xs" data-tracker-broken>
      <p className="text-destructive">
        This project&apos;s tracker file will not read: {listing.broken?.why}. Nothing is read from it, and nothing will be written over it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onFresh}>
          Start fresh
        </Button>
        <span className="text-muted-foreground">keeps the old file beside it as trackers.json.broken.</span>
      </div>
    </div>
  )
}

function SourceRow({
  source: s,
  now,
  busy,
  send,
  onRetry,
}: {
  source: ListedSource
  now: number
  busy: boolean
  send(edit: TrackerEdit): Promise<TrackerEdited | null>
  onRetry?: () => void
}) {
  const key = { tracker: s.tracker, host: s.host, repo: s.repo }
  return (
    <li className={cn('min-w-0 space-y-1 py-3 text-xs leading-snug', s.off && 'opacity-70')} data-tracker-source={sourceName(s)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-sm break-all">{sourceName(s)}</span>
        <Badge variant="outline" className="text-[10px]">
          {s.tracker === 'github' ? 'GitHub' : 'GitLab'}
        </Badge>
        {s.default && !s.off ? (
          <Badge variant="secondary" className="text-[10px]">
            default
          </Badge>
        ) : null}
      </div>
      <div className="text-muted-foreground">{rolesOf(s).join(' · ')}</div>
      {s.off ? null : (
        <WithLimitLink text={s.error ?? readSaid(s, now)} className={s.error ? 'text-destructive' : 'text-muted-foreground'} onRetry={onRetry} />
      )}
      {!s.off && s.listed ? <ReadsChoice source={s} busy={busy} send={send} /> : null}
      {!s.off && s.boards?.length
        ? s.boards.map((b) => (
            <div key={b.board} className="text-muted-foreground">
              Board {boardSaid(b)}
            </div>
          ))
        : null}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {s.off ? (
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void send({ kind: 'set', ...key, off: false })}>
            Turn back on
          </Button>
        ) : (
          <>
            {s.default ? null : (
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void send({ kind: 'set', ...key, default: true })}>
                Make default
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void send({ kind: 'set', ...key, list: !s.listed })}>
              {s.listed ? 'Stop listing recent' : 'List recent'}
            </Button>
            {s.origin === 'remote' ? (
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void send({ kind: 'set', ...key, off: true })}>
                Turn off
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void send({ kind: 'remove', ...key })}>
                Remove
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

/**
 * What a listed source reads (Jalez/kehikko#318): which kinds, which states, and whether a read asks
 * only for what changed since the last one. Folded to one line until opened; each change is one edit
 * of the tracker file and has the host read again. A ref somebody names is read whatever this says.
 */
function ReadsChoice({
  source: s,
  busy,
  send,
}: {
  source: ListedSource
  busy: boolean
  send(edit: TrackerEdit): Promise<TrackerEdited | null>
}) {
  const [open, setOpen] = useState(false)
  const reads: Reads = readsOf(s.reads ?? {}) ?? READS_DEFAULT
  const key = { tracker: s.tracker, host: s.host, repo: s.repo }
  const kinds = kindsFor(s.tracker)
  const choose = (next: Reads) => void send({ kind: 'set', ...key, reads: writtenReads(next) })
  const toggle = (kind: ReadKind, on: boolean) => {
    const next = on ? [...new Set([...reads.kinds, kind])] : reads.kinds.filter((k) => k !== kind)
    /* Something has to be read; the last kind cannot be unticked. */
    if (!next.some((k) => kinds.includes(k))) return
    choose({ ...reads, kinds: next })
  }
  const closedValue = reads.closed === true ? 'all' : reads.closed === false ? 'open' : String(reads.closed)
  const windows = [...new Set([...CLOSED_CHOICES, ...(typeof reads.closed === 'number' ? [reads.closed] : [])])].sort((a, b) => a - b)
  return (
    <div className="text-muted-foreground" data-tracker-reads={open ? 'open' : 'closed'}>
      <button
        type="button"
        aria-expanded={open}
        className="text-left underline underline-offset-2 hover:text-foreground"
        onClick={() => setOpen((was) => !was)}
      >
        Reads {readsSaid(reads, s.tracker)}
      </button>
      {open ? (
        <fieldset className="mt-1.5 space-y-2 rounded-md border p-3" disabled={busy}>
          <legend className="sr-only">What {sourceName(s)} reads</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {kinds.map((kind) => (
              <label key={kind} className="flex items-center gap-1.5 text-foreground">
                <input type="checkbox" checked={reads.kinds.includes(kind)} onChange={(e) => toggle(kind, e.target.checked)} />
                {kindSaid(kind, s.tracker)}
              </label>
            ))}
          </div>
          <label className="flex flex-wrap items-center gap-2">
            States
            <span className="w-64 max-w-full">
              <NativeSelect
                aria-label="Which states to read"
                className="h-7 text-xs"
                value={closedValue}
                onChange={(e) => {
                  const v = e.target.value
                  choose({ ...reads, closed: v === 'all' ? true : v === 'open' ? false : Number(v) })
                }}
              >
                <NativeSelectOption value="all">every state</NativeSelectOption>
                <NativeSelectOption value="open">open only</NativeSelectOption>
                {windows.map((n) => (
                  <NativeSelectOption key={n} value={String(n)}>
                    open, and closed in the last {n} days
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </span>
          </label>
          <label className="flex items-center gap-1.5 text-foreground">
            <input type="checkbox" checked={reads.since} onChange={(e) => choose({ ...reads, since: e.target.checked })} />
            Only what changed since the last read
          </label>
          <p className="leading-relaxed">
            Less to read makes every read faster. A reference a space or a module names is still read by name.
            {reads.since ? ' Everything is read whole once a day.' : ''}
          </p>
          {s.tracker === 'github' ? (
            <p>
              Background reads keep to Kehikot&apos;s share of your GitHub limit, set below.
              <Button
                type="button"
                size="sm"
                variant="link"
                data-change-limit
                className="ml-1 h-5 px-1 text-[11px]"
                onClick={() => openSettings(SETTINGS_TARGETS.githubShare.section, SETTINGS_TARGETS.githubShare.target)}
              >
                Change limit
              </Button>
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  )
}

/** A repository link, or owner/repo with its tracker; Check reads it once before it is kept. */
function AddRow({
  busy,
  send,
  setSaid,
}: {
  busy: boolean
  send(edit: TrackerEdit): Promise<TrackerEdited | null>
  setSaid(said: Said | null): void
}) {
  const id = useId()
  const [input, setInput] = useState('')
  const [tracker, setTracker] = useState<'github' | 'gitlab'>('github')
  const [host, setHost] = useState('')
  const [asking, setAsking] = useState(false)
  /* A link says its tracker by its host; a bare name cannot. */
  const plain = input.trim() !== '' && !/^(?:https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(input.trim())
  const link = /^(?:https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(input.trim())
  const known = link && /(?:^|[/@.])(?:github\.com|gitlab[\w.-]*)(?:[:/]|$)/i.test(input.trim())
  const needsTracker = plain || (link && !known)
  const rest = needsTracker ? { tracker, ...(tracker === 'gitlab' && host.trim() ? { host: host.trim() } : {}) } : {}

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
    <div {...target(SETTINGS_TARGETS.trackerAdd.target)} className={cn('min-w-0 space-y-2 border px-4 py-3', LIT_ROW, 'rounded-lg')} data-tracker-add>
      <Label htmlFor={id} className="flex items-center gap-1.5 text-sm">
        <Plus className="size-3.5" aria-hidden /> Add a source
      </Label>
      <Input
        id={id}
        aria-label="A repository link, or owner/repo"
        className="h-8 font-mono text-xs md:text-xs"
        placeholder="https://github.com/owner/repo, or owner/repo"
        value={input}
        onChange={(e) => {
          setInput(e.target.value)
          setSaid(null)
        }}
      />
      {needsTracker ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-32">
            <NativeSelect aria-label="Which tracker it is on" className="h-7 text-xs" value={tracker} onChange={(e) => setTracker(e.target.value as 'github' | 'gitlab')}>
              <NativeSelectOption value="github">GitHub</NativeSelectOption>
              <NativeSelectOption value="gitlab">GitLab</NativeSelectOption>
            </NativeSelect>
          </span>
          {tracker === 'gitlab' && plain ? (
            <Input
              aria-label="Its host, when it is not gitlab.com"
              className="h-7 min-w-40 flex-1 font-mono text-xs md:text-xs"
              placeholder="gitlab.example.org (blank is gitlab.com)"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy || asking || !input.trim()} onClick={() => void check()}>
          Check
        </Button>
        <Button
          size="sm"
          disabled={busy || asking || !input.trim()}
          onClick={async () => {
            const done = await send({ kind: 'add', input, ...rest })
            if (done?.outcome === 'changed') {
              setInput('')
              setHost('')
            }
          }}
        >
          Add
        </Button>
      </div>
    </div>
  )
}
