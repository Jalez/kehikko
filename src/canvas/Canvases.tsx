import { ChevronDown, LayoutGrid, LayoutTemplate, Settings } from 'lucide-react'
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
import { openKehikkoSettings } from '@/host/kehikkoSettings.ts'
import { openSaveLayout } from '@/host/onboarding.ts'
import { kehikkoVisitKey, ordered } from '@/host/pickerOrder.ts'
import { usePickerSort, useVisits } from '@/host/pickerStore.ts'
import { ActivityDot } from './Activity.tsx'
import { Hint } from './Hint.tsx'
import { SortSwitch } from './SortSwitch.tsx'
import { AddItem, armedSelect, Remove, renameKey, RowButton } from './Menu.tsx'

/**
 * The kehikko: which one this is, which others there are, and what you can do
 * to them — the same menu the project and the epic are.
 *
 * The owner's words: "The kehikko-menu I'd also want to use the same menu as
 * the other two, all from how a kehikko is renamed etc." It used to be four
 * controls of its own — a name field, a chevron, a `+` and a bin. Now it is
 * the row grammar in `Menu.tsx`: removed by the X in two presses, made by "new
 * kehikko" at the end. The remove is flat rather than gone when this is the
 * only kehikko, because the server refuses that.
 *
 * Each row's gear (or F2 on the row) opens THAT kehikko's settings — its name,
 * its skills, its primary agent (`KehikkoSettings.tsx`). The person's words:
 * "Accessing a kehikko's settings should be from the kehikko dropdown, for each
 * one separately." The gear took the pencil's place; renaming is in General.
 */
const NO_MARKS: ReadonlyMap<string, ActivityState> = new Map()
const NO_COUNTS: ReadonlyMap<string, number> = new Map()

export function Canvases({
  canvases,
  open,
  onOpen,
  onSettings = (id) => openKehikkoSettings('general', undefined, id),
  onCreate,
  onDelete,
  marks = NO_MARKS,
  counts = NO_COUNTS,
}: {
  canvases: readonly Canvas[]
  open: Canvas | null
  onOpen(id: number): void
  /** Open one kehikko's settings; Kehikko settings by default. */
  onSettings?(id: number): void
  onCreate(): void
  onDelete(id: number): void
  /** What each kehikko (by its key) holds that a module said it is doing: a small dot on its row. */
  marks?: ReadonlyMap<string, ActivityState>
  /** How many things need the person on each kehikko (by key): a number beside its dot, so "two need you there" is read at a glance. */
  counts?: ReadonlyMap<string, number>
}) {
  /** Whether the menu is open: closed before a kehikko's settings open over it. */
  const [shown, setShown] = useState(false)
  /** Which kehikko's removal has been asked about but not yet confirmed. */
  const [arming, setArming] = useState<number | null>(null)
  const alone = canvases.length < 2
  const sort = usePickerSort('kehikot')
  const visits = useVisits()
  const listed = ordered(canvases, sort, (one) => one.name, (one) => (one.key === undefined || one.project === null ? undefined : visits.kehikot[kehikkoVisitKey(one.project, one.key)]))
  const settings = (id: number) => {
    setShown(false)
    /* After the menu has closed and given focus back, so the window takes it. */
    setTimeout(() => onSettings(id), 0)
  }

  return (
    <DropdownMenu open={shown} onOpenChange={setShown}>
      <Hint label={`kehikko — ${canvases.length} in all`} align="start">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="switch kehikko"
            data-tour="kehikko"
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
          setArming(null)
        }}
      >
        <DropdownMenuLabel>kehikot</DropdownMenuLabel>
        <SortSwitch picker="kehikot" label="kehikot" />
        {listed.map((canvas) => (
          <DropdownMenuItem
            key={canvas.id}
            onSelect={armedSelect(arming === canvas.id, () => setArming(null), () => onOpen(canvas.id))}
            onKeyDown={renameKey(() => settings(canvas.id))}
            className="group/row"
          >
            <DropdownMenuCheck checked={canvas.id === open?.id} />
            <span className="min-w-0 flex-1 truncate">{canvas.name}</span>
            {canvas.key !== undefined && marks.get(canvas.key) ? (
              <ActivityDot state={marks.get(canvas.key)!} what={canvas.name} />
            ) : null}
            {canvas.key !== undefined && (counts.get(canvas.key) ?? 0) > 0 ? (
              <Hint label={`${counts.get(canvas.key)} ${counts.get(canvas.key) === 1 ? 'needs' : 'need'} you`}>
                <span
                  className="text-amber-600 dark:text-amber-400 shrink-0 text-[11px] tabular-nums"
                  data-attention-count={counts.get(canvas.key)}
                >
                  <span className="sr-only">, {counts.get(canvas.key) === 1 ? '1 needs' : `${counts.get(canvas.key)} need`} you</span>
                  <span aria-hidden>{counts.get(canvas.key)}</span>
                </span>
              </Hint>
            ) : null}
            <RowButton label={`settings for ${canvas.name}`} title="kehikko settings (F2)" icon={Settings} onPress={() => settings(canvas.id)} data-kehikko-settings-row={canvas.id} />
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
        <AddItem onAdd={onCreate} tour="new-kehikko">
          new kehikko…
        </AddItem>
        {/* The open one as a suggested layout — the project's, to travel
            with it, or the person's own. See `Layouts.tsx`. */}
        <DropdownMenuItem onSelect={() => openSaveLayout()} disabled={!open || open.placements.length === 0} data-save-layout-item="">
          <LayoutTemplate className="text-muted-foreground size-3 shrink-0" />
          save this kehikko as a layout…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
