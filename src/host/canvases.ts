import { z } from 'zod'
import { MODULE_ID } from 'roadmap-module-protocol'

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
   * Whether this pane follows the height its module asks for.
   *
   * Defaulted rather than required, so a canvas stored before this existed
   * still reads. A missing flag is off, which is what those panes were doing
   * anyway.
   */
  grow: z.boolean().default(false),
})
export type Placement = z.infer<typeof placementSchema>

const canvasSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** What has been picked out here. Defaulted, so a canvas stored before this reads. */
  selection: z.array(z.string()).max(64).default([]),
  epic: z.string().nullable(),
  project: z.string().nullable(),
  placements: z.array(placementSchema).max(64),
})
export type Canvas = z.infer<typeof canvasSchema>

/** What the canvas is about, in the shape `context.ts` wants it. */
export interface Subject {
  epic: string | null
  project: string | null
}

/** Which canvas this browser had open. See below for why this one thing is local. */
export const OPEN_KEY = 'roadmap.frame.open.v1'

export async function fetchCanvases(signal?: AbortSignal): Promise<Canvas[]> {
  const response = await fetch('/host/canvases', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`the host's server answered ${response.status}`)
  const body = await response.json()
  return z.object({ canvases: z.array(canvasSchema) }).parse(body).canvases
}

export async function createCanvas(name?: string): Promise<Canvas> {
  const response = await fetch('/host/canvases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!response.ok) throw new Error(`the host's server answered ${response.status}`)
  return z.object({ canvas: canvasSchema }).parse(await response.json()).canvas
}

export interface CanvasEdit {
  name?: string
  epic?: string | null
  project?: string | null
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
export function chooseOpen(canvases: readonly Canvas[], remembered: number | null): number | null {
  if (remembered !== null && canvases.some((canvas) => canvas.id === remembered)) return remembered
  return canvases[0]?.id ?? null
}

/** The grid is twelve columns wide, and a new pane takes half of it. */
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
 * gap would put a new pane somewhere a person cannot predict, and then finding
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

  /* Off. A new pane is the size this host chose and stays there until somebody
     says otherwise — either by dragging its corner or by turning this on. */
  return [...placements, { i: id, x, y, w: NEW_W, h: NEW_H, grow: false }]
}

/** Take one off. */
export function unplace(placements: readonly Placement[], id: string): Placement[] {
  return placements.filter((p) => p.i !== id)
}

/**
 * Reconcile a stored arrangement with what is actually registered.
 *
 * A module whose registration file is gone is not `silent` — it is genuinely
 * not here, because somebody deleted the file that said it was, and a pane for
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
