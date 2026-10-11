import type { Passage, Showing } from 'kehikot-module-protocol'

/**
 * What each loaded module last said about itself — what it shows and where it
 * points — held per MODULE, and read for whichever kehikko is open.
 *
 * ## Per frame, because that is what a claim is attached to
 *
 * A module's page is ONE document, loaded once and shown on whichever kehikko
 * asks for it (`Frames.tsx`): switching kehikko moves and hides frames, and
 * reloads none of them. So "I have chapter three open" is a fact about that
 * document, and it is exactly as true on the second kehikko the module sits on
 * as on the first.
 *
 * This used to be held per CANVAS — filed under whichever kehikko happened to
 * be open when the module spoke. Switching to another kehikko in the same
 * project then found nothing filed: `passage` null and every row empty, with
 * the paper plainly open on screen. Nothing renewed it either. The frames are
 * not re-greeted on a switch, because they did not reload, and a well-behaved
 * module says a thing once per change — the host had asked them to (see
 * `point` in `App.tsx`) — so neither side spoke again until somebody happened
 * to move a caret. The second kehikko stood with nothing until then.
 *
 * Asking every module to re-say on a switch was the alternative, and it is the
 * worse one: it needs a word the protocol does not have (a second greeting to
 * a page that is already greeted is not one), it is a burst of messages per
 * switch, and for the moments between the switch and the answers the host
 * would be telling every container "nothing is shown" about documents that
 * never left the screen. The host already heard the claim. It only filed it
 * in the wrong drawer.
 *
 * ## What a kehikko is told, out of this
 *
 * Only what the modules ON it said:
 *
 *  - a row of `context.containers` is that module's own word (`showing.ts`
 *    composes it, and only for the placements it is handed);
 *  - `context.passage` is the latest pointing among the modules placed on the
 *    open kehikko — `passageOn`. One finger per kehikko, as before; what
 *    changed is that the finger is found among who is HERE rather than
 *    remembered per canvas. So a paper pointing on one kehikko does not narrow
 *    a notes list on another where the paper is not placed — the reason the
 *    passage was per canvas in the first place — and a paper placed on both is
 *    pointing at the same paragraph on both, because it is.
 *
 * "Latest" needs an order across modules, so every pointing carries the tick
 * it was made at.
 *
 * ### A module that is not on the kehikko is not part of its conversation
 *
 * It neither sets the passage there nor takes it away. The second half is the
 * one that had to be measured. The other reading — "the passage is the last
 * pointing anybody made, and nothing where its owner is not placed" — was
 * tried, and a kehikko holding a file viewer and the questions lost its
 * passage every time a part was ticked: the paper, loaded and running for the
 * kehikko next door, re-says where it stands on every tick, became the last
 * to speak, and was not here. Every loaded frame is running and is told the
 * open kehikko's context, so modules that are elsewhere speak all the time.
 *
 * What this reading costs is one press of staleness, in one arrangement: the
 * notes pane, on the first kehikko only, is pressed last and walks the paper;
 * on the second kehikko the passage is the paper's own earlier pointing, not
 * the note. It is the staleness a row already has — a claim the host heard,
 * attributed to who made it, revised only by them — and it ends at the next
 * pointing by anybody there.
 *
 * ### A pointing at nothing is kept, and so is a tick whose frame has gone
 *
 * A null is not deleted: "the module that spoke last here closed its document"
 * has to beat an older pointing by a neighbour, exactly as a
 * `passage.set(null)` cleared the canvas's passage before. And a frame that
 * goes away leaves its tick behind with nothing in it, for the same reason.
 * Deleting it was tried and measured too: the paper's page reloaded, its
 * pointing went with it, the next latest was a question's source pressed ten
 * minutes earlier, and the host told the fresh page that somebody was
 * pointing there. It walked to the discussion chapter on a reload.
 *
 * ## When a claim ends
 *
 *  - The module revises it. `showing.set` is whole replacement; a pointing
 *    lasts until that module points elsewhere or at nothing.
 *  - The frame goes away — unplaced from every kehikko, restarted, updated,
 *    switched to a pinned version's page: `forgotten`. The document that made
 *    the claim no longer exists, and its successor has said nothing yet. It is
 *    the lifetime `Live` already has (`Covers` in `standing.ts`), and it is
 *    what stops a reloaded module being greeted with its predecessor's passage
 *    as though somebody else were pointing there. The same when a page reloads
 *    itself inside a frame that stays (`replaced` in `ModuleFrame.tsx`).
 *  - The project changes: everything goes (`App.tsx`), because a path belongs
 *    to a project.
 *
 * Pure, so `test/said.test.ts` is a table.
 */
export interface Said {
  /** What each module said with `showing.set`, by module id. */
  readonly showing: Readonly<Record<string, Showing>>
  /** What each module last pointed at with `passage.set`, by module id — null for a document closed. */
  readonly pointings: Readonly<Record<string, Pointing>>
  /** The next tick. Only ever compared, never shown. */
  readonly tick: number
}

export interface Pointing {
  passage: Passage | null
  /** When it was said, in this page's own order of hearing. */
  at: number
}

export const NOTHING_SAID: Said = { showing: {}, pointings: {}, tick: 1 }

/**
 * A module said what it shows. The SAME object back when nothing changed —
 * a module that re-says an identical statement on every render must not cost
 * every frame on the kehikko a context.
 */
export function shown(was: Said, from: string, showing: Showing): Said {
  if (JSON.stringify(was.showing[from] ?? null) === JSON.stringify(showing)) return was
  return { ...was, showing: { ...was.showing, [from]: showing } }
}

/**
 * A module pointed, or stopped pointing.
 *
 * The same object back when it said again what it had said last AND nobody
 * has pointed since — a drag that points on every pointer move is then one
 * context and not a hundred. Saying the same place again AFTER a neighbour
 * pointed is news, though: the finger has come back, and the tick moves.
 */
export function pointed(was: Said, from: string, passage: Passage | null): Said {
  const had = was.pointings[from]
  if (had === undefined && passage === null && !someoneIsPointing(was)) return was
  if (had && JSON.stringify(had.passage) === JSON.stringify(passage) && isLatest(was, from)) return was
  return { ...was, pointings: { ...was.pointings, [from]: { passage, at: was.tick } }, tick: was.tick + 1 }
}

/**
 * The module's document is gone, and what it had said goes with it.
 *
 * What it showed is deleted. Where it pointed is emptied IN PLACE, tick and
 * all: where it was the last to point, the passage is now nothing — and not
 * whatever a neighbour pointed at before it. See the essay above.
 */
export function forgotten(was: Said, from: string): Said {
  const pointing = was.pointings[from]
  const pointedSomewhere = pointing !== undefined && pointing.passage !== null
  if (!(from in was.showing) && !pointedSomewhere) return was
  const { [from]: _showed, ...showing } = was.showing
  return {
    ...was,
    showing,
    pointings: pointedSomewhere ? { ...was.pointings, [from]: { passage: null, at: pointing.at } } : was.pointings,
  }
}

/**
 * Where somebody is pointing on a kehikko holding these modules: the latest
 * pointing among them. Null when the one of them that spoke last closed its
 * document or was reloaded since, and when none of them has pointed.
 */
export function passageOn(said: Said, placed: readonly string[]): Passage | null {
  let latest: Pointing | null = null
  for (const id of new Set(placed)) {
    const one = said.pointings[id]
    if (one && (latest === null || one.at > latest.at)) latest = one
  }
  return latest?.passage ?? null
}

/** Every module still pointing at something, for `containersOf` — which keeps only the ones placed. */
export function pointedBy(said: Said): Record<string, Passage> {
  const out: Record<string, Passage> = {}
  for (const [id, one] of Object.entries(said.pointings)) {
    if (one.passage !== null) out[id] = one.passage
  }
  return out
}

function isLatest(said: Said, from: string): boolean {
  const mine = said.pointings[from]
  if (!mine) return false
  return Object.values(said.pointings).every((one) => one.at <= mine.at)
}

function someoneIsPointing(said: Said): boolean {
  return Object.values(said.pointings).some((one) => one.passage !== null)
}
