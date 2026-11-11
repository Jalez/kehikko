import { Plus, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import type { TrackerState } from '@/host/projects.ts'
import { ago, isTimedOutSaid, sourceName, statusSaid } from '@/host/trackerSources.ts'
import { SETTINGS_TARGETS, openSettings } from '@/host/agentSettings.ts'
import { isShareNotice } from '@/host/githubShare.ts'
import { Hint } from './Hint.tsx'

export { ago }

/**
 * A sentence from a read, and — when it says Kehikot's share of the GitHub limit is used up —
 * "Change limit", which opens Settings at the control that sets it. When it says the read timed
 * out (Jalez/kehikko#317) and a read can be started from here, "Try again".
 */
export function WithLimitLink({ text, className, onRetry }: { text: string; className?: string; onRetry?: () => void }) {
  return (
    <div className={className}>
      {text}
      {onRetry && isTimedOutSaid(text) ? (
        <Button type="button" size="sm" variant="link" data-try-again className="ml-1 h-5 px-1 text-[11px]" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
      {isShareNotice(text) ? (
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
      ) : null}
    </div>
  )
}

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
 * strip itself — never only inside the menu — because a reading that
 * quietly stopped updating looks exactly like one that is current.
 *
 * ## The menu only says what was read
 *
 * One line per source — its name, its kind, what it last read or why it could
 * not, with "Try again" and "Change limit" where they apply — and "Tracker
 * settings…". Nothing is changed here: the sources, how often they are read,
 * the git remotes, the GitHub share and the news to agents are Settings ›
 * Trackers (`TrackerSettings.tsx`), which the link opens.
 */
export function TrackerReading({ tracker, onRefresh }: { tracker: TrackerState; onRefresh(): void }) {
  const now = useNow(30_000)
  const [open, setOpen] = useState(false)
  const listing = tracker.listing ?? null

  const failed = tracker.sources.filter((s) => s.error)
  const age = tracker.at ? ago(Date.parse(tracker.at), now) : null
  const empty = listing !== null && listing.sources.length === 0 && !listing.broken
  const broken = listing?.broken ?? null
  const label = tracker.refreshing
    ? 'reading the trackers…'
    : broken
      ? 'tracker file will not read'
      : empty
        ? 'add a tracker'
        : failed.length
          ? `${failed.length === tracker.sources.length ? 'trackers' : `${failed.length} tracker${failed.length === 1 ? '' : 's'}`} not read`
          : age
            ? `trackers read ${age}`
            : tracker.sources.length
              ? 'trackers not read yet'
              : 'no trackers'
  const tooltip = empty
    ? 'no trackers — this project has no GitHub or GitLab remote; press to add one in Settings'
    : 'the GitHub and GitLab reading every module on this project shows — press for what was read and Refresh all'
  const settings = empty ? SETTINGS_TARGETS.trackerAdd : SETTINGS_TARGETS.trackerSources
  const lines: Line[] = listing
    ? listing.sources.map((s) => ({ key: `${s.tracker}|${s.host}|${s.repo}`, name: sourceName(s), kind: s.tracker, error: s.off ? null : (s.error ?? null), said: statusSaid(s, now), off: s.off === true }))
    : tracker.sources.map((s) => ({
        key: `${s.tracker}|${s.host}|${s.repo}`,
        name: sourceName(s),
        kind: s.tracker,
        error: s.error ?? null,
        said: s.at ? ago(Date.parse(s.at), now) : 'not read yet',
        off: false,
      }))

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
      <PopoverContent align="end" className="max-h-[80vh] w-80 max-w-[calc(100vw-1rem)] space-y-2 overflow-y-auto p-3 text-xs" data-tracker-menu>
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium" data-tracker-read>
            {empty ? 'Trackers' : `Trackers · ${tracker.at ? `read ${timeSaid(tracker.at)}` : 'never read'}`}
          </span>
          {empty ? null : (
            <Button size="sm" className="h-6 px-2 text-xs" disabled={tracker.refreshing} onClick={onRefresh}>
              <RefreshCw className={`size-3 ${tracker.refreshing ? 'animate-spin' : ''}`} />
              {tracker.refreshing ? 'Reading…' : 'Refresh all'}
            </Button>
          )}
        </div>
        {broken ? <p className="text-destructive">This project&apos;s tracker file will not read, so nothing is read from it.</p> : null}
        {empty ? <p className="text-muted-foreground">No sources yet.</p> : null}
        {lines.length ? (
          <ul className="space-y-1.5">
            {lines.map((one) => (
              <li key={one.key} className={`leading-snug ${one.off ? 'opacity-70' : ''}`} data-tracker-line={one.name}>
                <span className="font-mono">{one.name}</span>
                <span className="text-muted-foreground"> {one.kind === 'github' ? 'GitHub' : 'GitLab'}</span>
                {one.error ? (
                  <WithLimitLink text={one.error} className="text-destructive" onRetry={tracker.refreshing ? undefined : onRefresh} />
                ) : (
                  <div className="text-muted-foreground">{one.said}</div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="border-t pt-2">
          <Button
            type="button"
            size="sm"
            variant="link"
            data-tracker-settings
            className="h-5 px-0 text-xs"
            onClick={() => {
              setOpen(false)
              openSettings(settings.section, settings.target)
            }}
          >
            Tracker settings…
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** One source as the menu says it. */
interface Line {
  key: string
  name: string
  kind: 'github' | 'gitlab'
  error: string | null
  said: string
  off: boolean
}

/** "12:40" today, the date and time before. */
function timeSaid(at: string): string {
  const then = new Date(at)
  const today = new Date().toDateString() === then.toDateString()
  return today ? then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : then.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

/** The time, re-read every `every` ms, so "read 3 minutes ago" moves while nobody touches anything. */
export function useNow(every: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}
