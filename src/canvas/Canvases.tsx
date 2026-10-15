import { ChevronDown, LayoutGrid } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import type { Canvas } from '@/host/canvases.ts'
import type { ActivityState } from 'kehikot-module-protocol'
import { worstOther } from '@/host/activity.ts'
import { ActivityDot } from './Activity.tsx'
import { Hint } from './Hint.tsx'
import { AddItem, armedSelect, NameForm, Remove, renameKey, RowPencil } from './Menu.tsx'

/**
 * The kehikko: which one this is, which others there are, and what you can do
 * to them — the same menu the project and the epic are.
 *
 * The owner's words: "The kehikko-menu I'd also want to use the same menu as
 * the other two, all from how a kehikko is renamed etc." It used to be four
 * controls of its own — a name field, a chevron, a `+` and a bin. Now it is
 * the row grammar in `Menu.tsx`: renamed by the pencil or F2, removed by the X
 * in two presses, made by "new kehikko" at the end. The remove is flat rather
 * than gone when this is the only kehikko, because the server refuses that.
 */
const NO_MARKS: ReadonlyMap<string, ActivityState> = new Map()
const NO_COUNTS: ReadonlyMap<string, number> = new Map()

export function Canvases({
  canvases,
  open,
  onOpen,
  onRename,
  onCreate,
  onDelete,
  marks = NO_MARKS,
  counts = NO_COUNTS,
}: {
  canvases: readonly Canvas[]
  open: Canvas | null
  onOpen(id: number): void
  onRename(id: number, name: string): void
  onCreate(): void
  onDelete(id: number): void
  /** What each kehikko (by its key) holds that a module said it is doing: a small dot on its row. */
  marks?: ReadonlyMap<string, ActivityState>
  /** How many things need the person on each kehikko (by key): a number beside its dot, so "two need you there" is read at a glance. */
  counts?: ReadonlyMap<string, number>
}) {
  /** Which kehikko is being renamed, if any. Null is the ordinary list. */
  const [editing, setEditing] = useState<number | null>(null)
  /** Which kehikko's removal has been asked about but not yet confirmed. */
  const [arming, setArming] = useState<number | null>(null)
  const alone = canvases.length < 2
  const renaming = canvases.find((one) => one.id === editing) ?? null

  return (
    <DropdownMenu>
      <Hint label={`kehikko — ${canvases.length} in all`} align="start">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="switch kehikko"
            className="text-foreground h-6 max-w-52 min-w-6 shrink-[0.01] gap-1 max-[400px]:min-w-5 px-1.5 text-xs font-medium max-[640px]:has-[>svg]:px-1"
          >
            <LayoutGrid className="text-muted-foreground size-3 shrink-0 max-[640px]:hidden" />
            <span className="min-w-0 truncate">{open?.name ?? 'no kehikko'}</span>
            {(() => {
              const other = worstOther(marks, open?.key ?? null)
              return other ? <ActivityDot state={other} what="another kehikko" /> : null
            })()}
            <ChevronDown className="text-muted-foreground size-3 shrink-0 max-[640px]:hidden" />
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
        {renaming ? (
          <NameForm
            key={renaming.id}
            heading="rename this kehikko"
            initial={renaming.name}
            label={`what ${renaming.name} is called`}
            placeholder="kehikko"
            maxLength={60}
            onSave={(name) => {
              onRename(renaming.id, name)
              return true
            }}
            onDone={() => setEditing(null)}
          />
        ) : (
          <>
            <DropdownMenuLabel>kehikot</DropdownMenuLabel>
            {canvases.map((canvas) => (
              <DropdownMenuItem
                key={canvas.id}
                onSelect={armedSelect(arming === canvas.id, () => setArming(null), () => onOpen(canvas.id))}
                onKeyDown={renameKey(() => setEditing(canvas.id))}
                className="group/row"
              >
                <DropdownMenuCheck checked={canvas.id === open?.id} />
                <span className="min-w-0 flex-1 truncate">{canvas.name}</span>
                {canvas.key !== undefined && marks.get(canvas.key) ? (
                  <ActivityDot state={marks.get(canvas.key)!} what={canvas.name} />
                ) : null}
                {canvas.key !== undefined && (counts.get(canvas.key) ?? 0) > 0 ? (
                  <span
                    className="text-amber-600 dark:text-amber-400 shrink-0 text-[11px] tabular-nums"
                    data-attention-count={counts.get(canvas.key)}
                    title={`${counts.get(canvas.key)} ${counts.get(canvas.key) === 1 ? 'needs' : 'need'} you`}
                  >
                    <span className="sr-only">, {counts.get(canvas.key) === 1 ? '1 needs' : `${counts.get(canvas.key)} need`} you</span>
                    <span aria-hidden>{counts.get(canvas.key)}</span>
                  </span>
                ) : null}
                <RowPencil label={`rename ${canvas.name}`} title="rename (F2)" onStart={() => setEditing(canvas.id)} />
                {/* How much is on it: how a person tells two kehikot apart
                    when they gave both the same forgettable name. */}
                <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                  {canvas.placements.length}
                </span>
                <Remove
                  armed={arming === canvas.id}
                  label={`remove ${canvas.name}`}
                  question="remove it?"
                  disabled={alone}
                  why={alone ? 'the only kehikko cannot be removed' : 'remove — the modules on it keep running'}
                  onArm={() => setArming(canvas.id)}
                  onConfirm={() => {
                    setArming(null)
                    onDelete(canvas.id)
                  }}
                />
              </DropdownMenuItem>
            ))}
            <AddItem onAdd={onCreate}>new kehikko</AddItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
