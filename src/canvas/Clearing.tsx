import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Hint } from './Hint.tsx'

/**
 * The second control a module can put in its own container's header, and the
 * only one anywhere in this host that destroys something.
 *
 * A module says that what it is showing can be cleared and what to call it; the
 * host draws this; the SECOND press sends `roadmap.clear`; and the module does
 * the deleting. The host never touches the data and never learns what went —
 * see `sendClear` in `conversation.ts` and `MESSAGE.CLEAR` in the protocol.
 *
 * ## Absent by default, exactly as the filter is
 *
 * A module that has not announced a clear offer renders `null` here, and a
 * header with this in it is byte-for-byte the header it was before for every
 * module that has said nothing. Most modules cannot honour this at all — a
 * paper cannot delete a paper — and they are untouched. See `Filters.tsx` for
 * the longer version of this argument; it is the same one.
 *
 * ## No module string is laid out in the header, and here it costs more
 *
 * The button carries an icon and nothing else. The module's label — `forget 12
 * shown` — appears in the tooltip and in the accessible name, both of which are
 * a floating layer or a string nothing lays out.
 *
 * `Filters.tsx` has the measurement: a `whitespace-nowrap` element carrying a
 * variable string put an 1187-pixel min-content floor under a 220-pixel
 * container in this workspace, and it did not read as a badge bug — it read as
 * the whole window refusing to be narrow. The temptation is stronger here than
 * it was there, because this label carries the COUNT of what is about to be
 * deleted and that is genuinely worth seeing before pressing. It is still not
 * worth a container that cannot be made narrow, and the count is one hover or
 * one focus away rather than lost.
 *
 * There is no `Badge` in this file and there must not be. shadcn's badge is
 * `whitespace-nowrap` in its base.
 *
 * ## Two presses, because there is no third option
 *
 * The host frames modules with no `allow-modals` — one container must not be
 * able to freeze a browser holding five other people's programs — and a blocked
 * `confirm()` does not throw and does not warn. It returns `false`, which is
 * exactly what a person pressing Cancel produces, so a control guarded behind
 * one does nothing, silently, forever. That cost the checklist module an
 * afternoon; the essay is in `ModuleFrame.tsx`.
 *
 * A host dialog would be possible — `Prompts.tsx` is one — and it is the wrong
 * size for this. A modal over the whole canvas to confirm one press in one
 * header is a bigger interruption than the thing it is confirming, and it would
 * have to describe, in the host's words, data the host cannot see.
 *
 * So: an arm. The first press changes what the button says and does nothing
 * else; the second sends. That is the answer this workspace already uses — the
 * notifications module built one for the button this control replaces — and it
 * is better than a dialog anyway, because the armed state can say what is about
 * to happen in the MODULE's own words.
 *
 * ## What disarms it, and why each of them
 *
 * **A timer**, at four seconds, so a button left reading "press again" does not
 * sit armed until somebody presses it by accident half an hour later. Four is
 * the number the notifications module used for the same arm, and keeping it is
 * cheaper than defending a new one.
 *
 * **The label changing.** This is the one worth arguing for, because it is
 * easy not to think of. The label carries a count of what would be deleted, so
 * a label that changes while the control is armed means the thing a person
 * aimed at is not the thing the second press would hit — a notification
 * arriving between the two presses turns `forget 3 shown` into `forget 4
 * shown`. Disarming is the honest answer: they aimed at three.
 *
 * **Unmounting**, which is free, and covers the container being folded, the
 * module withdrawing its offer, and the canvas being switched. The arm lives
 * here rather than in `App.tsx` precisely so that all three are one case.
 */
export function ClearButton({
  label,
  name,
  onClear,
}: {
  /**
   * What the module says pressing this would clear, in its own words. `null`
   * when it is offering nothing, which is almost every module and is the state
   * that draws no control at all.
   */
  label: string | null
  /** The module's name, for the sentence somebody reads before pressing. */
  name: string
  /** Send the press. Called ONLY by the second one. */
  onClear(): void
}) {
  const [armed, setArmed] = useState(false)

  /* Disarmed on a timer. `label` is in the dependencies as well, so a count
     that moved between the two presses takes the arm down with it — see the
     essay above on why that is the honest answer rather than a nicety. */
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), DISARM_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [armed, label])

  if (label === null) return null

  const said = saying(name, label, armed)

  return (
    <Hint label={said.hint} side="left">
      <Button
        variant="ghost"
        size="icon"
        aria-label={said.name}
        /* The arm is a state a screen reader should hear without hovering
           anything, and `aria-pressed` is how a toggle says it. The name says
           it too, in words, because `aria-pressed` is announced with the name
           by some readers and not others — and this is the one control on the
           canvas where being wrong about which state it is in destroys
           something. */
        aria-pressed={armed}
        className={
          armed
            ? 'text-destructive bg-destructive/10 hover:text-destructive size-6 cursor-default'
            : /* Foreground rather than muted whichever state it is in, for the
                 reason `Filters.tsx` argues at length: this button is on almost
                 no containers, so its PRESENCE is the message, and a fifth grey
                 icon in a row of grey icons does not deliver one. */
              'text-foreground size-6 cursor-default'
        }
        /* Stops the grid reading the press as the start of a drag, which would
           make this button unpressable — see `Container.tsx`. */
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => {
          if (armed) {
            setArmed(false)
            onClear()
            return
          }
          setArmed(true)
        }}
      >
        {/* One glyph in both states, and the difference is said in colour, in
            the name and in the tooltip. A second icon would be a second thing
            to keep in step, and the icon is not where a person reads "are you
            sure" — the words are. */}
        <Trash2 className="size-3" />
      </Button>
    </Hint>
  )
}

/**
 * How long an armed button stays armed.
 *
 * Four seconds, which is what the notifications module used for the button this
 * control replaces. Long enough to be a deliberate second press, short enough
 * that a person who walked away does not come back to a canvas with a live
 * delete on it.
 */
export const DISARM_AFTER_MS = 4000

/**
 * What this control is called, and what it says when hovered or focused.
 *
 * A function rather than three ternaries at the call site, for the reason
 * `Filters.tsx` gives for its own: the wording IS the feature here, and a
 * wording nothing can test is a wording that drifts back. `test/clearing.test.ts`
 * asserts against this directly — that both states name the module, that the
 * resting state says what will be deleted, and that the armed state says the
 * press is the one that does it. Rendering the button to check a string would
 * need a Radix tooltip standing up in a test runner with no browser.
 *
 * ## The module's words are quoted, not paraphrased
 *
 * `label` goes into both strings verbatim. The host does not know what it
 * counts — rows, files, runs, minutes — and any sentence it invented around it
 * would eventually be wrong for somebody. What the host contributes is the two
 * things it does know: which module this is, and whether this press is the one
 * that deletes.
 *
 * ## Why the verb changes here, when the filter's does not
 *
 * `Filters.tsx` keeps one verb and appends the state, because pressing it does
 * the same thing either way: it opens a menu. Pressing this does two entirely
 * different things — the first press changes a label, the second destroys
 * something — so the name says which of the two is about to happen. A control
 * whose accessible name is the same in both states would be a control a screen
 * reader user cannot tell is armed, on the one button where that matters.
 */
export function saying(name: string, label: string, armed: boolean): { name: string; hint: string } {
  return armed
    ? {
        name: `press again to ${label} in ${name} — this deletes them`,
        hint: `press again to ${label}. This deletes them, and nothing brings them back`,
      }
    : {
        name: `delete what ${name} shows: ${label}`,
        hint: `delete: ${label}. It takes two presses, and nothing brings them back`,
      }
}
