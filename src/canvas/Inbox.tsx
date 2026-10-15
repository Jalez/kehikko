import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import type { ActivityState } from 'kehikot-module-protocol'

import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { cn } from '@/lib/utils'
import type { Namer } from '@/host/activity.ts'
import {
  STATE_WORDS,
  ageWords,
  byLine,
  closedWords,
  elsewhereWords,
  fold,
  inScope,
  isSeen,
  placeLines,
  rowKey,
  sections,
  wasWords,
  type Entry,
  type FoldedRow,
  type LogRow,
  type Priority,
  type Scope,
  type Tally,
} from '@/host/inbox.ts'
import { ActivityDot } from './Activity.tsx'
import { Hint } from './Hint.tsx'

/**
 * The Inbox: ONE control in the bar and a panel opened on demand. No standing
 * row anywhere. See `host/inbox.ts` for the record and its rules.
 *
 * ## What the panel says, top to bottom
 *
 *  - Nothing asking for the person: a sentence ("Nothing needs you.") with
 *    what is going on elsewhere, and a press to switch scope.
 *  - A primary row, **Next: <label> — <place>**, that goes to the most
 *    pressing thing and, pressed again, to the next (`nextOf`).
 *  - **Needs you** (urgent first, then the longest waiting), **Working**,
 *    **Finished** (unseen), and **Earlier** (the log; collapsed, paged).
 *  - Each row says WHO before it says what ("<module> says …"): the by-line
 *    is the host's word, the label the module's claim.
 *
 * Never colour alone: every dot is beside the state in words. Working
 * pulses only where motion is welcome (`ActivityDot`).
 */

export interface InboxView {
  /** Every open entry of the project (put-away ones are filtered here). */
  entries: readonly Entry[]
  /** How many closed entries the record holds: whether there is an Earlier at all. */
  earlierCount: number
  at: { epic: string | null; kehikko: string | null }
  scope: Scope
  onScope(scope: Scope): void
  names: Namer
  tally: Tally
  /** What Next would go to now; null when nothing needs the person. */
  next: Entry | null
  open: boolean
  onOpenChange(open: boolean): void
  onGo(entry: Entry): void
  onNext(): void
  onSee(entries: readonly Entry[]): void
  onDismiss(entries: readonly Entry[]): void
  /** `null` is everything shown in the log. */
  onForget(keys: readonly { module: string; id: string }[] | null): void
  onSeeAll(): void
  loadLog(offset: number, limit: number): Promise<{ rows: LogRow[]; more: boolean; total: number } | null>
  /** Changes whenever the record does; the log is read again. */
  rev: number
  shortcut: string
  now: () => number
}

const PAGE = 20
/** Rows drawn per section before "show more": a bound on the DOM. */
const SECTION_ROWS = 25

const sayNames = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The control's words, for its tooltip and its accessible name. */
export function controlWords(tally: Tally, shortcut: string): string {
  const said: string[] = []
  const need = tally.needHere + tally.needElsewhere
  if (need) {
    said.push(
      tally.needElsewhere
        ? `${tally.needHere} ${tally.needHere === 1 ? 'needs' : 'need'} you here, ${tally.needElsewhere} in other kehikot`
        : `${need} ${need === 1 ? 'needs' : 'need'} you`,
    )
  }
  if (tally.working) said.push(`${tally.working} working`)
  if (tally.finished) said.push(`${tally.finished} finished`)
  return `inbox — ${said.length ? said.join(', ') : 'nothing new'} (${shortcut} for the next that needs you)`
}

function Mark({ priority }: { priority: Priority }) {
  if (priority !== 'urgent') return null
  return (
    <span className="rounded border border-amber-500/60 px-1 text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-300">
      urgent
    </span>
  )
}

function Ring({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="ring-muted-foreground/60 inline-block size-1.5 shrink-0 rounded-full ring-1 ring-inset"
    />
  )
}

interface RowProps {
  dot: ActivityState | null
  ringLabel?: string
  by: string
  state: string
  label: string
  detail?: string
  place: string
  age: string
  priority: Priority
  count?: number
  expanded?: boolean
  onPress(): void
  action?: { label: string; title: string; run(): void }
  dim?: boolean
  data: string
}

function Row({ dot, ringLabel, by, state, label, detail, place, age, priority, count, expanded, onPress, action, dim, data }: RowProps) {
  return (
    <li
      data-inbox-row={data}
      className={cn('group/row hover:bg-accent/60 flex items-start gap-1 rounded-sm px-1.5 py-1', dim && 'opacity-80')}
    >
      <button
        type="button"
        onClick={onPress}
        title={detail ?? undefined}
        aria-expanded={count && count > 1 ? expanded : undefined}
        className="focus-visible:ring-ring/50 flex min-w-0 flex-1 cursor-pointer flex-col items-stretch rounded-sm text-left outline-none focus-visible:ring-[3px]"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
          <span className="flex shrink-0">
            {dot ? <ActivityDot state={dot} what={state} /> : <Ring label={ringLabel ?? state} />}
          </span>
          <span className="text-muted-foreground min-w-0 truncate">
            <span className="text-foreground/80">{by}</span>
            <span aria-hidden> · </span>
            <span className="sr-only">, </span>
            {state}
          </span>
          <Mark priority={priority} />
          <span className="text-muted-foreground/80 ml-auto shrink-0 whitespace-nowrap tabular-nums">{age}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 pl-3 text-xs">
          <span className="min-w-0 truncate">{label}</span>
          {count && count > 1 ? (
            <span className="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[10px] tabular-nums">
              {expanded ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
              {count}
            </span>
          ) : null}
        </span>
        {place ? <span className="text-muted-foreground/80 mt-px truncate pl-3 text-[11px]">{place}</span> : null}
      </button>
      {action ? (
        <button
          type="button"
          onClick={action.run}
          aria-label={action.label}
          title={action.title}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 mt-0.5 shrink-0 rounded-sm p-0.5 opacity-60 outline-none group-hover/row:opacity-100 focus-visible:opacity-100 focus-visible:ring-[3px]"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </li>
  )
}

function SectionHeading({ children, count }: { children: string; count: number }) {
  return (
    <h3 className="text-muted-foreground flex items-baseline gap-1.5 px-1.5 pt-2 pb-0.5 text-[11px] font-medium tracking-wide uppercase">
      {children}
      <span className="font-normal tabular-nums normal-case">{count}</span>
    </h3>
  )
}

export function InboxPanel({ view }: { view: InboxView }) {
  const { names, scope, at } = view
  const [earlierOpen, setEarlierOpen] = useState(false)
  const [log, setLog] = useState<{ rows: LogRow[]; more: boolean; total: number } | null>(null)
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set())
  const [shownMore, setShownMore] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => view.now())
  const nextButton = useRef<HTMLButtonElement | null>(null)

  /* Ages tick while the panel is open. */
  useEffect(() => {
    setNow(view.now())
    const timer = setInterval(() => setNow(view.now()), 30_000)
    return () => clearInterval(timer)
  }, [view])

  /* Earlier: the first page, again whenever the record changes. */
  useEffect(() => {
    let cancelled = false
    void view.loadLog(0, PAGE).then((got) => {
      if (!cancelled) setLog(got)
    })
    return () => {
      cancelled = true
    }
    // `loadLog` closes over the scope and the place; `rev` is the record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.rev, view.scope, view.at.kehikko, view.at.epic])

  const [more, setMore] = useState(false)
  const loadMore = () => {
    if (!log || more) return
    setMore(true)
    void view.loadLog(log.rows.length, PAGE).then((got) => {
      setMore(false)
      if (got) setLog((was) => (was ? { rows: [...was.rows, ...got.rows], more: got.more, total: got.total } : got))
    })
  }

  const shown = useMemo(
    () => view.entries.filter((one) => inScope(one.place, scope, at)),
    [view.entries, scope, at],
  )
  const s = useMemo(() => sections(shown), [shown])
  const unknownKehikko = at.kehikko === null
  const unplaced = scope === 'here' ? shown.filter((one) => one.place?.kehikko === undefined && one.place?.epic === undefined).length : 0
  const nothing = s.needs.length + s.working.length + s.finished.length === 0
  const elsewhere = view.tally.needElsewhere

  const row = (entry: Entry, kind: 'now' | 'member'): React.ReactElement => {
    const { here, epic } = placeLines(entry, names)
    const place = [here, epic].filter(Boolean).join(' · ') || 'the project'
    const dismissable = entry.state !== 'working'
    return (
      <Row
        key={`${kind}:${rowKey(entry)}`}
        data={entry.state}
        dot={entry.state}
        by={byLine(entry)}
        state={STATE_WORDS[entry.state]}
        label={entry.label}
        {...(entry.detail ? { detail: entry.detail } : {})}
        place={place}
        age={ageWords(now, entry.entered)}
        priority={entry.priority}
        onPress={() => view.onGo(entry)}
        {...(dismissable
          ? {
              action: {
                label: `dismiss ${entry.label}`,
                title: entry.state === 'done' ? 'Dismiss — it returns only if it changes' : 'Dismiss — it returns only if its state changes',
                run: () => view.onDismiss([entry]),
              },
            }
          : {})}
      />
    )
  }

  const folded = (list: readonly Entry[], section: string): React.ReactElement[] => {
    const rows: FoldedRow[] = fold(list)
    const cap = shownMore.has(section) ? rows.length : SECTION_ROWS
    const out: React.ReactElement[] = []
    for (const group of rows.slice(0, cap)) {
      if (group.members.length === 1) {
        out.push(row(group.head, 'now'))
        continue
      }
      const open = unfolded.has(group.key)
      const { here, epic } = placeLines(group.head, names)
      const place = [here, epic].filter(Boolean).join(' · ') || 'the project'
      out.push(
        <Row
          key={group.key}
          data={`${group.head.state}-group`}
          dot={group.head.state}
          by={byLine(group.head)}
          state={STATE_WORDS[group.head.state]}
          label={group.head.label}
          place={place}
          age={ageWords(now, group.head.entered)}
          priority={group.head.priority}
          count={group.members.length}
          expanded={open}
          onPress={() =>
            setUnfolded((was) => {
              const next = new Set(was)
              if (next.has(group.key)) next.delete(group.key)
              else next.add(group.key)
              return next
            })
          }
          {...(group.head.state !== 'working'
            ? {
                action: {
                  label: `dismiss ${group.members.length} from ${group.head.name || group.head.module}`,
                  title: 'Dismiss all of these',
                  run: () => view.onDismiss(group.members),
                },
              }
            : {})}
        />,
      )
      if (open) {
        out.push(
          <li key={`${group.key}:members`} className="border-border/60 ml-3 border-l">
            <ul>{group.members.map((member) => row(member, 'member'))}</ul>
          </li>,
        )
      }
    }
    if (rows.length > cap) {
      out.push(
        <li key={`${section}:more`} className="px-1.5 py-0.5">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-[11px] underline underline-offset-2"
            onClick={() => setShownMore((was) => new Set(was).add(section))}
          >
            show {rows.length - cap} more
          </button>
        </li>,
      )
    }
    return out
  }

  const logRow = (one: LogRow): React.ReactElement => {
    const { here, epic } = placeLines(one, names)
    const place = [here, epic].filter(Boolean).join(' · ') || 'the project'
    const what =
      one.kind === 'closed'
        ? closedWords({ state: one.state, how: one.how, origin: one.origin })
        : one.kind === 'seen'
          ? 'finished, seen'
          : wasWords(one.state)
    return (
      <Row
        key={one.key}
        data={`earlier-${one.kind}`}
        dot={null}
        ringLabel={what}
        by={byLine(one)}
        state={what}
        label={one.label}
        {...(one.detail ? { detail: one.detail } : {})}
        place={place}
        age={ageWords(now, one.at)}
        priority={one.priority}
        dim
        onPress={() => {
          /* The place of a closed thing is still a place to go to. */
          view.onGo({
            module: one.module,
            name: one.name,
            id: one.id,
            state: one.state,
            label: one.label,
            ...(one.place ? { place: one.place } : {}),
            priority: one.priority,
            refs: one.refs,
            entered: one.at,
            opened: one.at,
            closed: one.at,
            how: one.how,
            seen: null,
            dismissed: null,
            origin: one.origin,
          })
        }}
        action={{
          label: `forget ${one.label}`,
          title: 'Forget — remove it from the log',
          run: () => view.onForget([{ module: one.module, id: one.id }]),
        }}
      />
    )
  }

  const nextWhere = view.next ? [placeLines(view.next, names).here, placeLines(view.next, names).epic].filter(Boolean).join(' · ') : ''
  const unseenFinished = s.finished.length
  const logTotal = log?.total ?? 0
  const forgettable = logTotal + s.seen.length > 0

  return (
    <div className="flex max-h-[min(70vh,34rem)] min-h-0 flex-col text-sm" data-inbox-panel="">
      <div className="border-border/60 flex items-center gap-2 border-b px-2 py-1.5">
        <span className="text-xs font-medium">Inbox</span>
        <span className="flex-1" />
        <div role="group" aria-label="which kehikot the inbox shows" className="bg-muted flex rounded-md p-0.5 text-[11px]">
          {(['here', 'everywhere'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => view.onScope(value)}
              className={cn(
                'focus-visible:ring-ring/50 rounded px-1.5 py-0.5 outline-none focus-visible:ring-[3px]',
                scope === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value === 'here' ? 'This kehikko' : 'Everywhere'}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {view.next ? (
          <button
            ref={nextButton}
            type="button"
            data-inbox-next=""
            onClick={view.onNext}
            className="bg-accent/50 hover:bg-accent focus-visible:ring-ring/50 mt-1 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-[3px]"
          >
            <ActivityDot state="attention" what="needs you" />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">Next:</span> {view.next.label}
              {nextWhere ? <span className="text-muted-foreground"> — {nextWhere}</span> : null}
            </span>
            <kbd className="text-muted-foreground shrink-0 rounded border px-1 text-[10px]">{view.shortcut}</kbd>
          </button>
        ) : null}

        {nothing ? (
          <div className="px-2 py-2 text-xs" data-inbox-empty="">
            <p>{view.tally.needHere + view.tally.needElsewhere === 0 ? 'Nothing needs you.' : 'Nothing needs you here.'}</p>
            {scope === 'here' && elsewhere + view.tally.working + view.tally.finished > 0 ? (
              <p className="text-muted-foreground mt-0.5">
                {elsewhere ? `${sayNames(elsewhere, 'thing needs', 'things need')} you elsewhere` : 'Nothing here'}
                {elsewhereWords(view.tally) ? `; ${elsewhereWords(view.tally)}` : ''}.{' '}
                <button
                  type="button"
                  className="text-foreground underline underline-offset-2"
                  onClick={() => view.onScope('everywhere')}
                >
                  Show everywhere
                </button>
              </p>
            ) : view.tally.working + view.tally.finished > 0 ? (
              <p className="text-muted-foreground mt-0.5">{elsewhereWords(view.tally)}.</p>
            ) : null}
          </div>
        ) : null}

        {scope === 'here' && unknownKehikko ? (
          <p className="text-muted-foreground px-2 py-1 text-[11px]">
            This host cannot tell which kehikko is open, so everything is shown.
          </p>
        ) : scope === 'here' && unplaced > 0 ? (
          <p className="text-muted-foreground px-2 py-1 text-[11px]">
            {sayNames(unplaced, 'item does', 'items do')} not say which kehikko {unplaced === 1 ? 'it belongs' : 'they belong'} to,
            so {unplaced === 1 ? 'it is' : 'they are'} shown here.
          </p>
        ) : null}

        {s.needs.length ? (
          <section aria-label="needs you">
            <SectionHeading count={s.needs.length}>Needs you</SectionHeading>
            <ul>{folded(s.needs, 'needs')}</ul>
          </section>
        ) : null}
        {s.working.length ? (
          <section aria-label="working">
            <SectionHeading count={s.working.length}>Working</SectionHeading>
            <ul>{folded(s.working, 'working')}</ul>
          </section>
        ) : null}
        {s.finished.length ? (
          <section aria-label="finished">
            <SectionHeading count={s.finished.length}>Finished</SectionHeading>
            <ul>{folded(s.finished, 'finished')}</ul>
          </section>
        ) : null}

        {view.earlierCount > 0 || logTotal > 0 || s.seen.length > 0 ? (
          <section aria-label="earlier">
            <h3 className="px-1 pt-2 pb-0.5">
              <button
                type="button"
                aria-expanded={earlierOpen}
                onClick={() => setEarlierOpen((was) => !was)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center gap-1 rounded-sm px-0.5 text-[11px] font-medium tracking-wide uppercase outline-none focus-visible:ring-[3px]"
              >
                {earlierOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                Earlier
                <span className="font-normal tabular-nums normal-case">{log ? log.total : view.earlierCount}</span>
              </button>
            </h3>
            {earlierOpen ? (
              <ul data-inbox-earlier="">
                {log === null ? (
                  <li className="text-muted-foreground px-2 py-1 text-[11px]">Reading…</li>
                ) : log.rows.length === 0 ? (
                  <li className="text-muted-foreground px-2 py-1 text-[11px]">
                    {scope === 'here' ? 'Nothing earlier on this kehikko.' : 'Nothing earlier.'}
                  </li>
                ) : (
                  log.rows.map(logRow)
                )}
                {log?.more ? (
                  <li className="px-1.5 py-0.5">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground text-[11px] underline underline-offset-2"
                      onClick={loadMore}
                    >
                      {more ? 'Reading…' : `show ${Math.min(PAGE, log.total - log.rows.length)} more`}
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>

      {unseenFinished > 0 || forgettable ? (
        <div className="border-border/60 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t px-2 py-1 text-[11px]">
          {unseenFinished > 0 ? (
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={view.onSeeAll}>
              Mark finished as seen
            </button>
          ) : null}
          {forgettable ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              title="Remove from the log what is shown here — what is open is not touched"
              onClick={() => view.onForget(null)}
            >
              Forget what is shown
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The bar's one control: the worst live dot and the count of what needs the person. */
export function InboxControl({ view, worst }: { view: InboxView; worst: ActivityState | null }) {
  const label = controlWords(view.tally, view.shortcut)
  const needing = view.tally.needHere + view.tally.needElsewhere
  return (
    <Popover open={view.open} onOpenChange={view.onOpenChange}>
      <Hint label={label} align="end">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            data-activity-menu=""
            data-inbox-control=""
            className="text-muted-foreground hover:text-foreground h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          >
            {worst ? (
              <ActivityDot state={worst} />
            ) : (
              <span aria-hidden className="ring-muted-foreground/60 inline-block size-1.5 rounded-full ring-1 ring-inset" />
            )}
            {needing > 0 ? (
              <span className="text-amber-600 tabular-nums dark:text-amber-400" data-activity-count="">
                {needing}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[min(26rem,calc(100vw-1rem))] p-0"
        onOpenAutoFocus={(event) => {
          /* Focus the primary row when there is one, so that Enter goes to the next thing. */
          const next = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-inbox-next]')
          if (next) {
            event.preventDefault()
            next.focus()
          }
        }}
      >
        <InboxPanel view={view} />
      </PopoverContent>
    </Popover>
  )
}

/** Where `isSeen` is wanted by a caller that holds entries; re-exported so the bar need not reach into the record. */
export { isSeen }
