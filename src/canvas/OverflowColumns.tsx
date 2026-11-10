import { Fragment, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'

import { DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, EDGE_GAP } from '@/components/ui/dropdown-menu.tsx'
import { columnsFor, columnsOf, stepIn, type Section } from '@/host/headerOffer.ts'

/**
 * The header's "⋯" drawn as columns where the window has room (`columnsFor`, `columnsOf` and
 * `stepIn` in `host/headerOffer.ts` hold the rules; this draws them). The menu is a popover
 * anchored to its trigger, so it is measured against the window, not the container: Radix keeps it
 * `EDGE_GAP` pixels inside the window's edges, shifting it along the side it opens on, and the
 * columns are chosen to fit in what is left.
 *
 * The menu stays one `menu`; each section is a `group` named by its heading, vertical. A column is
 * no element a screen reader is told about. The keys: Up and Down within a column, Left and Right
 * between columns, Home and End within a column, and typing finds a row by its first letters, as
 * Radix does for the whole menu.
 */

/** One section of the overflow, drawn by whoever owns its rows. `first` is "nothing above it in its column". */
export interface OverflowPart {
  key: string
  size: number
  kind: Section['kind']
  draw(first: boolean): ReactNode
}

/** How many columns the overflow stands in while it is open: re-measured when the window changes size. */
export function useColumns(open: boolean, sections: number): number {
  const [available, setAvailable] = useState<number | null>(null)
  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    const measure = () => setAvailable(window.innerWidth - 2 * EDGE_GAP)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])
  return columnsFor(open ? available : null, sections)
}

/** The class the menu's content takes: the one list's widths, or as wide as its columns. */
export function contentClass(columns: number, list: string): string {
  return columns > 1 ? 'flex w-auto max-w-none flex-col overflow-hidden' : list
}

/** A section of the overflow: its heading, and its rows, as one vertical group named by the heading. */
export function OverflowSection({ name, title, first, children }: { name: string; title: string; first: boolean; children: ReactNode }) {
  const id = useId()
  return (
    <DropdownMenuGroup data-section={name} aria-labelledby={id} aria-orientation="vertical">
      {first ? null : <DropdownMenuSeparator />}
      <DropdownMenuLabel id={id} className="text-foreground py-1 text-[11px] font-semibold">
        {title}
      </DropdownMenuLabel>
      {children}
    </DropdownMenuGroup>
  )
}

/** The overflow's sections: one under another, or side by side in `columns` columns. */
export function OverflowSections({ parts, columns }: { parts: readonly OverflowPart[]; columns: number }) {
  if (columns <= 1) return <>{parts.map((part, index) => <Fragment key={part.key}>{part.draw(index === 0)}</Fragment>)}</>
  const laid = columnsOf(parts, columns)
  return (
    <div className="flex min-h-0 items-stretch gap-1" data-columns={laid.length} role="none">
      {laid.map((column, at) => (
        <div key={at} data-column={at} role="none" className={`flex min-h-0 w-52 shrink-0 flex-col overflow-y-auto ${at > 0 ? 'border-l pl-1' : ''}`}>
          {column.map((index, nth) => (
            <Fragment key={parts[index]!.key}>{parts[index]!.draw(nth === 0)}</Fragment>
          ))}
        </div>
      ))}
    </div>
  )
}

const ROWS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'

/**
 * The columns' keys, taken before Radix's own (`onKeyDownCapture` on the content): a key this rule
 * moves focus for is prevented, so the row's and the menu's own handlers leave it alone. Keys from a
 * submenu, which is drawn elsewhere in the document, are not this rule's.
 */
export function onColumnKeys(event: KeyboardEvent<HTMLElement>): void {
  const content = event.currentTarget
  const target = event.target as HTMLElement
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  if (!content.contains(target)) return
  const columns = [...content.querySelectorAll('[data-column]')].map((column) => [...column.querySelectorAll<HTMLElement>(ROWS)].filter((row) => !row.hasAttribute('data-disabled')))
  if (columns.length < 2) return
  const column = columns.findIndex((rows) => rows.includes(target))
  if (column < 0) return
  const next = stepIn(
    columns.map((rows) => rows.length),
    { column, row: columns[column]!.indexOf(target) },
    event.key,
  )
  if (!next) return
  event.preventDefault()
  columns[next.column]![next.row]!.focus()
}
