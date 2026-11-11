import { ChevronDown, ChevronUp } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import { foldHint } from '@/host/folds.ts'
import type { FoldRows } from '@/host/rows.ts'
import { Hint } from './Hint.tsx'

/**
 * Fold a container, or open it again.
 *
 * How far a fold goes — the header, or the header and the footer — and when
 * the header and footer show are Settings › Appearance's, the same for every
 * container (`host/appearance.ts`). This control used to open a menu of both
 * on a held press; it is a plain button again, and `rows` only says in its
 * words where the fold goes.
 */
export function FoldControl({
  collapsed,
  foldedBy,
  rows,
  onCollapse,
}: {
  collapsed: boolean
  foldedBy: string | null
  /** How far a press folds, as drawn: two rows only where the footer is drawn and Appearance says two. */
  rows: FoldRows
  onCollapse(collapsed: boolean): void
}) {
  const label =
    (collapsed ? 'unfold this container' : rows === 2 ? 'fold this container down to its header and footer' : 'fold this container down to its header')
    + (foldedBy ? ` — ${collapsed ? 'folded' : 'unfolded'} by ${foldedBy}` : '')
  const className = foldedBy
    ? 'bg-primary text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground size-6 cursor-default'
    : collapsed
      ? 'text-foreground size-6 cursor-default'
      : 'text-muted-foreground hover:text-foreground size-6 cursor-default'
  return (
    <Hint label={foldHint(collapsed, foldedBy, rows)} side="left">
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-expanded={!collapsed}
        data-tour="fold"
        data-fold-rows={collapsed ? rows : undefined}
        data-folded-by={foldedBy ?? undefined}
        className={className}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => onCollapse(!collapsed)}
      >
        {collapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
      </Button>
    </Hint>
  )
}
