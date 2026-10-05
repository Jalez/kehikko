import { Pencil, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'

/**
 * The row grammar the three header menus share — project, epic, kehikko.
 *
 * Each of them is a list with a check on what is open, and the same three
 * things done to a row: renamed by a pencil (or F2) that puts a form where the
 * list was, removed by an X in two presses, and made by an item at the end of
 * the list. They used to be written three times over. They are written here
 * once, and what stays in each menu is only what is particular to it: what a
 * row shows, what a save writes, and what its empty states say.
 */

/**
 * A row's remove, in two presses.
 *
 * The first press arms it and the X becomes a sentence naming what will
 * happen; the second does it. Armed rather than confirmed because `confirm()`
 * is unavailable inside a module frame, and the host should not be less
 * careful than its modules. Which row is armed is the menu's state, one at a
 * time — two armed destructive controls on one screen is a way to press the
 * wrong one — and the row's `onSelect` must ignore a press while it is armed,
 * which `armedSelect` does.
 *
 * `disabled` draws it flat rather than hiding it, with `why` as its tooltip: a
 * control that vanishes is one a person hunts for, and its absence explains
 * nothing.
 */
export function Remove({
  armed,
  label,
  question,
  disabled = false,
  why,
  onArm,
  onConfirm,
}: {
  armed: boolean
  /** What the X is called to a screen reader: "forget thesis". */
  label: string
  /** What the armed X says: "remove it?" */
  question: string
  disabled?: boolean
  /** The tooltip — why it is flat when disabled, what it does otherwise. */
  why?: string
  onArm(): void
  onConfirm(): void
}) {
  if (armed) {
    return (
      <button
        type="button"
        className="text-destructive shrink-0 text-[10px] font-medium"
        onClick={(event) => {
          event.stopPropagation()
          onConfirm()
        }}
      >
        {question}
      </button>
    )
  }
  return (
    <button
      type="button"
      aria-label={disabled && why ? why : label}
      title={why}
      disabled={disabled}
      className="text-muted-foreground hover:text-destructive disabled:hover:text-muted-foreground shrink-0 disabled:opacity-40"
      onClick={(event) => {
        event.stopPropagation()
        onArm()
      }}
    >
      <X className="size-3" />
    </button>
  )
}

/**
 * A row's `onSelect` that does nothing while the row's remove is armed, and
 * disarms otherwise. An armed row is asking a question, and answering it must
 * not also switch what is open; `preventDefault` keeps the menu open for the
 * answer.
 */
export function armedSelect(armed: boolean, disarm: () => void, select: () => void) {
  return (event: Event) => {
    if (armed) {
      event.preventDefault()
      return
    }
    disarm()
    select()
  }
}

/**
 * A row's `onKeyDown` that starts its rename on F2 — because the pencil cannot
 * be reached from the keyboard: inside a menu, Tab dismisses and the arrows
 * move between items, so a button that is not an item is a button for the
 * mouse only. F2 is what renames a thing in a file manager and in every editor
 * this host sits beside. The row needs `className="group/row"` for the pencil.
 */
export function renameKey(start: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key !== 'F2') return
    event.preventDefault()
    start()
  }
}

/**
 * The pencil on a row, revealed when the row is hovered or focused rather than
 * drawn on every one of them.
 *
 * A span and not a button: this is inside a menu item, whose own click is what
 * picks the row, and a nested button would be a button inside a control that
 * already means something. The CLICK is stopped so that renaming does not also
 * switch.
 *
 * ## The pointerdown must NOT be stopped, and stopping it was a bug
 *
 * Radix's menu item keeps a ref saying whether the press STARTED on it, set
 * from its own `onPointerDown`, and on `pointerup` does
 * `if (!isPointerDownRef.current) event.currentTarget?.click()` — so a press
 * begun on one item and released over another activates the one released
 * over. Stopping `pointerdown` here kept the ref false, so the release
 * synthesised a click ON THE ITEM, which never passes through this span: the
 * row was picked and the menu closed. Letting pointerdown through is what lets
 * the real click land here, where stopping it keeps it off the item.
 */
export function RowPencil({ label, title, onStart }: { label: string; title: string; onStart(): void }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={label}
      title={title}
      className="text-muted-foreground hover:text-foreground pointer-events-auto shrink-0 opacity-0 group-hover/row:opacity-100 group-focus/row:opacity-100"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onStart()
      }}
    >
      <Pencil className="size-3" />
    </span>
  )
}

/**
 * The item at the end of a list that makes a new one, under a separator.
 *
 * At the end, because the list IS where a person goes when what they want is
 * not in it, and the answer belongs where the question was asked. `keepOpen`
 * for a form that takes the list's place rather than closing the menu.
 */
export function AddItem({
  icon,
  children,
  keepOpen = false,
  onAdd,
}: {
  icon?: ReactNode
  children: ReactNode
  keepOpen?: boolean
  onAdd(): void
}) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={(event) => {
          if (keepOpen) event.preventDefault()
          onAdd()
        }}
      >
        {icon ?? <Plus className="text-muted-foreground size-3 shrink-0" />}
        <span className="flex-1">{children}</span>
      </DropdownMenuItem>
    </>
  )
}

/**
 * A one-field rename form, in place of the list.
 *
 * ## The list is replaced rather than one row swapped
 *
 * A row that turned into a text field would be the smaller change and it does
 * not work: Radix moves focus to whatever item the pointer crosses, so drifting
 * the mouse one row while typing blurs the field and commits half a name. With
 * the list gone for the duration there is nothing to drift onto, and the form
 * has room for a sentence about what will and will not change.
 *
 * ## The keys stop here
 *
 * The menu around it reads keystrokes as typeahead and the canvas behind it
 * has its own keyboard — see `presses.ts` — and in a field `s` means `s`.
 * Enter saves, Escape abandons.
 *
 * ## A refusal leaves it standing
 *
 * `onSave` answers whether it was written. Nothing typed or nothing changed is
 * not a write and simply closes. A refusal keeps the form open with the typed
 * name still in it, and the reason — the server's own sentence — goes to the
 * error line, where every other refusal in this host goes.
 */
export function NameForm({
  heading,
  initial,
  label,
  placeholder,
  maxLength,
  note,
  onSave,
  onDone,
}: {
  heading: string
  initial: string
  /** What the field is called to a screen reader. */
  label: string
  placeholder?: string
  /** A courtesy stop. Whatever saves the name is what actually decides. */
  maxLength: number
  /** Said under the field: what this does not change. */
  note?: ReactNode
  onSave(name: string): Promise<boolean> | boolean
  onDone(): void
}) {
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  /* Focused and selected on the way in: this form replaced a list the person
     had already reached, and a field without the caret in it is one they have
     to go and click. */
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  const commit = async () => {
    const name = draft.trim()
    if (!name || name === initial) {
      onDone()
      return
    }
    setSaving(true)
    const written = await onSave(name)
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
      <p className="text-muted-foreground pb-1.5 text-xs font-medium">{heading}</p>
      <Input
        ref={field}
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        maxLength={maxLength}
        className="h-7 w-full text-xs"
      />
      {note ? <p className="text-muted-foreground pt-1.5 text-[11px] leading-snug">{note}</p> : null}
      <div className="flex justify-end gap-1 pt-2">
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onDone}>
          cancel
        </Button>
        <Button size="sm" className="h-6 px-2 text-xs" disabled={saving} onClick={() => void commit()}>
          {saving ? 'saving…' : 'save'}
        </Button>
      </div>
    </div>
  )
}
