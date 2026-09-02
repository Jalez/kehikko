import { X } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import { Hint } from './Hint.tsx'

/**
 * A container for a module this computer has no registration for.
 *
 * ## Why this is drawn at all
 *
 * The arrangement is kept in the project's own folder and travels with it —
 * see `server/kehikot.ts`. The other computer will not have every module
 * registered, and a container for `roadmap.paper` arriving on a machine that
 * has never heard of `roadmap.paper` has two honest fates: drawn as a
 * container that says so, or taken off. The page used to take it off AND write
 * the arrangement back without it, which was defensible when the only way a
 * registration could be missing was somebody deleting the file, and is
 * destructive now: the write would go into the file, the file would be
 * committed, and the other computer would pull a layout with its own
 * containers gone. So the placement stays exactly as it arrived, and this is
 * what stands in the rectangle.
 *
 * ## What it is not
 *
 * Not `silent`, not `asleep`, not `starting` — those are conditions of a
 * program this host knows where to find. This host does not know where to
 * find this one, and `Conditions.tsx` would be lying to say anything about
 * it. The one control is the remove button, because taking a container off
 * is the one decision a person can still make about it here; everything else
 * needs the program.
 *
 * `@container/container` and the same header rule the real container uses,
 * so it drags by its header and narrows the way its neighbours do.
 */
export function Missing({ id, onRemove }: { id: string; onRemove(): void }) {
  return (
    <div className="pointer-events-none @container/container relative flex h-full flex-col overflow-hidden rounded-lg border border-dashed">
      <header className="container-grip bg-card pointer-events-auto flex h-8 shrink-0 cursor-move items-center gap-2 border-b px-2.5 select-none @max-[300px]/container:gap-1">
        <span className="bg-muted-foreground/40 size-1.5 shrink-0 rounded-full" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={id}>
          {id}
        </span>
        <span className="text-muted-foreground shrink-0 text-[11px] @max-[300px]/container:hidden">missing</span>
        <Hint label="take it off this kehikko" side="left">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`take ${id} off the canvas`}
            className="text-muted-foreground hover:text-foreground -mr-1 size-6 cursor-default"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onRemove}
          >
            <X className="size-3" />
          </Button>
        </Hint>
      </header>
      <div className="bg-card/80 pointer-events-auto flex min-h-0 flex-1 items-center justify-center p-3">
        <p className="text-muted-foreground max-w-prose text-center text-xs leading-snug">
          <span className="font-mono">{id}</span> is not registered on this computer. The container is kept in
          the layout so it is still there where it is; register the module here, or take it off.
        </p>
      </div>
    </div>
  )
}
