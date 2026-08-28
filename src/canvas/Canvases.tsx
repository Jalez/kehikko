import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'
import type { Canvas } from '@/host/canvases.ts'
import { Hint } from './Hint.tsx'

/**
 * The kehikko cluster: which one this is, which others there are, and the two
 * things you can do to the set of them.
 *
 * Top left, where the name of the thing you are looking at goes in every
 * program anybody has ever used. Four controls in a row and no chrome around
 * them — the field has no border until you touch it, and the rest are bare
 * icons. The strip is meant to be almost absent, and a group of framed controls
 * in the corner would be the loudest thing on the screen.
 *
 * ## The name is a field, not a menu item
 *
 * Renaming is the most common thing a person does to a kehikko, and it is
 * usually done immediately after making one — the new kehikko is called
 * "kehikko" and is about to be called something else. Putting the name behind
 * "rename…" in the dropdown would make the common case two clicks and a dialog.
 * So the name is editable where it is displayed.
 *
 * ## Making and removing sit together, and neither is in the menu
 *
 * They used to be split: `+` in the strip, "remove …" at the bottom of the
 * dropdown. That put the two halves of one idea in two places, and it put the
 * destructive half inside a menu whose whole job is switching — so the list you
 * open in order to CHANGE kehikko also held the one item that DESTROYS one, a
 * few pixels below the thing you meant to click.
 *
 * Now they are a pair, adjacent, both plain icons, and the menu does nothing
 * but switch. Removing is still the more dangerous of the two and is treated as
 * such: its label names what will go, and when there is only one kehikko left
 * the button goes flat rather than disappearing — a control that vanishes is
 * one a person hunts for, and its absence explains nothing.
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
        <Hint label={`switch kehikko — ${canvases.length} in all`}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="switch kehikko"
              className="text-muted-foreground hover:text-foreground size-6 shrink-0"
            >
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>kehikot</DropdownMenuLabel>
          {canvases.map((canvas) => (
            <DropdownMenuItem key={canvas.id} onSelect={() => onOpen(canvas.id)}>
              <DropdownMenuCheck checked={canvas.id === open?.id} />
              <span className="min-w-0 flex-1 truncate">{canvas.name}</span>
              {/* How much is on it. The one fact worth carrying in a switcher:
                  it is how a person tells two kehikot apart when they gave both
                  the same forgettable name. */}
              <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                {canvas.placements.length}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Hint label="a new, empty kehikko">
        <Button
          variant="ghost"
          size="icon"
          aria-label="new kehikko"
          className="text-muted-foreground hover:text-foreground size-6 shrink-0"
          onClick={onCreate}
        >
          <Plus className="size-3" />
        </Button>
      </Hint>

      {/*
       * Removing, beside making, because they are the two halves of one idea.
       *
       * Disabled rather than hidden when this is the only kehikko. The server
       * refuses that deletion anyway — a host with no kehikko has no state to
       * be in — and a button that is present and flat says so before you press
       * it, where a button that has quietly gone missing leaves you looking for
       * a feature you are sure you saw.
       */}
      <Hint
        label={
          canvases.length > 1
            ? `remove “${open?.name ?? 'this kehikko'}” — the modules on it keep running`
            : 'the only kehikko cannot be removed'
        }
      >
        {/* A span, because a disabled button dispatches no pointer events and
            so never triggers the tooltip — which is precisely the moment the
            explanation is worth having. */}
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label={open ? `remove ${open.name}` : 'remove this kehikko'}
            disabled={!open || canvases.length < 2}
            className="text-muted-foreground hover:text-destructive size-6 shrink-0 disabled:pointer-events-none"
            onClick={() => open && onDelete(open.id)}
          >
            <Trash2 className="size-3" />
          </Button>
        </span>
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
 * flows in when the kehikko itself changes underneath it — which is what
 * switching is. The draft is committed on blur and on Enter, and abandoned on
 * Escape.
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
    <Hint label="the name of this kehikko" align="start">
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
        placeholder="kehikko"
        aria-label="the name of this kehikko"
        spellCheck={false}
        maxLength={60}
        className="hover:border-input focus-visible:border-ring h-6 w-44 border-transparent bg-transparent px-1.5 text-xs font-medium"
      />
    </Hint>
  )
}
