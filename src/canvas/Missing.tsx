import { X } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Hint } from './Hint.tsx'
import { reinstallModule } from '@/host/official.ts'

/**
 * A container for a module this computer has no registration for.
 *
 * ## Why this is drawn at all
 *
 * The arrangement is kept in the project's own folder and travels with it —
 * see `server/kehikot.ts`. The other computer will not have every module
 * registered, and a container for `kehikot.paper` arriving on a machine that
 * has never heard of `kehikot.paper` has two honest fates: drawn as a
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
            aria-label={`take ${id} off this kehikko`}
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
          <span className="font-mono">{id}</span> is not installed on this computer. Its container stays where it
          is; install the module from Kehikko modules, or take it off this kehikko.
        </p>
      </div>
    </div>
  )
}

/**
 * A container for a module the person uninstalled on this computer (`server/uninstall.ts`): "Module
 * removed", never a broken frame. The placement stays, for the reason `Missing` gives — the
 * arrangement travels with the project — and the two decisions left are the person's: Reinstall
 * (from the list it came from: `reinstallModule`), or Remove container. Same header shape as a
 * real container, so it drags and narrows like its neighbours.
 */
export function Removed({ id, name, onRemove }: { id: string; name: string; onRemove(): void }) {
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'asking' } | { kind: 'refused'; why: string }>({ kind: 'idle' })
  const reinstall = () => {
    setState({ kind: 'asking' })
    void reinstallModule(id).catch((error: unknown) => setState({ kind: 'refused', why: (error as Error).message }))
  }
  return (
    <div className="pointer-events-none @container/container relative flex h-full flex-col overflow-hidden rounded-lg border border-dashed" data-removed={id}>
      <header className="container-grip bg-card pointer-events-auto flex h-8 shrink-0 cursor-move items-center gap-2 border-b px-2.5 select-none @max-[300px]/container:gap-1">
        <span className="bg-muted-foreground/40 size-1.5 shrink-0 rounded-full" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs" title={id}>
          {name}
        </span>
        <span className="text-muted-foreground shrink-0 text-[11px] @max-[300px]/container:hidden">removed</span>
      </header>
      <div className="bg-card/80 pointer-events-auto flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3 text-center">
        <p className="text-xs font-medium">Module removed</p>
        <p className="text-muted-foreground max-w-prose text-xs leading-snug">
          {name} was uninstalled from this computer. Its container stays where it is, with what it saved in this project.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={state.kind === 'asking'} onClick={reinstall}>
            {state.kind === 'asking' ? 'Reinstalling…' : 'Reinstall'}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onRemove}>
            Remove container
          </Button>
        </div>
        {state.kind === 'refused' ? <p className="text-destructive max-w-prose text-[11px] leading-snug">{state.why}</p> : null}
      </div>
    </div>
  )
}
