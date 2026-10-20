import { MapPinOff, X } from 'lucide-react'
import { useEffect } from 'react'

import type { WentNote } from './useGoToPlace.ts'

/** How long the line stays before it goes by itself. */
const SHOWN_MS = 8_000

/**
 * The quiet line after an Inbox item was pressed and could not be gone to all
 * the way: its kehikko is gone, its module is not on it, or it never said
 * where it came from. See `useGoToPlace`. Text only — the words are the host's,
 * with names the person gave.
 */
export function WentTo({ note, onClose }: { note: WentNote | null; onClose(): void }) {
  useEffect(() => {
    if (!note) return
    const gone = setTimeout(onClose, SHOWN_MS)
    return () => clearTimeout(gone)
  }, [note, onClose])

  if (!note) return null
  return (
    <div
      role="status"
      data-went-to=""
      className="bg-popover text-popover-foreground fixed bottom-3 left-1/2 z-50 flex max-w-[min(90vw,32rem)] -translate-x-1/2 items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-sm"
    >
      <MapPinOff className="text-muted-foreground mt-px size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">{note.text}</p>
      <button type="button" aria-label="Close" onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0">
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}
