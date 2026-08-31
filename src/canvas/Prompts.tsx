import { MessageSquareText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { promptFor, type Placement } from '@/host/canvases.ts'
import type { Presence } from '@/host/registry.ts'
import { Hint } from './Hint.tsx'

/**
 * What one container says to another module, and what is being said to it.
 *
 * ## Why this is the host's dialog and not the module's
 *
 * A module cannot open a modal over the canvas. Its page is inside an iframe,
 * so a dialog it renders is clipped by the frame's own box: a container 220 pixels
 * wide gets a 220-pixel modal, which is not a modal at all — it is a cramped
 * panel with a backdrop over one twentieth of the screen. Anything that has to
 * be bigger than a container belongs to the program that owns the whole window.
 *
 * There is a second reason and it is the stronger one. A prompt is aimed from
 * one container AT another, and a module has no way to name its neighbours — it does
 * not know what else is on the canvas and must not, or modularity is over. The
 * host is the only thing that knows what is here. So the host owns the writing
 * of prompts, and a module's part is to declare it has a use for one and to
 * read what arrives in `context.prompt`.
 *
 * ## Two halves, and they are not symmetrical
 *
 * **What this container says** is editable: a person writes it here and picks who it
 * is for. **What this container is told** is read-only, because it was composed by
 * the host out of what OTHER containers wrote — editing it here would be editing
 * somebody else's sentence in a window that does not say whose it is.
 *
 * The second half is shown even when empty, and shown to every container rather than
 * only to modules that declared a use for one. A module that never asked for a
 * prompt still gets the courtesy of a screen saying nothing is aimed at it,
 * because the alternative is a person wondering whether the prompt they wrote
 * arrived.
 */
export function Prompts({
  open,
  onOpenChange,
  container,
  presences,
  placements,
  onWrite,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** The container whose prompt is being written. */
  container: Placement
  /** Everything registered, so a target can be named and described. */
  presences: readonly Presence[]
  /** The whole arrangement, because a prompt is aimed at something on it. */
  placements: readonly Placement[]
  onWrite(prompt: string, promptFor: string | null): void
}) {
  const me = presences.find((p) => p.id === container.i)
  const mine = me?.name ?? container.i

  /*
   * Who a prompt can be aimed at: the other containers on this kehikko whose modules
   * said they have a use for one.
   *
   * Filtered by the DECLARATION rather than offered to everything, because a
   * prompt aimed at a module that never reads one is a person typing into a
   * void with no way to find out. `declares.prompt` exists precisely so a host
   * can offer this honestly — see the manifest schema in the protocol package.
   *
   * A container cannot aim at itself. A module that wanted to tell itself something
   * would be a module with a settings screen, which is its own business and not
   * something the host should be relaying in a circle.
   */
  const targets = placements
    .filter((p) => p.i !== container.i)
    .map((p) => presences.find((presence) => presence.id === p.i))
    .filter((p): p is Presence => !!p?.module?.declares.prompt)

  /*
   * A draft, for the reason the kehikko name field holds one: the write is
   * debounced, the answer comes back a beat later, and binding straight to the
   * stored value means a reply landing mid-sentence replaces what somebody is
   * still typing. A prompt is longer than a name, so there is more to lose.
   */
  const [draft, setDraft] = useState(container.prompt)
  const [aimedAt, setAimedAt] = useState<string | null>(container.promptFor)
  const belongsTo = useRef(container.i)

  useEffect(() => {
    if (belongsTo.current === container.i) return
    belongsTo.current = container.i
    setDraft(container.prompt)
    setAimedAt(container.promptFor)
  }, [container.i, container.prompt, container.promptFor])

  const told = promptFor(placements, container.i)

  const commit = (text: string, target: string | null) => {
    setDraft(text)
    setAimedAt(target)
    onWrite(text, target)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Prompts for {mine}</DialogTitle>
          <DialogDescription>
            What this container says to another module on this kehikko, and what this one is being told.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium" htmlFor="prompt-text">
              What {mine} says
            </label>
            <span className="flex-1" />
            {/* A plain select. There is nothing to search and rarely more than a
                handful of containers, and a combobox would be three interactions
                where one will do. */}
            <label className="text-muted-foreground text-xs" htmlFor="prompt-target">
              aimed at
            </label>
            <select
              id="prompt-target"
              className="border-input bg-background h-7 rounded-md border px-2 text-xs"
              value={aimedAt ?? ''}
              onChange={(event) => commit(draft, event.target.value || null)}
            >
              <option value="">nobody yet</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name ?? target.id}
                </option>
              ))}
            </select>
          </div>

          <Textarea
            id="prompt-text"
            value={draft}
            spellCheck
            rows={6}
            placeholder={`What should the other module know? This text is sent to it as written.`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commit(draft, aimedAt)}
            className="font-mono text-xs"
          />

          {/* Said plainly rather than left to be inferred from an empty select.
              A prompt with nobody to receive it is stored and goes nowhere, and
              somebody who typed a paragraph deserves to be told that before
              they close the window. */}
          {draft.trim() && !aimedAt ? (
            <p className="text-muted-foreground text-xs">
              This is written down and is not being sent anywhere: nothing is selected to receive it.
              {targets.length === 0
                ? ' No other module on this kehikko has said it uses a prompt.'
                : null}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">What {mine} is told</p>
          {told ? (
            <pre className="bg-muted max-h-56 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
              {told}
            </pre>
          ) : (
            <p className="text-muted-foreground text-xs">
              Nothing on this kehikko is aimed at {mine}.
              {me?.module?.declares.prompt
                ? ' It has said it uses a prompt, so this is a thing you could write.'
                : ' It has not said it uses one, so writing it something would have no effect.'}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The button on a container header that opens the dialog above. */
export function PromptButton({ wanted, onOpen }: { wanted: boolean; onOpen(): void }) {
  return (
    <Hint
      label={
        wanted
          ? 'prompts — this module uses one, and this is where it is written'
          : 'prompts — what this container says to another module, and what it is told'
      }
      side="left"
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label="prompts"
        className={
          wanted
            ? 'text-foreground size-6 cursor-default'
            : 'text-muted-foreground hover:text-foreground size-6 cursor-default'
        }
        onMouseDown={(event) => event.stopPropagation()}
        onClick={onOpen}
      >
        <MessageSquareText className="size-3" />
      </Button>
    </Hint>
  )
}
