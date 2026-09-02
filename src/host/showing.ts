import { LIMITS, type CanvasContainer, type Passage, type Showing } from 'roadmap-module-protocol'

/**
 * `context.containers`, composed: every container on the open kehikko, whether
 * it is picked out, and what it is showing.
 *
 * ## Three sources, one function, and why that is not "two sources for one fact"
 *
 * A container's `showing` is made of three things the host can vouch for, and
 * the vouching is the same strength for each: a frame said it, and a frame is
 * identified by its window, which nothing in a page can forge.
 *
 *   1. What the module SAID, with `showing.set`. Held per canvas per module,
 *      in memory, exactly as a passage is held — see `App.tsx` — and for the
 *      same reason: it is a claim about a running program's own state, and
 *      nobody is left to renew it once the program has gone.
 *   2. The canvas's passage, if this container is the one that pointed. The
 *      host already knows who called `passage.set`; it simply never wrote it
 *      down. A module that only ever points is "showing" what it points at
 *      without having learned a new word, which is what lets a paper module
 *      written last month narrow a checklist written this week.
 *   3. The canvas's selection, if this container is the one that set it. The
 *      same argument.
 *
 * The passage and the selection appear TWICE in a context — once as themselves
 * and once inside their setter's row — and that is a projection, not a second
 * source. One value, held in one place, written into a second field by this
 * one function. The protocol's essay on `containerSchema` says a host may do
 * this and should say so in its own code; this is the saying.
 *
 * ## What it refuses to guess
 *
 * A selection read back from the database after a reload has no setter — the
 * host remembers the refs and not who picked them — and it goes into nobody's
 * row. It is still in `context.selection`, so a consumer with nothing picked
 * out still shows it; a consumer narrowed to a picked container does not,
 * unless that container says it again. Inventing an attribution would be the
 * host stating who said something it did not hear.
 *
 * Likewise a container whose module has no registration on this machine is
 * listed with nothing shown. It is on the kehikko — `read_canvas` says so —
 * and a consumer told it is picked out has to be able to say that it shows
 * nothing, rather than not know it exists.
 *
 * ## Order and bounds
 *
 * Top to bottom then left to right, the order a person reads their canvas in
 * and the order `promptFor` and `read_canvas` already use, so that a consumer
 * printing "Paper and Journeys are picked out" prints them in the order the
 * person sees them.
 *
 * The passage goes FIRST among a row's documents, because it is the narrowest
 * thing there and the one the reader's finger is actually on, and the list is
 * cut at the protocol's bound afterwards. A module that said sixteen documents
 * and also points has said one more than fits; what is dropped is the last of
 * what it said, never the place the reader is standing.
 *
 * Pure, so `test/showing.test.ts` is a table.
 */

/** As much of a placement as composing a row needs. */
export interface Arranged {
  i: string
  x: number
  y: number
  selected: boolean
}

export function containersOf(input: {
  placements: readonly Arranged[]
  /** What each module said with `showing.set`, by module id. */
  said: Readonly<Record<string, Showing>>
  passage: Passage | null
  /** Which module set the passage, or null when nobody the host heard did. */
  pointedBy: string | null
  selection: readonly string[]
  /** Which module set the selection, or null — including after a reload. */
  selectedBy: string | null
}): CanvasContainer[] {
  const { placements, said, passage, pointedBy, selection, selectedBy } = input
  const here = [...placements].sort((a, b) => a.y - b.y || a.x - b.x)
  return here.map((p) => {
    const own = said[p.i]
    const refs = dedupe([
      ...(selectedBy === p.i ? selection : []),
      ...(own?.refs ?? []),
    ]).slice(0, LIMITS.REFS)
    const documents = dedupeDocuments([
      ...(pointedBy === p.i && passage ? [passage] : []),
      ...(own?.documents ?? []),
    ]).slice(0, LIMITS.SHOWING_DOCUMENTS)
    return { module: p.i, selected: p.selected, showing: { refs, documents } }
  })
}

/**
 * The list as a string, for React to depend on by value.
 *
 * `containersOf` builds fresh objects on every call, and a memo keyed on it by
 * identity would rebuild the context — and post a `roadmap.context` into every
 * frame — on every render. The same discipline `pointing` and `picked` keep in
 * `App.tsx`, for the same measured reason.
 */
export function containersKey(containers: readonly CanvasContainer[]): string {
  return JSON.stringify(containers)
}

function dedupe(refs: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const ref of refs) {
    if (seen.has(ref)) continue
    seen.add(ref)
    out.push(ref)
  }
  return out
}

/** Two places are the same place when path, page and range agree; the quote is what happened to be there. */
function dedupeDocuments(documents: readonly Passage[]): Passage[] {
  const seen = new Set<string>()
  const out: Passage[] = []
  for (const one of documents) {
    const key = `${one.path}\t${one.page ?? ''}\t${one.from ?? ''}\t${one.to ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(one)
  }
  return out
}
