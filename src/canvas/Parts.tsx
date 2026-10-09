import { ChevronDown, Focus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { undividedSaid, type Going, type Maker } from '@/host/dividing.ts'
import { alone, focusSaid, goneSaid, pickedIn, toggled, type Part } from '@/host/parts.ts'
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
 * ## It is drawn for an epic with no parts, and says where they are made
 *
 * It used not to be, and the paragraph that stood here argued for that: most
 * epics have no parts, and a control saying "no parts" in the bar of every
 * one of them would be furniture; "there is nothing here to explain".
 *
 * There was. The person who asked for parts opened their thesis — a chapter
 * to a file, nothing divided yet — and saw no parts control at all. Nothing
 * on screen said an epic could be divided, or where; the feature's only door
 * was drawn after somebody had already been through it. So for an epic with
 * no parts this is a quiet button, the same size and place as the picker it
 * becomes, that says "no parts" and opens to one sentence and one press. The
 * press goes to the module that makes parts, on this epic, with the place
 * open — `host/dividing.ts` has how, and why this host still writes no part
 * itself. See `Undivided` below.
 *
 * It is not drawn when NO epic is open: there is nothing to divide, and the
 * epic control beside it is already saying so.
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
 *
 * ## A row is two things to press: its box, and its name
 *
 * It was one. The whole row toggled its part, and going from "these three" to
 * "just that one" was three presses and three redraws of every module. People
 * arrive expecting what a list of ticks does everywhere else: the box adds or
 * takes away and leaves the others alone, and the name means "this one" — the
 * others are unticked. So the box is a real checkbox named for its part, and
 * the name is the menu's item, saying "only" before the heading to whoever
 * cannot see that it is not the box. Pressing the name of the only part picked
 * changes nothing; the box is the way back to none.
 *
 * On the keyboard a part is still ONE stop — two a row would double the walk
 * down the list — and the two presses are two keys: Space ticks, as it does on
 * a checkbox, and Enter picks the part alone.
 *
 * Either way it is one `onPick` with the whole list: one write, one context.
 * See `alone` in `host/parts.ts`.
 */
export function Parts({
  parts,
  picked,
  onPick,
  epic = null,
  undivided = null,
}: {
  /** Every part of the open epic, in the epic's order. Empty draws the way to make some. */
  parts: readonly Part[]
  /** The stored ids. Ones that name no part here are ignored, and dropped on the next press. */
  picked: readonly string[]
  /** What is picked now. `[]` is the whole epic. */
  onPick(ids: string[]): void
  /** The open epic. With none there is nothing to divide, and nothing is drawn. */
  epic?: string | null
  /** Where parts are made and the press that goes there — what an epic with no parts draws. */
  undivided?: Undividing | null
}) {
  if (parts.length === 0) {
    /* A stored pick that names nothing is still said, beside the entry: the
       last part of an epic can be removed while it is picked. */
    return epic !== null && undivided ? <Undivided undivided={undivided} gone={goneSaid(parts, picked)} onPick={onPick} /> : null
  }
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
          {parts.map((part) => {
            const ticked = on.includes(part.id)
            const toggle = () => onPick(toggled(parts, picked, part.id))
            return (
              <div key={part.id} data-part={part.id} className="flex items-center">
                <Checkbox
                  checked={ticked}
                  tabIndex={-1}
                  aria-label={part.heading}
                  className={TICK}
                  /* The press must not take the focus out of the menu's own
                     walk: the arrow keys belong to its items. */
                  onPointerDown={(event) => event.preventDefault()}
                  onCheckedChange={toggle}
                />
                <Hint label="only this part" side="right">
                  <DropdownMenuItem
                    className="min-w-0 flex-1 pl-1"
                    onSelect={(event) => {
                      event.preventDefault()
                      const next = alone(parts, picked, part.id)
                      if (next) onPick(next)
                    }}
                    onKeyDown={(event) => {
                      /* Space is the box's key. Prevented, so the menu does
                         not also take it as a press on the name. */
                      if (event.key !== ' ') return
                      event.preventDefault()
                      toggle()
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <span className="sr-only">only </span>
                      {part.heading}
                    </span>
                    {/* What is under the heading, when the file says. A part with
                        nothing in it yet is still a part somebody can pick; the
                        blank here is why a module then shows nothing for it. */}
                    <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{countOf(part)}</span>
                  </DropdownMenuItem>
                </Hint>
              </div>
            )
          })}
          {said.narrowed ? (
            <p className="text-muted-foreground border-t px-2 pt-1.5 pb-1 text-[11px] leading-snug">
              Every module is told. One that follows the focus shows these parts only and says how much it left
              out; one that has not learned to still shows the whole epic. Steps, references and files of
              the paper in no part belong to the epic as a whole, and are outside any focus.
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

/** What `useDividing` hands the bar: where the module that makes parts is, and the press. */
export interface Undividing {
  maker: Maker
  going: Going
  trouble: string | null
  ask(): void
  press(): void
}

/**
 * The parts control of an epic that has none.
 *
 * ## One sentence, one place, one press
 *
 * Opened, it says three things and each is there because its absence was the
 * complaint: that the epic is not divided (so the control is not broken),
 * what a part is for (so a person knows whether they want one), and WHERE
 * parts are made, by name, with whether that module is on this kehikko, on
 * this computer, or neither. Then one button, worded as what it does —
 * `undividedSaid` has the words, as data.
 *
 * ## A popover and not the menu the picker is
 *
 * The picker is a list of rows somebody presses several of, and a dropdown
 * menu is the right thing for a list. This is prose and a button, and a
 * menu's roles — every child a `menuitem` — are wrong for a paragraph a
 * screen reader should simply read.
 *
 * ## It closes itself when the person has arrived, and stays when they have not
 *
 * The press ends with Journeys scrolled into view on the canvas below, and a
 * popover left standing over it would be in the way of exactly what was
 * asked for. When the press did NOT arrive — the module did not answer, the
 * install failed — it stays open, because the sentence saying so is in it.
 */
function Undivided({
  undivided,
  gone,
  onPick,
}: {
  undivided: Undividing
  gone: ReturnType<typeof goneSaid>
  onPick(ids: string[]): void
}) {
  const [open, setOpen] = useState(false)
  const said = undividedSaid(undivided.maker, undivided.going, undivided.trouble)
  /* Closed on the edge from "a press is in flight" to "it is not, and nothing
     went wrong". Not while idle: opening the popover must not close it. */
  const was = useRef(false)
  useEffect(() => {
    const flying = undivided.going !== null
    if (was.current && !flying && undivided.trouble === null) setOpen(false)
    was.current = flying
  }, [undivided.going, undivided.trouble])

  return (
    <span className="inline-flex shrink-0 items-center" data-undivided={undivided.maker.at}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) undivided.ask()
        }}
      >
        <Hint label={said.hint} align="start">
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="the parts of this epic — it is not divided into parts yet"
              className="text-muted-foreground h-6 max-w-56 gap-1 px-1.5 text-xs"
            >
              <Focus className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{said.label}</span>
              <ChevronDown className="size-3 shrink-0 opacity-70" />
            </Button>
          </PopoverTrigger>
        </Hint>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-1rem)] space-y-2 p-3 text-xs leading-snug">
          <p className="text-foreground text-sm font-medium">parts of this epic</p>
          <p className="text-muted-foreground">{said.lead}</p>
          <p data-where>{said.where}</p>
          {said.trouble ? (
            <p role="alert" data-trouble className="text-amber-600 dark:text-amber-400">
              {said.trouble}
            </p>
          ) : null}
          {said.press ? (
            /* As tall as its words: every one of these presses is two lines
               at this width, and a fixed height let the second spill out of
               the button. */
            <Button size="sm" className="h-auto min-h-7 w-full justify-center px-2 py-1 text-xs whitespace-normal" data-divide onClick={undivided.press}>
              {said.press}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
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
 * The box in the first row: drawn, not pressed — "the whole epic" is one
 * thing to press, and the row is it.
 *
 * The second class is there because the box is the whole message here. In the
 * dark theme the shared checkbox's `dark:bg-input/30` outranks its checked
 * fill, so a ticked box keeps a dark ground under a dark tick; a container's
 * header can live with that, beside a ring that says the same thing, and a
 * list whose only signal is the tick cannot.
 */
const BOX = 'pointer-events-none dark:data-[state=checked]:bg-primary'

/**
 * The box in a part's row, which IS pressed. Twelve pixels is the size of
 * every box on this host and too small a thing to aim at beside a name that
 * does something else, so what takes the press reaches six pixels past it on
 * every side — as far as the name and not over it. Under the pointer it wears the
 * ring a focused box wears, which is what says the box is its own target.
 */
const TICK =
  "relative mr-1 ml-2 cursor-default after:absolute after:-inset-1.5 after:content-[''] hover:border-ring hover:ring-ring/50 hover:ring-[3px] dark:data-[state=checked]:bg-primary"

/**
 * "3 refs", "2 steps · 5 refs · 1 file", or nothing at all — never a zero
 * dressed as a count.
 *
 * Files are counted with the rest because they are the third thing a part can
 * hold, and for a paper they are the only thing: a part of a paper with no
 * steps and no references used to read as blank here, and blank is this
 * column's word for "picking this shows nothing".
 */
export function countOf(part: Part): string {
  const said: string[] = []
  const files = part.files?.length ?? 0
  if (part.steps) said.push(`${part.steps} ${part.steps === 1 ? 'step' : 'steps'}`)
  if (part.refs.length) said.push(`${part.refs.length} ${part.refs.length === 1 ? 'ref' : 'refs'}`)
  if (files) said.push(`${files} ${files === 1 ? 'file' : 'files'}`)
  return said.join(' · ')
}
