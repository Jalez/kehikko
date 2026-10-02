import { ChevronDown, Circle, CircleSlash } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'
import { offerOfCreate, slugFrom } from '@/host/epics.ts'
import type { Epic, Epics as Held } from '@/host/projects.ts'
import { Hint } from './Hint.tsx'
import { AddItem, armedSelect, NameForm, Remove, renameKey, RowPencil } from './Menu.tsx'

/**
 * The epic every module on this kehikko is shown, picked from a list.
 *
 * ## It used to be a text field, and a text field was the wrong control
 *
 * The bar had an `<input>`: you typed a slug, it was trimmed, and whatever came
 * out became `roadmap.context.epic`. That was the right control while the host
 * had no idea what epics existed — it holds no data of its own, and a picker
 * over a list it could not read would have been a picker with nothing in it.
 *
 * Now a kehikko is in a project and a project is a folder, so the host CAN read
 * the list: `.kehikot/roadmap/epics` under the project, which is the same reading
 * `epics.list` gives a framed module. A field you type a slug into, next to a
 * list of the slugs that exist, is a way to make a typo authoritative. So it is
 * a select.
 *
 * The fallback in `toWireContext` for a slug the schema will not take is kept
 * rather than deleted, and its comment now says what it actually guards: a slug
 * persisted before this picker existed, and a kehikko whose remembered epic is
 * no longer in its project.
 *
 * ## A project with no epics says so
 *
 * The user's thesis folder has `main.tex`, `chapters/` and `references.bib` and
 * no `.kehikot/roadmap/epics` at all. A kehikko there honestly has nothing to pick, and an
 * empty dropdown is indistinguishable from a project whose epics failed to
 * load. So `holds` — whether the directory exists at all — is carried
 * separately from the list, and the control says which of the two it is in
 * words. It is disabled in that case rather than hidden: a control that
 * vanishes is one somebody hunts for, and its absence explains nothing.
 *
 * ## `view.goto` moves this, and it is not a second source of truth
 *
 * A module may ask the canvas to show an epic — `view.goto` in `host/ask.ts`,
 * which is a protocol method rather than any one module's feature. It does not
 * touch this component. It sets the canvas's subject, which is where this reads
 * from, so the select follows for the same reason every framed module does.
 * That is deliberate: the subject is one fact, and a control holding its own
 * copy would be a second one for the method to fail to move.
 *
 * ## An epic can be RETITLED here, and cannot be re-slugged
 *
 * "Rename an epic" names two operations. Retitling changes what it is called —
 * one field of one file, nothing else refers to it. Re-slugging changes what it
 * IS, and the slug is on `canvases.epic`, in `roadmap.context.epic`, and is the
 * key every module files its own material under: a record in `journeys.json`, a
 * file per epic under `checklist/`, a whole directory under `paper/`. Only the
 * first is offered, the control says "retitle" rather than "rename", and the
 * form says in words that the slug is staying — because the failure mode here
 * is not an error message, it is a person believing they moved something they
 * did not. `retitleEpic` in `server/holdings.ts` has the long version.
 *
 * It is not armed. Two-press arming is for what cannot be undone — forgetting a
 * project, removing a kehikko — and a title is a field you can type again, in a
 * file that is in somebody's git history. Arming everything is how arming stops
 * being read.
 *
 * ## The list is replaced by the form rather than one row being swapped
 *
 * A menu row that turned into a text field would be the smaller change and it
 * does not work: Radix moves focus to whatever item the pointer crosses, so
 * drifting the mouse one row up while typing blurs the field and commits half a
 * title. With the list gone for the duration there is nothing to drift onto,
 * and the form has the room to say what it will and will not change. Escape
 * abandons the draft, and whether the menu goes with it costs nothing either
 * way — the form is not left standing over a list it is no longer editing.
 *
 * ## An epic can be MADE here, at the end of the list
 *
 * The owner's words: "If there are no epics user seems unable to add an epic."
 * And later: the `+` that answered that should be "the last dropdown menu
 * item, like it is for the projects". Both are honoured by the same rule — the
 * menu opens whenever there is a project, even when it has nothing to pick, so
 * "new epic…" at its bottom is reachable in exactly the situation it exists
 * for. The trigger is disabled only when there is no project at all, which is
 * the one state with nowhere to create into.
 *
 * `offerOfCreate` in `host/epics.ts` decides what it does per state, and it
 * is data rather than JSX so each state can be asserted without a DOM.
 *
 * ## The slug is shown while the title is typed, and is not checked here
 *
 * Retitle draws the line between a title and a slug sharply, so create has to
 * as well: the person is choosing both. The slug is derived from the title as
 * they type, by the same `slugFrom` the server uses when an agent gives none,
 * and it stops following the moment they edit it — "derived unless somebody
 * says otherwise". It is NOT validated on this side. The server's `createEpic`
 * is the one rule about what a slug may be, and its sentence is the refusal;
 * a copy here would be the copy that drifts, and the field would refuse a slug
 * the server takes or take one it refuses.
 *
 * ## It replaces the list, as the retitle does, and it is not armed
 *
 * In the menu and in place of the list, for the reason the retitle form is —
 * see "The list is replaced by the form" above. Not armed, for the reason the
 * retitle is not: a file that can be deleted, in a repository, is not the
 * class of thing two presses are for.
 *
 * ## Creating opens the epic; the door's `create_epic` does not
 *
 * Both go through the same server function and produce the same file, and
 * they differ in exactly one thing afterwards, which `onCreateEpic` in
 * `App.tsx` argues: a person who pressed `+` and typed a title has chosen this
 * epic; an agent has not chosen it for them.
 */
export function Epics({
  epic,
  held,
  hasProject,
  onPick,
  onRetitle,
  onCreate,
  onDelete,
}: {
  /** What the kehikko is on now, straight from the canvas's subject. */
  epic: string | null
  /** What this project holds, or null while it is still being read. */
  held: Held | null
  hasProject: boolean
  onPick(epic: string | null): void
  /**
   * Change what one epic is called — never its slug.
   *
   * Answers whether it was written, which is what keeps the form open over a
   * refusal with the typed title still in it. The sentence saying why is the
   * server's own and goes to the header's error line, where every other refusal in this host
   * already goes.
   */
  onRetitle(slug: string, title: string): Promise<boolean>
  /**
   * Make a new epic in this project, filed under `slug`, and open it.
   *
   * Answers whether it was written, exactly as `onRetitle` does and for the
   * same reason: the form stays open over a refusal with what was typed still
   * in it, and the server's own sentence goes to the header's error line.
   */
  onCreate(slug: string, title: string): Promise<boolean>
  /**
   * Delete one epic's file. Armed on its row, as forgetting a project and
   * removing a kehikko are: the first press says what will go, the second
   * does it. What modules filed under the slug stays — see `deleteEpic` in
   * `server/holdings.ts`.
   */
  onDelete(slug: string): void
}) {
  /** Which epic is being retitled, if any. Null is the ordinary list. */
  const [editing, setEditing] = useState<string | null>(null)
  /** Whether the create form is standing in place of the list. */
  const [creating, setCreating] = useState(false)
  /** Which epic's delete has been asked about but not yet confirmed. One at a time. */
  const [arming, setArming] = useState<string | null>(null)
  const epics = held?.epics ?? []
  const holds = held?.holds ?? false
  /* Three states and not two: no project, a project with no epics directory,
     and a directory that is there and empty. Only the first is the host not
     knowing yet; the other two are answers. */
  const nothingToPick = !hasProject || !holds || epics.length === 0
  /* Null when the list has been re-read and no longer has this epic in it. */
  const retitling = epics.find((one) => one.slug === editing) ?? null
  const offer = offerOfCreate(hasProject, held)
  /* Openable whenever something can be created, even with nothing to pick:
     "new epic…" lives at the bottom of this menu. */
  const shut = !offer.offered

  const label = !hasProject
    ? 'no project is open, so there is no epic to pick'
    : !held
      ? 'reading this project’s epics…'
      : !holds
        ? 'this project has no .kehikot/roadmap/epics, so there is no epic to pick — which is not a fault: not every project has any'
        : epics.length === 0
          ? 'this project’s .kehikot/roadmap/epics is empty'
          : 'the epic every module on this kehikko is shown'

  return (
    <DropdownMenu>
      <Hint label={label} align="start">
        {/* A span, because a disabled button dispatches no pointer events and
            so never opens its tooltip — which is precisely the moment the
            explanation is worth having. The same trick `Canvases.tsx` uses on
            the delete button, for the same reason. */}
        <span className="inline-flex shrink-0">
          <DropdownMenuTrigger asChild disabled={shut}>
            <Button
              variant="ghost"
              size="sm"
              aria-label="the epic this kehikko is about"
              disabled={shut}
              className="h-6 max-w-52 gap-1 px-1.5 font-mono text-xs disabled:pointer-events-none"
            >
              {epic ? (
                <Circle className="text-muted-foreground size-3 shrink-0" />
              ) : (
                <CircleSlash className="text-muted-foreground size-3 shrink-0" />
              )}
              <span className={epic ? 'min-w-0 truncate' : 'text-muted-foreground min-w-0 truncate'}>
                {epic ?? sentenceFor(hasProject, held)}
              </span>
              {shut ? null : <ChevronDown className="text-muted-foreground size-3 shrink-0" />}
            </Button>
          </DropdownMenuTrigger>
        </span>
      </Hint>
      <DropdownMenuContent
        align="start"
        className="max-h-[60vh] w-80 overflow-auto"
        /* The list comes back when the menu is shut and opened again. A form
           left half-typed from twenty minutes ago, reappearing over the list
           somebody opened in order to SWITCH epic, is a menu that does not do
           what it was opened for. */
        onCloseAutoFocus={() => {
          setEditing(null)
          setCreating(false)
          setArming(null)
        }}
      >
        {creating && offer.offered ? (
          <Create
            note={offer.note}
            makesDirectory={offer.makesDirectory}
            onCreate={onCreate}
            onDone={() => setCreating(false)}
          />
        ) : retitling ? (
          /* Keyed on the slug, so that starting a retitle of a different epic
             replaces the draft rather than carrying the last one into it.
             The note is the disclosure that stops somebody retitling an epic
             in the belief that they moved its paper directory with it. */
          <NameForm
            key={retitling.slug}
            heading="retitle this epic"
            initial={titleOf(retitling)}
            label={`what ${retitling.slug} is called`}
            maxLength={200}
            note={
              <>
                the slug stays <span className="text-foreground break-all font-mono">{retitling.slug}</span> — it is
                what this kehikko, and every module’s own material, files this epic under.
              </>
            }
            onSave={(title) => onRetitle(retitling.slug, title)}
            onDone={() => setEditing(null)}
          />
        ) : (
          <>
            <DropdownMenuLabel>epics</DropdownMenuLabel>
            {/* Said rather than left blank, so an empty list reads as an answer
                and not as a list that failed to load. */}
            {nothingToPick ? (
              <p className="text-muted-foreground px-2 pb-1.5 text-xs">{sentenceFor(hasProject, held)}</p>
            ) : null}
            {epics.map((one) => (
              <DropdownMenuItem
                key={one.slug}
                onSelect={armedSelect(arming === one.slug, () => setArming(null), () => onPick(one.slug))}
                onKeyDown={renameKey(() => setEditing(one.slug))}
                className="group/row"
              >
                <DropdownMenuCheck checked={one.slug === epic} />
                <span className="min-w-0 flex-1 truncate">{titleOf(one)}</span>
                <RowPencil
                  label={`retitle ${titleOf(one)} — its slug, ${one.slug}, does not change`}
                  title={`retitle — the slug ${one.slug} does not change (F2)`}
                  onStart={() => setEditing(one.slug)}
                />
                {/* How much it names, when the file says. Never invented — see
                    `countOf` in `server/holdings.ts`, which answers null rather
                    than zero when there is nothing to count. */}
                {one.size ? (
                  <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{one.size}</span>
                ) : null}
                <Remove
                  armed={arming === one.slug}
                  label={`delete ${titleOf(one)}`}
                  question="delete its file?"
                  onArm={() => setArming(one.slug)}
                  onConfirm={() => {
                    setArming(null)
                    onDelete(one.slug)
                  }}
                />
              </DropdownMenuItem>
            ))}
            {epic ? (
              <>
                <DropdownMenuSeparator />
                {/* "No epic" is a state a kehikko is allowed to be in, and every
                    module is required to be able to move into it — so it is a thing
                    a person can choose rather than one they can only leave. */}
                <DropdownMenuItem onSelect={() => onPick(null)}>
                  <CircleSlash className="text-muted-foreground size-3 shrink-0" />
                  <span className="flex-1">no epic</span>
                </DropdownMenuItem>
              </>
            ) : null}
            {offer.offered ? (
              <AddItem keepOpen onAdd={() => setCreating(true)}>
                new epic…
              </AddItem>
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The create form: a title, the slug it makes, and a sentence about where the
 * file goes.
 *
 * ## The slug follows the title until it is touched
 *
 * `slug` is `null` while it is derived and a string once the person has typed
 * in it — `null` rather than a copy of the derivation, so that "is this still
 * following" is a fact the form holds rather than a comparison it makes.
 * Clearing the slug field entirely puts it back to following, which is the
 * gesture a person makes when they have edited it into something they no
 * longer want.
 *
 * ## The keys stop here, as in `Retitle`
 *
 * The menu around it reads keystrokes as typeahead, and the canvas behind it
 * has its own keyboard — see `presses.ts` — and a title with a space in it
 * must not fold a container. Enter creates, Escape abandons.
 *
 * ## Nothing is checked on this side
 *
 * The button is disabled for an empty title and for nothing else. A slug
 * the server will refuse is sent and refused, and the refusal lands in the
 * error line with the server's sentence while the form stays open with both
 * fields as they were — see the essay on the component.
 */
function Create({
  note,
  makesDirectory,
  onCreate,
  onDone,
}: {
  note: string
  makesDirectory: boolean
  onCreate(slug: string, title: string): Promise<boolean>
  onDone(): void
}) {
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
  }, [])

  const derived = slugFrom(title)
  const chosen = slug ?? derived

  const commit = async () => {
    if (!title.trim()) return
    setSaving(true)
    const written = await onCreate(chosen, title.trim())
    setSaving(false)
    if (written) onDone()
  }

  return (
    <div
      className="px-2 py-1.5"
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') void commit()
        if (event.key === 'Escape') onDone()
      }}
    >
      <p className="text-muted-foreground pb-1.5 text-xs font-medium">new epic</p>
      <Input
        ref={field}
        value={title}
        disabled={saving}
        onChange={(event) => setTitle(event.target.value)}
        aria-label="what the new epic is called"
        placeholder="what it is called"
        spellCheck={false}
        /* The same courtesy stop `Retitle` puts on a title, and the same
           division of labour: the server decides. */
        maxLength={200}
        className="h-7 w-full text-xs"
      />
      <Input
        value={chosen}
        disabled={saving}
        onChange={(event) => setSlug(event.target.value === '' ? null : event.target.value)}
        aria-label="what the new epic is filed under — its slug"
        placeholder="its slug"
        spellCheck={false}
        className="mt-1.5 h-7 w-full font-mono text-xs"
      />
      <p className="text-muted-foreground pt-1.5 text-[11px] leading-snug">
        {slug === null ? 'the slug follows the title until you edit it. ' : 'the slug is yours. '}
        It is what this kehikko, and every module’s own material, will file this epic under, and it does not
        change afterwards.
      </p>
      <p
        className={
          makesDirectory
            ? 'text-foreground pt-1.5 text-[11px] leading-snug'
            : 'text-muted-foreground pt-1.5 text-[11px] leading-snug'
        }
      >
        {note}.
      </p>
      <div className="flex justify-end gap-1 pt-2">
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onDone}>
          cancel
        </Button>
        <Button
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={saving || !title.trim()}
          onClick={() => void commit()}
        >
          {saving ? 'creating…' : 'create and open'}
        </Button>
      </div>
    </div>
  )
}

/**
 * What the control says when no epic is picked.
 *
 * Four different sentences for four different situations, because "no epic" and
 * "this project has none" and "still reading" look identical if they are all
 * rendered as an empty box — and only one of the four is something a person
 * should do anything about.
 */
function sentenceFor(hasProject: boolean, held: Held | null): string {
  if (!hasProject) return 'no project'
  if (!held) return 'reading epics…'
  if (!held.holds) return 'no epics here'
  if (!held.epics.length) return 'no epics yet'
  return 'pick an epic'
}

/** The title when the file has one, the slug when it does not. Never invented. */
function titleOf(epic: Epic): string {
  return epic.title ?? epic.slug
}
