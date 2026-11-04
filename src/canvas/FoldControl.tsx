import { ChevronDown, ChevronUp } from 'lucide-react'
import { useId, useMemo, useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { foldHint } from '@/host/folds.ts'
import { FOLD_ROWS_SAID, LongPress, SHOW_ROWS, SHOW_ROWS_SAID, opensFoldChoice, type FoldRows, type ShowRows } from '@/host/rows.ts'
import { Hint } from './Hint.tsx'

/**
 * Fold a container, or open it again — and, held, choose how far it folds.
 *
 * A plain press folds to the remembered choice (`foldRows`) or unfolds, as it
 * always did. When the module's footer is drawn there are two choices, and a
 * long press (`LONG_PRESS_MS`), Shift+Enter, Shift+F10, the context-menu key,
 * a right click or ArrowDown opens a small menu of them: one row, the header;
 * two rows, the header and the footer. Picking one folds to it.
 *
 * Under it, a second group: when this container's header and footer show —
 * as the bar says, always, on hover, on click (`reveal`, the same choice as
 * the Frame menu's "Header and footer"). It is here as well because this is
 * the control a person holds when the rows are what they are thinking about.
 * Picking one changes when the rows show and folds nothing. With neither a
 * second fold nor `reveal` there is no menu, and the control is exactly the
 * button it was.
 *
 * The menu is the shared dropdown, so it closes on a press outside it and on
 * the keyboard leaving for a module's page (`useCloseOnFrameBlur`).
 */
export function FoldControl({
  collapsed,
  foldedBy,
  foldRows,
  choices,
  onCollapse,
  onFold,
  reveal,
}: {
  collapsed: boolean
  foldedBy: string | null
  /** The remembered choice: how far a plain press folds. */
  foldRows: FoldRows
  /** What may be chosen: `foldChoices` in `host/rows.ts`. One choice: no menu. */
  choices: readonly FoldRows[]
  onCollapse(collapsed: boolean): void
  /** A choice picked from the menu: remember it and fold to it. */
  onFold(rows: FoldRows): void
  /** When the header and footer show: the container's own choice (`null`: the bar's), what the bar says, and the change. Absent: no such group. */
  reveal?: { mode: ShowRows | null; bar: ShowRows; onChange(mode: ShowRows | null): void }
}) {
  const [open, setOpen] = useState(false)
  const long = useMemo(() => new LongPress(() => setOpen(true)), [])
  const described = useId()
  const choosable = choices.length > 1
  /* Whether a held press opens a menu at all: a second fold to choose, or when the rows show. */
  const menu = choosable || reveal !== undefined
  /* The fold a plain press makes: the remembered one, when it can be drawn. */
  const rows: FoldRows = choosable ? foldRows : 1
  const label =
    (collapsed ? 'unfold this container' : rows === 2 ? 'fold this container down to its header and footer' : 'fold this container down to its header')
    + (foldedBy ? ` — ${collapsed ? 'folded' : 'unfolded'} by ${foldedBy}` : '')
  const className = foldedBy
    ? 'bg-primary text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground size-6 cursor-default'
    : collapsed
      ? 'text-foreground size-6 cursor-default'
      : 'text-muted-foreground hover:text-foreground data-[state=open]:bg-accent size-6 cursor-default'
  const icon = collapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />
  const hint = foldHint(collapsed, foldedBy, rows, choosable, reveal !== undefined)

  if (!menu) {
    return (
      <Hint label={hint} side="left">
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-expanded={!collapsed}
          data-tour="fold"
          data-fold-rows={collapsed ? 1 : undefined}
          data-folded-by={foldedBy ?? undefined}
          className={className}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => onCollapse(!collapsed)}
        >
          {icon}
        </Button>
      </Hint>
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (opensFoldChoice(event)) {
      event.preventDefault()
      setOpen(true)
      return
    }
    /* Enter and Space are a plain press, as on any button: taken here, before the menu's own
       trigger would read them as "open". ArrowDown is left to it — the menu button's key. */
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onCollapse(!collapsed)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Hint label={hint} side="left">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            aria-describedby={described}
            aria-keyshortcuts="Shift+Enter"
            data-tour="fold"
            data-fold-rows={collapsed ? rows : undefined}
            data-folded-by={foldedBy ?? undefined}
            className={className}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => {
              /* The menu's trigger opens on a pointerdown; here a pointerdown only arms the long press. */
              event.preventDefault()
              event.stopPropagation()
              if (event.button === 0) long.down()
            }}
            onPointerUp={() => long.cancel()}
            onPointerLeave={() => long.cancel()}
            onPointerCancel={() => long.cancel()}
            onContextMenu={(event) => {
              event.preventDefault()
              long.cancel()
              setOpen(true)
            }}
            onKeyDown={onKeyDown}
            onClick={() => {
              if (long.click()) onCollapse(!collapsed)
            }}
          >
            {icon}
            <span id={described} hidden>
              {choosable && reveal
                ? 'Hold, or press Shift+Enter, to choose one row or two, and when the header and footer show.'
                : choosable
                  ? 'Hold, or press Shift+Enter, to choose one row or two.'
                  : 'Hold, or press Shift+Enter, to choose when the header and footer show.'}
            </span>
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-1rem)]" data-menu-content="fold">
        {choosable ? (
          <>
            <DropdownMenuLabel className="text-muted-foreground py-1 text-[11px] font-normal">Fold to</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={String(foldRows)} data-fold-group="rows">
              {choices.map((choice) => (
                <DropdownMenuRadioItem key={choice} value={String(choice)} data-fold-choice={choice} className="items-start py-1 text-xs" onSelect={() => onFold(choice)}>
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{FOLD_ROWS_SAID[choice].label}</span>
                    <span className="text-muted-foreground text-[11px] leading-snug">{FOLD_ROWS_SAID[choice].line}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
        {choosable && reveal ? <DropdownMenuSeparator /> : null}
        {reveal ? (
          <>
            <DropdownMenuLabel className="text-muted-foreground py-1 text-[11px] font-normal">Header and footer</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={reveal.mode ?? 'bar'}
              data-fold-group="reveal"
              onValueChange={(value) => reveal.onChange(value === 'bar' ? null : (value as ShowRows))}
            >
              <DropdownMenuRadioItem value="bar" data-reveal-choice="bar" className="items-start py-1 text-xs">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">As the bar says</span>
                  <span className="text-muted-foreground text-[11px] leading-snug">
                    the bar’s focus control decides; now: {SHOW_ROWS_SAID[reveal.bar].label.toLowerCase()}.
                  </span>
                </span>
              </DropdownMenuRadioItem>
              {SHOW_ROWS.map((mode) => (
                <DropdownMenuRadioItem key={mode} value={mode} data-reveal-choice={mode} className="items-start py-1 text-xs">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{SHOW_ROWS_SAID[mode].label}</span>
                    <span className="text-muted-foreground text-[11px] leading-snug">{SHOW_ROWS_SAID[mode].hint}.</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
