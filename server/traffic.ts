import { AsyncLocalStorage } from 'node:async_hooks'

import {
  LIMITS,
  TRAFFIC_HOST_BY,
  trafficCallSchema,
  trafficCommand,
  trafficNoteSchema,
  trafficPath,
  trafficTarget,
  type TrafficBudget,
  type TrafficCaller,
  type TrafficCache,
  type TrafficCall,
  type TrafficLimits,
  type TrafficNote,
  type TrafficNoteResult,
  type TrafficProcesses,
  type TrafficReadResult,
  type TrafficVia,
} from 'kehikot-module-protocol'

import { callerOf, isLoopback, remoteCaller, type Found } from './callers.ts'

/**
 * The host's record of traffic (protocol 2.20.0): every call this host makes, every request it
 * receives on its own routes, the calls modules note, and the connections the process sampler sees.
 *
 * ## In memory, and bounded
 *
 * The last `LIMITS.TRAFFIC_KEPT` rows, in a ring, in this process. Never in a project, never on
 * disk: what a person's machine talked to and when is theirs, and a restart forgets it.
 *
 * ## The reason comes from the call site
 *
 * `because(reason, work)` runs `work` with a reason that every call made inside it — however deep,
 * across awaits — is filed under (`AsyncLocalStorage`). The recorders sit at the two choke points,
 * the global `fetch` and `Bun.spawn`, so a call nobody gave a reason is still recorded, as "no reason
 * given", and a new call site cannot be missed: only its reason can.
 *
 * ## Sanitized where it is made
 *
 * An address goes through the protocol's `trafficTarget`/`trafficPath`/`trafficCommand` before it
 * reaches the record: no user, password, query value, fragment or token-looking segment, and of a
 * program's arguments only the remote or API path. Never a body or a header.
 */

/** A row before the record numbers it. */
export type Unnumbered = Omit<TrafficCall, 'seq'>

interface Context {
  reason: string | null
  /** True inside `untraced`: the plumbing of traffic itself, which is not recorded. */
  quiet: boolean
}

const context = new AsyncLocalStorage<Context>()

/** Run `work` with every call made inside it filed under `reason`. The innermost reason wins. */
export function because<T>(reason: string, work: () => T): T {
  return context.run({ reason: reason.trim().slice(0, LIMITS.TRAFFIC_REASON) || null, quiet: context.getStore()?.quiet ?? false }, work)
}

/** Run `work` without recording what it calls: reading and noting traffic would otherwise fill the record with itself. */
export function untraced<T>(work: () => T): T {
  return context.run({ reason: context.getStore()?.reason ?? null, quiet: true }, work)
}

/** The reason the code running now was given, or null. */
export const reasonNow = (): string | null => context.getStore()?.reason ?? null
const quietNow = (): boolean => context.getStore()?.quiet === true

/** The ring. */
export class TrafficRecord {
  readonly started: number
  readonly kept: number
  #rows: TrafficCall[] = []
  #seq = 0
  #listeners = new Set<(row: TrafficCall) => void>()

  constructor(kept: number = LIMITS.TRAFFIC_KEPT, now: () => number = Date.now) {
    this.kept = kept
    this.started = now()
  }

  /** Number and keep one row; a row that does not fit the protocol's shape is dropped, not clipped into one. */
  add(row: Unnumbered): TrafficCall | null {
    const read = trafficCallSchema.safeParse({ ...row, seq: this.#seq + 1 })
    if (!read.success) return null
    this.#seq++
    this.#rows.push(read.data)
    if (this.#rows.length > this.kept) this.#rows.splice(0, this.#rows.length - this.kept)
    for (const listen of this.#listeners) listen(read.data)
    return read.data
  }

  /** Told of every row as it is kept. Returns the way to stop. */
  listen(listener: (row: TrafficCall) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get newest(): number {
    return this.#seq
  }

  get oldest(): number {
    return this.#rows[0]?.seq ?? this.#seq + 1
  }

  /** The rows after `since`, oldest first, at most `limit`. */
  read(since: number, limit: number): Pick<TrafficReadResult, 'calls' | 'newest' | 'oldest' | 'gap' | 'kept' | 'started'> {
    const after = since > this.#seq ? 0 : since
    const first = this.#rows.findIndex((row) => row.seq > after)
    const calls = first < 0 ? [] : this.#rows.slice(first, first + Math.max(1, Math.min(limit, LIMITS.TRAFFIC_KEPT)))
    const oldest = this.oldest
    return { calls, newest: this.#seq, oldest, gap: after > 0 && after < oldest - 1, kept: this.kept, started: this.started }
  }
}

/* ------------------------------------------------------------------------ *
 * The host's own calls: `fetch` and `Bun.spawn`.
 * ------------------------------------------------------------------------ */

const lengthOf = (headers: Headers): number | undefined => {
  const said = Number(headers.get('content-length'))
  return headers.has('content-length') && Number.isInteger(said) && said >= 0 ? said : undefined
}

function bodyBytes(body: unknown): number | undefined {
  if (typeof body === 'string') return Buffer.byteLength(body)
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  return undefined
}

/** A row of the host's own making, `out` from its server. */
export function hostCall(fields: Pick<Unnumbered, 'at' | 'kind' | 'host' | 'path'> & Partial<Unnumbered>): Unnumbered {
  return {
    ms: null,
    reason: reasonNow(),
    status: null,
    ok: null,
    by: TRAFFIC_HOST_BY,
    via: 'server',
    side: 'out',
    reported: 'host',
    ...fields,
  }
}

/**
 * `fetch` that records the call: method, sanitized address, status, time, the bytes the headers say,
 * and a 304 as `not-modified`. The body is never read here — the caller reads the same response.
 */
export function recordingFetch(record: TrafficRecord, inner: typeof fetch, now: () => number = Date.now): typeof fetch {
  const traced = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (quietNow()) return inner(input, init)
    const at = now()
    const url = input instanceof Request ? input.url : String(input)
    const kind = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase().slice(0, LIMITS.TRAFFIC_KIND)
    const target = trafficTarget(url)
    const reason = reasonNow()
    const out = bodyBytes(init?.body)
    try {
      const response = await inner(input, init)
      const bytesIn = lengthOf(response.headers)
      record.add(
        hostCall({
          at,
          ms: Math.min(3_600_000, now() - at),
          reason,
          kind,
          ...target,
          status: response.status,
          ok: response.ok || response.status === 304,
          ...(bytesIn !== undefined ? { bytesIn } : {}),
          ...(out !== undefined ? { bytesOut: out } : {}),
          ...(response.status === 304 ? { cache: 'not-modified' as const } : {}),
        }),
      )
      return response
    } catch (error) {
      record.add(hostCall({ at, ms: Math.min(3_600_000, now() - at), reason, kind, ...target, ok: false, ...(out !== undefined ? { bytesOut: out } : {}) }))
      throw error
    }
  }
  return Object.assign(traced, inner) as typeof fetch
}

type Spawn = typeof Bun.spawn
type SpawnSync = typeof Bun.spawnSync

const argvOf = (first: unknown): string[] | null => {
  if (Array.isArray(first)) return first.map(String)
  if (first && typeof first === 'object' && Array.isArray((first as { cmd?: unknown }).cmd)) return (first as { cmd: unknown[] }).cmd.map(String)
  return null
}

/**
 * `Bun.spawn` and `Bun.spawnSync` that record a program run when it went over the network
 * (`trafficCommand`: `git fetch`, `gh api`, `glab api`…), with its exit code and time. Every other run
 * passes through untouched.
 */
export function recordingSpawn(record: TrafficRecord, inner: { spawn: Spawn; spawnSync: SpawnSync }, now: () => number = Date.now) {
  const spawn = ((...args: Parameters<Spawn>) => {
    const child = (inner.spawn as (...a: unknown[]) => ReturnType<Spawn>)(...args)
    if (quietNow()) return child
    const said = trafficCommand(argvOf(args[0]) ?? [])
    if (!said) return child
    const at = now()
    const reason = reasonNow()
    void child.exited
      .then((code) => record.add(hostCall({ at, ms: Math.min(3_600_000, now() - at), reason, kind: said.kind, host: said.host, path: said.path, status: code, ok: code === 0 })))
      .catch(() => {})
    return child
  }) as Spawn
  const spawnSync = ((...args: Parameters<SpawnSync>) => {
    const at = now()
    const ran = (inner.spawnSync as (...a: unknown[]) => ReturnType<SpawnSync>)(...args)
    if (quietNow()) return ran
    const said = trafficCommand(argvOf(args[0]) ?? [])
    if (said) record.add(hostCall({ at, ms: Math.min(3_600_000, now() - at), kind: said.kind, host: said.host, path: said.path, status: ran.exitCode, ok: ran.exitCode === 0 }))
    return ran
  }) as SpawnSync
  return { spawn, spawnSync }
}

/** The record this process keeps, once `recordThisProcess` put it in place; null in a test that did not. */
let processRecord: TrafficRecord | null = null

/** Put both recorders in place, once, for this process. */
export function recordThisProcess(record: TrafficRecord): void {
  const marked = globalThis as { __kehikotTraffic?: boolean }
  if (marked.__kehikotTraffic) return
  marked.__kehikotTraffic = true
  processRecord = record
  globalThis.fetch = recordingFetch(record, globalThis.fetch.bind(globalThis))
  const recorded = recordingSpawn(record, { spawn: Bun.spawn, spawnSync: Bun.spawnSync })
  ;(Bun as unknown as { spawn: Spawn }).spawn = recorded.spawn
  ;(Bun as unknown as { spawnSync: SpawnSync }).spawnSync = recorded.spawnSync
}

/**
 * A call answered from what this host kept, so nothing was sent: filed in this process's record
 * (`recordThisProcess`) as `hit`, so a reader sees what a cache saved. A no-op before that.
 */
export function noteHit(address: string, kind = 'GET'): void {
  if (processRecord) noteFree(processRecord, address, 'hit', kind)
}

/** A call that never went out: answered from what was kept, or held back by a budget. */
export function noteFree(record: TrafficRecord, address: string, cache: TrafficCache, kind = 'GET', now: () => number = Date.now): void {
  if (quietNow()) return
  record.add(hostCall({ at: now(), ms: 0, kind, ...trafficTarget(address), cache, ok: cache !== 'refused' }))
}

/**
 * A program run held back by a budget, so it never went out: filed as `refused`, its reason the
 * sentence why ("held: Kehikot's share of your GitHub limit is used until 11:00"), then the reason
 * the work was given, as far as both fit.
 */
export function noteHeld(record: TrafficRecord, argv: readonly string[], why: string, now: () => number = Date.now): void {
  if (quietNow()) return
  const said = trafficCommand(argv)
  if (!said) return
  const outer = reasonNow()
  const full = `held: ${why}${outer ? ` · ${outer}` : ''}`
  const reason = full.length > LIMITS.TRAFFIC_REASON ? `${full.slice(0, LIMITS.TRAFFIC_REASON - 1)}…` : full
  record.add(hostCall({ at: now(), ms: 0, reason, kind: said.kind, host: said.host, path: said.path, cache: 'refused', ok: false }))
}

/* ------------------------------------------------------------------------ *
 * What modules note.
 * ------------------------------------------------------------------------ */

const HOST_NAME = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$|^\[[0-9a-f:.]+\](?::\d{1,5})?$|^$/

/**
 * A module's notes, sanitized again and filed under it. The module said it sanitized them; this
 * host does not take its word: the host must be a host name, the path goes through `trafficPath`.
 */
export function takeNotes(record: TrafficRecord, module: string, via: TrafficVia, calls: readonly TrafficNote[]): TrafficNoteResult {
  let taken = 0
  for (const one of calls) {
    const note = trafficNoteSchema.safeParse(one)
    if (!note.success) continue
    const host = note.data.host.toLowerCase()
    const row = record.add({
      ...note.data,
      host: HOST_NAME.test(host) ? host : '',
      path: trafficPath(note.data.path),
      by: module,
      via,
      side: 'out',
      reported: 'module',
    })
    if (row) taken++
  }
  return { outcome: 'taken', taken, why: '' }
}

/* ------------------------------------------------------------------------ *
 * What this host receives.
 * ------------------------------------------------------------------------ */

/**
 * What a received request is about, by route: the reason a row of `in` gets when nothing more exact
 * is known. A fixed vocabulary, read through `routeReason`: a route under one of these (`/host/canvases/3`
 * under `/host/canvases`) is about the same thing. Every route `server/` answers has one
 * (`test/traffic-reasons.test.ts`); a route not here is "no reason given".
 */
export const ROUTE_REASONS: Readonly<Record<string, string>> = {
  '/host/call': 'a module asks',
  '/host/watch': 'the page waits for news',
  '/host/modules': 'the page reads the modules',
  '/host/quiet': 'the page asks whether modules are quiet',
  '/host/canvases': 'the page reads or saves the kehikot',
  '/host/connections': 'the person switches how a kehikko’s modules affect each other',
  '/host/subject': 'the page says which epic is open',
  '/host/parts': 'the page edits an epic’s parts',
  '/host/layouts': 'the page’s suggested layouts',
  '/host/projects': 'the page reads the projects',
  '/host/projects/followed': 'the page reads the projects',
  '/host/projects/locate': 'a person locates a project',
  '/host/folders': 'a person picks a folder',
  '/host/base-branch': 'a project’s base branch',
  '/host/epics': 'the page reads the epics',
  '/host/tracker': 'the page reads the tracker reading',
  '/host/tracker/refresh': 'tracker refresh asked',
  '/host/trackers': 'a project’s tracker sources',
  '/host/dispositions': 'the page reads why refs closed',
  '/host/updates': 'update check',
  '/host/module-release': 'a module’s release details',
  '/host/release-notes': 'release notes',
  '/host/releases': 'release list',
  '/host/official': 'the official module list',
  '/host/official/install': 'a person installs a module',
  '/host/official/propose': 'a person proposes a module',
  '/host/mine': 'my modules',
  '/host/feedback': 'a person sends feedback',
  '/host/is-project': 'a module asks whether a folder is a project',
  '/host/place': 'a session’s place',
  '/host/settings-pass': 'a module checks a settings pass',
  '/host/server-ask': 'a module’s server asks',
  '/host/headers': 'the page reports a module’s header',
  '/host/pressed': 'the page reports a press',
  '/host/open': 'the page says what it has open',
  '/host/start': 'start a module',
  '/host/restart': 'restart a module',
  '/host/restart-anyway': 'restart a module',
  '/host/restart-module': 'restart a module',
  '/host/agent': 'an agent’s place',
  '/host/inbox/report': 'the page reports a module’s Inbox items',
  '/host/inbox/notice': 'the page reports a module’s notice',
  '/host/inbox/act': 'a person acts on the Inbox',
  '/host/inbox/log': 'the page reads the Inbox',
  '/host/inbox/migrate': 'the page reads the Inbox',
  '/host/inbox': 'the page reads the Inbox',
  '/host/health': 'is Kehikot up',
  '/host/hello': 'is Kehikot here',
  '/host/tools': 'a module’s tools',
  '/host/skills': 'a module’s skills',
  '/host/versions': 'a module’s versions',
  '/host/whats-new': 'what’s new',
  '/host/onboarding': 'the introduction and the tour',
  '/host/settings': 'settings',
  '/host/sounds': 'the Inbox chime’s own sounds',
  '/host/module-settings': 'a module’s settings',
  '/host/storage': 'the storage overview',
  '/mcp': 'an agent asks Kehikot',
}

/** What the page's own files are fetched for, when this host serves them (the desktop app's). */
export const PAGE_FILES_REASON = 'the page loads Kehikot'

/**
 * The reason for a request to `pathname`: its route's, else the route it is under, else — for
 * anything outside `/host/` and `/mcp` — the page's own files. Null for an unknown `/host/` path.
 */
export function routeReason(pathname: string): string | null {
  const exact = ROUTE_REASONS[pathname]
  if (exact) return exact
  for (let at = pathname.lastIndexOf('/'); at > 0; at = pathname.lastIndexOf('/', at - 1)) {
    const under = ROUTE_REASONS[pathname.slice(0, at)]
    if (under) return under
  }
  if (pathname === '/host' || pathname.startsWith('/host/') || pathname === '/mcp' || pathname.startsWith('/mcp/')) return null
  return PAGE_FILES_REASON
}

/** What the route that answered says about the request, beside what the wrapper sees. */
export interface Tag {
  by?: string
  via?: TrafficVia
  reason?: string | null
  /** Who asked, when the route knows better than the connection: an MCP call's place token names its session. */
  caller?: TrafficCaller
  /** A session's place ("Wide · methods"), when its MCP session is recorded but nothing else names it. */
  place?: string
  /** Not recorded: the plumbing of traffic itself. */
  skip?: boolean
}

const tags = new WeakMap<Request, Tag>()

/** Said by a route about the request it is answering: who asked, and why. */
export function tag(request: Request, said: Tag): void {
  tags.set(request, { ...(tags.get(request) ?? {}), ...said })
}

/** What the routes said about a request so far. */
export const tagOf = (request: Request): Tag => tags.get(request) ?? {}

export interface ReceivedFrom {
  /** The page's own origins: a request carrying one of these is this host's page. */
  pageOrigins: readonly string[]
  /** The module whose page answers on this origin, or null: a module's page asking the host itself. */
  moduleAt?(origin: string): string | null
  /** A module's registered name ("Paper"); the id when it has none. */
  nameOf?(module: string): string
}

const MODULE_ID = /^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/

/** Whether a request carries this host's page's origin (or is same-origin with no `Origin`). */
export function fromThePage(request: Request, pageOrigins: readonly string[]): boolean {
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  return (origin !== null && pageOrigins.includes(origin)) || (origin === null && (site === 'same-origin' || site === 'none'))
}

/**
 * The row for one request this host answered, with who asked (protocol 2.25.0, `caller`): what the
 * route said (`tag`: a module's server asking with its pass, an MCP call's place token), else this
 * host's own page by its `Origin`/`Sec-Fetch-Site`, else a module's page by its origin, else another
 * computer by its address, else the process at the other end of the connection (`found`, from
 * `PeerLookup`; null when it had closed), else a module named in the query. `found` undefined: not
 * looked up.
 */
export function receivedRow(
  request: Request,
  response: Response,
  at: number,
  ms: number,
  from: ReceivedFrom,
  client: { address?: string; port: number } | null,
  found?: Found | null,
): Unnumbered | null {
  const said = tags.get(request) ?? {}
  if (said.skip) return null
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  const fromPage = fromThePage(request, from.pageOrigins)
  const nameOf = (id: string) => (id === TRAFFIC_HOST_BY ? 'Kehikot' : (from.nameOf?.(id) ?? id))
  const named = url.searchParams.get('module')
  const claimed = named && MODULE_ID.test(named) ? named : null
  const pageOf = !fromPage && origin ? (from.moduleAt?.(origin) ?? null) : null
  let by = ''
  let via: TrafficVia = 'server'
  let caller: TrafficCaller
  if (said.caller) {
    by = said.by ?? ''
    via = said.via ?? 'process'
    /* A session named by its token; the process, when the lookup already found it, says which. */
    caller = found ? { ...said.caller, process: found.exe || undefined, parent: found.parent || undefined, pid: found.pid } : said.caller
  } else if (said.by !== undefined && said.by !== '') {
    by = said.by
    via = said.via ?? (fromPage ? 'page' : 'server')
    caller = { kind: by === TRAFFIC_HOST_BY ? 'host' : 'module', name: nameOf(by), how: fromPage || via === 'page' ? 'origin' : 'route' }
  } else if (fromPage) {
    by = TRAFFIC_HOST_BY
    via = said.via ?? 'page'
    caller = { kind: 'host', name: 'Kehikot', how: 'origin' }
  } else if (pageOf) {
    by = pageOf
    via = 'page'
    caller = { kind: 'module', name: nameOf(pageOf), how: 'origin' }
  } else if (client?.address && !isLoopback(client.address)) {
    caller = remoteCaller(client.address)
  } else if (found) {
    caller = callerOf(found, { module: nameOf, place: said.place ?? null })
    by = found.owner ?? ''
    via = caller.kind === 'module' || caller.kind === 'host' ? 'server' : 'process'
  } else if (claimed) {
    by = claimed
    caller = { kind: 'module', name: nameOf(claimed), how: 'route' }
  } else {
    caller = callerOf(null, { module: nameOf })
  }
  if (said.via && !said.caller) via = said.via
  const reason = said.reason !== undefined ? said.reason : routeReason(url.pathname)
  const bytesIn = lengthOf(request.headers)
  const bytesOut = lengthOf(response.headers)
  return {
    at,
    ms: Math.min(3_600_000, Math.max(0, Math.round(ms))),
    reason,
    kind: request.method.toUpperCase().slice(0, LIMITS.TRAFFIC_KIND),
    host: url.host.toLowerCase().slice(0, LIMITS.TRAFFIC_HOST),
    path: trafficPath(`${url.pathname}${url.search}`),
    status: response.status,
    ok: response.ok || response.status === 304,
    ...(bytesIn !== undefined ? { bytesIn } : {}),
    ...(bytesOut !== undefined ? { bytesOut } : {}),
    ...(response.status === 304 ? { cache: 'not-modified' as const } : {}),
    by: by.slice(0, LIMITS.TRAFFIC_BY),
    via,
    side: 'in',
    reported: 'host',
    caller,
  }
}

/**
 * Whether the process at the other end of a request's connection is worth looking up: nothing at
 * the door names it (this host's page, a module's page, another computer) and the connection is on
 * this computer.
 */
export function needsLookup(request: Request, from: ReceivedFrom, client: { address?: string; port: number } | null): boolean {
  if (!client || !client.port) return false
  if (client.address && !isLoopback(client.address)) return false
  if (fromThePage(request, from.pageOrigins)) return false
  const origin = request.headers.get('origin')
  return !(origin && from.moduleAt?.(origin))
}

/* ------------------------------------------------------------------------ *
 * The door: `traffic.read`.
 * ------------------------------------------------------------------------ */

export interface TrafficDoor {
  read(asked: { since: number; limit: number; sample: boolean }): TrafficReadResult
  note(module: string, via: TrafficVia, calls: readonly TrafficNote[]): TrafficNoteResult
}

export function trafficDoor(deps: {
  record: TrafficRecord
  budgets(): TrafficBudget[]
  /** Each forge's budgets, separately (protocol 2.24.0). */
  limits?(): TrafficLimits
  /** Somebody reads the record: a Monitor is open (`githubAccount.watch`). */
  read?(): void
  /** Ask the sampler to look (for a while), and what it last saw. */
  processes(wanted: boolean): TrafficProcesses | null
}): TrafficDoor {
  return {
    read({ since, limit, sample }) {
      deps.read?.()
      const limits = deps.limits?.()
      return { ...deps.record.read(since, limit), budgets: deps.budgets(), processes: sample ? deps.processes(true) : null, ...(limits ? { limits } : {}) }
    },
    note: (module, via, calls) => takeNotes(deps.record, module, via, calls),
  }
}
