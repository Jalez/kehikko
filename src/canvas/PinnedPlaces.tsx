import { ArrowDown, ArrowUp, Pin, PinOff } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import { movedBy, movedOnto, PIN_CHORD, PINNED_SAYS } from '@/host/pinnedPlaces.ts'
import { Hint } from './Hint.tsx'
import { HIT_AREA } from './Menu.tsx'
import type { PinnedView } from './usePinnedPlaces.ts'

/**
 * The pinned places, right after the breadcrumb, and the Pin button beside
 * them (`src/host/pinnedPlaces.ts` has every rule).
 *
 * The menu lists each pin by its label — project › epic › parts · kehikko —
 * newest first unless the person put them in another order (drag a row onto
 * another, or its arrows, or Alt+↑/↓). Picking one goes there as the person's
 * own pickers go; a pin whose project, kehikko, epic or parts are gone is
 * greyed with the reason and can still be unpinned (its button, or Delete).
 *
 * On the strip it gives way first: "Pinned" and its count at 900 pixels and
 * wider, the pin alone under it. The Pin button is an icon at every width.
 */
export function PinnedMenu({ view }: { view: PinnedView }) {
  const [dragging, setDragging] = useState<number | null>(null)
  const ids = view.places.map((one) => one.id)
  const count = view.places.length
  const said = count ? `${PINNED_SAYS.menu} — ${count}` : PINNED_SAYS.menu

  return (
    <DropdownMenu onOpenChange={(open) => open && view.onOpen()}>
      <Hint label={said} align="start">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={said}
            data-testid="pinned-menu"
            data-tour="pinned"
            className="text-muted-foreground hover:text-foreground h-6 min-w-6 shrink-0 gap-1 px-1.5 text-xs max-[900px]:px-1"
          >
            <Pin className="size-3 shrink-0" />
            <span className="max-[900px]:hidden" data-testid="pinned-label">
              Pinned
            </span>
            {count ? (
              <span className="tabular-nums text-[11px] max-[900px]:hidden" aria-hidden>
                {count}
              </span>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-80 overflow-auto" data-testid="pinned-list">
        <DropdownMenuLabel>{PINNED_SAYS.menu.toLowerCase()}</DropdownMenuLabel>
        {count === 0 ? (
          <p className="text-muted-foreground px-2 pb-2 text-xs" data-testid="pinned-empty">
            {PINNED_SAYS.empty}
          </p>
        ) : (
          view.places.map((pin, i) => {
            const up = i > 0
            const down = i < count - 1
            const stale = pin.stale !== null
            return (
              <DropdownMenuItem
                key={pin.id}
                data-pinned={pin.id}
                data-stale={stale || undefined}
                aria-disabled={stale || undefined}
                draggable
                onDragStart={(event) => {
                  setDragging(pin.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', String(pin.id))
                }}
                onDragOver={(event) => {
                  if (dragging === null || dragging === pin.id) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragging !== null && dragging !== pin.id) view.onOrder(movedOnto(ids, dragging, pin.id))
                  setDragging(null)
                }}
                onDragEnd={() => setDragging(null)}
                onSelect={(event) => {
                  /* A stale pin goes nowhere; the menu stays for its unpin. */
                  if (stale) {
                    event.preventDefault()
                    return
                  }
                  view.onGo(pin)
                }}
                onKeyDown={(event) => {
                  const moving = event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                  if (event.key !== 'Delete' && event.key !== 'Backspace' && !moving) return
                  event.preventDefault()
                  if (!moving) view.onUnpin(pin.id)
                  else if (event.key === 'ArrowUp' && up) view.onOrder(movedBy(ids, pin.id, -1))
                  else if (event.key === 'ArrowDown' && down) view.onOrder(movedBy(ids, pin.id, 1))
                }}
                className={`group/row items-start ${dragging === pin.id ? 'opacity-50' : ''}`}
              >
                <span className={`flex min-w-0 flex-1 flex-col ${stale ? 'text-muted-foreground' : ''}`}>
                  <span className="truncate" title={pin.label} data-testid="pinned-row-label">
                    {pin.label}
                  </span>
                  {pin.stale || pin.note ? (
                    <span className="text-muted-foreground text-[11px] leading-snug whitespace-normal" data-testid="pinned-row-why">
                      {pin.stale ?? pin.note}
                    </span>
                  ) : null}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5 pt-0.5">
                  <span className="hidden items-center gap-1.5 group-hover/row:inline-flex group-focus/row:inline-flex">
                    <Tool label={PINNED_SAYS.upRow(pin.label)} title="move up (Alt+↑)" off={!up} onPress={() => view.onOrder(movedBy(ids, pin.id, -1))}>
                      <ArrowUp className="size-3" />
                    </Tool>
                    <Tool label={PINNED_SAYS.downRow(pin.label)} title="move down (Alt+↓)" off={!down} onPress={() => view.onOrder(movedBy(ids, pin.id, 1))}>
                      <ArrowDown className="size-3" />
                    </Tool>
                  </span>
                  <Hint label="unpin (Delete)">
                    <button
                      type="button"
                      aria-label={PINNED_SAYS.unpinRow(pin.label)}
                      data-testid="pinned-unpin"
                      className={`text-muted-foreground hover:text-foreground relative ${HIT_AREA} shrink-0`}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        view.onUnpin(pin.id)
                      }}
                    >
                      <PinOff className="size-3" />
                    </button>
                  </Hint>
                </span>
              </DropdownMenuItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Pin the place on screen, or unpin it: filled while pinned. Alt+Shift+P does the same. */
export function PinButton({ view }: { view: PinnedView }) {
  const pinned = view.here !== null
  const words = !view.canPin ? PINNED_SAYS.noPlace : pinned ? PINNED_SAYS.unpin : PINNED_SAYS.pin
  const button = (
    <Button
      variant="ghost"
      size="icon"
      aria-label={pinned ? PINNED_SAYS.unpin : PINNED_SAYS.pin}
      aria-pressed={pinned}
      aria-keyshortcuts={PIN_CHORD.aria}
      disabled={!view.canPin}
      data-testid="pin-here"
      data-tour="pin"
      className={pinned ? 'text-foreground size-6 shrink-0' : 'text-muted-foreground hover:text-foreground size-6 shrink-0'}
      onClick={view.onToggle}
    >
      <Pin className="size-3" fill={pinned ? 'currentColor' : 'none'} />
    </Button>
  )
  const label = view.canPin ? `${words} (${PIN_CHORD.said})` : words
  /* A disabled button gets no pointer events, so its tooltip goes on a wrapper then. */
  return view.canPin ? (
    <Hint label={label}>{button}</Hint>
  ) : (
    <Hint label={label}>
      <span className="inline-flex shrink-0">{button}</span>
    </Hint>
  )
}

/** One of a row's small presses: a span, the click stopped and the pointerdown not, as `RowPencil` in `Menu.tsx` says. */
function Tool({ label, title, off, onPress, children }: { label: string; title: string; off: boolean; onPress(): void; children: ReactNode }) {
  return (
    <Hint label={title}>
      <span
        role="button"
        tabIndex={-1}
        aria-label={label}
        aria-disabled={off || undefined}
        className={`${off ? 'text-muted-foreground opacity-30' : 'text-muted-foreground hover:text-foreground'} relative shrink-0 ${HIT_AREA}`}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (!off) onPress()
        }}
      >
        {children}
      </span>
    </Hint>
  )
}
