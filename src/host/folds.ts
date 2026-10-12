/**
 * Who folded a container, when it was not the person looking at it.
 *
 * ## Why this exists
 *
 * A fold made by a press needs no signature: the hand that made it is the eye
 * that sees it. A fold made by an agent at the host's door (`fold_modules` in
 * `server/mcp.ts`), or by a module asking the host to bring itself or a
 * neighbour into view (`view.fold`, answered by `asked` below), happens to
 * somebody: a container they were reading
 * shuts, and nothing on the canvas says why. The arrangement belongs to the
 * person, and the least a host owes them when something else touches it is to
 * say who did, on the control that puts it back.
 *
 * ## What it is, which is very little
 *
 * A mark per container: who, and the state they left it in. It is kept by the
 * page and nowhere else — not in the database and not in the project's
 * `kehikot.json`, because "an agent folded this" is a fact about a moment on a
 * screen and not about the arrangement. It is drawn ON the fold control (see
 * `Container.tsx`) and takes no room of its own.
 *
 * ## When it goes
 *
 * The moment the container is no longer in the state that was left: the
 * person pressed the control — which is the one press that undoes it — or
 * dragged it open, or took it off. `standing` is that rule, and the page runs
 * it against every arrangement it draws, so a mark can never outlive what it
 * describes. It also goes when whoever folded puts it back themselves: an
 * agent that folded a container and then unfolded it has left things as they
 * were, and a container saying "unfolded by an agent" about the state its
 * owner chose would be a mark about nothing.
 *
 * A reload forgets every mark, and that is accepted: what is left is an
 * ordinary folded container with an ordinary control.
 */

import { folded, type Wished } from './columns.ts'

/** What travels with a wake — `FoldNote` in `server/wake.ts`. */
export interface FoldNote {
  by: string
  fold: string[]
  unfold: string[]
}

/** One container's mark: who changed its fold, and what they left it as. */
export interface FoldMark {
  by: string
  collapsed: boolean
}

/** Marks by module id, for one kehikko. */
export type FoldMarks = Readonly<Record<string, FoldMark>>

/** More ids than a kehikko holds containers, and a bound on what is read off a stream. */
const MAX_IDS = 64
const MAX_TEXT = 64

/**
 * A note read off the wake stream, or `null` for anything that is not one.
 *
 * Bounded before it is believed, like everything else that arrives: a
 * malformed note is a fold nobody signed, and the page still re-reads.
 */
export function foldNoteIn(value: unknown): FoldNote | null {
  if (typeof value !== 'object' || value === null) return null
  const { by, fold, unfold } = value as { by?: unknown; fold?: unknown; unfold?: unknown }
  if (typeof by !== 'string' || !by.length || by.length > MAX_TEXT) return null
  const ids = (list: unknown): string[] | null =>
    Array.isArray(list) && list.length <= MAX_IDS
      && list.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_TEXT)
      ? (list as string[])
      : null
  const folded = ids(fold)
  const unfolded = ids(unfold)
  if (!folded || !unfolded) return null
  return { by, fold: folded, unfold: unfolded }
}

/**
 * The marks after a note.
 *
 * A container whose mark already says the OPPOSITE state is being put back by
 * a second call, and loses its mark instead of gaining another.
 */
export function noted(marks: FoldMarks, note: FoldNote): FoldMarks {
  const next: Record<string, FoldMark> = { ...marks }
  const sign = (id: string, collapsed: boolean) => {
    const held = next[id]
    if (held && held.collapsed !== collapsed) delete next[id]
    else next[id] = { by: note.by, collapsed }
  }
  for (const id of note.fold) sign(id, true)
  for (const id of note.unfold) sign(id, false)
  return next
}

/**
 * The marks that still describe what is drawn.
 *
 * The same object when nothing was dropped, so a caller can hold it in state
 * and run this against every arrangement without causing a render.
 */
export function standing(marks: FoldMarks, placements: readonly { i: string; collapsed: boolean }[]): FoldMarks {
  const drawn = new Map(placements.map((p) => [p.i, p.collapsed]))
  const kept = Object.entries(marks).filter(([id, mark]) => drawn.get(id) === mark.collapsed)
  return kept.length === Object.keys(marks).length ? marks : Object.fromEntries(kept)
}

/**
 * What goes on screen when a re-read comes back from a wake, and what — if
 * anything — the page has to write for it.
 *
 * A wake means "read again", and reading again is right until the person's
 * own hand is in the way. The page saves a WHOLE arrangement, a moment after
 * the hand stops (`Writer`), so two things can cross a fold made at the door:
 *
 *   - `theirs`: kehikot the person changed while the read was out. That
 *     change is not in the read and is about to be sent, so their kehikko is
 *     kept as they have it — a read that replaced it would undo their press
 *     in front of them and then be overwritten by it anyway.
 *   - `saved`: the person had an unsaved change when the wake arrived. It was
 *     sent before the read, as a whole arrangement made before the fold, and
 *     took the fold with it.
 *
 * Either way the person's arrangement is what stands, and the door's fold is
 * no longer in it — while the agent has been told it folded. So the fold, and
 * nothing but the fold, is put onto THEIR arrangement with the function every
 * fold goes through. It cannot flip a press of theirs: they pressed looking
 * at the arrangement the door also read, so a press on a container the note
 * names left it exactly as the note does.
 */
export function reread<P extends Wished, C extends { id: number; placements: P[] }>(
  was: readonly C[],
  found: readonly C[],
  theirs: ReadonlySet<number>,
  crossed: { kehikko: number; note: FoldNote; saved: boolean } | null,
): { canvases: C[]; write: { kehikko: number; placements: P[] } | null } {
  let write: { kehikko: number; placements: P[] } | null = null
  const canvases = found.map((read) => {
    const kept = theirs.has(read.id) ? (was.find((c) => c.id === read.id) ?? read) : read
    if (!crossed || crossed.kehikko !== read.id || !(crossed.saved || theirs.has(read.id))) return kept
    const placements = folded(kept.placements, crossed.note)
    if (placements.every((p, n) => p === kept.placements[n])) return kept
    write = { kehikko: read.id, placements }
    return { ...kept, placements }
  })
  return { canvases, write }
}

/** What a module's `view.fold` came to — the protocol's `foldResult`, and the arrangement to draw. */
export interface Asked<P> {
  outcome: 'changed' | 'unchanged' | 'declined' | 'no-such-container'
  /** What THIS call folded and unfolded, and nothing it left alone. */
  folded: string[]
  unfolded: string[]
  why: string
  /** The arrangement after it; the same array when nothing changed. */
  placements: readonly P[]
}

/**
 * A module asking the host to fold or unfold containers (`view.fold`).
 *
 * The same write a person's press and an agent's `fold_modules` make —
 * `folded` in `columns.ts` — and the rules kehikko#61 sets, kept here:
 *
 *   - **Only on the kehikko the asker is on.** `placements` is the open
 *     kehikko's. A module whose page is loaded but which is not placed there
 *     is declined: it would be folding what it is not beside, on a screen it
 *     is not on.
 *   - **Not while the person's hand is in the way.** `busy` is a sentence
 *     saying what they are in the middle of — a drag, a dialog — or `null`.
 *   - **Every id has to be here.** One that is not is `no-such-container`,
 *     and nothing is changed, so a caller never has half of what it asked.
 *   - **A container already as asked is left alone**, and is in neither list:
 *     the lists are what the caller hands back to undo exactly this call.
 */
/** How many missing ids a refusal names before it counts the rest. */
const MISSING_NAMED = 3

export function asked<P extends Wished>(
  placements: readonly P[],
  from: string,
  call: { fold: readonly string[]; unfold: readonly string[] },
  busy: string | null,
): Asked<P> {
  const none = (outcome: Asked<P>['outcome'], why: string): Asked<P> =>
    ({ outcome, folded: [], unfolded: [], why, placements })
  const on = new Map(placements.map((p) => [p.i, p]))
  if (!on.has(from)) {
    return none('declined', `${from} is not on the kehikko that is open, so it cannot fold or unfold anything there.`)
  }
  if (busy) return none('declined', busy)
  /* Each id once: the schema allows one twice in a list, and the lists handed
     back are what a caller undoes with. */
  const fold = [...new Set(call.fold)]
  const unfold = [...new Set(call.unfold)]
  const missing = [...fold, ...unfold].filter((id) => !on.has(id))
  if (missing.length) {
    /* The first few by name and the rest by count. A call may name 128 ids of
       64 characters, and the protocol's `why` holds 400: a sentence listing
       them all would not fit the answer, and the caller would be told the
       call failed instead of what was wrong with it. */
    const named = missing.slice(0, MISSING_NAMED).join(', ')
    const more = missing.length - MISSING_NAMED
    return none(
      'no-such-container',
      `${named}${more > 0 ? ` and ${more} more` : ''} ${missing.length === 1 ? 'is' : 'are'} not on this kehikko. Nothing was folded or unfolded.`,
    )
  }
  const folding = fold.filter((id) => !on.get(id)?.collapsed)
  const unfolding = unfold.filter((id) => on.get(id)?.collapsed)
  if (!folding.length && !unfolding.length) return none('unchanged', '')
  return {
    outcome: 'changed',
    folded: folding,
    unfolded: unfolding,
    why: '',
    placements: folded(placements, { fold: folding, unfold: unfolding }),
  }
}

/** Who left this container as it is drawn, or `null` when nobody but the person did. */
export function signedBy(marks: FoldMarks | null, placement: { i: string; collapsed: boolean }): string | null {
  const mark = marks?.[placement.i]
  return mark && mark.collapsed === placement.collapsed ? mark.by : null
}

/** What the fold control says when it is hovered: who, and what a press does. */
export function foldHint(collapsed: boolean, by: string | null): string {
  if (by === null) {
    return collapsed
      ? 'folded — the module is still running. Press to put it back at the height it had'
      : 'fold it down to this header. The module keeps running and keeps what is in it'
  }
  return collapsed
    ? `folded by ${by} — the module is still running. Press to put it back at the height it had`
    : `unfolded by ${by}. Press to fold it down to its header again`
}
