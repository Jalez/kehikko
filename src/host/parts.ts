import {
  isPartDocument,
  isPartFile,
  KEHIKOT_DIR,
  LIMITS,
  moduleFolder,
  own,
  PAPER_MODULE,
  PART_ID,
  paperFileOf,
  partDocument,
  partIdFor,
  partsOf,
  slugFrom,
  stepPart,
  type EpicHoldings,
  type EpicPart,
  type ListedPart,
  type PartsSetResult,
} from 'kehikot-module-protocol'
import { z } from 'zod'

/**
 * The parts of an epic, and the ones a person has picked out.
 *
 * ## What a part is, and whose
 *
 * A part belongs to the EPIC: an id, a name and a place in an order, one
 * level deep. It is no module's. The list is `parts: [{ id, name }]` in the
 * file this host already keeps for the epic, this host is its only writer
 * (`editParts` in `server/holdings.ts`), and a person edits it in the picker
 * in the bar. Nothing in this file, or anywhere in this host, names a module
 * for the purpose of parts.
 *
 * ## The id is made once
 *
 * A name cannot be the key: it is prose somebody rewords, and the project's
 * stored focus, a step's `part` and whatever a module files under a part all
 * have to keep pointing at the same thing afterwards. So a part is given an
 * id when it is added — `partIdFor`, the protocol's one derivation — and no
 * edit changes it: `rename` changes the name, `move` the order. See `edited`.
 *
 * ## An epic whose file keeps no list yet
 *
 * Parts were first read off an epic's record: its `groups`, one part each,
 * with an id written on the group or derived from its heading (`partsOf`, the
 * protocol's). That reading is still the answer for an epic whose file has no
 * `parts` key, exactly as it was, and it is what the list is ADOPTED from the
 * first time somebody edits it — ids and names as read. See `listedIn` and
 * `partsHeld`.
 *
 * ## What a part holds
 *
 * References and documents, and they are not this host's: each module keeps
 * what it has for a part in its own data and publishes it, and `partsHeld`
 * unions what every module said. So one module can narrow by a document
 * another said belongs to a part, and neither knows the other exists.
 *
 * ## This file is importable from both halves
 *
 * No `node:fs` and no `window`, for the reason `epics.ts` gives: the server
 * reads and edits the list and the page composes it into a context, and two
 * readings of what a part is would be the disagreement this workspace keeps
 * meeting.
 *
 * ## The bounds and the wire shape are the protocol's
 *
 * `PART_ID`, `LIMITS.PARTS`, `LIMITS.PART_REFS` and the shape of one part in
 * `context.parts` (`EpicPart`, checked by `partsSchema` inside
 * `contextSchema`) are imported, and nothing here restates them.
 *
 * What is here is what is this host's own: the list and its edits
 * (`listedIn`, `edited`), the union (`partsHeld`), which parts a PERSON
 * picked (`partIdsIn`, `pickedIn`, `toggled`, `alone`), how they go out on
 * the wire (`partsOnWire`), and the words the bar says (`focusSaid`).
 */

/**
 * One part of an epic, as this host holds it: its id, its name (`heading`, the
 * word the wire has always used), how many steps say they are in it, and what
 * the modules hold for it — references and documents, unioned. `files` is the
 * paper-relative spelling of those documents that have one, for a module built
 * before a part had `documents`. See `partsHeld`.
 */
export interface Part {
  id: string
  heading: string
  refs: string[]
  steps: number
  files?: string[]
  documents?: string[]
}

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
  /* What the modules hold for the part, project-relative, whichever module
     keeps each — the protocol's 1.2.0. Optional and absent when empty, for
     `files`' reason, and listed here for the reason that paragraph ends on:
     a `z.object` without the line strips the key on the way to the page. */
  documents: z.array(z.string().refine(isPartDocument)).max(LIMITS.PART_DOCUMENTS).optional(),
})

/**
 * The reading of a record's groups as parts, and which part a step says it is
 * in: the protocol's, handed on from here so that what imports them from this
 * file goes on finding them. `partsOf` is how an epic with no list of its own
 * is read, and what its list is adopted from; `test/parts.test.ts` was this
 * host's specification of it and still passes word for word.
 */
export { partsOf, slugFrom, stepPart }

/**
 * The list an epic's own file keeps, or null when the file has no `parts` key.
 *
 * Null and `[]` are different answers and the difference is the adoption:
 * with no key the list is read where it was read before the host kept one
 * (`partsOf` over the record), and with the key — even an empty one — only
 * the file is read. Tolerant per entry, for the reason every reader of a
 * hand-editable file here is: one entry that is not `{ id, name }` costs that
 * entry. An id met twice is the first one; the list stops at `LIMITS.PARTS`.
 */
export function listedIn(file: unknown): ListedPart[] | null {
  if (!file || typeof file !== 'object' || !Object.hasOwn(file, 'parts')) return null
  const raw = (file as { parts?: unknown }).parts
  const out: ListedPart[] = []
  if (!Array.isArray(raw)) return out
  for (const one of raw) {
    if (out.length >= LIMITS.PARTS) break
    if (!one || typeof one !== 'object') continue
    const { id, name } = one as { id?: unknown; name?: unknown }
    if (typeof id !== 'string' || !PART_ID.test(id) || out.some((part) => part.id === id)) continue
    const called = typeof name === 'string' ? name.trim().slice(0, LIMITS.TITLE) : ''
    out.push({ id, name: called || id })
  }
  return out
}

/** A reference as a part lists it: trimmed, not empty, at most `LIMITS.REF`. */
function refsIn(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const one of raw) {
    if (typeof one !== 'string') continue
    const ref = one.trim()
    if (ref && ref.length <= LIMITS.REF && !out.includes(ref)) out.push(ref)
  }
  return out
}

/**
 * Every part of one epic, with what is held for each.
 *
 * ## The list, and where it is read
 *
 * `listed` is the epic's own list (`listedIn`), or null when its file keeps
 * none. With one, the parts are exactly those, in that order. With none they
 * are read as they always were — `partsOf` over the record — which is the
 * released behaviour and stays: an epic nobody has edited the parts of
 * answers exactly what it answered before the host kept a list at all.
 *
 * ## What each part holds: a union, naming nobody
 *
 * `held` is what the modules published for this epic (`readHoldings`, a sweep
 * of every folder under `.kehikot/`). A part's `refs` and `documents` are
 * that, after what the record itself says for the part: the refs listed under
 * its group and those of the steps filed under its id, and the group's
 * `files`. The record's share is first and is what a project gets today, so
 * nothing moves for a project whose modules have published nothing.
 *
 * A group's `files` were written relative to the one folder papers were kept
 * in, and that folder is spelled by the protocol (`PAPER_MODULE`, deprecated
 * with `files`), not here. They become documents under it; `files` is then
 * read back OUT of the documents, so a document some other module published
 * under that folder reaches an older module too, and one anywhere else in the
 * project reaches only a module that reads `documents`.
 *
 * Bounded as the wire is. `files` and `documents` are absent when empty.
 */
export function partsHeld(listed: readonly ListedPart[] | null, epic: unknown, held: EpicHoldings | undefined, slug: string): Part[] {
  const read = partsOf(epic)
  const byId = new Map(read.map((part) => [part.id, part]))
  const base: Part[] =
    listed === null
      ? read.map((part) => ({ ...part }))
      : listed.slice(0, LIMITS.PARTS).map((one) => {
          const was = byId.get(one.id)
          const part: Part = { id: one.id, heading: one.name, refs: [...(was?.refs ?? [])], steps: was?.steps ?? 0 }
          if (was?.files?.length) part.files = was.files
          return part
        })

  /* A step filed under a part the record has no group for — a part made in
     the host — is still that part's step: `partsOf` folds only into groups. */
  if (listed !== null && epic && typeof epic === 'object' && Array.isArray((epic as { steps?: unknown }).steps)) {
    const loose = new Map(base.filter((part) => !byId.has(part.id)).map((part) => [part.id, part]))
    for (const step of (epic as { steps: unknown[] }).steps) {
      const id = stepPart(step)
      const part = id === null ? undefined : loose.get(id)
      if (!part) continue
      part.steps += 1
      for (const ref of refsIn((step as { refs?: unknown }).refs)) if (!part.refs.includes(ref)) part.refs.push(ref)
    }
  }

  const under = `${KEHIKOT_DIR}/${moduleFolder(PAPER_MODULE)}/${slug}`
  return base.map((part) => {
    const said = held ? own(held, part.id) : undefined
    const refs = [...part.refs]
    for (const ref of said?.refs ?? []) if (!refs.includes(ref)) refs.push(ref)

    const documents: string[] = []
    const put = (raw: string | null) => {
      if (raw !== null && !documents.includes(raw) && documents.length < LIMITS.PART_DOCUMENTS) documents.push(raw)
    }
    for (const file of part.files ?? []) put(partDocument(`${under}/${file}`))
    for (const document of said?.documents ?? []) put(partDocument(document))

    const files: string[] = []
    for (const document of documents) {
      const file = paperFileOf(`/${document}`, slug)
      if (file !== null && !files.includes(file) && files.length < LIMITS.PART_FILES) files.push(file)
    }

    const out: Part = { id: part.id, heading: part.heading, refs: refs.slice(0, LIMITS.PART_REFS), steps: part.steps }
    if (files.length) out.files = files
    if (documents.length) out.documents = documents
    return out
  })
}

/** One edit of an epic's list: the four `parts.set` makes, as the protocol parses them. */
export type PartsEdit =
  | { add: { name: string; after?: string | null } }
  | { rename: { id: string; name: string } }
  | { move: { id: string; after?: string | null } }
  | { remove: { id: string } }

/** The one edit in something that names exactly one, or null. */
export function editIn(raw: unknown): PartsEdit | null {
  if (!raw || typeof raw !== 'object') return null
  const { add, rename, move, remove } = raw as { add?: unknown; rename?: unknown; move?: unknown; remove?: unknown }
  const named = [add, rename, move, remove].filter((one) => one !== undefined && one !== null)
  if (named.length !== 1) return null
  if (add) return { add: add as { name: string; after?: string | null } }
  if (rename) return { rename: rename as { id: string; name: string } }
  if (move) return { move: move as { id: string; after?: string | null } }
  return { remove: remove as { id: string } }
}

/** `list` with `part` placed by `after`: right after that id, first for null, last when absent. Null for an `after` the list does not have. */
function placed(list: readonly ListedPart[], part: ListedPart, after: string | null | undefined): ListedPart[] | null {
  if (after === undefined) return [...list, part]
  if (after === null) return [part, ...list]
  const at = list.findIndex((one) => one.id === after)
  return at < 0 ? null : [...list.slice(0, at + 1), part, ...list.slice(at + 1)]
}

/**
 * One edit applied to a list: the whole of what `parts.set` decides, and the
 * only place it is decided — the picker, a module's `parts.set` and the
 * `set_parts` tool at the host's door all arrive here, through the one writer
 * in `server/holdings.ts`.
 *
 * Pure, so every outcome is a line in a test. What it holds to:
 *
 * - **An id is made once.** `add` gives the part `partIdFor(name, ids)`,
 *   against the ids in the list NOW; `rename` changes the name and nothing
 *   else; `move` changes the order and nothing else.
 * - **`remove` takes the entry out and touches nothing else.** What modules
 *   filed under the id is theirs.
 * - **An `id` or an `after` that names no part is `no-such-part`**, and
 *   nothing changed. A list already at `LIMITS.PARTS` declines an `add`.
 * - **Already so is `unchanged`**: the same name, the same place.
 *
 * `parts` is always the list as it then stands.
 */
export function edited(list: readonly ListedPart[], edit: PartsEdit): PartsSetResult {
  const same = (outcome: PartsSetResult['outcome'], id: string | null = null, why = ''): PartsSetResult => ({
    outcome,
    parts: [...list],
    id,
    why,
  })
  const changed = (parts: ListedPart[], id: string): PartsSetResult => ({ outcome: 'changed', parts, id, why: '' })
  const nameOf = (raw: unknown): string | null => {
    const name = typeof raw === 'string' ? raw.trim() : ''
    return name && name.length <= LIMITS.TITLE && !/[\u0000-\u001f\u007f]/.test(name) ? name : null
  }

  if ('add' in edit) {
    const name = nameOf(edit.add.name)
    if (name === null) return same('declined', null, NOT_A_NAME)
    if (list.length >= LIMITS.PARTS) {
      return same('declined', null, `An epic has at most ${LIMITS.PARTS} parts, and this one has that many.`)
    }
    const part = { id: partIdFor(name, list.map((one) => one.id)), name }
    const next = placed(list, part, edit.add.after)
    return next ? changed(next, part.id) : same('no-such-part')
  }

  if ('rename' in edit) {
    const at = list.findIndex((one) => one.id === edit.rename.id)
    if (at < 0) return same('no-such-part')
    const name = nameOf(edit.rename.name)
    if (name === null) return same('declined', edit.rename.id, NOT_A_NAME)
    if (list[at]!.name === name) return same('unchanged', edit.rename.id)
    return changed(list.map((one, index) => (index === at ? { id: one.id, name } : one)), edit.rename.id)
  }

  if ('move' in edit) {
    const part = list.find((one) => one.id === edit.move.id)
    if (!part) return same('no-such-part')
    if (edit.move.after === part.id) return same('unchanged', part.id)
    const next = placed(list.filter((one) => one !== part), part, edit.move.after)
    if (!next) return same('no-such-part')
    return next.every((one, index) => one === list[index]) ? same('unchanged', part.id) : changed(next, part.id)
  }

  const gone = list.find((one) => one.id === edit.remove.id)
  if (!gone) return same('no-such-part')
  return changed(list.filter((one) => one !== gone), gone.id)
}

const NOT_A_NAME = `A part is called something: one line, at most ${LIMITS.TITLE} characters.`

/**
 * Where a part goes when it is moved one place up or down, as `parts.set`
 * says a place: the id it is to follow, null for first — or `undefined` when
 * it is already at that end and there is nowhere to go.
 */
export function stepTo(parts: readonly { id: string }[], id: string, by: -1 | 1): string | null | undefined {
  const at = parts.findIndex((part) => part.id === id)
  if (at < 0) return undefined
  if (by === -1) return at === 0 ? undefined : at === 1 ? null : parts[at - 2]!.id
  return at === parts.length - 1 ? undefined : parts[at + 1]!.id
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
 * The stored picks that name NO part of this epic, and what the bar says
 * about them; `null` when every stored pick is a part, which is nearly always.
 *
 * `pickedIn` already stops such a pick applying, and that half was always
 * right: a focus on a part that is gone must not hide everything. What it
 * left was the other half of the same event. Somebody focuses on a part; the
 * part is removed — in the picker, by a module's `parts.set`, by an agent —
 * and the bar goes from a filled, named control back to a quiet "all
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
 * project's material, and for the moment between a part being made in one window and
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
    /* And its documents, absent when it has none for the same reason. Both go
       out: a module built before 1.2.0 reads `files` and never sees this key. */
    const documents = (part.documents ?? []).slice(0, LIMITS.PART_DOCUMENTS)
    if (documents.length) sent.documents = documents
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
