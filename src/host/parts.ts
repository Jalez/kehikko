import {
  isPartFile,
  LIMITS,
  PART_ID,
  partsOf,
  slugFrom,
  stepPart,
  type EpicPart,
  type JourneyPart,
} from 'kehikot-module-protocol'
import { z } from 'zod'

/**
 * The parts of an epic, and the ones a person has picked out.
 *
 * ## What a part is, and what it is built on
 *
 * An epic file has always had `groups: [{ heading, refs }]`. It came over from
 * the roadmap this host was, where it was the ownership table's, and since the
 * split nothing has read it: not this host, which hands the epic over verbatim
 * through `epic.get`, and not one of the modules, which carry it untouched. So
 * a part is not a new idea beside `groups` — it IS a group, read for the first
 * time. One level deep, a heading and what is under it. An epic inside an epic
 * was considered and refused; see `parts.ts` in the protocol.
 *
 * ## The id
 *
 * A group had a heading and no name. A heading cannot be the name: it is prose
 * somebody rewords, and a step's `part` and the project's stored focus both
 * have to keep pointing at the same thing afterwards. So a group may now carry
 * `id` — the class of characters an epic's slug is in — and when it does not,
 * the id is `slugFrom(heading)`, the same derivation an epic's slug gets from
 * its title. Every epic already on disk therefore has ids without anybody
 * editing it, and they are stable for as long as the heading is; a person who
 * means to reword a heading writes the id down first, and from then on the
 * heading is free.
 *
 * Two groups that come out with one id are told apart by a suffix — `-2`,
 * `-3` — in file order, and a heading with nothing usable in it becomes
 * `part-<n>`. Both are better than dropping a group: a part that vanished from
 * the picker would be exactly the silent hiding this feature exists to avoid.
 *
 * ## A step says which part it is in
 *
 * `steps[].part` is the id of a part, and it is optional. A step is in a part
 * because it says so and for no other reason — not because it names a ref the
 * part lists. A step with no `part`, or one naming a part the epic does not
 * have, belongs to the epic as a whole.
 *
 * What an assignment does here is fold the step's refs into its part's
 * `refs`. That is one fact projected into a second place by one function, and
 * it is what lets a module that knows only references narrow correctly.
 *
 * ## This file is importable from both halves
 *
 * No `node:fs` and no `window`, for the reason `epics.ts` gives: the server
 * reads the parts off an epic file and the page composes them into a context,
 * and two readings of what a part is would be the disagreement this workspace
 * keeps meeting.
 *
 * ## The bounds and the wire shape are the protocol's
 *
 * `PART_ID`, `LIMITS.PARTS`, `LIMITS.PART_REFS` and the shape of one part in
 * `context.parts` (`EpicPart`, checked by `partsSchema` inside
 * `contextSchema`) are imported, and nothing here restates them. They were
 * restated once — this host shipped parts while still locked to a protocol
 * from before the field — and the copies went the day the lock moved.
 *
 * ## And so is the reading, now
 *
 * Which group is called what — the paragraph headed "The id" above — is
 * `partsOf` in the protocol, and no longer a function in this file; see the
 * note where it is handed on, below. The paragraph stays because it is still
 * true and still the reason, and because the rule it describes is one this
 * host depends on: the project's stored focus is a list of those ids.
 *
 * What stays here is what is this host's own: which parts a PERSON picked
 * (`partIdsIn`, `pickedIn`, `toggled`, `alone`), how they go out on the wire
 * (`partsOnWire`), and the words the bar says about them (`focusSaid`).
 */

/**
 * One part of an epic, as this host reads it off a record: its id, its
 * heading, the refs listed under the heading together with those of the steps
 * assigned to it, and how many steps that is. The protocol's `JourneyPart`,
 * under the name this host has always used for it.
 */
export type Part = JourneyPart

/** What the page is sent for one epic, and what the server answers with. */
export const partSchema = z.object({
  id: z.string().regex(PART_ID),
  heading: z.string().max(LIMITS.TITLE).default(''),
  refs: z.array(z.string().min(1).max(LIMITS.REF)).max(LIMITS.PART_REFS).default([]),
  steps: z.number().int().min(0).default(0),
  /* The files of the epic's paper this part owns, each relative to the
     paper's folder (`chapters/design.tex`) — the protocol's 0.32.0. OPTIONAL
     and not defaulted, for the protocol's own reason: `partsOf` leaves the key
     off a part that names none, and a part is compared whole in this host's
     tests and in the string `App.tsx` watches for a change of focus. This
     schema used to have no such line, and a `z.object` without one STRIPS the
     key: the server read the files off the journey, the page parsed them away,
     and a module that narrows a paper was told every part owned nothing.
     An entry not in `partFile`'s form is refused, as on the wire. */
  files: z.array(z.string().refine(isPartFile)).max(LIMITS.PART_FILES).optional(),
})

/**
 * The reading itself — which groups are parts, what each is called, and which
 * part a step says it is in — is the protocol's, handed on from here so that
 * what imports it from this file goes on finding it.
 *
 * All three were written here first. `stepPart` went when a second program
 * needed it: the Journeys module, which keeps the steps and shows only the
 * ones in a picked part. `partsOf` and `slugFrom` have gone the same way now
 * and for a sharper reason. Journeys can FILE a step under a part, and when
 * it does it writes the part's id onto the group — the id it worked out. Had
 * that been worked out by a second copy of the function below, the day the
 * copies differed by one character a step filed on that module's page would
 * be in a part this host's bar has never heard of, with both programs
 * correct about their own function.
 *
 * So there is one derivation, `partsOf` in `kehikot-module-protocol`, and this
 * file holds none. `test/parts.test.ts` was this host's specification of it
 * and still passes word for word against the protocol's — which is the proof
 * that no id moved when the copy was deleted: every group in every file on
 * disk is called what it was called the day before.
 *
 * What is bounded is unchanged and is the protocol's too: `LIMITS.PARTS` parts
 * and `LIMITS.PART_REFS` refs each, because the list goes out in a context
 * broadcast to every frame. Nothing in it throws; an epic with a malformed
 * `groups` costs that epic its parts and nothing else.
 */
export { partsOf, slugFrom, stepPart }

/**
 * Part ids, bounded before they are stored or compared.
 *
 * The same shape of function as `refsIn` in `server/canvases.ts` and for its
 * reason: this arrives from a request body, a hand-edited `kehikot.json` or a
 * column on somebody's own disk. Anything that is not an id is dropped, a
 * duplicate is not a second pick, and the list stops at `LIMITS.PARTS`.
 */
export function partIdsIn(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const one of raw) {
    if (typeof one !== 'string' || !PART_ID.test(one) || out.includes(one)) continue
    out.push(one)
    if (out.length >= LIMITS.PARTS) break
  }
  return out
}

/**
 * The stored picks that name a part this epic actually has, in the epic's
 * order.
 *
 * A stored id that names nothing is not an error and not a pick. The epic file
 * is edited by hand and by agents, under a running host; a part can be renamed
 * or removed while it is picked out. The pick then simply stops applying — and
 * if it was the only one, nothing is picked, which is the whole epic. That is
 * the safe direction to fail in: a stale focus must never hide everything.
 */
export function pickedIn(parts: readonly Part[], stored: readonly string[]): string[] {
  return parts.filter((part) => stored.includes(part.id)).map((part) => part.id)
}

/**
 * The stored picks that name NO part of this epic, and what the bar says
 * about them; `null` when every stored pick is a part, which is nearly always.
 *
 * `pickedIn` already stops such a pick applying, and that half was always
 * right: a focus on a part that is gone must not hide everything. What it
 * left was the other half of the same event. Somebody focuses on a part; the
 * part is removed — in the Journeys module, which can do that from its page
 * now — and the bar goes from a filled, named control back to a quiet "all
 * parts" with nothing to say that anything happened. Every module on the
 * canvas widened, correctly, and the person was not told why.
 *
 * And the id was still in the store. A part made later under the same
 * heading gets the same id, so the old focus would come back by itself, on a
 * part the person had never picked.
 *
 * So it is said, and it is one press to forget: `kept` is the list to store
 * instead — the picks that are still parts. Not forgotten without the press.
 * The list of parts this page holds is read again on every change to the
 * journeys, and for the moment between a part being made in one window and
 * this one hearing of it, a pick of that part looks exactly like a pick of
 * nothing; a page that tidied up by itself would undo it.
 */
export function goneSaid(
  parts: readonly Part[],
  stored: readonly string[],
): { gone: string[]; kept: string[]; label: string; hint: string } | null {
  const has = new Set(parts.map((part) => part.id))
  const gone = stored.filter((id) => !has.has(id))
  if (gone.length === 0) return null
  const kept = pickedIn(parts, stored)
  const one = gone.length === 1
  return {
    gone,
    kept,
    label: one ? 'a picked part is gone' : `${gone.length} picked parts are gone`,
    hint:
      `this project was focused on ${one ? 'a part' : `${gone.length} parts`} this epic no longer has ` +
      `(${gone.join(', ')}) — removed, or given another id, since. ${one ? 'It narrows' : 'They narrow'} nothing: ` +
      (kept.length === 0
        ? 'every module is shown the whole epic. '
        : `the focus is the ${kept.length === 1 ? 'one part' : `${kept.length} parts`} still here. `) +
      'Press to forget it',
  }
}

/**
 * What is picked after one checkbox is pressed.
 *
 * Built from `pickedIn`, so a press also drops any stored id that names
 * nothing: the list written back is always one the picker could have drawn.
 */
export function toggled(parts: readonly Part[], stored: readonly string[], id: string): string[] {
  const now = pickedIn(parts, stored)
  const next = now.includes(id) ? now.filter((one) => one !== id) : [...now, id]
  return pickedIn(parts, next)
}

/**
 * What is picked after a part's NAME is pressed: that part, and no other.
 *
 * The whole list in one value, for the reason `toggled` returns one: the
 * picker hands it on in a single press, so it is one write and one context.
 * "Untick the rest, then tick this" as two presses would send every module a
 * context with nothing picked in between, and a module redraws on each.
 *
 * `null` when that is already exactly what is stored — the name always means
 * "just this one", so a second press has nothing to write. A stored id that
 * names no part still counts as a difference, and is dropped, as it is by a
 * press on a box. An id that is not a part of this epic picks nothing and
 * writes nothing.
 */
export function alone(parts: readonly Part[], stored: readonly string[], id: string): string[] | null {
  const next = pickedIn(parts, [id])
  if (next.length === 0) return null
  return stored.length === 1 && stored[0] === id ? null : next
}

/** `context.parts`: every part of the open epic, each saying whether it is picked. */
export function partsOnWire(parts: readonly Part[], stored: readonly string[]): EpicPart[] {
  const picked = pickedIn(parts, stored)
  return parts.slice(0, LIMITS.PARTS).map((part) => {
    const sent: EpicPart = {
      id: part.id,
      heading: part.heading,
      refs: part.refs.slice(0, LIMITS.PART_REFS),
      picked: picked.includes(part.id),
    }
    /* A part's files go out only when it names some. The key is ABSENT
       otherwise and never `[]`: that is the shape `partsOf` reads and the
       shape the protocol's `partSchema` parses to, so a part with no files is
       still `{ id, heading, refs, picked }` exactly, to every module and to
       every comparison that was written before a part could own a file. */
    const files = (part.files ?? []).slice(0, LIMITS.PART_FILES)
    if (files.length) sent.files = files
    return sent
  })
}

/**
 * What the bar says about the focus, in words.
 *
 * Data rather than markup, so it can be asserted without a DOM. `narrowed` is
 * what makes the control stand out: a focus that hides things has to be
 * visible from across the room, not discovered by opening a menu.
 */
export function focusSaid(
  parts: readonly Part[],
  stored: readonly string[],
): { narrowed: boolean; label: string; hint: string } {
  const picked = parts.filter((part) => stored.includes(part.id))
  if (picked.length === 0) {
    return {
      narrowed: false,
      label: 'all parts',
      hint: `the whole epic — all ${parts.length} of its parts. Pick some to point every module at those only`,
    }
  }
  const names = picked.map((part) => part.heading).join(', ')
  return {
    narrowed: true,
    label: picked.length === 1 ? picked[0]!.heading : `${picked.length} of ${parts.length} parts`,
    hint:
      `every module is pointed at ${picked.length === 1 ? 'one part' : `${picked.length} parts`} of this epic: ${names}. ` +
      `The other ${parts.length - picked.length} are still there — clear this to see the whole epic`,
  }
}
