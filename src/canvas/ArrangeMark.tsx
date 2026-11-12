import { LayoutGrid, Undo2, X } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'

import { arrangeMarkText, type ArrangeMark as Mark } from '@/host/arrange.ts'

/**
 * The mark an agent's `arrange_modules` leaves on the kehikko: "Arranged by an agent: …", the
 * containers it changed (each also outlined on the canvas, `Container.tsx`), and **Undo**, which
 * puts back the arrangement before exactly — every container's place, size and fold. See
 * `host/arrange.ts`. It stays until Undo, the close, or the person arranging the kehikko
 * themselves (`arrangeStands`).
 *
 * Text only: module names are drawn as text, never as markup. Sits above a jump's mark when both
 * are up, so neither covers the other.
 */
export function ArrangeMark({
  mark,
  names,
  raised,
  onUndo,
  onClose,
}: {
  mark: Mark | null
  names(id: string): string
  /** A jump's mark is up below it. */
  raised: boolean
  onUndo(): void
  onClose(): void
}) {
  if (!mark) return null
  return (
    <div
      role="status"
      data-arrange-mark=""
      className={`bg-popover text-popover-foreground fixed left-1/2 z-50 flex max-w-[min(90vw,32rem)] -translate-x-1/2 items-center gap-2 rounded-md border px-3 py-2 text-xs shadow-sm ${raised ? 'bottom-14' : 'bottom-3'}`}
    >
      <LayoutGrid className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">{arrangeMarkText(mark, names)}</p>
      <Button type="button" variant="ghost" size="sm" data-arrange-undo="" onClick={onUndo} className="h-auto shrink-0 gap-1 rounded px-1.5 py-0.5 text-xs">
        <Undo2 className="size-3" aria-hidden />
        Undo
      </Button>
      <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose} className="text-muted-foreground hover:text-foreground size-5 shrink-0 rounded">
        <X className="size-3.5" aria-hidden />
      </Button>
    </div>
  )
}
