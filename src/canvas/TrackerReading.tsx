import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import type { TrackerState } from '@/host/projects.ts'
import { Hint } from './Hint.tsx'

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
 */
export function TrackerReading({ tracker, onRefresh }: { tracker: TrackerState; onRefresh(): void }) {
  const now = useNow(30_000)
  const failed = tracker.sources.filter((s) => s.error)
  const age = tracker.at ? ago(Date.parse(tracker.at), now) : null
  const label = tracker.refreshing
    ? 'reading the trackers…'
    : failed.length
      ? `${failed.length === tracker.sources.length ? 'trackers' : `${failed.length} tracker${failed.length === 1 ? '' : 's'}`} not read`
      : age
        ? `trackers read ${age}`
        : tracker.sources.length
          ? 'trackers not read yet'
          : 'no trackers'

  return (
    <Popover>
      <Hint label="the GitHub and GitLab reading every module on this project shows — press for its sources and Refresh all">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            className={`h-6 gap-1 px-1.5 text-[11px] font-normal ${failed.length ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <RefreshCw className={`size-3 ${tracker.refreshing ? 'animate-spin' : ''}`} />
            <span>{label}</span>
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="w-96 space-y-2 p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">
            Tracker reading{tracker.at ? `, ${new Date(tracker.at).toLocaleString()}` : ', never read'}
          </span>
          <Button size="sm" className="h-6 px-2 text-xs" disabled={tracker.refreshing} onClick={onRefresh}>
            <RefreshCw className={`size-3 ${tracker.refreshing ? 'animate-spin' : ''}`} />
            {tracker.refreshing ? 'Reading…' : 'Refresh all'}
          </Button>
        </div>
        {tracker.sources.length ? (
          <ul className="space-y-1">
            {tracker.sources.map((s) => (
              <li key={`${s.tracker}|${s.host}|${s.repo}`} className="leading-snug">
                <span className="font-mono">
                  {s.host === 'github.com' || s.host === 'gitlab.com' ? s.repo : `${s.host}/${s.repo}`}
                </span>
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
        ) : (
          <p className="text-muted-foreground">
            This project has no GitHub or GitLab remote. Name the repositories it reads in
            {' '}
            <span className="font-mono">.kehikot/kehikko/trackers.json</span>.
          </p>
        )}
        <p className="text-muted-foreground">
          Read with your own logged-in <span className="font-mono">gh</span> and{' '}
          <span className="font-mono">glab</span>. Every container on this project is told when a read lands.
        </p>
      </PopoverContent>
    </Popover>
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

/** How long ago, in the words a strip has room for. */
export function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}
