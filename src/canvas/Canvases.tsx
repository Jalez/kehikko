import { ChevronDown, LayoutGrid, Pencil, Plus, X } from 'lucide-react'
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
 * The kehikko: which one this is, which others there are, and what you can do
 * to them — all in one menu, the same menu the project and the epic are.
 *
 * ## It is the same menu as the other two, on purpose
 *
 * The owner's words: "The kehikko-menu I'd also want to use the same menu as
 * the other two, all from how a kehikko is renamed etc." It used to be four
 * controls of its own — a name field, a chevron, a `+` and a bin — and the
 * strip read as three different ideas of what a header control is. Now each
 * is a trigger naming what is open, a list with a check on it, and the same
 * row grammar:
 *
 *   - **renamed** by the pencil on its row, or F2, which replaces the list with
 *     a one-field form — exactly as an epic is retitled, and for the reason
 *     `Epics.tsx` gives: a row that turned into a field would lose focus to
 *     whatever row the pointer drifted onto;
 *   - **removed** by the X on its row, in two presses — exactly as a project is
 *     forgotten. Flat rather than gone when it is the only kehikko, because the
 *     server refuses that and a control that vanishes explains nothing;
 *   - **made** by "new kehikko" at the end of the list — exactly as a project is
 *     added and an epic is made.
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
  onRename(id: number, name: string): void
  onCreate(): void
  onDelete(id: number): void
}) {
  /** Which kehikko is being renamed, if any. Null is the ordinary list. */
  const [editing, setEditing] = useState<number | null>(null)
  /** Which kehikko's removal has been asked about but not yet confirmed. */
  const [arming, setArming] = useState<number | null>(null)
  const alone = canvases.length < 2

  return (
    <div className="flex shrink-0 items-center">
      <DropdownMenu>
        <Hint label={`kehikko — ${canvases.length} in all`} align="start">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="switch kehikko"
              className="text-foreground h-6 max-w-52 gap-1 px-1.5 text-xs font-medium"
            >
              <LayoutGrid className="text-muted-foreground size-3 shrink-0" />
              <span className="min-w-0 truncate">{open?.name ?? 'no kehikko'}</span>
              <ChevronDown className="text-muted-foreground size-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent
          align="start"
          className="max-h-[60vh] w-64 overflow-auto"
          onCloseAutoFocus={() => {
            setEditing(null)
            setArming(null)
          }}
        >
          {editing !== null ? (
            <Rename
              key={editing}
              canvas={canvases.find((one) => one.id === editing) ?? null}
              onRename={onRename}
              onDone={() => setEditing(null)}
            />
          ) : (
            <>
              <DropdownMenuLabel>kehikot</DropdownMenuLabel>
              {canvases.map((canvas) => (
                <DropdownMenuItem
                  key={canvas.id}
                  onSelect={(event) => {
                    if (arming === canvas.id) {
                      event.preventDefault()
                      return
                    }
                    setArming(null)
                    onOpen(canvas.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'F2') return
                    event.preventDefault()
                    setEditing(canvas.id)
                  }}
                  className="group/row"
                >
                  <DropdownMenuCheck checked={canvas.id === open?.id} />
                  <span className="min-w-0 flex-1 truncate">{canvas.name}</span>
                  {/* A span, not a button, and only the click stopped — see the
                      pencil in `Epics.tsx` for why stopping pointerdown here
                      would pick the row instead. */}
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`rename ${canvas.name}`}
                    title="rename (F2)"
                    className="text-muted-foreground hover:text-foreground pointer-events-auto shrink-0 opacity-0 group-hover/row:opacity-100 group-focus/row:opacity-100"
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setEditing(canvas.id)
                    }}
                  >
                    <Pencil className="size-3" />
                  </span>
                  {/* How much is on it: how a person tells two kehikot apart
                      when they gave both the same forgettable name. */}
                  <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                    {canvas.placements.length}
                  </span>
                  {arming === canvas.id ? (
                    <button
                      type="button"
                      className="text-destructive shrink-0 text-[10px] font-medium"
                      onClick={(event) => {
                        event.stopPropagation()
                        setArming(null)
                        onDelete(canvas.id)
                      }}
                    >
                      remove it?
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={alone ? 'the only kehikko cannot be removed' : `remove ${canvas.name}`}
                      title={alone ? 'the only kehikko cannot be removed' : 'remove — the modules on it keep running'}
                      disabled={alone}
                      className="text-muted-foreground hover:text-destructive shrink-0 disabled:opacity-40 disabled:hover:text-muted-foreground"
                      onClick={(event) => {
                        event.stopPropagation()
                        setArming(canvas.id)
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onCreate}>
                <Plus className="text-muted-foreground size-3 shrink-0" />
                <span className="flex-1">new kehikko</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * The rename form, in place of the list — the kehikko's twin of `Retitle` in
 * `Epics.tsx`. Every key stops here, because the menu around it reads typing as
 * typeahead. Enter saves, Escape abandons, and an empty name is a slip of the
 * hand rather than a rename.
 */
function Rename({
  canvas,
  onRename,
  onDone,
}: {
  canvas: Canvas | null
  onRename(id: number, name: string): void
  onDone(): void
}) {
  const [draft, setDraft] = useState(canvas?.name ?? '')
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  if (!canvas) return null

  const commit = () => {
    const name = draft.trim()
    if (name && name !== canvas.name) onRename(canvas.id, name)
    onDone()
  }

  return (
    <div
      className="px-2 py-1.5"
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') onDone()
      }}
    >
      <p className="text-muted-foreground pb-1.5 text-xs font-medium">rename this kehikko</p>
      <Input
        ref={field}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={`what ${canvas.name} is called`}
        placeholder="kehikko"
        spellCheck={false}
        maxLength={60}
        className="h-7 w-full text-xs"
      />
      <div className="flex justify-end gap-1 pt-2">
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onDone}>
          cancel
        </Button>
        <Button size="sm" className="h-6 px-2 text-xs" onClick={commit}>
          save
        </Button>
      </div>
    </div>
  )
}
