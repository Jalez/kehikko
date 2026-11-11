import { useCallback, useEffect, useId, useState } from 'react'
import { Inbox as InboxIcon } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { cn } from '@/lib/utils'
import { COLOUR_WORDS, type CountLook } from '@/host/inboxBar.ts'
import { Hint } from './Hint.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'
import { MessagesSection, type MessagesView } from './Messages.tsx'

/**
 * The bar's small count of what needs the person. The Inbox itself is a module on a kehikko
 * (protocol 2.79.0); this is what is left in the bar, and its rules are `host/inboxBar.ts`.
 *
 * The icon is the Inbox module's own, in the colour the module draws what needs the person in, so
 * the two read as one thing. Pressing it goes to the Inbox's container when one is on this kehikko;
 * otherwise a small popover offers to place it and lists the top items as plain text. Its checkbox,
 * "Show notification colour and number", is the person's on this machine (`server/inboxCount.ts`).
 */

/** The attention colour: the same amber the Inbox module draws "needs you" in. */
export const ATTENTION = 'text-amber-600 dark:text-amber-400'

export interface InboxCountView {
  look: CountLook
  /** The module that shows the Inbox, for its icon and the offer; null when none is known. */
  module: { id: string; name: string; icon: string | null } | null
  /** An Inbox container is on the kehikko shown: a press goes there. */
  placedHere: boolean
  onFocusInbox(): void
  open: boolean
  onOpenChange(open: boolean): void
  /** The offer to place the module on this kehikko, or null. */
  offer: { label: string; run(): void; busy?: string | null } | null
  /** The top items, as plain text. */
  items: readonly { key: string; text: string }[]
  colour: boolean
  onColour(on: boolean): void
  /** Messages between agent sessions in the open project, folded at the foot. */
  messages?: MessagesView
}

export function InboxCount({ view }: { view: InboxCountView }) {
  const { look } = view
  const box = useId()
  const icon = view.module ? (
    <ModuleIcon id={view.module.id} icon={view.module.icon} name={view.module.name} className="size-3.5" />
  ) : (
    <InboxIcon aria-hidden className="size-3.5" />
  )
  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={look.label}
      data-inbox-count=""
      data-attention={look.attention ? '' : undefined}
      onClick={(event) => {
        if (view.placedHere) {
          event.preventDefault()
          view.onFocusInbox()
        }
      }}
      className={cn('hover:text-foreground h-6 shrink-0 gap-1 px-1.5 text-[11px]', look.attention ? ATTENTION : 'text-muted-foreground')}
    >
      {icon}
      {look.number !== null ? (
        <span className="tabular-nums" data-inbox-number="">
          {look.number}
        </span>
      ) : null}
    </Button>
  )
  return (
    <Popover open={view.open && !view.placedHere} onOpenChange={(open) => view.onOpenChange(view.placedHere ? false : open)}>
      <Hint label={look.label} align="end">
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </Hint>
      <PopoverContent align="end" sideOffset={6} className="w-[min(20rem,calc(100vw-1rem))] p-2 text-xs" data-inbox-popover="">
        {view.offer ? (
          <Button size="sm" variant="secondary" className="mb-2 w-full justify-start gap-1.5" onClick={view.offer.run} disabled={Boolean(view.offer.busy)} data-inbox-add="">
            {icon}
            {view.offer.busy ?? view.offer.label}
          </Button>
        ) : null}
        {view.items.length ? (
          <ul className="mb-2 space-y-1" aria-label="what is in the Inbox" data-inbox-top="">
            {view.items.map((one) => (
              <li key={one.key} className="truncate" title={one.text}>
                {one.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground mb-2">Nothing needs you.</p>
        )}
        <label htmlFor={box} className="flex cursor-pointer items-center gap-2 border-t pt-2">
          <Checkbox id={box} checked={view.colour} onCheckedChange={(on) => view.onColour(on === true)} data-inbox-colour="" />
          <span>{COLOUR_WORDS}</span>
        </label>
        {view.messages ? (
          <div className="mt-1 border-t pt-1">
            <MessagesSection view={view.messages} />
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** The checkbox's value, from `/host/settings`, and the person's change of it. On until told. */
export function useInboxColour(): [boolean, (on: boolean) => void] {
  const [colour, setColour] = useState(true)
  useEffect(() => {
    let cancelled = false
    void fetch('/host/settings', { cache: 'no-store' })
      .then((response) => response.json())
      .then((got: { inbox?: { colour?: unknown } }) => {
        if (!cancelled && typeof got?.inbox?.colour === 'boolean') setColour(got.inbox.colour)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  const change = useCallback((on: boolean) => {
    setColour(on)
    void fetch('/host/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inbox: { colour: on } }) })
      .then((response) => response.json())
      .then((got: { inbox?: { colour?: unknown } }) => {
        if (typeof got?.inbox?.colour === 'boolean') setColour(got.inbox.colour)
      })
      .catch(() => setColour(!on))
  }, [])
  return [colour, change]
}
