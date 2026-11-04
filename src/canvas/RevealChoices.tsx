import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu.tsx'
import { SHOW_ROWS, SHOW_ROWS_SAID, type ShowRows } from '@/host/rows.ts'

/** When a container's header and footer show: its own choice (`null`: the bar's), what the bar says, and the change. */
export interface Reveal {
  mode: ShowRows | null
  bar: ShowRows
  onChange(mode: ShowRows | null): void
}

/**
 * The choices of when a container's header and footer show, each with its line.
 *
 * Offered in two places on purpose — the Container menu's "Header and footer", and
 * the fold control's held menu, the control a person holds when the rows are
 * what they are thinking about — and drawn by this one component in both, so
 * the two are the same words in the same order and cannot drift apart.
 */
export function RevealChoices({ reveal }: { reveal: Reveal }) {
  return (
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
  )
}
