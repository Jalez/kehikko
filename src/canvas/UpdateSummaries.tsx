import { useEffect, useState } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { APP_REPO, fetchNotes, fetchReleases, tagFor } from '@/host/releaseNotes.ts'
import { appRange } from '@/host/whatsNew.ts'
import { capped, moreSaid, noteSummaries, summaryLines, type CompatBadge, type SummaryLine } from '@/host/updateSummaries.ts'
import { cn } from '@/lib/utils'

/**
 * What an update brings, under its row in the Updates menu: the bold
 * summaries of the notes of every release it moves through, newest first, a
 * few lines and then "+N more". Read once the row is drawn — never before the
 * menu opens — through the same request as the notes dialog, whose answers
 * the server keeps; a page-wide memo spares asking again on the next open.
 * Every line is a string child: nothing in the notes becomes markup or a link.
 */

const memo = new Map<string, Promise<string[]>>()

/** One release's summary lines, asked once per page. A failure is forgotten, so the next open asks again. */
export function summariesOf(repo: string, tag: string, load: typeof fetchNotes = fetchNotes): Promise<string[]> {
  const key = `${repo}@${tag}`
  const kept = memo.get(key)
  if (kept) return kept
  const asked = load(repo, tag).then((release) => noteSummaries(release.body))
  memo.set(key, asked)
  asked.catch(() => memo.delete(key))
  return asked
}

/** For tests: forget what was read. */
export function forgetSummaries(): void {
  memo.clear()
}

type Reading = { kind: 'reading' } | { kind: 'read'; lines: SummaryLine[] } | { kind: 'failed' }

export function useSummaries(repo: string | null, tags: readonly string[], load: typeof fetchNotes = fetchNotes): Reading {
  const key = repo && tags.length ? `${repo}|${tags.join(',')}` : null
  const [reading, setReading] = useState<{ key: string | null; at: Reading }>({ key, at: { kind: 'reading' } })
  useEffect(() => {
    if (!key || !repo) return
    let live = true
    const list = key.split('|')[1]!.split(',')
    Promise.allSettled(list.map((tag) => summariesOf(repo, tag, load))).then((settled) => {
      if (!live) return
      const read = settled.flatMap((one, i) => (one.status === 'fulfilled' ? [{ tag: list[i]!, lines: one.value }] : []))
      setReading({ key, at: read.length ? { kind: 'read', lines: summaryLines(read) } : { kind: 'failed' } })
    })
    return () => {
      live = false
    }
  }, [key, repo, load])
  return reading.key === key ? reading.at : { kind: 'reading' }
}

/**
 * The lines themselves. While they are read, as many quiet placeholder lines
 * as there are releases (up to the cap), so the row hardly moves when they
 * arrive; nothing at all when they could not be read.
 */
export function UpdateSummaries({
  repo,
  tags,
  onMore,
  load,
}: {
  repo: string | null
  /** Newest first; null while they are still being worked out. */
  tags: readonly string[] | null
  /** "+N more": the notes of every release in a dialog. */
  onMore?(opener: HTMLElement): void
  load?: typeof fetchNotes
}) {
  const reading = useSummaries(repo, tags ?? [], load)
  if (!repo || (tags !== null && tags.length === 0) || reading.kind === 'failed') return null
  if (tags === null || reading.kind === 'reading') {
    return (
      <ul className="space-y-0.5 pt-1" aria-hidden data-testid="updates-summaries-reading">
        {(tags ?? ['']).slice(0, 3).map((tag) => (
          <li key={tag} className="flex h-4 items-center">
            <span className="bg-muted h-2 w-3/4 animate-pulse rounded-sm" />
          </li>
        ))}
      </ul>
    )
  }
  if (reading.lines.length === 0) return null
  const { shown, more } = capped(reading.lines)
  return (
    <ul className="text-foreground space-y-0.5 pt-1" data-testid="updates-summaries">
      {shown.map((line, i) => (
        <li key={`${line.tag}-${i}`} className="flex h-4 items-center gap-1.5" data-testid="updates-summary" data-tag={line.tag}>
          <span aria-hidden className="text-muted-foreground shrink-0">
            •
          </span>
          <span className="min-w-0 flex-1 truncate" title={line.text}>
            {line.text}
          </span>
        </li>
      ))}
      {more > 0 ? (
        <li className="flex h-4 items-center pl-3">
          {onMore ? (
            <button
              type="button"
              data-testid="updates-summaries-more"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-[11px] underline-offset-2 outline-none hover:underline focus-visible:ring-2"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onMore(event.currentTarget)
              }}
            >
              {moreSaid(more)}
            </button>
          ) : (
            <span className="text-muted-foreground text-[11px]" data-testid="updates-summaries-more">
              {moreSaid(more)}
            </span>
          )}
        </li>
      ) : null}
    </ul>
  )
}

/** "Kehikot 0.1.129+" beside a release: quiet when this Kehikot meets it, a warning when it does not. */
export function CompatBadgeView({ badge }: { badge: CompatBadge }) {
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <span
          data-testid="updates-compat"
          data-warn={badge.warn ? '' : undefined}
          aria-label={badge.warn ? `${badge.text}. ${badge.tip}` : badge.text}
          className={cn(
            'inline-flex h-4 shrink-0 items-center rounded-sm border px-1 text-[10px] leading-none font-normal whitespace-nowrap',
            badge.warn
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300'
              : 'text-muted-foreground border-border',
          )}
        >
          {badge.text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{badge.tip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The app releases an update of the app moves through, newest first: every
 * one after `from` up to `to`, from the app's release list. Null while the
 * list is read; `to` alone when it cannot be.
 */
export function useAppTags(from: string | null, to: string | null, list: typeof fetchReleases = fetchReleases): string[] | null {
  const [tags, setTags] = useState<{ key: string; tags: string[] } | null>(null)
  const key = `${from ?? ''}>${to ?? ''}`
  useEffect(() => {
    if (!to) return
    let live = true
    const alone = [tagFor(to)]
    list(APP_REPO).then(
      (releases) => {
        if (!live) return
        const range = appRange(releases.filter((one) => !one.prerelease).map((one) => one.tag), from, to)
        setTags({ key, tags: range && range.length ? range : alone })
      },
      () => {
        if (live) setTags({ key, tags: alone })
      },
    )
    return () => {
      live = false
    }
  }, [key, from, to, list])
  if (!to) return []
  return tags?.key === key ? tags.tags : null
}
