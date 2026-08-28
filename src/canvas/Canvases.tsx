import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'
import type { Canvas } from '@/host/canvases.ts'
import { Hint } from './Hint.tsx'

/**
 * The canvas cluster: which canvas this is, which others there are, and one
 * more.
 *
 * Top left, where the name of the thing you are looking at goes in every
 * program anybody has ever used. Three controls in a row and no chrome around
 * them — the field has no border until you touch it, the chevron has no box,
 * and the plus is an icon. The strip is meant to be almost absent, and a group
 * of framed controls in the corner would be the loudest thing on a black
 * screen.
 *
 * ## The name is a field, not a menu item
 *
 * Renaming a canvas is the most common thing a person does to one, and it is
 * usually done immediately after making it — the new canvas is called "canvas"
 * and it is about to be called something else. Putting the name behind
 * "rename…" in the dropdown would make the common case two clicks and a dialog.
 * So the name is simply editable where it is displayed, and the dropdown holds
 * only the things that are not the name.
 */
export function Canvases({
  canvases,
  open,
  onOpen,
  onRename,
  onCreate,
  onDelete,
}: {
  canvases: readonly Canvas[]
  open: Canvas | null
  onOpen(id: number): void
  onRename(name: string): void
  onCreate(): void
  onDelete(id: number): void
}) {
  return (
    <div className="flex shrink-0 items-center">
      <Name canvas={open} onRename={onRename} />

      <DropdownMenu>
        <Hint label={`switch canvas — ${canvases.length} in all`}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="switch canvas"
              className="text-muted-foreground hover:text-foreground size-6 shrink-0"
            >
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>canvases</DropdownMenuLabel>
          {canvases.map((canvas) => (
            <DropdownMenuItem key={canvas.id} onSelect={() => onOpen(canvas.id)}>
              <DropdownMenuCheck checked={canvas.id === open?.id} />
              <span className="min-w-0 flex-1 truncate">{canvas.name}</span>
              {/* How much is on it. The one fact worth carrying in a switcher:
                  it is how a person tells two canvases apart when they gave
                  both the same forgettable name. */}
              <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                {canvas.placements.length}
              </span>
            </DropdownMenuItem>
          ))}
          {open && canvases.length > 1 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(open.id)}>
                <Trash2 className="size-4" />
                <span className="truncate">remove &ldquo;{open.name}&rdquo;</span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Hint label="a new, empty canvas">
        <Button
          variant="ghost"
          size="icon"
          aria-label="new canvas"
          className="text-muted-foreground hover:text-foreground size-6 shrink-0"
          onClick={onCreate}
        >
          <Plus className="size-3" />
        </Button>
      </Hint>
    </div>
  )
}

/**
 * The name, edited in place.
 *
 * ## Why the field holds a draft rather than the stored name
 *
 * The obvious version binds the input straight to the canvas and writes on
 * every keystroke. It has one bad moment and it happens every time: the write
 * is debounced, the answer comes back a beat later, and if the person kept
 * typing during that beat the answer overwrites what they typed with what the
 * server heard. A name that eats characters is a name nobody trusts to hold
 * still.
 *
 * So the field owns a draft while it is being edited, and the stored name only
 * flows in when the canvas itself changes underneath it — which is what
 * switching canvases is. The draft is committed on blur and on Enter, and
 * abandoned on Escape.
 */
function Name({ canvas, onRename }: { canvas: Canvas | null; onRename(name: string): void }) {
  const [draft, setDraft] = useState(canvas?.name ?? '')
  /* Which canvas the draft belongs to. Switching canvases must replace the
     draft; a re-render for any other reason must not. */
  const belongsTo = useRef(canvas?.id ?? null)

  useEffect(() => {
    if (belongsTo.current === canvas?.id) return
    belongsTo.current = canvas?.id ?? null
    setDraft(canvas?.name ?? '')
  }, [canvas?.id, canvas?.name])

  const commit = () => {
    const name = draft.trim()
    /* An empty field is a slip of the hand, not a rename. The stored name comes
       back into the field so that what is on screen is what is true. */
    if (!name) {
      setDraft(canvas?.name ?? '')
      return
    }
    if (name !== canvas?.name) onRename(name)
  }

  return (
    <Hint label="the name of this canvas" align="start">
      <Input
        value={draft}
        disabled={!canvas}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setDraft(canvas?.name ?? '')
            event.currentTarget.blur()
          }
        }}
        placeholder="canvas"
        aria-label="the name of this canvas"
        spellCheck={false}
        maxLength={60}
        className="hover:border-input focus-visible:border-ring h-6 w-44 border-transparent bg-transparent px-1.5 text-xs font-medium"
      />
    </Hint>
  )
}
