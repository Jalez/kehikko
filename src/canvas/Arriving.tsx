import { placementShows } from '@/host/arriving.ts'
import { ModuleCover } from './Conditions.tsx'
import { Missing } from './Missing.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'

/**
 * What stands in a container whose module the page has no presence for: on its way until a reading
 * of the whole registry says otherwise, and only then missing (`placementShows`).
 */
export function Absent({
  id,
  reading,
  name,
  onRemove,
}: {
  id: string
  /** The page's latest reading of the modules, or null before its first. */
  reading: { scanned?: boolean } | null
  /** The module's name as the last reading gave it, for the cover. */
  name: string | null
  onRemove(): void
}) {
  return placementShows(false, reading) === 'arriving' ? <Arriving id={id} name={name} /> : <Missing id={id} onRemove={onRemove} />
}

/**
 * A container for a module the page has no reading for yet: the host's first
 * look at its registry has not come back. Not `Missing.tsx` — nothing is known
 * to be missing yet (`placementShows` in `host/arriving.ts`) — but the cover a
 * module's page shows on its way, with its icon and its name as the last
 * reading gave them. The header is the same shape as a real container's, so
 * it drags by its header and narrows the way its neighbours do.
 */
export function Arriving({ id, name }: { id: string; name: string | null }) {
  const shown = name ?? id
  return (
    <div className="pointer-events-none @container/container relative flex h-full flex-col overflow-hidden rounded-lg border" data-testid="arriving" data-module={id}>
      <header className="container-grip bg-card pointer-events-auto flex h-8 shrink-0 cursor-move items-center gap-2 border-b px-2.5 select-none @max-[300px]/container:gap-1">
        <ModuleIcon id={id} name={shown} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs" title={id}>
          {shown}
        </span>
      </header>
      <div className="bg-card pointer-events-auto min-h-0 flex-1">
        <ModuleCover state="loading" at="" id={id} name={shown} />
      </div>
    </div>
  )
}
