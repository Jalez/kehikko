import { Filter, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { CONTROLS_TITLE, type Control } from '@/host/headerOffer.ts'
import type { FilterGroup } from 'kehikot-module-protocol'
import type { Choice } from '@/host/filters.ts'
import { DISARM_AFTER_MS, saying as clearSaying } from './Clearing.tsx'
import { FilterChoices, saying as filterSaying } from './Filters.tsx'
import { RefreshChoices } from './Refreshing.tsx'
import { OverflowSection } from './OverflowColumns.tsx'

/**
 * The module's own row controls — filter, clear, refresh — and the host's remove, as rows of the
 * header's "⋯" under 220 px, where `layoutOf` (`host/headerOffer.ts`) takes them out of the row so
 * that nothing is pushed past its edge. The same choices as the buttons, from the same components
 * (`FilterChoices`, `RefreshChoices`), and the same words (`saying` in `Filters.tsx` and
 * `Clearing.tsx`).
 *
 * The two that destroy something keep a two-press arm in the menu: the first press changes what
 * the row says and leaves the menu open, the second acts. It comes down after `DISARM_AFTER_MS`,
 * when what it would clear changes, and when the menu closes (the row unmounts).
 */

const ROW = 'cursor-default gap-2 text-xs'

/** What the module's row controls are drawn from, wherever they are drawn. */
export interface ControlParts {
  name: string
  filter: { groups: readonly FilterGroup[]; chosen: Choice; onChoose(group: string, option: string | string[]): void; onEverything(): void }
  clear: { label: string | null; onClear(): void }
  refresh: { state: { can: boolean; at: string | null; busy: boolean } | undefined; every: number | null; onRefresh(): void; onEvery(every: number | null): void }
}

/** Which row controls the module offers now, for `layoutOf`. */
export function controlsOf(parts: ControlParts): Control[] {
  const out: Control[] = []
  if (parts.filter.groups.length) out.push('filter')
  if (parts.clear.label !== null) out.push('clear')
  if (parts.refresh.state?.can) out.push('refresh')
  return out
}

/** The controls' section of the "⋯": labelled, in `CONTROLS` order. */
export function ControlRows({ parts, controls, first }: { parts: ControlParts; controls: readonly Control[]; first: boolean }) {
  const { name, filter, clear, refresh } = parts
  return (
    <OverflowSection name="controls" title={CONTROLS_TITLE} first={first}>
      {controls.includes('filter') && filter.groups.length ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={ROW} data-control="filter" title={filterSaying(name, false).hint}>
            <Filter className="text-muted-foreground size-3.5" aria-hidden />
            <span className="flex-1">Filter</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-w-56 min-w-44">
            <FilterChoices groups={filter.groups} chosen={filter.chosen} onChoose={filter.onChoose} onEverything={filter.onEverything} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {controls.includes('clear') && clear.label !== null ? <ClearRow name={name} label={clear.label} onClear={clear.onClear} /> : null}
      {controls.includes('refresh') && refresh.state?.can ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={ROW} data-control="refresh" title={`refresh: ${name} reads its material again`}>
            <RefreshCw className={refresh.state.busy ? 'text-muted-foreground size-3.5 motion-safe:animate-spin' : 'text-muted-foreground size-3.5'} aria-hidden />
            <span className="flex-1">Refresh</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-w-64 min-w-52">
            <RefreshChoices state={refresh.state} every={refresh.every} onRefresh={refresh.onRefresh} onEvery={refresh.onEvery} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
    </OverflowSection>
  )
}

/** A two-press arm for a menu row: armed, the label changes and the menu stays open. */
function useArm(key: string): [boolean, (armed: boolean) => void] {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), DISARM_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [armed, key])
  useEffect(() => setArmed(false), [key])
  return [armed, setArmed]
}

/** The clear control as a row: the module's label, then "press again", then the clear. */
function ClearRow({ name, label, onClear }: { name: string; label: string; onClear(): void }) {
  const [armed, setArmed] = useArm(label)
  const said = clearSaying(name, label, armed)
  return (
    <DropdownMenuItem
      className={armed ? `${ROW} text-destructive focus:text-destructive` : ROW}
      data-control="clear"
      data-armed={armed ? 'true' : undefined}
      aria-label={said.name}
      title={said.hint}
      onSelect={(event) => {
        if (armed) {
          setArmed(false)
          onClear()
          return
        }
        event.preventDefault()
        setArmed(true)
      }}
    >
      <Trash2 className="size-3.5" aria-hidden />
      <span className="flex-1">{armed ? `Press again to ${label}` : `Clear: ${label}`}</span>
    </DropdownMenuItem>
  )
}

/** What the remove row says, at rest and armed. */
export function removeSaying(name: string, armed: boolean): { label: string; name: string } {
  return armed
    ? { label: 'Press again to remove', name: `press again to take ${name} off this kehikko — the module keeps running` }
    : { label: 'Remove from this kehikko', name: `take ${name} off this kehikko` }
}

/**
 * Remove, as a Container row of the "⋯" under 220 px (the × button above that). Two presses: in a
 * menu the row sits among others, and a slip there takes a container off the canvas.
 */
export function RemoveRow({ name, onRemove }: { name: string; onRemove(): void }) {
  const [armed, setArmed] = useArm(name)
  const said = removeSaying(name, armed)
  return (
    <DropdownMenuItem
      className={armed ? `${ROW} text-destructive focus:text-destructive` : ROW}
      data-frame="remove"
      data-armed={armed ? 'true' : undefined}
      aria-label={said.name}
      title="take it off this kehikko — the program keeps running"
      onSelect={(event) => {
        if (armed) {
          setArmed(false)
          onRemove()
          return
        }
        event.preventDefault()
        setArmed(true)
      }}
    >
      <X className="text-muted-foreground size-3.5" aria-hidden />
      <span className="flex-1">{said.label}</span>
    </DropdownMenuItem>
  )
}
