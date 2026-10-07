import { LIMITS, PART_ID, stepPart, type EpicPart } from 'kehikot-module-protocol'
import { z } from 'zod'

import { slugFrom } from './epics.ts'

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
 * What stays here is what is this host's own: `Part`, which is one part as
 * the host reads it off an epic and carries a count of steps the wire has no
 * use for, and the reading itself.
 */

/** One part of an epic, as this host reads it off the epic's file. */
export interface Part {
  id: string
  heading: string
  /** The refs listed under the heading, and the refs of the steps assigned here. */
  refs: string[]
  /** How many steps say they are in this part. */
  steps: number
}

/** What the page is sent for one epic, and what the server answers with. */
export const partSchema = z.object({
  id: z.string().regex(PART_ID),
  heading: z.string().max(LIMITS.TITLE).default(''),
  refs: z.array(z.string().min(1).max(LIMITS.REF)).max(LIMITS.PART_REFS).default([]),
  steps: z.number().int().min(0).default(0),
})

/**
 * The part a step says it is in, or null — the protocol's reading, and no
 * longer one of this host's own.
 *
 * It was written here first, and then a second program needed it: the
 * Journeys module, which keeps the steps and shows only the ones in a picked
 * part. Two functions deciding what counts as an assignment are a step that
 * is in a part on this host's bar and in none on that module's page. So it is
 * `stepPart` in `kehikot-module-protocol` now, and handed on from here only so
 * that what imports it from this file goes on finding it.
 *
 * The derivation of a part's id from its heading, below, is the next thing to
 * go the same way and for the same reason.
 */
export { stepPart }

/** Refs out of whatever a file holds under `refs`: short non-empty strings, once each, bounded. */
function refsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const one of raw) {
    if (typeof one !== 'string') continue
    const ref = one.trim()
    if (!ref || ref.length > LIMITS.REF || out.includes(ref)) continue
    out.push(ref)
  }
  return out
}

/**
 * Every part an epic has, in the file's order.
 *
 * `[]` for an epic with no `groups`, which is most of them, and for anything
 * that is not an epic at all. Nothing here throws: this is called on every
 * listing of a project's epics, and one epic with a malformed `groups` must
 * cost that epic its parts and nothing else.
 *
 * Bounded at `LIMITS.PARTS` parts and `LIMITS.PART_REFS` refs each, because the list
 * goes out in a context broadcast to every frame. What is past either bound is
 * not sent; the epic file is where the whole of it is.
 */
export function partsOf(epic: unknown): Part[] {
  if (!epic || typeof epic !== 'object') return []
  const { groups, steps } = epic as { groups?: unknown; steps?: unknown }
  if (!Array.isArray(groups)) return []

  const parts: Part[] = []
  const taken = new Set<string>()
  groups.forEach((group, index) => {
    if (parts.length >= LIMITS.PARTS) return
    if (!group || typeof group !== 'object') return
    const { id: written, heading: said, refs } = group as { id?: unknown; heading?: unknown; refs?: unknown }
    const heading = typeof said === 'string' ? said.trim().slice(0, LIMITS.TITLE) : ''
    const wanted =
      typeof written === 'string' && PART_ID.test(written) ? written : slugFrom(heading) || `part-${index + 1}`
    let id = wanted
    for (let n = 2; taken.has(id); n += 1) id = `${wanted.slice(0, 76)}-${n}`
    taken.add(id)
    parts.push({ id, heading: heading || id, refs: refsOf(refs), steps: 0 })
  })

  /* The steps that say which part they are in bring their refs with them. */
  if (Array.isArray(steps)) {
    const byId = new Map(parts.map((part) => [part.id, part]))
    for (const step of steps) {
      const assigned = stepPart(step)
      const part = assigned === null ? undefined : byId.get(assigned)
      if (!part) continue
      part.steps += 1
      for (const ref of refsOf((step as { refs?: unknown }).refs)) {
        if (!part.refs.includes(ref)) part.refs.push(ref)
      }
    }
  }
  for (const part of parts) part.refs = part.refs.slice(0, LIMITS.PART_REFS)
  return parts
}

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

/** `context.parts`: every part of the open epic, each saying whether it is picked. */
export function partsOnWire(parts: readonly Part[], stored: readonly string[]): EpicPart[] {
  const picked = pickedIn(parts, stored)
  return parts.slice(0, LIMITS.PARTS).map((part) => ({
    id: part.id,
    heading: part.heading,
    refs: part.refs.slice(0, LIMITS.PART_REFS),
    picked: picked.includes(part.id),
  }))
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
