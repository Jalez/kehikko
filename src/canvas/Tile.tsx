import { useSyncExternalStore } from 'react'
import { OctagonAlert, TriangleAlert } from 'lucide-react'
import type { ActivityState } from 'kehikot-module-protocol'

import type { FooterSource } from '@/host/footerStore.ts'
import { TILE_INBOX, tileLabel, tileReadouts } from '@/host/tile.ts'
import { ActivityDot } from './Activity.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'

/**
 * The host's tile: what a container drawn as a tile shows when its module draws no tile of its own
 * (`host/tile.ts`). The module's icon, large and centred; its name; the crucial readouts of its
 * footer; and its Inbox state when it holds one — said in words beside the dot, never by colour
 * alone. The whole square is one button: pressing it shows the container large (`host/expand.ts`).
 *
 * A module's strings are text: the name and the readouts are never markup or a link.
 */
export function TileFace({
  id,
  name,
  footer,
  activity = null,
  onExpand,
}: {
  id: string
  name: string
  footer: FooterSource
  activity?: ActivityState | null
  /** Show the container large. Absent: the page is not there to show, and the square is no button. */
  onExpand?(): void
}) {
  const items = useSyncExternalStore(footer.subscribe, footer.get, footer.get)
  const readouts = tileReadouts(items)
  const body = (
    <>
      <ModuleIcon id={id} name={name} className="text-foreground size-8 shrink-0" />
      <span data-tile-name className="w-full truncate text-xs font-medium">
        {name}
      </span>
      {readouts.length ? (
        <span className="flex w-full min-w-0 flex-col items-center gap-0.5" data-tile-readouts>
          {readouts.map((one) => (
            <span
              key={one.id}
              data-tile-readout={one.id}
              data-level={one.level === 'normal' ? undefined : one.level}
              title={one.tooltip ?? one.text}
              className={`flex max-w-full min-w-0 items-center gap-1 text-[11px] ${one.level === 'critical' ? 'text-destructive' : one.level === 'warn' ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              {one.level === 'critical' ? <OctagonAlert className="size-3 shrink-0" aria-label="critical" /> : null}
              {one.level === 'warn' ? <TriangleAlert className="size-3 shrink-0 text-amber-600 dark:text-amber-400" aria-label="warning" /> : null}
              <span className="truncate">{one.text}</span>
            </span>
          ))}
        </span>
      ) : null}
      {activity ? (
        <span data-tile-inbox={activity} className="flex items-center gap-1.5 text-[11px] font-medium">
          <ActivityDot state={activity} what={name} className="size-2" />
          {TILE_INBOX[activity]}
        </span>
      ) : null}
    </>
  )
  const className = 'bg-card pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-1.5 overflow-hidden p-2 text-center'
  return onExpand ? (
    <button
      type="button"
      data-tile={id}
      aria-label={`${tileLabel(name)}${readouts.length ? `. ${readouts.map((one) => one.text).join('. ')}` : ''}${activity ? `. ${TILE_INBOX[activity]}` : ''}`}
      title={tileLabel(name)}
      className={`${className} hover:bg-accent/40 focus-visible:ring-ring cursor-default focus-visible:ring-2 focus-visible:outline-none`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onExpand}
    >
      {body}
    </button>
  ) : (
    <div data-tile={id} className={className}>
      {body}
    </div>
  )
}
