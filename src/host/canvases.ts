import { z } from 'zod'
import { MODULE_ID } from 'roadmap-module-protocol'

import { projectSchema, type Project } from './projects.ts'

/**
 * The page's side of the canvases.
 *
 * Four calls and a rule about when to make them. The shapes are declared here
 * rather than imported from `server/canvases.ts` for the reason given in
 * `registry.ts`: the page and the server are two programs that share a
 * repository, what crosses between them is JSON, and typing that JSON as the
 * server's own interface lets a change on one side become a wrong belief on the
 * other with nothing failing in between.
 */

const placementSchema = z.object({
  i: z.string().regex(MODULE_ID),
  x: z.number().int().min(0).max(200),
  y: z.number().int().min(0).max(10_000),
  w: z.number().int().min(1).max(200),
  h: z.number().int().min(1).max(400),
  /**
   * Whether this container follows the height its module asks for.
   *
   * Defaulted rather than required, so a canvas stored before this existed
   * still reads. A missing flag is off, which is what those containers were doing
   * anyway.
   */
  grow: z.boolean().default(false),
  /**
   * Whether this container is pinned, and stops hearing about the canvas.
   *
   * Defaulted, so an arrangement stored before pinning existed reads as not
   * pinned — which is what those containers have been doing all along.
   */
  pinned: z.boolean().default(false),
  /** What this container says to another module, and which one it says it to. */
  prompt: z.string().default(''),
  promptFor: z.string().nullable().default(null),
  /**
   * Whether this container is folded down to its header.
   *
   * Defaulted, so an arrangement stored before folding existed reads as open —
   * which is what every container in it has been all along.
   */
  collapsed: z.boolean().default(false),
  /**
   * The height it had before it was folded, in rows, or `null`.
   *
   * Remembered rather than recomputed, so that unfolding puts the container back
   * where it was rather than at a size somebody never chose. See the essay on
   * `onCollapse` in `App.tsx`.
   */
  openH: z.number().int().min(1).max(400).nullable().default(null),
  /**
   * Whether this container is picked out as a target on this kehikko.
   *
   * Defaulted, so an arrangement stored before selection existed reads as not
   * selected — which is what every container in it has been all along.
   *
   * A third axis, and deliberately not either of the two beside it: `selection`
   * on the canvas is REFS somebody picked out of a tracker, a passage is a
   * place inside a document, and this is which of the containers arranged here
   * are the ones being aimed at. See the essay on `selected` in
   * `server/canvases.ts` for why it is a field on the placement rather than a
   * second list on the canvas.
   */
  selected: z.boolean().default(false),
  /**
   * Which of the filters this container's module offers are chosen for it.
   *
   * Group id to option id, in the module's own words, and the host knows what
   * none of them mean — see `src/host/filters.ts`, which is the whole of what
   * this host does with them.
   *
   * ## A fourth axis, and it is per CONTAINER for a reason with a bug behind it
   *
   * The other place this could have lived is `module_state`, which is keyed by
   * module and by nothing else. That is right for what it holds — a module's
   * page is loaded once and shown wherever it is asked for, so one module is
   * one document — and wrong for this, because a filter is not a fact about the
   * document. It is a fact about how one container is being looked at, and two
   * containers showing the same module on two kehikot are two ways of looking.
   *
   * The failure is not hypothetical. One module in this workspace keeps its
   * filter in `localStorage`, which is per BROWSER, so every container of it on
   * every canvas already shares one choice and overwrites the others. Storing
   * it here is what stops this facility inheriting that.
   *
   * Defaulted, so an arrangement stored before filters existed reads as nothing
   * chosen — which is what every container in it has been all along, and which
   * means every group falls back to whatever its module says its resting option
   * is.
   */
  filters: z.record(z.string(), z.string()).default({}),
})

/**
 * What one module is being told, composed from every container aiming at it.
 *
 * The host does the composing rather than handing a module a list of fragments
 * — see the essay on `prompt` in the protocol's `wire.ts`. Ordering is the
 * arrangement's own: top to bottom, then left to right, which is the order a
 * person reads their canvas in and therefore the order they will expect their
 * instructions to have been assembled in. Anything else would be a rule they
 * cannot see.
 *
 * Each fragment is labelled with the container it came from. A person reading the
 * whole of what a module was told needs to know which container said what, or a
 * contradiction between two of them is unattributable.
 */
export function promptFor(
  placements: readonly Placement[],
  module: string,
  /**
   * What each module on this canvas says its presence implies.
   *
   * Keyed by module id. Supplied by the caller rather than read here, because
   * it comes from manifests — which the server sweeps and this file has never
   * touched. Absent for a module that is registered but not answering, which is
   * correct: a program that is not running implies nothing.
   */
  guidance: ReadonlyMap<string, string> = new Map(),
): string | null {
  const here = [...placements].sort((a, b) => a.y - b.y || a.x - b.x)

  /*
   * Standing notes first, written instructions after, and the order is the
   * argument. Guidance is context — what is on this canvas and what that means
   * — and instructions are orders about a particular piece of work. An agent
   * that read the orders first would be deciding what to do before it knew what
   * it had to hand.
   *
   * A module's own guidance is left out of its own prompt. It already knows
   * what it is; repeating it back would be the host explaining a module to
   * itself, and it would cost a paragraph in the one place that is bounded.
   */
  const notes = here
    .filter((p) => p.i !== module && (guidance.get(p.i) ?? '').trim())
    .map((p) => `## ${p.i} is on this kehikko\n\n${guidance.get(p.i)!.trim()}`)

  const aimed = here
    .filter((p) => p.promptFor === module && p.prompt.trim())
    .map((p) => `## from ${p.i}\n\n${p.prompt.trim()}`)

  const all = [...notes, ...aimed]
  return all.length ? all.join('\n\n') : null
}
export type Placement = z.infer<typeof placementSchema>

const canvasSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** What has been picked out here. Defaulted, so a canvas stored before this reads. */
  selection: z.array(z.string()).max(64).default([]),
  epic: z.string().nullable(),
  /**
   * Which project this kehikko is in, as a project id.
   *
   * It used to be a project's NAME, typed onto the canvas, and it was null on
   * every canvas that ever existed — see the essay on `project` in
   * `server/canvases.ts` for why that was the relationship the wrong way round.
   * A project is the container; this is the key into it.
   */
  project: z.number().int().nullable(),
  placements: z.array(placementSchema).max(64),
})
export type Canvas = z.infer<typeof canvasSchema>

/** Which canvas this browser had open. See below for why this one thing is local. */
export const OPEN_KEY = 'roadmap.frame.open.v1'

/**
 * Every kehikko, from every project, and the projects themselves.
 *
 * Both in one call because both are read at exactly the same moment and a
 * header drawn from two answers that arrived separately is a header that flashes
 * a project with no kehikot in it.
 *
 * ALL the kehikot, deliberately. The page shows one project's worth and keeps
 * the rest, because a module's page is loaded once and kept for as long as it is
 * on any kehikko — see `everyPlaced` and `Frames.tsx`. Filtering here would
 * shrink that union on every project switch and unmount every frame that is not
 * on the new project, which is the reload the user chose re-pointing over.
 */
export async function fetchCanvases(signal?: AbortSignal): Promise<{ canvases: Canvas[]; projects: Project[] }> {
  const response = await fetch('/host/canvases', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`the host's server answered ${response.status}`)
  const body = await response.json()
  return z
    .object({ canvases: z.array(canvasSchema), projects: z.array(projectSchema).default([]) })
    .parse(body)
}

export async function createCanvas(name?: string, project?: number | null): Promise<Canvas> {
  const response = await fetch('/host/canvases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, project }),
  })
  if (!response.ok) throw new Error(`the host's server answered ${response.status}`)
  return z.object({ canvas: canvasSchema }).parse(await response.json()).canvas
}

export interface CanvasEdit {
  name?: string
  epic?: string | null
  project?: number | null
  selection?: string[]
  placements?: Placement[]
}

export async function editCanvas(id: number, edit: CanvasEdit): Promise<Canvas> {
  const response = await fetch(`/host/canvases/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edit),
  })
  if (!response.ok) throw new Error(await reason(response))
  return z.object({ canvas: canvasSchema }).parse(await response.json()).canvas
}

export async function removeCanvas(id: number): Promise<void> {
  const response = await fetch(`/host/canvases/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await reason(response))
}

/**
 * Why a request failed, in the server's own words when it gave any.
 *
 * "The only canvas cannot be removed" is a sentence somebody needs to read.
 * `409` is not.
 */
async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  if (body && typeof body.error === 'string') return body.error
  return `the host's server answered ${response.status}`
}

/**
 * Which page this is, so the server can tell one tab's report from another's.
 *
 * In `sessionStorage`, which is per tab and survives a reload — so a page that
 * reloads REPLACES its own report rather than adding a second one beside it.
 * Minted fresh when there is none, and falling back to a value that lives only
 * in this module when storage refuses, which is the private-browsing case: a
 * report that cannot be replaced across a reload is worse than none only if it
 * disagrees with the new one, and the withdrawal on `pagehide` covers that.
 *
 * It is not a credential and there is nothing behind it. See `/host/open` in
 * `server/server.ts`.
 */
const PAGE_KEY = 'roadmap.frame.page.v1'
let minted: string | null = null
export function pageId(): string {
  if (minted) return minted
  try {
    const had = window.sessionStorage.getItem(PAGE_KEY)
    if (had) {
      minted = had
      return had
    }
    const made = crypto.randomUUID()
    window.sessionStorage.setItem(PAGE_KEY, made)
    minted = made
    return made
  } catch {
    minted = crypto.randomUUID()
    return minted
  }
}

/**
 * Tell the server which kehikko this page has open, or that it has none.
 *
 * The one fact this host keeps in the browser rather than on the server, said
 * OUT LOUD to the server anyway — and the difference matters. It is not stored
 * there: it is held in memory, per page, for as long as the process lives, and
 * it exists so that an agent at the host's MCP door can be told which kehikko
 * somebody is looking at instead of guessing. See `server/open.ts`.
 *
 * `null` withdraws, which is what a page sends on its way out.
 *
 * Failures are swallowed. A report that did not land costs an agent a refusal
 * naming the kehikot, which is a sentence it can act on; an exception in an
 * effect would cost the person their canvas.
 *
 * It hands back a promise, which it did not need to while only an agent read
 * the report. Now the host also decides which modules to have running from it —
 * see `server/lifecycle.ts` — and the page's next sweep must be the one that
 * comes AFTER the server knows what is open, or the sweep asks about a kehikko
 * the server has not heard of yet and nothing starts until something else
 * happens to look. The promise resolves whether the report landed or not: a
 * failed report is a sweep that finds nothing new, not a page that stops.
 */
export function reportOpen(kehikko: number | null): Promise<void> {
  const body = JSON.stringify({ page: pageId(), kehikko })
  return fetch('/host/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  })
    .then(() => undefined)
    .catch(() => {
      /* See above. */
    })
}

/**
 * Listen for a kehikko that changed under this page, and re-read when one does.
 *
 * The other half of `server/wake.ts`. What arrives is an id and nothing else,
 * so the caller re-reads the kehikot the ordinary way — this stream is
 * deliberately not a second route by which a canvas can arrive, because a
 * second route is a second shape to keep in step.
 *
 * `EventSource` reconnects on its own when the server restarts, which is worth
 * having: a person editing this host restarts its server constantly, and a page
 * that stopped hearing about changes at the first restart would be a mechanism
 * that works only until it is first tested.
 */
export function watchCanvases(kehikko: number | null, woke: (kehikko: number) => void): () => void {
  /*
   * Which page this is and what it has open, on the URL of the stream itself.
   *
   * The report `reportOpen` makes above is the page SAYING what it has open,
   * and it has one hole: a page that dies without running `pagehide` — a
   * crashed tab, a force-quit browser — never withdraws, and the server has to
   * keep believing it for half a day rather than poll. That hole is what stops
   * the host reclaiming any memory at all after a browser is killed.
   *
   * This stream closes when the browser does, with no heartbeat and no request
   * per tick: it is a connection the page already holds for another reason, and
   * its lifetime is exactly the lifetime of the screen. So the server treats
   * this URL as a report and the socket closing as its withdrawal.
   *
   * The kehikko has to be ON the url rather than reported once, because
   * `EventSource` reconnects on its own — after a server restart, after a
   * sleep — and a reconnection that did not say what it had open would withdraw
   * the report and never restore it. Carrying it means every reconnect
   * re-asserts, which is why this hook is re-run when the open kehikko changes.
   */
  const where = new URL('/host/watch', window.location.origin)
  where.searchParams.set('page', pageId())
  if (kehikko !== null) where.searchParams.set('kehikko', String(kehikko))
  const stream = new EventSource(where.pathname + where.search)
  stream.onmessage = (event) => {
    try {
      const parsed: unknown = JSON.parse(event.data)
      const id = (parsed as { kehikko?: unknown })?.kehikko
      if (typeof id === 'number' && Number.isInteger(id)) woke(id)
    } catch {
      /* Not something this page understands. A malformed wake is a wake that
         does not happen, and the page is no worse off than before this existed. */
    }
  }
  return () => stream.close()
}

/**
 * Which canvas was open, remembered per browser rather than per person.
 *
 * The canvases themselves are on the server, and this one fact is not, on
 * purpose: two windows on two screens showing two canvases is a reasonable
 * thing to do, and a server that stored "the current canvas" would make them
 * fight over it. It is also the one piece of this whose loss costs nothing —
 * a forgotten choice means opening on the first canvas, which is where a person
 * starts anyway.
 */
export function readOpen(storage: Pick<Storage, 'getItem'>): number | null {
  try {
    const raw = storage.getItem(OPEN_KEY)
    if (raw === null) return null
    const id = Number(raw)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function writeOpen(storage: Pick<Storage, 'setItem'>, id: number): void {
  try {
    storage.setItem(OPEN_KEY, String(id))
  } catch {
    /* Private browsing, or storage refused. It opens on the first canvas next
       time, which is a smaller loss than an exception in a click handler. */
  }
}

/**
 * Which canvas to open, given what is stored and what exists.
 *
 * A remembered canvas that has since been deleted — in another window, most
 * likely — falls back to the first rather than to nothing. There is always at
 * least one canvas; the server guarantees it.
 */
export function chooseOpen(
  canvases: readonly Canvas[],
  remembered: number | null,
  /**
   * Which project's kehikot are on offer, or null for "any".
   *
   * A remembered kehikko in ANOTHER project is not the one to open: the header
   * shows one project at a time, and opening a kehikko the dropdown beside it
   * does not list would be a canvas whose own switcher cannot see it. So the
   * memory is honoured only when it belongs here, and otherwise the first
   * kehikko of this project is opened — which is where a person starts anyway.
   */
  project: number | null = null,
): number | null {
  const here = project === null ? canvases : canvases.filter((canvas) => canvas.project === project)
  if (remembered !== null && here.some((canvas) => canvas.id === remembered)) return remembered
  return here[0]?.id ?? null
}

/** The kehikot of one project, in the order they were made. What the header lists. */
export function inProject(canvases: readonly Canvas[], project: number | null): Canvas[] {
  if (project === null) return []
  return canvases.filter((canvas) => canvas.project === project)
}

/** The grid is twelve columns wide, and a new container takes half of it. */
export const COLUMNS = 12
const NEW_W = 6
const NEW_H = 10

/**
 * Where a module goes when it is put on the canvas.
 *
 * Beside the last one if the bottom row has room, on a new row below if it does
 * not. Left to right, top to bottom, like words.
 *
 * Deliberately not a packing algorithm. Something that hunted for the largest
 * gap would put a new container somewhere a person cannot predict, and then finding
 * it is a step before moving it — two gestures where there should be one. This
 * rule is small enough to hold in your head, which is the only property that
 * matters: you press add, and you already know where to look.
 */
export function place(placements: readonly Placement[], id: string): Placement[] {
  if (placements.some((p) => p.i === id)) return [...placements]

  const bottom = placements.reduce((low, p) => Math.max(low, p.y), 0)
  const onBottomRow = placements.filter((p) => p.y === bottom)
  const usedToTheRight = onBottomRow.reduce((edge, p) => Math.max(edge, p.x + p.w), 0)

  const beside = placements.length > 0 && usedToTheRight + NEW_W <= COLUMNS
  const y = beside ? bottom : placements.reduce((low, p) => Math.max(low, p.y + p.h), 0)
  const x = beside ? usedToTheRight : 0

  /* Off. A new container is the size this host chose and stays there until somebody
     says otherwise — either by dragging its corner or by turning this on. */
  return [
    ...placements,
    {
      i: id,
      x,
      y,
      w: NEW_W,
      h: NEW_H,
      grow: false,
      pinned: false,
      prompt: '',
      promptFor: null,
      collapsed: false,
      openH: null,
      /* Off. A container arriving on the canvas has not been picked out by
         anybody, and a host that selected what it just added would be aiming an
         agent at a container the person has not even looked at yet. */
      selected: false,
      /* Nothing chosen. Every group falls back to whatever its module says its
         resting option is, which is what a container nobody has pressed this
         on should be showing. */
      filters: {},
    },
  ]
}

/** Take one off. */
export function unplace(placements: readonly Placement[], id: string): Placement[] {
  return placements.filter((p) => p.i !== id)
}

/**
 * Reconcile a stored arrangement with what is actually registered.
 *
 * A module whose registration file is gone is not `silent` — it is genuinely
 * not here, because somebody deleted the file that said it was, and a container for
 * it would be the host inventing a program. It comes off the canvas.
 *
 * Nothing is ADDED here, and that asymmetry is the point: a new registration
 * appearing is not a licence for the host to rearrange somebody's canvas
 * underneath them. It shows up in the list of modules to add, and waits.
 */
export function reconcile(placements: readonly Placement[], registered: readonly string[]): Placement[] {
  const present = new Set(registered)
  return placements.filter((p) => present.has(p.i))
}

/**
 * Every module placed on any canvas.
 *
 * The canvas layer loads a module's page ONCE and shows it on whichever canvas
 * asked for it, so it needs the union rather than the current canvas — see
 * `canvas/Frames.tsx` for why a page that is switched away from must not be
 * torn down.
 */
export function everyPlaced(canvases: readonly Canvas[]): string[] {
  const ids = new Set<string>()
  for (const canvas of canvases) for (const p of canvas.placements) ids.add(p.i)
  return [...ids].sort()
}

/**
 * Has a drag of the corner asked a folded container to open?
 *
 * ## Why a resize is an unfold and not an error
 *
 * A folded container is one grid row and draws only its header. When somebody
 * pulled its corner, the grid took the new height and the container kept
 * `collapsed` — so the row grew, the container went on drawing its header, and a
 * gap appeared where the module should be. The handle looked broken.
 *
 * Refusing the resize would be worse. A handle that does not move is a handle
 * somebody pulls again, harder, and then reports. Reaching for the corner of a
 * folded container is a person saying "I want to see this", which is the same
 * sentence the fold control says — so it is honoured as one.
 *
 * Only a TALLER drag counts. `h` arrives unchanged for every container on every
 * drag of a neighbour, and a height equal to or smaller than the folded one
 * cannot be a request to see more.
 */
export function unfoldedByResize(
  before: { collapsed?: boolean } | undefined,
  height: number,
  foldedRows: number,
): boolean {
  if (!before?.collapsed) return false
  return height > foldedRows
}
