import { ChevronDown, ChevronUp, Maximize2 } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import type { Collapse } from '@/host/appearance.ts'
import { foldHint, tileHint } from '@/host/folds.ts'
import type { FoldRows } from '@/host/rows.ts'
import { Hint } from './Hint.tsx'

/**
 * Fold a container, make it a tile, or open it again: the collapse button (^).
 *
 * What a press on an open container does is Settings › Appearance's, the same for every container
 * (`host/appearance.ts`): fold it to its header, or make it a tile (`host/columns.ts`). How far a
 * fold goes is Appearance's too, and `rows` only says in its words where the fold goes. A folded
 * container's press unfolds it and a tile's restores it, whatever the setting says now, so the
 * press that undoes a state is always the one on this button.
 */
export function FoldControl({
  collapsed,
  tiled = false,
  makes = 'fold',
  foldedBy,
  rows,
  onCollapse,
  onTile = () => {},
}: {
  collapsed: boolean
  /** Drawn as a tile now: this button is its restore control. */
  tiled?: boolean
  /** What a press on an open container does (Settings › Appearance). */
  makes?: Collapse
  foldedBy: string | null
  /** How far a press folds, as drawn: two rows only where the footer is drawn and Appearance says two. */
  rows: FoldRows
  onCollapse(collapsed: boolean): void
  onTile?(tiled: boolean): void
}) {
  const tile = tiled || (!collapsed && makes === 'tile')
  const label = tile
    ? (tiled ? 'restore this container from its tile' : 'make this container a tile') + (foldedBy ? ` — ${tiled ? 'made a tile' : 'put back'} by ${foldedBy}` : '')
    : (collapsed ? 'unfold this container' : rows === 2 ? 'fold this container down to its header and footer' : 'fold this container down to its header')
      + (foldedBy ? ` — ${collapsed ? 'folded' : 'unfolded'} by ${foldedBy}` : '')
  const shut = collapsed || tiled
  const className = foldedBy
    ? 'bg-primary text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground size-6 cursor-default'
    : shut
      ? 'text-foreground size-6 cursor-default'
      : 'text-muted-foreground hover:text-foreground size-6 cursor-default'
  /* The same ^ on an open container whichever it does (the tooltip says which); a tile's restore is its own mark. */
  const icon = tiled ? <Maximize2 className="size-3" /> : collapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />
  return (
    <Hint label={tile ? tileHint(tiled, foldedBy) : foldHint(collapsed, foldedBy, rows)} side="left">
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-expanded={!shut}
        data-tour="fold"
        data-fold-rows={collapsed ? rows : undefined}
        data-collapse-makes={tile ? 'tile' : 'fold'}
        data-tiled={tiled ? 'true' : undefined}
        data-folded-by={foldedBy ?? undefined}
        className={className}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => (tiled ? onTile(false) : collapsed ? onCollapse(false) : makes === 'tile' ? onTile(true) : onCollapse(true))}
      >
        {icon}
      </Button>
    </Hint>
  )
}
