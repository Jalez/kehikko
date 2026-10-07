import { ChevronDown, Focus, X } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { focusSaid, goneSaid, pickedIn, toggled, type Part } from '@/host/parts.ts'
import { Hint } from './Hint.tsx'

/**
 * Which parts of the open epic the project is pointed at.
 *
 * ## Beside the epic, because it is the same question asked more narrowly
 *
 * The epic control answers "what is this project about"; this answers "which
 * of it". It sits immediately after it in the bar and before the kehikko, and
 * that order is the argument: it depends on the epic and on nothing to its
 * right. Switching kehikko leaves it exactly where it is, for the reason it
 * leaves the epic — see `Subject` in `server/canvases.ts`.
 *
 * ## Checkboxes, and nothing ticked means everything
 *
 * A person wants one part, or two, or all of them, so it is a set and the
 * control is a list of boxes. The resting state is NONE ticked, and none
 * ticked is the whole epic — not "nothing". That reads oddly for the half
 * second before the first press and is right every moment after it: ticking
 * one box narrows to that part, which is the gesture, and a control whose
 * resting state was eight ticked boxes would need seven presses to say "just
 * this one". The first row says it in words, with its own tick, so the empty
 * state is an answer on screen rather than an absence.
 *
 * ## It is not drawn for an epic with no parts
 *
 * Most epics have none, and a disabled control saying "no parts" in the bar of
 * every one of them would be furniture. The house rule is that a control is
 * disabled rather than hidden so that an absence explains nothing — but there
 * is nothing here to explain: an epic with no parts has no narrower question
 * to ask, and the epic control beside it already says what is open. It comes
 * back the moment the epic's file has a group in it.
 *
 * ## When it is narrowed, it has to be seen
 *
 * This is the control whose failure is silent. A person focuses on one part
 * on Monday, and on Thursday a module is showing six references out of forty
 * and nothing says why. So the narrowed state is filled, in the primary
 * colour, with the part's own name or a count in it — the one loud thing in a
 * bar of quiet ones — and it carries its own clear button outside the menu, so
 * undoing it is one press and does not have to be found.
 *
 * ## And when what it was narrowed to is gone, that has to be seen too
 *
 * A part can be removed while it is picked. The focus then stops applying,
 * which is right, and used to stop applying in silence, which was not: see
 * `goneSaid` in `host/parts.ts`.
 *
 * ## The menu stays open while boxes are pressed
 *
 * Picking two parts is two presses, and a menu that shut after the first would
 * make it four. Each press is written at once, like every other change to what
 * a project is about; there is no "apply".
 */
export function Parts({
  parts,
  picked,
  onPick,
}: {
  /** Every part of the open epic, in the epic's order. Empty draws nothing. */
  parts: readonly Part[]
  /** The stored ids. Ones that name no part here are ignored, and dropped on the next press. */
  picked: readonly string[]
  /** What is picked now. `[]` is the whole epic. */
  onPick(ids: string[]): void
}) {
  if (parts.length === 0) return null
  const on = pickedIn(parts, picked)
  const said = focusSaid(parts, picked)
  const gone = goneSaid(parts, picked)

  return (
    <span className="inline-flex shrink-0 items-center" data-narrowed={said.narrowed ? '' : undefined}>
      <DropdownMenu>
        <Hint label={said.hint} align="start">
          <DropdownMenuTrigger asChild>
            <Button
              variant={said.narrowed ? 'default' : 'ghost'}
              size="sm"
              aria-label={
                said.narrowed
                  ? `focused on ${on.length} of ${parts.length} parts of this epic`
                  : 'the parts of this epic — all of them are shown'
              }
              className={
                said.narrowed
                  ? 'h-6 max-w-56 gap-1 rounded-r-none px-1.5 text-xs'
                  : 'text-muted-foreground h-6 max-w-56 gap-1 px-1.5 text-xs'
              }
            >
              <Focus className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{said.label}</span>
              <ChevronDown className="size-3 shrink-0 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="start" className="max-h-[60vh] w-80 overflow-auto">
          <DropdownMenuLabel>parts of this epic</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              if (on.length) onPick([])
            }}
          >
            <Checkbox checked={on.length === 0} tabIndex={-1} aria-hidden className={BOX} />
            <span className="flex-1">the whole epic</span>
            <span className="text-muted-foreground shrink-0 text-[11px]">all {parts.length} parts</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {parts.map((part) => (
            <DropdownMenuItem
              key={part.id}
              onSelect={(event) => {
                event.preventDefault()
                onPick(toggled(parts, picked, part.id))
              }}
            >
              <Checkbox checked={on.includes(part.id)} tabIndex={-1} aria-hidden className={BOX} />
              <span className="min-w-0 flex-1 truncate">{part.heading}</span>
              {/* What is under the heading, when the file says. A part with
                  nothing in it yet is still a part somebody can pick; the
                  blank here is why a module then shows nothing for it. */}
              <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{countOf(part)}</span>
            </DropdownMenuItem>
          ))}
          {said.narrowed ? (
            <p className="text-muted-foreground border-t px-2 pt-1.5 pb-1 text-[11px] leading-snug">
              Every module is told. One that follows the focus shows these parts only and says how much it left
              out; one that has not learned to still shows the whole epic. Steps and references in no part
              belong to the epic as a whole, and are outside any focus.
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {said.narrowed ? (
        <Hint label="show the whole epic again">
          <Button
            variant="default"
            size="sm"
            aria-label="clear the focus and show the whole epic"
            className="h-6 rounded-l-none border-l border-l-white/25 px-1 text-xs"
            onClick={() => onPick([])}
          >
            <X className="size-3" />
          </Button>
        </Hint>
      ) : null}
      {/*
        A stored pick that names a part the epic no longer has. It narrows
        nothing — `pickedIn` sees to that — and that is exactly why it is
        said: the bar has just gone from a filled, named focus to "all
        parts", every module has widened, and without this nothing on screen
        says why. Amber and not filled: it is news about the focus, not a
        focus. One press forgets it; see `goneSaid` for why it is a press and
        not something the page does by itself.
      */}
      {gone ? (
        <Hint label={gone.hint}>
          <Button
            variant="ghost"
            size="sm"
            data-gone={gone.gone.length}
            aria-label={`${gone.label} — forget ${gone.gone.length === 1 ? 'it' : 'them'}`}
            className="ml-1 h-6 gap-1 px-1.5 text-[11px] text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
            onClick={() => onPick(gone.kept)}
          >
            <span>{gone.label}</span>
            <X className="size-3" />
          </Button>
        </Hint>
      ) : null}
    </span>
  )
}

/**
 * The box in a row: drawn, not pressed — the row is the control, so the menu's
 * own keyboard and its one press per row both work.
 *
 * The second class is there because the box is the whole message here. In the
 * dark theme the shared checkbox's `dark:bg-input/30` outranks its checked
 * fill, so a ticked box keeps a dark ground under a dark tick; a container's
 * header can live with that, beside a ring that says the same thing, and a
 * list whose only signal is the tick cannot.
 */
const BOX = 'pointer-events-none dark:data-[state=checked]:bg-primary'

/** "3 refs", "2 steps · 5 refs", or nothing at all — never a zero dressed as a count. */
function countOf(part: Part): string {
  const said: string[] = []
  if (part.steps) said.push(`${part.steps} ${part.steps === 1 ? 'step' : 'steps'}`)
  if (part.refs.length) said.push(`${part.refs.length} ${part.refs.length === 1 ? 'ref' : 'refs'}`)
  return said.join(' · ')
}
