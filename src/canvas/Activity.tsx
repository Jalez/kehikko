import type { ActivityState } from 'kehikot-module-protocol'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { cn } from '@/lib/utils'
import { ACTIVITY_WORDS, attentionCount, markWords, ordered, type HeldItem } from '@/host/activity.ts'
import { Hint } from './Hint.tsx'

/**
 * What the modules are doing, drawn as small dots on what already exists —
 * the container's header, an epic's row, a part's row, a kehikko's row — and
 * as ONE menu in the bar. No standing row anywhere; see `host/activity.ts`.
 *
 * Yellow is "needs you", green is "finished and not yet seen", grey is
 * "working". A working dot pulses only where the person has not asked for
 * less motion (`motion-safe:`); otherwise it is a still ring. Colour is never
 * the only sign: each dot says its state in words, to assistive technology
 * and in its tooltip.
 */
const LOOK: Record<ActivityState, string> = {
  attention: 'bg-amber-500 dark:bg-amber-400',
  done: 'bg-emerald-500 dark:bg-emerald-400',
  /* A filled grey that breathes where motion is welcome, and a hollow ring
     where it is not. */
  working:
    'bg-neutral-500 dark:bg-neutral-400 motion-safe:animate-pulse motion-reduce:bg-transparent motion-reduce:ring-[1.5px] motion-reduce:ring-inset motion-reduce:ring-neutral-500 dark:motion-reduce:ring-neutral-400',
}

/** The classes a state's dot carries; exported for a test of the reduced-motion rule. */
export const dotClasses = (state: ActivityState): string => LOOK[state]

export function ActivityDot({
  state,
  what,
  className,
}: {
  state: ActivityState
  /** What it is about, put before the state's words in the tooltip. */
  what?: string
  className?: string
}) {
  const words = markWords(state, what)
  return (
    <span
      role="img"
      title={words}
      aria-label={words}
      data-activity={state}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', LOOK[state], className)}
    />
  )
}

/** One item of the menu: the dot, its label, and who and where it is. */
export interface MenuRow {
  item: HeldItem
  seen: boolean
  module: string
  place: string
}

/**
 * The one list. Drawn only when something is held; worst first, then newest.
 * The count is what needs the person, not what is done or working.
 */
export function ActivityMenu({
  rows,
  onPress,
}: {
  rows: readonly MenuRow[]
  onPress(item: HeldItem): void
}) {
  if (rows.length === 0) return null
  const live = rows.filter((row) => !row.seen).map((row) => row.item)
  const first = ordered(live)[0]
  const needing = attentionCount(live)
  const working = live.filter((one) => one.state === 'working').length
  const done = live.filter((one) => one.state === 'done').length
  const said = [
    needing ? `${needing} ${ACTIVITY_WORDS.attention}` : null,
    working ? `${working} ${ACTIVITY_WORDS.working}` : null,
    done ? `${done} ${ACTIVITY_WORDS.done}` : null,
  ].filter(Boolean)
  const label = said.length ? `activity — ${said.join(', ')}` : 'activity — nothing new'
  const byItem = new Map(rows.map((row) => [row.item, row]))
  const sorted = [...ordered(live), ...ordered(rows.filter((row) => row.seen).map((row) => row.item))].map(
    (item) => byItem.get(item)!,
  )

  return (
    <DropdownMenu>
      <Hint label={label} align="end">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            data-activity-menu=""
            className="text-muted-foreground hover:text-foreground h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          >
            {first ? (
              <ActivityDot state={first.state} />
            ) : (
              <span aria-hidden className="ring-muted-foreground/60 inline-block size-1.5 rounded-full ring-1 ring-inset" />
            )}
            {needing > 0 ? (
              <span className="text-amber-600 tabular-nums dark:text-amber-400" data-activity-count="">
                {needing}
              </span>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="max-h-[60vh] w-96 overflow-auto">
        <DropdownMenuLabel>activity</DropdownMenuLabel>
        {sorted.map((row) => (
          <DropdownMenuItem
            key={`${row.item.module}\u0000${row.item.id}`}
            data-activity-row={row.item.state}
            title={row.item.detail ?? ACTIVITY_WORDS[row.item.state]}
            onSelect={() => onPress(row.item)}
            className="items-start gap-2"
          >
            <span className="mt-1.5 flex shrink-0">
              {row.seen ? (
                <span
                  role="img"
                  aria-label={`${ACTIVITY_WORDS.done}, seen`}
                  title={`${ACTIVITY_WORDS.done}, seen`}
                  className="ring-muted-foreground/60 inline-block size-1.5 rounded-full ring-1 ring-inset"
                />
              ) : (
                <ActivityDot state={row.item.state} />
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs">{row.item.label}</span>
              <span className="text-muted-foreground truncate text-[11px]">
                {[row.module, row.place].filter(Boolean).join(' · ')}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
