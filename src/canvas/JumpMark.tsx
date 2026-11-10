import { Footprints, Undo2, X } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'

import { jumpMarkText, type JumpMark as Mark } from '@/host/jump.ts'

/**
 * The mark an agent's `jump` leaves on the kehikko: "Jumped here by an
 * agent." (or "Moved to step 7 (Cap the rate) by an agent." when only the
 * step changed), and **Go back**, which restores exactly where the person was
 * — project, kehikko, epic, parts and step. See `host/jump.ts`.
 *
 * Text only: a step's title is the journey's, drawn as text and never as
 * markup. It stays until Go back, the close, or the person going somewhere
 * else themselves (`markStands`).
 */
export function JumpMark({ mark, onBack, onClose }: { mark: Mark | null; onBack(): void; onClose(): void }) {
  if (!mark) return null
  return (
    <div
      role="status"
      data-jump-mark=""
      className="bg-popover text-popover-foreground fixed bottom-3 left-1/2 z-50 flex max-w-[min(90vw,32rem)] -translate-x-1/2 items-center gap-2 rounded-md border px-3 py-2 text-xs shadow-sm"
    >
      <Footprints className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">{jumpMarkText(mark)}</p>
      <Button type="button" variant="ghost" size="sm" data-jump-back="" onClick={onBack} className="h-auto shrink-0 gap-1 rounded px-1.5 py-0.5 text-xs">
        <Undo2 className="size-3" aria-hidden />
        Go back
      </Button>
      <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose} className="text-muted-foreground hover:text-foreground size-5 shrink-0 rounded">
        <X className="size-3.5" aria-hidden />
      </Button>
    </div>
  )
}
