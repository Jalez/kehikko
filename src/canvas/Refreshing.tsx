import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { REFRESH_EVERY_MAX, REFRESH_EVERY_MIN } from 'roadmap-module-protocol'

import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Hint } from './Hint.tsx'

/**
 * The third control a module can put in its own container's header, and the
 * first one that a clock can press.
 *
 * A module says it can be read again and when it last was; the host draws this;
 * a press — or a tick — goes back as `roadmap.refresh`. Nothing here knows what
 * the module reads, where from, or what it costs.
 *
 * ## Why this is in the header at all, when five modules drew their own
 *
 * The same argument `Filters.tsx` makes, arriving at the same place from a
 * different direction. A refresh button, a freshness line and an auto-refresh
 * setting is three controls; in a column that is routinely 220 pixels wide,
 * every module that wanted them paid a row of chrome for them, competing with
 * the thing somebody opened the module to look at. One twenty-four-pixel button
 * that opens a menu costs the header nothing when nobody is using it.
 *
 * There is a second reason that is this control's own. The interval has to
 * survive the module's next reload, and a module cannot promise that — its page
 * is loaded once and shown wherever it is asked for, so a module holding the
 * setting would give every container of itself the same one. The host stores it
 * per container, beside the filter choice, for exactly the reasons in the essay
 * on `refreshEvery` in `host/canvases.ts`.
 *
 * ## The freshness line is the MODULE's sentence, formatted here
 *
 * This host knows when it last asked. It does not know whether the module
 * answered out of a cache, whether the read failed over a reading still on
 * screen, or whether the module refreshed itself for a reason nothing here can
 * see. So `at` comes from the module, and where a module says `null` — "I
 * cannot say" — this draws no time rather than inventing one.
 *
 * That is the whole reason the line is worth having. A freshness line that can
 * be wrong is worse than none, because a stale list and a short list look
 * identical and the line is the only thing that tells them apart.
 *
 * ## What is NOT here
 *
 * No error. A refresh that failed is the module's to draw, in its own page, in
 * its own words, with whatever remedy it can offer — "this machine is not
 * logged in to GitHub" is a sentence with somewhere to go, and a header has
 * nowhere to put it. The most a host can honestly say is when the data is from.
 *
 * No count of what was read, for the reason `Clearing.tsx` has: the host would
 * be reporting a number it did not count about data it cannot see.
 */

/** How often the "3 minutes ago" line is re-rendered while the menu is open. */
const RETICK_MS = 30_000

export function RefreshButton({
  state,
  every,
  name,
  onRefresh,
  onEvery,
}: {
  /**
   * What the module last said. `undefined` for a module that has never
   * mentioned the idea — which is almost all of them — and that draws nothing
   * at all, exactly as an empty filter offer does.
   */
  state: { can: boolean; at: string | null; busy: boolean } | undefined
  /** How often this container reads again, in minutes, or `null` for only on a press. */
  every: number | null
  /** The module's name, for the sentence somebody reads before pressing. */
  name: string
  onRefresh(): void
  onEvery(every: number | null): void
}) {
  /* A module that never announced, and one that has withdrawn, draw the same
     nothing. The two are kept apart in `Live` because that is what a person
     reads when working out why a control is missing; here they are one case. */
  if (!state?.can) return null

  return (
    <DropdownMenu>
      <Hint label={`refresh: ${name} reads its material again`} side="left">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`refresh what ${name} shows${every === null ? '' : ` — every ${every} minutes`}`}
            /* Foreground in every state, for the reason `Filters.tsx` argues at
               length: this button is on almost no containers, so its presence
               is itself the message, and a fifth grey icon in a row of grey
               icons does not deliver one. */
            className="text-foreground pointer-events-auto size-6 cursor-default"
            /* Stops the grid reading the press as the start of a drag, which
               would make this button unpressable — see `Container.tsx`. */
            onMouseDown={(event) => event.stopPropagation()}
          >
            {/* Turning while the module says it is reading. The module is the
                only side that knows: this host posted a message into a frame
                and has no idea whether anything is happening. */}
            <RefreshCw className={state.busy ? 'size-3 animate-spin' : 'size-3'} />
          </Button>
        </DropdownMenuTrigger>
      </Hint>

      {/* Bounded in width like the filter menu, and for the same reason: it
          floats over the canvas, so it cannot push a container about, and it
          must not cover half the screen either. */}
      <DropdownMenuContent align="end" className="max-w-64 min-w-52">
        <DropdownMenuLabel className="text-muted-foreground min-w-0 truncate text-[11px] font-normal">
          <Ago at={state.at} />
        </DropdownMenuLabel>

        <DropdownMenuItem
          className="cursor-default text-xs"
          /* Disabled while the module says it is reading, because two reads
             racing is two subprocesses and one answer that wins for no reason
             anybody could predict — and the module is the only side that could
             have told us. */
          disabled={state.busy}
          onSelect={() => onRefresh()}
        >
          {state.busy ? 'reading…' : 'Refresh now'}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <Every every={every} onEvery={onEvery} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * When the module last read, in words, from the instant the module gave.
 *
 * ## `null` prints nothing about time, and says why
 *
 * "I cannot say" is a real answer — a module that has never successfully read
 * anything is in it — and the honest rendering of it is not "never" and
 * certainly not the current time. It is a sentence saying the module has not
 * said, which is a thing somebody can act on: it means the list below is from
 * nowhere yet.
 *
 * ## Re-ticked while the menu is open
 *
 * "2 minutes ago" is wrong a minute later, and this menu is a thing people
 * leave open while they decide. Half a minute is finer than the resolution of
 * anything printed here.
 */
function Ago({ at }: { at: string | null }) {
  const [, retick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => retick((n) => n + 1), RETICK_MS)
    return () => clearInterval(timer)
  }, [])

  if (at === null) return <span>this module has not said when it last read</span>
  const when = Date.parse(at)
  /* The schema has already refused anything that is not an instant; this is
     what is left if a host somewhere ships without running it. Printing the raw
     string is better than printing `NaN minutes ago`. */
  if (Number.isNaN(when)) return <span title={at}>last read at an unreadable time</span>
  return (
    <span title={new Date(when).toLocaleString()}>last read {said(Date.now() - when)}</span>
  )
}

/** Coarse on purpose: nothing in a header is worth a number that changes every second. */
function said(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1 minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

/**
 * The auto-refresh setting: a toggle and a number of minutes.
 *
 * ## Off is `null` and not zero
 *
 * Zero would be an interval of no length, which a program will one day divide
 * by or loop on, and it would also be a setting that reads as "as often as
 * possible" to whoever finds it in the database. `null` says the thing that is
 * true: this container reads when somebody presses.
 *
 * ## The number is remembered while the toggle is off
 *
 * Locally, for as long as the menu is mounted. Somebody who switches it off and
 * on again meant the interval they had, and asking them to type 15 twice is the
 * kind of small rudeness that makes a control feel broken. What is STORED is
 * still `null`, because the stored value is what the timer reads.
 *
 * ## Typing is not committed on every keystroke
 *
 * `1` is on the way to `15`, and committing it would put a container on a
 * one-minute clock for as long as somebody's finger was moving. So the field is
 * local and the setting is written on blur or on Enter, clamped to what the
 * protocol allows — a person who types 5000 meant "rarely", and a day is this
 * protocol's word for that.
 */
function Every({ every, onEvery }: { every: number | null; onEvery(every: number | null): void }) {
  const [typed, setTyped] = useState(String(every ?? 15))

  useEffect(() => {
    if (every !== null) setTyped(String(every))
  }, [every])

  const commit = () => {
    const wanted = Number(typed)
    if (!Number.isFinite(wanted) || wanted <= 0) {
      /* Not a number, or nothing. The field goes back to what is stored rather
         than silently turning the clock off — somebody who cleared the box to
         retype has not said "stop refreshing". */
      setTyped(String(every ?? 15))
      return
    }
    const kept = Math.min(REFRESH_EVERY_MAX, Math.max(REFRESH_EVERY_MIN, Math.round(wanted)))
    setTyped(String(kept))
    if (every !== null) onEvery(kept)
  }

  return (
    <div className="flex flex-col gap-1 px-2 py-1.5">
      <label className="flex cursor-default items-center gap-2 text-xs">
        <input
          type="checkbox"
          className="size-3"
          checked={every !== null}
          onChange={(event) => onEvery(event.target.checked ? Math.max(REFRESH_EVERY_MIN, Number(typed) || 15) : null)}
        />
        <span>Refresh on its own</span>
      </label>
      <div className="flex items-center gap-1.5 pl-5">
        <span className="text-muted-foreground text-[11px]">every</span>
        <Input
          type="number"
          inputMode="numeric"
          min={REFRESH_EVERY_MIN}
          max={REFRESH_EVERY_MAX}
          value={typed}
          aria-label="minutes between refreshes"
          /* Disabled rather than hidden while the clock is off, so the setting
             does not jump about as it is switched — and so somebody can see
             what it would be before they switch it on. */
          disabled={every === null}
          className="h-6 w-16 text-xs"
          onChange={(event) => setTyped(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            /* Menus treat typing as type-ahead and arrows as navigation; both
               would move the highlight instead of editing the number. Escape is
               left alone, because closing the menu is what Escape does
               everywhere else in this host. */
            if (event.key !== 'Escape') event.stopPropagation()
            if (event.key === 'Enter') commit()
          }}
        />
        <span className="text-muted-foreground text-[11px]">minutes</span>
      </div>
    </div>
  )
}
