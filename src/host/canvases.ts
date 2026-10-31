import { settingIn, type ConnectionsSetting } from './connections.ts'
import { z } from 'zod'
import { EPIC_SLUG, LIMITS, MODULE_ID, MODULE_SCOPES, contentSignalSchema, isWebAddress, type ContentChange, type FooterItem, type HeaderItem, type SharedAddress, type SharedLocation } from 'kehikot-module-protocol'

import { projectSchema, type Project } from './projects.ts'
import { subjectsSchema, type Subjects } from './subject.ts'
import { foldNoteIn, type FoldNote } from './folds.ts'
import { arranged, granted, tops } from './columns.ts'
import { CANVAS_ROWS, COLUMNS } from './fit.ts'
import { announceUpdatesChanged } from './updates.ts'
import { announceMessagesChanged } from './messagesClient.ts'
import { registryIn, type RegistryView } from './registry.ts'
import type { Told } from './jump.ts'

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

export const placementSchema = z.object({
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
   * The height its owner last asked for, in rows.
   *
   * Not `h`. `h` is what is drawn, and this is what was chosen — by a hand on
   * the corner or by the module when `grow` is on — and the two part company
   * whenever a column is over-subscribed. The rule that turns wishes into
   * heights is `granted` in `columns.ts`; the essays on it and on
   * `Placement.wish` in `server/canvases.ts` say why there are two numbers.
   *
   * Required rather than defaulted, unlike its neighbours: the server fills it
   * for every row, migrated or new, so a canvas without one is not an older
   * canvas but a wrong one.
   */
  wish: z.number().int().min(1).max(400),
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
  filters: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  /**
   * How often this container refreshes itself, in minutes, or `null`.
   *
   * A fifth axis, and the filter choice's sibling in every way that matters: a
   * person's setting about ONE container, which has to survive quitting the
   * app, which the module cannot hold because it is not always running, and
   * which cannot go in `module_state` because that is keyed by module and every
   * container of one module would then share it.
   *
   * The module is told what it can be narrowed by and is never told this. A
   * module that knew the interval would be tempted to run a second timer beside
   * the host's, and only the host knows the things that should stop a tick —
   * that the container is folded, or pinned, or on a kehikko nobody has open.
   *
   * Defaulted to `null`, so an arrangement stored before this existed reads as
   * "only when somebody presses it", which is what every container in it has
   * been all along. The server bounds the number; see `everyIn` there and
   * `REFRESH_EVERY_MIN`/`MAX` in the protocol.
   */
  refreshEvery: z.number().int().nullable().default(null),
  /**
   * Which version of its module this container runs — a semver tag such as
   * `v1.2.0` — or `null` for latest, the module's own checkout. Per container;
   * see `version` on `Placement` in `server/canvases.ts`. Defaulted, so an
   * arrangement stored before versions existed runs latest, as it always did.
   */
  version: z.string().nullable().default(null),
  /**
   * The scope the person picked for this container (protocol 2.29.0), or `null`
   * for its module's default. Kept only when it is not the default
   * (`scopeToKeep` in `host/scope.ts`); see `scope` on `Placement` in
   * `server/canvases.ts`. Any string reads here, and one the module does not
   * list reads as its default where it is used (`scopeOfContainer`).
   */
  scope: z.enum(MODULE_SCOPES).nullable().catch(null).default(null),
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
  /**
   * The kehikko's stable key, from the project's own `kehikot.json` — see
   * `Canvas.key` in `server/canvases.ts`. Read here so the page can hand it to
   * modules (`kehikkoOnWire` in `host/context.ts`), which file what they keep
   * under it. Optional, so an older server still answers.
   */
  key: z.string().optional(),
  name: z.string(),
  /* No epic and no selection: those are the project's, not the kehikko's.
     See `host/subject.ts`. An older server still sends them, and zod drops
     what is not named here, so they cannot leak back in from one. */
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
  /**
   * The connections between its modules the person switched off or chose a provider for
   * (`host/connections.ts`). Read through `settingIn`, so an older server — which sends none —
   * and a setting that will not read are both automatic.
   */
  connections: z.unknown().optional().transform((value) => settingIn(value)),
})
export type Canvas = z.infer<typeof canvasSchema>

/** Which canvas this browser had open. See below for why this one thing is local. */
export const OPEN_KEY = 'kehikot.frame.open.v1'

/**
 * Every kehikko, from every project, and the projects themselves.
 *
 * Both in one call because both are read at exactly the same moment and a
 * header drawn from two answers that arrived separately is a header that flashes
 * a project with no kehikot in it.
 *
 * ALL the kehikot, deliberately. The page shows one project's worth and keeps
 * the rest, because a module's page is loaded once and kept while it is on the
 * open kehikko or one of the last few left, whichever project they are in —
 * see `framesKept` and `Frames.tsx`. Filtering here would unmount every frame
 * not on the new project at each project switch, which is the reload the user
 * chose re-pointing over.
 */
export async function fetchCanvases(
  signal?: AbortSignal,
  /**
   * Which kehikko this browser remembers having open, for the server's one-time
   * move of the epic off the kehikot and onto the project — see `hintSubject`
   * in `server/canvases.ts`. Only this page knows it; after the first load the
   * server ignores it.
   */
  remembered: number | null = null,
): Promise<{ canvases: Canvas[]; projects: Project[]; trouble: string[]; subjects: Subjects }> {
  const where = remembered === null ? '' : `?open=${remembered}`
  const response = await fetch(`/host/canvases${where}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`the host's server answered ${response.status}`)
  const body = await response.json()
  return z
    .object({
      canvases: z.array(canvasSchema),
      projects: z.array(projectSchema).default([]),
      /* Sentences about a project's `kehikot.json` that would not read — see
         `server/kehikot.ts`. Defaulted, so an older server still answers. */
      trouble: z.array(z.string()).default([]),
      /* What each project is about. Defaulted, so an older server — whose
         epics were on its kehikot — still answers, with every project about
         nothing until somebody picks. */
      subjects: subjectsSchema,
    })
    .parse(body)
}

export async function createCanvas(name?: string, project?: number | null, placements?: Placement[]): Promise<Canvas> {
  const response = await fetch('/host/canvases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    /* `placements`: made from a suggested layout (`src/host/layouts.ts`). */
    body: JSON.stringify({ name, project, ...(placements ? { placements } : {}) }),
  })
  if (!response.ok) throw new Error(`the host's server answered ${response.status}`)
  return z.object({ canvas: canvasSchema }).parse(await response.json()).canvas
}

export interface CanvasEdit {
  name?: string
  project?: number | null
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

/**
 * The person's switches of how the open kehikko's modules affect each other: the whole setting, to
 * `POST /host/connections` (`PAGE_ONLY`). Never through `editCanvas`: no program may make this.
 */
export async function saveConnections(id: number, connections: ConnectionsSetting): Promise<Canvas> {
  const response = await fetch('/host/connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kehikko: id, connections }),
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
const PAGE_KEY = 'kehikot.frame.page.v1'
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
 * failed report is a sweep that finds nothing new, not a page that stops. It
 * resolves to whether the host started anything on it (true when it did not
 * say), so the sweep after it is made only when it can find something new.
 */
export function reportOpen(kehikko: number | null, { again = false }: { again?: boolean } = {}): Promise<{ started: boolean }> {
  const page = pageId()
  const now = Date.now()
  /* The same report from this page, standing and recent: the one already made is the answer.
     `again` is for a server that may have forgotten it (the stream reopened). */
  if (!again && lastReport && lastReport.page === page && lastReport.kehikko === kehikko && now - lastReport.at < REASSERT_MS) return lastReport.said
  /* Nothing was ever said by this page, so there is nothing to withdraw. */
  if (!again && kehikko === null && (!lastReport || lastReport.page !== page)) return Promise.resolve({ started: false })
  const body = JSON.stringify({ page, kehikko })
  const said = fetch('/host/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  })
    .then(async (response) => {
      const answer = (await response.json().catch(() => null)) as { started?: unknown } | null
      /* An answer that does not say is one to look after. */
      return { started: answer?.started !== false }
    })
    .catch(() => {
      /* See above; and said again next time, since it may not have landed. */
      if (lastReport?.said === said) lastReport = null
      return { started: true }
    })
  lastReport = { page, kehikko, at: now, said }
  return said
}

/**
 * The last report this page made, so one said again on focus, on `pageshow` and by React's
 * StrictMode in development is not sent again. Said anew after `REASSERT_MS`: the server believes
 * a report for half a day (`server/open.ts`), and a page open longer than that says it again.
 */
let lastReport: { page: string; kehikko: number | null; at: number; said: Promise<{ started: boolean }> } | null = null
const REASSERT_MS = 10 * 60_000

/** For tests: as if this page had reported nothing. */
export function forgetReports(): void {
  lastReport = null
}

/**
 * Listen for news that something changed under this page, and re-read when it
 * does.
 *
 * The other half of `server/wake.ts`. What arrives is an id, or the bare word
 * `registry`, and nothing else — so the caller re-reads the ordinary way. This
 * stream is deliberately not a second route by which a canvas or a condition
 * can arrive, because a second route is a second shape to keep in step.
 *
 * ## The two callbacks, and why the second one is here rather than a timer
 *
 * `woke` is a kehikko somebody else changed. `looked` is the host saying that
 * what is registered — or what is ANSWERING — is not what this page was last
 * told, and the occasion for it is the one every other mechanism in this page
 * misses: a module's server dying while the person sits perfectly still,
 * watching a green light that has stopped being true. Focus does not fire,
 * `visibilitychange` does not fire, nothing is `starting`, and before this the
 * page had no reason to ask again.
 *
 * It is not a poll and it does not become one. The page opens no timer, makes
 * no extra request, and hears nothing at all unless the host actually found
 * something out — see `WATCH_EVERY_MS` in `server/lifecycle.ts` for who does
 * the finding out and what it costs. What this end contributes is one line: it
 * sweeps, exactly as it would have on focus.
 *
 * `EventSource` reconnects on its own when the server restarts, which is worth
 * having: a person editing this host restarts its server constantly, and a page
 * that stopped hearing about changes at the first restart would be a mechanism
 * that works only until it is first tested.
 */
export function watchCanvases(
  kehikko: number | null,
  /**
   * A kehikko changed under this page. With a note when what changed is a
   * fold somebody other than the person made — see `folds.ts`.
   */
  woke: (kehikko: number, folded: FoldNote | null) => void,
  /**
   * What is registered or answering changed: look again — or, with the reading the host sent
   * with the news (`{ registry: true, modules }`), take that instead of asking for it.
   */
  looked?: (reading?: RegistryView) => void,
  /**
   * A project's epics are not what this page last read — see `epicsChanged`
   * in `server/wake.ts`. Given the project's id, so a page standing in a
   * different one can leave its dropdown alone.
   */
  wrote?: (project: number) => void,
  /**
   * A project's dispositions changed — see `dispositionsChanged` in
   * `server/wake.ts`. Given the project's id for `wrote`'s reason.
   */
  marked?: (project: number) => void,
  /**
   * A project's tracker reading started or landed a read — see
   * `trackerChanged` in `server/wake.ts`. The signal comes with the news.
   */
  read?: (project: number, signal: { at: string | null; refreshing: boolean }) => void,
  /**
   * Material kept for a project's epics changed — see `contentChanged` in
   * `server/wake.ts`. The list comes with the news, held to the protocol's
   * shape: a list this page cannot read is news that does not happen.
   */
  rewritten?: (project: number, changes: ContentChange[]) => void,
  /**
   * An agent asked the host's door to press one item of a module's header,
   * and the server picked THIS page to do it — see `press` in
   * `server/wake.ts`. The one piece of news that is an order rather than a
   * reason to re-read; the page answers it with `answerPress`.
   */
  ordered?: (order: PressOrder) => void,
  /**
   * The stream is open: the first time, and again after every reconnection.
   * A server that restarted has forgotten what this page told it — which
   * headers its modules declared, and which kehikko this page has open — and
   * this is when to say it again. `again` is false the first time.
   */
  opened?: (again: boolean) => void,
  /**
   * A project's inbox changed — see `inboxChanged` in `server/wake.ts`.
   * Given the project's id and the revision of the record the news is
   * about; the page re-reads `/host/inbox` unless it already holds that.
   */
  inboxed?: (project: number, rev: number | null) => void,
  /**
   * The list of projects changed — a project was found again where its folder
   * went. See `projectsChanged` in `server/wake.ts`. Carries nothing.
   */
  relisted?: () => void,
  /**
   * An agent asked the host's door to show a web address on a kehikko, and the
   * server picked THIS page to do it — see `address` in `server/wake.ts`. An
   * order like `ordered`, answered with `answerPress`.
   */
  addressed?: (order: AddressOrder) => void,
  /**
   * An agent asked the host's door to jump the view (`jump`), and the server
   * picked THIS page, the one on screen — see `jump` in `server/wake.ts`.
   * Answered with `answerPress`, with who was told of a step.
   */
  jumped?: (order: JumpOrder) => void,
): () => void {
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
  /* A stream that had to reconnect may have missed a wake while it was away —
     the host restarted, the machine slept. Looking again on every reopening
     after the first is what catches up. */
  let before = false
  let stopped = false
  let stream: EventSource
  let again: ReturnType<typeof setTimeout> | null = null
  let wait = REOPEN_FIRST_MS
  const connect = () => {
    again = null
    stream = new EventSource(where.pathname + where.search)
    stream.onopen = () => {
      wait = REOPEN_FIRST_MS
      const reopened = before
      if (reopened) looked?.()
      before = true
      opened?.(reopened)
    }
    /*
     * `EventSource` reconnects on its own only after a connection that DROPPED.
     * A reconnection the server answers with anything but a stream — the dev
     * proxy's 500 while the API is still starting — closes it for good, and a
     * page left with a closed stream never says what it has open again. So a
     * closed stream is opened again here, a little later each time up to
     * `REOPEN_MOST_MS`. This runs only while the host is away; a page whose
     * stream is open makes no requests at all.
     */
    stream.onerror = () => {
      if (stopped || stream.readyState !== CLOSED) return
      again = setTimeout(connect, wait)
      wait = Math.min(wait * 2, REOPEN_MOST_MS)
    }
    stream.onmessage = heard
  }
  const heard = (event: MessageEvent<string>) => {
    try {
      const parsed: unknown = JSON.parse(event.data)
      const id = (parsed as { kehikko?: unknown })?.kehikko
      if (typeof id === 'number' && Number.isInteger(id)) {
        woke(id, foldNoteIn((parsed as { folded?: unknown }).folded))
      }
      /* Checked for `=== true` rather than for truthiness, so that a future
         server sending something else under this name is news this page does
         not understand rather than news it half-understands. */
      /* With the reading itself when the host had it in hand (its wait for a module it started
         ended): taken as a look's answer, so no page asks for it again. Without one, look. */
      if ((parsed as { registry?: unknown })?.registry === true) {
        const carried = (parsed as { modules?: unknown }).modules
        looked?.(carried === undefined ? undefined : (registryIn(carried) ?? undefined))
      }
      if ((parsed as { projects?: unknown })?.projects === true) relisted?.()
      /* An automatic module update began, ended or now waits (`server/autoUpdates.ts`): the Updates
         menu and What's new read again, each on its own (`onUpdatesChanged`). */
      if ((parsed as { updates?: unknown })?.updates === true) announceUpdatesChanged()
      const project = (parsed as { epics?: unknown })?.epics
      if (typeof project === 'number' && Number.isInteger(project)) wrote?.(project)
      const inbox = (parsed as { inbox?: unknown })?.inbox
      if (typeof inbox === 'number' && Number.isInteger(inbox)) {
        const rev = (parsed as { rev?: unknown }).rev
        inboxed?.(inbox, typeof rev === 'number' && Number.isInteger(rev) ? rev : null)
      }
      /* Messages between agent sessions changed (protocol 2.41.0): the view reads again. */
      const messaged = (parsed as { messages?: unknown })?.messages
      if (typeof messaged === 'number' && Number.isInteger(messaged)) announceMessagesChanged(messaged)
      const disposed = (parsed as { dispositions?: unknown })?.dispositions
      if (typeof disposed === 'number' && Number.isInteger(disposed)) marked?.(disposed)
      const tracked = parsed as { tracker?: unknown; at?: unknown; refreshing?: unknown }
      if (
        typeof tracked?.tracker === 'number' && Number.isInteger(tracked.tracker)
        && (tracked.at === null || typeof tracked.at === 'string') && typeof tracked.refreshing === 'boolean'
      ) {
        read?.(tracked.tracker, { at: tracked.at, refreshing: tracked.refreshing })
      }
      const changed = parsed as { content?: unknown; changes?: unknown }
      if (typeof changed?.content === 'number' && Number.isInteger(changed.content)) {
        const changes = contentSignalSchema.safeParse(changed.changes)
        if (changes.success) rewritten?.(changed.content, changes.data)
      }
      const order = pressOrderIn((parsed as { press?: unknown })?.press)
      if (order) ordered?.(order)
      const asked = addressOrderIn((parsed as { address?: unknown })?.address)
      if (asked) addressed?.(asked)
      const jump = jumpOrderIn((parsed as { jump?: unknown })?.jump)
      if (jump) jumped?.(jump)
    } catch {
      /* Not something this page understands. A malformed wake is a wake that
         does not happen, and the page is no worse off than before this existed. */
    }
  }
  connect()
  return () => {
    stopped = true
    if (again !== null) clearTimeout(again)
    stream.close()
  }
}

/** `EventSource.CLOSED`, spelled out so this file does not need the global to read it. */
const CLOSED = 2
/** How soon a stream the host closed for good is opened again, the first time. */
export const REOPEN_FIRST_MS = 500
/** And at most — so a page notices a host that is back within a couple of seconds. */
export const REOPEN_MOST_MS = 2000

/**
 * One press an agent asked for, as the server hands it to the page that is to
 * make it: which module on which kehikko, which item, and the option or the
 * state wanted. `id` is the server's, and comes back with the answer.
 */
export interface PressOrder {
  id: string
  kehikko: number
  module: string
  item: string
  value?: string | boolean
  /** Protocol 2.38.0: `footer` for an item of the module's footer; absent for one of its header. */
  place?: 'footer'
}

/**
 * A press order off the stream, or `null` for anything that is not one — and
 * for one addressed to another page. The server sends an order only down the
 * streams of the page it chose; the check here is the page not taking that on
 * trust.
 */
export function pressOrderIn(value: unknown, page: string = pageId()): PressOrder | null {
  if (typeof value !== 'object' || value === null) return null
  const said = value as Record<string, unknown>
  const short = (one: unknown): one is string => typeof one === 'string' && one.length > 0 && one.length <= 64
  if (said.page !== page) return null
  if (!short(said.id) || !short(said.module) || !short(said.item)) return null
  if (typeof said.kehikko !== 'number' || !Number.isInteger(said.kehikko) || said.kehikko <= 0) return null
  if (said.value !== undefined && typeof said.value !== 'boolean' && !short(said.value)) return null
  return {
    id: said.id,
    kehikko: said.kehikko,
    module: said.module,
    item: said.item,
    ...(said.value === undefined ? {} : { value: said.value }),
    ...(said.place === 'footer' ? { place: 'footer' as const } : {}),
  }
}

/**
 * A web address an agent asked to have shown on a kehikko (protocol 2.16.0),
 * as the server hands it to the page that is to show it. `id` comes back with
 * the answer, through `answerPress`.
 */
export interface AddressOrder {
  id: string
  kehikko: number
  url: string
  title?: string
}

/**
 * An address order off the stream, or `null` for anything that is not one —
 * for one addressed to another page, and for an address the protocol would not
 * take. Checked here again rather than taken on the server's word.
 */
export function addressOrderIn(value: unknown, page: string = pageId()): AddressOrder | null {
  if (typeof value !== 'object' || value === null) return null
  const said = value as Record<string, unknown>
  if (said.page !== page) return null
  if (typeof said.id !== 'string' || !said.id || said.id.length > 64) return null
  if (typeof said.kehikko !== 'number' || !Number.isInteger(said.kehikko) || said.kehikko <= 0) return null
  if (!isWebAddress(said.url)) return null
  if (said.title !== undefined && (typeof said.title !== 'string' || !said.title.trim() || said.title.length > LIMITS.TITLE)) return null
  return { id: said.id, kehikko: said.kehikko, url: said.url, ...(said.title === undefined ? {} : { title: said.title.trim() }) }
}

/**
 * Where an agent asked to jump the view, as the server hands it to the page on
 * screen. Anything absent is "stay where you are". `id` comes back with the
 * answer, through `answerPress`.
 */
export interface JumpOrder {
  id: string
  project?: number
  kehikko?: string
  epic?: string
  parts?: string[]
  step?: number
  title?: string
}

/** A jump order off the stream, or `null` for anything that is not one — and for one addressed to another page. */
export function jumpOrderIn(value: unknown, page: string = pageId()): JumpOrder | null {
  if (typeof value !== 'object' || value === null) return null
  const said = value as Record<string, unknown>
  if (said.page !== page) return null
  if (typeof said.id !== 'string' || !said.id || said.id.length > 64) return null
  if (said.project !== undefined && (typeof said.project !== 'number' || !Number.isInteger(said.project) || said.project <= 0)) return null
  if (said.kehikko !== undefined && (typeof said.kehikko !== 'string' || !said.kehikko || said.kehikko.length > 64)) return null
  if (said.epic !== undefined && (typeof said.epic !== 'string' || !EPIC_SLUG.test(said.epic))) return null
  if (said.parts !== undefined && (!Array.isArray(said.parts) || said.parts.length > 64 || !said.parts.every((one) => typeof one === 'string' && one.length > 0 && one.length <= 64))) return null
  if (said.step !== undefined && (typeof said.step !== 'number' || !Number.isInteger(said.step) || said.step < 1 || said.step > 999)) return null
  const title = typeof said.title === 'string' && said.title.trim() && said.title.length <= LIMITS.TITLE ? said.title.trim() : undefined
  return {
    id: said.id,
    ...(said.project !== undefined ? { project: said.project as number } : {}),
    ...(said.kehikko !== undefined ? { kehikko: said.kehikko as string } : {}),
    ...(said.epic !== undefined ? { epic: said.epic as string } : {}),
    ...(said.parts !== undefined ? { parts: [...new Set(said.parts as string[])] } : {}),
    ...(said.step !== undefined ? { step: said.step as number } : {}),
    ...(title ? { title } : {}),
  }
}

/**
 * Tell the server what each module on the open kehikko has declared for its
 * header.
 *
 * The declarations live in this page — a module says them to the frame it is
 * in — and the host's MCP door is on the server. This is how the door comes
 * to list a container's items in `read_canvas` and to judge a `press_item`
 * before anything is pressed. The whole map every time, like a declaration
 * itself: it replaces what this page said before. See `server/headers.ts`.
 *
 * Failures are swallowed, for `reportOpen`'s reason: a post that did not land
 * costs an agent a refusal it can act on.
 */
export function postHeaders(
  kehikko: number,
  headers: Readonly<Record<string, readonly HeaderItem[]>>,
  /* Where in a change's code somebody is pointing on it (protocol 2.13.0), so
     `read_canvas` can say it. The same posting, because it is the same kind of
     fact: about this page's screen, held per page, gone with the process. */
  location: SharedLocation | null = null,
  /* The last web address handed to it (protocol 2.16.0), for `read_canvas`, for the location's reason. */
  address: SharedAddress | null = null,
  /* What each container declared for its footer (protocol 2.38.0), for `read_canvas` and `press_item`. */
  footers: Readonly<Record<string, readonly FooterItem[]>> = {},
): Promise<void> {
  return fetch('/host/headers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    /* `at`, so a posting that arrives after a later one does not replace it. */
    body: JSON.stringify({ page: pageId(), kehikko, at: Date.now(), headers, location, address, footers }),
  })
    .then(() => undefined)
    .catch(() => {
      /* See above. */
    })
}

/** Tell the server what became of a press it ordered: taken, or not and why. */
export function answerPress(id: string, came: { ok: boolean; why: string; told?: readonly Told[]; ignored?: boolean }): Promise<void> {
  return fetch('/host/pressed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: pageId(), id, ok: came.ok, why: came.why, ...(came.told ? { told: came.told } : {}), ...(came.ignored ? { ignored: true } : {}) }),
  })
    .then(() => undefined)
    .catch(() => {
      /* The server gives up on its own deadline and says no page answered. */
    })
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

/**
 * The grid is twenty-four columns wide (`COLUMNS`, in `fit.ts` beside the
 * rows), and a new container takes half of it, twelve (the six of twelve it
 * always took), and twenty of the fifty-six rows (the ten of twenty-eight).
 */
export { COLUMNS }
export const NEW_W = 12
export const NEW_H = 20
/**
 * The least a container is shaped down to when only a smaller gap exists: eight
 * columns by twelve rows (four of the old twelve columns, six of the old
 * twenty-eight rows). A third of the canvas is the narrowest at which a module's
 * header (title, version and its menus) and a line of content still sit side by
 * side; twelve rows is twice `SQUEEZED_ROWS`, the least a neighbour may be
 * pushed to, so a shaped container is a header and a readable body and never
 * one that looks as if it had been squeezed. The repo has no per-module
 * minimum size (the grid's only `minW` is `MIN_W`, the old single column, and
 * it has no `minH`); this is the host's own floor for a placement it chooses,
 * and a person can still resize.
 */
export const GAP_MIN_W = 8
export const GAP_MIN_H = 12

/**
 * Where a module goes when it is put on the canvas: the first free space that
 * fits, in reading order.
 *
 * The canvas is scanned left to right, top to bottom, over the grid as it is
 * DRAWN (`arranged`: wishes granted, vertical compaction applied), and the
 * container takes the first free rectangle that holds the usual twelve columns
 * by twenty rows. Failing that, the first gap in reading order that holds at least
 * `GAP_MIN_W` by `GAP_MIN_H` is taken at that gap's size, capped at the usual
 * one; a full-size gap anywhere is preferred to a shaped one. Failing that, the
 * old rule: beside the last container on the bottom row if it has room, else on
 * a new row below.
 *
 * Why it is a scan and not a search for the best fit. The only property that
 * matters is that you press add and already know where to look, and the first
 * hole you would see reading the canvas is that place. Something that hunted
 * for the tightest or largest gap would be right more often and
 * unpredictable every time. A gap the grid's vertical compaction would close
 * (a stored top edge that is lower than the drawn one) is not a gap: the scan
 * runs on the compacted layout, and the result is checked against it, so the
 * new container is where it was put after the grid has settled. The existing
 * containers are returned as they were.
 */
export function place(placements: readonly Placement[], id: string): Placement[] {
  if (placements.some((p) => p.i === id)) return [...placements]

  const drawn = arranged(placements)
  const spot = firstGap(drawn)
  const holds = (at: Spot) => {
    const trial = [...placements, fresh(id, at)]
    const heights = granted(trial)
    const before = granted(placements)
    const above = tops(trial)
    const was = tops(placements)
    return (
      above.get(id) === at.y &&
      heights.get(id) === at.h &&
      placements.every((p) => heights.get(p.i) === before.get(p.i) && above.get(p.i) === was.get(p.i))
    )
  }
  const at = spot && holds(spot) ? spot : beside(drawn)
  return [...placements, fresh(id, at)]
}

interface Spot {
  x: number
  y: number
  w: number
  h: number
}

/** The old rule: beside the last container on the bottom row if it has room, else a new row. */
function beside(drawn: readonly Placement[]): Spot {
  const bottom = drawn.reduce((low, p) => Math.max(low, p.y), 0)
  const onBottomRow = drawn.filter((p) => p.y === bottom)
  const usedToTheRight = onBottomRow.reduce((edge, p) => Math.max(edge, p.x + p.w), 0)
  const next = drawn.length > 0 && usedToTheRight + NEW_W <= COLUMNS
  return {
    x: next ? usedToTheRight : 0,
    y: next ? bottom : drawn.reduce((low, p) => Math.max(low, p.y + p.h), 0),
    w: NEW_W,
    h: NEW_H,
  }
}

/** The first free rectangle in reading order: a full-size one if any, else the first that is at least the least. */
function firstGap(drawn: readonly Placement[]): Spot | null {
  const taken = Array.from({ length: CANVAS_ROWS }, () => new Array<boolean>(COLUMNS).fill(false))
  for (const p of drawn) {
    for (let y = Math.max(0, p.y); y < Math.min(CANVAS_ROWS, p.y + p.h); y += 1) {
      for (let x = Math.max(0, p.x); x < Math.min(COLUMNS, p.x + p.w); x += 1) taken[y]![x] = true
    }
  }
  /* How far down from (x, y) the column is free, to the bottom of the canvas. */
  const down = (x: number, y: number) => {
    let n = 0
    while (y + n < CANVAS_ROWS && !taken[y + n]![x]) n += 1
    return n
  }
  for (let y = 0; y + NEW_H <= CANVAS_ROWS; y += 1) {
    for (let x = 0; x + NEW_W <= COLUMNS; x += 1) {
      let fits = true
      for (let c = x; c < x + NEW_W && fits; c += 1) fits = down(c, y) >= NEW_H
      if (fits) return { x, y, w: NEW_W, h: NEW_H }
    }
  }

  for (let y = 0; y + GAP_MIN_H <= CANVAS_ROWS; y += 1) {
    for (let x = 0; x + GAP_MIN_W <= COLUMNS; x += 1) {
      if (taken[y]![x]) continue
      let best: Spot | null = null
      let height = NEW_H
      for (let w = 1; w <= NEW_W && x + w <= COLUMNS; w += 1) {
        height = Math.min(height, down(x + w - 1, y))
        if (height === 0) break
        if (w >= GAP_MIN_W && height >= GAP_MIN_H && (!best || w * height >= best.w * best.h)) {
          best = { x, y, w, h: height }
        }
      }
      if (best) return best
    }
  }
  return null
}

function fresh(id: string, at: Spot): Placement {
  const { x, y, w, h } = at
  /* Off. A new container is the size this host chose and stays there until somebody
     says otherwise — either by dragging its corner or by turning this on. */
  return {
    i: id,
    x,
    y,
    w,
    h,
    grow: false,
    pinned: false,
    prompt: '',
    promptFor: null,
    collapsed: false,
    /* The height it was given, which is the height it asks for until a hand
       or its module says otherwise. */
    wish: h,
    /* Off. A container arriving on the canvas has not been picked out by
       anybody, and a host that selected what it just added would be aiming an
       agent at a container the person has not even looked at yet. */
    selected: false,
    /* Nothing chosen. Every group falls back to whatever its module says its
       resting option is, which is what a container nobody has pressed this
       on should be showing. */
    filters: {},
    /* Not on a clock. A container that arrived refreshing itself every five
       minutes would be spending somebody's rate limit on a decision they
       never made. */
    refreshEvery: null,
    /* Latest. A new container runs the module's own checkout until somebody
       picks a version in its header. */
    version: null,
    /* Its module's default scope, until somebody picks another in its settings. */
    scope: null,
  }
}

/** Take one off. */
export function unplace(placements: readonly Placement[], id: string): Placement[] {
  return placements.filter((p) => p.i !== id)
}

/*
 * There used to be a `reconcile()` here that took every container for an
 * unregistered module off the arrangement. It is gone on purpose and must not
 * come back: the arrangement now lives in the project's own folder and travels
 * with it — see `server/kehikot.ts` — so a page on one computer filtering by
 * what THAT computer has registered, and writing the result, would delete the
 * other computer's containers through the shared file. What is drawn for such
 * a container is `canvas/Missing.tsx`.
 */

/**
 * How many kehikot left are kept loaded, beside the open one. Two: the one
 * just left, which is where people go back to, and the one before it, for the
 * person working across a pair with a third open now and then.
 */
export const KEPT_KEHIKOT = 2

/**
 * The kehikot whose pages are kept, most recent first: the open one, then the
 * ones left, at most `kept` of them, each once. `recent` is what this said
 * last; the open kehikko moves to its front.
 */
export function recentlyOpen(recent: readonly number[], open: number | null, kept = KEPT_KEHIKOT): number[] {
  const rest = recent.filter((id) => id !== open)
  return (open === null ? rest : [open, ...rest]).slice(0, kept + 1)
}

/**
 * The modules whose pages may stay loaded: every module on a kehikko in
 * `recent`. A page outside it is let go — see `Frames.tsx`.
 */
export function framesKept(canvases: readonly Canvas[], recent: readonly number[]): Set<string> {
  const ids = new Set<string>()
  const keep = new Set(recent)
  for (const canvas of canvases) if (keep.has(canvas.id)) for (const p of canvas.placements) ids.add(p.i)
  return ids
}

/**
 * Every module placed on any canvas.
 *
 * The canvas layer loads a module's page ONCE and shows it on whichever canvas
 * asked for it, so it needs the union rather than the current canvas — see
 * `canvas/Frames.tsx` for why a page that is switched away from must not be
 * torn down (until its kehikko falls off `recentlyOpen`).
 */
export function everyPlaced(canvases: readonly Canvas[]): string[] {
  const ids = new Set<string>()
  for (const canvas of canvases) for (const p of canvas.placements) ids.add(p.i)
  return [...ids].sort()
}

/* There used to be an `unfoldedByResize()` here: whether a drag of the corner
   had asked a folded container to open. It is `dragged()` in `columns.ts` now,
   beside the rule that decides what a drag to the FOLDED height means, because
   the two are one question asked in two directions. */
