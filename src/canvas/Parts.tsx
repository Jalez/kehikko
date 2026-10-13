import { ArrowDown, ArrowUp, ChevronDown, Focus, Pencil, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

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
import { Input } from '@/components/ui/input.tsx'
import { alone, focusSaid, goneSaid, pickedIn, stepTo, toggled, type Part, type PartsEdit } from '@/host/parts.ts'
import { Hint } from './Hint.tsx'
import { AddItem, Remove } from './Menu.tsx'

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
 * ## This is where the parts are made, too
 *
 * A part belongs to the epic and to no module, so the one place it is added,
 * renamed, moved and removed is the one place that is no module's: here. The
 * list ends in a row that makes a part; each row has, under the pointer or
 * the keyboard's focus and in the room its count otherwise takes, a pencil,
 * an up, a down and a remove. So the picker is no wider and no taller for
 * being an editor, and a row at rest is what it was.
 *
 * An epic with no parts draws the same control, quiet, saying "no parts", and
 * opens straight onto that last row with the caret in it. It used to open
 * onto a paragraph and a press that walked a person to a module; there is
 * nowhere to walk to now.
 *
 * Every edit is one `onEdit`, which is one `parts.set` to the one writer
 * (`editParts` in `server/holdings.ts`). The id a part gets is the server's
 * to make and is never changed by a rename, so what is picked stays picked.
 *
 * ## Editing is in the row, and the menu is held still for it
 *
 * The header menus put a form where the list was (`NameForm`). That costs
 * the list — and here the list is the point: a part is named by looking at
 * the others. So the name is typed in the row. What makes that hard in a
 * Radix menu is that the pointer crossing any item takes the focus, and a
 * field that lost it would lose the caret mid-word; while a name is being
 * typed the items do not take the focus from the pointer (`STILL`). Enter
 * saves; Escape leaves it as it was.
 *
 * ## Removing asks once
 *
 * The X arms, and says "remove?" where it was; a second press does it. The
 * pattern every header menu uses (`Remove` in `Menu.tsx`), for its reason. A
 * part that was picked when it was removed here is simply no longer picked
 * (`unpicked` in `host/parts.ts`); the bar says a picked part is gone only
 * when it went by somebody else's doing — see below.
 *
 * On the keyboard, on a row: F2 renames, Alt+↑ and Alt+↓ move, and Delete
 * arms the remove and then confirms it.
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
  onEdit = null,
}: {
  /** Every part of the open epic, in the epic's order. Empty opens onto the row that makes one. */
  parts: readonly Part[]
  /** The stored ids. Ones that name no part here are ignored, and dropped on the next press. */
  picked: readonly string[]
  /** What is picked now. `[]` is the whole epic. */
  onPick(ids: string[]): void
  /** The open epic. With none there is nothing to divide, and nothing is drawn. */
  epic?: string | null
  /**
   * Make one edit of the epic's list, and say whether it was made. Null when
   * the list cannot be edited from here — the epics are still being read —
   * and then the rows are for picking only, and an epic with no parts draws
   * nothing.
   */
  onEdit?: ((edit: PartsEdit) => Promise<boolean>) | null
}) {
  /* What is being typed: a new part's name, or another name for one part. */
  const [typing, setTyping] = useState<'new' | { rename: string } | null>(null)
  const [arming, setArming] = useState<string | null>(null)
  /* When a name box goes, the caret goes with it; the menu takes the focus
     back, so the arrow keys still walk the list. */
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (typing === null) menu.current?.focus({ preventScroll: true })
  }, [typing])

  const none = parts.length === 0
  if (none && (epic === null || !onEdit)) return null

  const on = pickedIn(parts, picked)
  const said = focusSaid(parts, picked)
  const gone = goneSaid(parts, picked)
  const renaming = typing !== null && typing !== 'new' ? typing.rename : null
  /* With no parts there is one thing to do here, so it is already begun. */
  const adding = onEdit !== null && (typing === 'new' || none)
  const still = typing !== null || none ? STILL : undefined

  return (
    <span className="inline-flex shrink-0 items-center" data-narrowed={said.narrowed ? '' : undefined}>
      <DropdownMenu>
        <Hint label={none ? 'this epic has no parts yet — press to add one' : said.hint} align="start">
          <DropdownMenuTrigger asChild>
            <Button
              variant={said.narrowed ? 'default' : 'ghost'}
              size="sm"
              data-parts={parts.length}
              aria-label={
                none
                  ? 'the parts of this epic — it has none yet'
                  : said.narrowed
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
              <span className="min-w-0 truncate">{none ? 'no parts' : said.label}</span>
              <ChevronDown className="size-3 shrink-0 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent
          align="start"
          className="max-h-[60vh] w-80 overflow-auto"
          /* Shut and opened again, it is the list: a name left half typed, or
             a remove left armed, is not what the next opening is for. */
          onCloseAutoFocus={() => {
            setTyping(null)
            setArming(null)
          }}
          ref={menu}
          /* Escape in a name box leaves the name as it was, and the menu
             open; with no box it shuts the menu as it always did. */
          onEscapeKeyDown={(event) => {
            if (typing === null) return
            event.preventDefault()
            setTyping(null)
          }}
        >
          <DropdownMenuLabel>parts of this epic</DropdownMenuLabel>
          {none ? null : (
            <>
              <DropdownMenuItem
                {...still}
                onSelect={(event) => {
                  event.preventDefault()
                  if (on.length) onPick([])
                }}
              >
                <Checkbox checked={on.length === 0} tabIndex={-1} aria-hidden className={BOX} />
                <span className="flex-1">the whole epic</span>
                <span className="text-muted-foreground shrink-0 text-[11px]">
                  {parts.length === 1 ? 'its one part' : `all ${parts.length} parts`}
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {parts.map((part) => {
            const ticked = on.includes(part.id)
            const toggle = () => onPick(toggled(parts, picked, part.id))
            const armed = arming === part.id
            const up = stepTo(parts, part.id, -1)
            const down = stepTo(parts, part.id, 1)
            const move = (after: string | null | undefined) => {
              setArming(null)
              if (after !== undefined) void onEdit?.({ move: { id: part.id, after } })
            }
            const remove = () => {
              setArming(null)
              void onEdit?.({ remove: { id: part.id } })
            }
            return (
              /* As tall with a name box in it as without, so the rows below
                 do not jump when a rename begins. */
              <div key={part.id} data-part={part.id} className="group/row flex min-h-8 items-center pr-1">
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
                {renaming === part.id && onEdit ? (
                  <NameBox
                    initial={part.heading}
                    label={`what the part ${part.heading} is called`}
                    onSave={(name) => (name === part.heading ? true : onEdit({ rename: { id: part.id, name } }))}
                    onDone={() => setTyping(null)}
                  />
                ) : (
                  <Hint label="only this part" side="right">
                    <DropdownMenuItem
                      {...still}
                      className="min-w-0 flex-1 pl-1"
                      onSelect={(event) => {
                        event.preventDefault()
                        /* An armed row is asking a question; answering it is
                           not also a pick. */
                        if (armed) return
                        setArming(null)
                        const next = alone(parts, picked, part.id)
                        if (next) onPick(next)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === ' ') {
                          /* Space is the box's key. Prevented, so the menu does
                             not also take it as a press on the name. */
                          event.preventDefault()
                          toggle()
                          return
                        }
                        if (!onEdit) return
                        const moving = event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                        if (event.key !== 'F2' && event.key !== 'Delete' && !moving) return
                        event.preventDefault()
                        if (event.key === 'F2') setTyping({ rename: part.id })
                        else if (event.key === 'Delete') armed ? remove() : setArming(part.id)
                        else move(event.key === 'ArrowUp' ? up : down)
                      }}
                    >
                      {/* The whole name, for a row too narrow to say it. */}
                      <span className="min-w-0 flex-1 truncate" title={part.heading}>
                        <span className="sr-only">only </span>
                        {part.heading}
                      </span>
                      {/* What is under the heading, when anything is. A part with
                          nothing in it yet is still a part somebody can pick; the
                          blank here is why a module then shows nothing for it. */}
                      <span
                        className={`text-muted-foreground shrink-0 text-[11px] tabular-nums ${onEdit ? (armed ? 'hidden' : REST) : ''}`}
                      >
                        {countOf(part)}
                      </span>
                      {onEdit ? (
                        <span data-tools className={`shrink-0 items-center gap-1.5 ${armed ? 'inline-flex' : TOOLS}`}>
                          {armed ? null : (
                            <>
                              <Tool label={`rename ${part.heading}`} title="rename (F2)" onPress={() => setTyping({ rename: part.id })}>
                                <Pencil className="size-3" />
                              </Tool>
                              <Tool label={`move ${part.heading} up`} title="move up (Alt+↑)" off={up === undefined} onPress={() => move(up)}>
                                <ArrowUp className="size-3" />
                              </Tool>
                              <Tool label={`move ${part.heading} down`} title="move down (Alt+↓)" off={down === undefined} onPress={() => move(down)}>
                                <ArrowDown className="size-3" />
                              </Tool>
                            </>
                          )}
                          <Remove
                            armed={armed}
                            label={`remove ${part.heading}`}
                            question="remove?"
                            why="remove this part (Delete)"
                            onArm={() => setArming(part.id)}
                            onConfirm={remove}
                          />
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                  </Hint>
                )}
              </div>
            )
          })}
          {adding && onEdit ? (
            <div data-new-part className={`flex min-h-8 items-center gap-2 px-2 ${none ? '' : 'mt-1 border-t pt-1'}`}>
              <Plus className="text-muted-foreground size-3 shrink-0" />
              <NameBox
                again
                label="the name of a new part"
                placeholder="name of the part"
                onSave={(name) => onEdit({ add: { name } })}
                onDone={() => setTyping(null)}
              />
            </div>
          ) : onEdit ? (
            <AddItem keepOpen onAdd={() => setTyping('new')}>
              part
            </AddItem>
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
 * Props that stop a menu item taking the focus from the pointer.
 *
 * Radix focuses whichever item the pointer crosses, and the content when it
 * leaves one; both run after the item's own handler and not at all when that
 * handler prevented the default. Spread onto every item while a name is being
 * typed, so the caret stays in the field with the pointer anywhere.
 */
const STILL = {
  onPointerMove: (event: { preventDefault(): void }) => event.preventDefault(),
  onPointerLeave: (event: { preventDefault(): void }) => event.preventDefault(),
}

/** A row's count: drawn at rest, and gives its place to the tools under the pointer or the focus. */
const REST = 'group-hover/row:hidden group-focus-within/row:hidden'

/** A row's tools: there only under the pointer or the focus, in the place the count had. */
const TOOLS = 'hidden group-hover/row:inline-flex group-focus-within/row:inline-flex'

/**
 * One of a row's small presses. A span and not a button, and the click
 * stopped while the pointerdown is not, for the two reasons `RowPencil` in
 * `Menu.tsx` gives. `off` draws it flat instead of taking it away: the first
 * row's "up" is still where "up" is.
 */
function Tool({
  label,
  title,
  off = false,
  onPress,
  children,
}: {
  label: string
  title: string
  off?: boolean
  onPress(): void
  children: ReactNode
}) {
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={label}
      aria-disabled={off || undefined}
      title={title}
      className={off ? 'text-muted-foreground shrink-0 opacity-30' : 'text-muted-foreground hover:text-foreground shrink-0'}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!off) onPress()
      }}
    >
      {children}
    </span>
  )
}

/**
 * One name, typed in the row it belongs to.
 *
 * Enter saves and Escape leaves things as they were; there are no buttons,
 * because the row has no room for them and the two keys are what every name
 * box in a list answers to. Nothing typed, or nothing changed, is not a write.
 * A refusal leaves the box standing with the name still in it — the sentence
 * goes to the bar's error line, where every refusal in this host goes.
 *
 * The keys stop here: the menu around it reads keystrokes as typeahead and
 * the canvas behind it has a keyboard of its own.
 *
 * `again` is for the row that makes parts: a save empties the box and leaves
 * the caret in it, since whoever adds one chapter is usually about to add the
 * next.
 */
function NameBox({
  initial = '',
  label,
  placeholder,
  again = false,
  onSave,
  onDone,
}: {
  initial?: string
  label: string
  placeholder?: string
  again?: boolean
  onSave(name: string): Promise<boolean> | boolean
  onDone(): void
}) {
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  /* Disabled while it saves, which drops the caret; put back when it is not. */
  useEffect(() => {
    if (!saving) field.current?.focus()
  }, [saving])

  const commit = async () => {
    const name = draft.trim()
    if (!name) {
      onDone()
      return
    }
    setSaving(true)
    const written = await onSave(name)
    setSaving(false)
    if (!written) return
    if (again) setDraft('')
    else onDone()
  }

  return (
    <Input
      ref={field}
      value={draft}
      disabled={saving}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') void commit()
        if (event.key === 'Escape') onDone()
      }}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      maxLength={200}
      className="h-6 min-w-0 flex-1 px-1.5 text-xs"
    />
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
 * hold, and for a part that is a chapter they are the only thing: one with no
 * steps and no references used to read as blank here, and blank is this
 * column's word for "picking this shows nothing". A file is a document any
 * module said the part has; `files` is read for a list from before
 * `documents`.
 */
export function countOf(part: Part): string {
  const said: string[] = []
  const files = (part.documents ?? part.files)?.length ?? 0
  if (part.steps) said.push(`${part.steps} ${part.steps === 1 ? 'step' : 'steps'}`)
  if (part.refs.length) said.push(`${part.refs.length} ${part.refs.length === 1 ? 'ref' : 'refs'}`)
  if (files) said.push(`${files} ${files === 1 ? 'file' : 'files'}`)
  return said.join(' · ')
}
