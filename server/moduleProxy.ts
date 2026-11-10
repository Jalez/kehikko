import { readBuild, START_HEADER, startVerdict, WELL_KNOWN } from 'kehikot-module-protocol'

import { ADDRESS_CHECK_PATH, frameOriginOf, isModuleHost, machineBaseFor, routeOf, type ModuleRoute } from '../src/host/moduleAddress.ts'

/**
 * The host forwarding a request for a module to the process it knows is that module, at whatever
 * port it bound (`src/host/moduleAddress.ts` says which addresses).
 *
 * ## What it checks before forwarding anything
 *
 * A port is a number anything can take. Before a request goes to the module's registered origin,
 * the proxy asks who is there (`identify`), and forwards only to the module:
 *
 *  - The manifest at `WELL_KNOWN` names this module's id. A program that answers 404, serves
 *    something that is not a manifest, or names another id is not this module, and the request is
 *    refused with a sentence.
 *  - When this host started the module it handed it a start token (`KEHIKOT_START_TOKEN`,
 *    protocol 2.60.0). A module that says one back must say THAT one (`startVerdict`). Another
 *    token means another process, such as an older start, another host's copy or a lookalike, and
 *    it is refused. A module built before 2.60.0, or one this host did not start, says none, and
 *    the id decides.
 *  - Every answer is checked again: one that carries another start token is refused, even when
 *    the check before it passed, because the process may have changed in between.
 *
 * What it found is kept for `KEEP_MS`, and dropped as soon as a forward fails to connect.
 *
 * ## What it changes on the way
 *
 * The module's server is the same program it is on its own port. Its `hostFence` and its doors'
 * gate compare `Host` and `Origin` with its own address, so the proxy rewrites both to the
 * module's real origin when the request came from the module's own frame address. An `Origin` from
 * anywhere else is passed as it is, and the module refuses it as it always has. That is what
 * keeps one module's frame from talking to another module through this host. Hop-by-hop headers go.
 * A `Location` that names the real origin is put back on the address the request came by.
 * Bodies stream both ways and nothing is buffered, so an event stream and a long MCP call pass as
 * they are. WebSockets are relayed frame by frame (`ModuleSockets`).
 *
 * ## The program's address is for programs
 *
 * `/m/<id>/…` is on this host's own origin, so a page served there would be this host's page,
 * able to write to everything the guard keeps for it. A request there that a browser sent (it
 * carries `Origin` or `Sec-Fetch-*`) is refused, and every answer there is sent with
 * `content-security-policy: sandbox`, so even a page that got through runs on no origin at all.
 */

/** How long what `identify` found is believed. Short: a module restarting changes it. */
export const KEEP_MS = 2_000

/** How long the manifest gets to answer before the module is called not running. */
export const IDENTIFY_TIMEOUT_MS = 1_500

/** How long a module's WebSocket gets to accept before the handshake is refused. */
export const SOCKET_OPEN_TIMEOUT_MS = 5_000

/** Messages held for a socket whose other side has not opened yet. More, and the socket is closed. */
export const SOCKET_QUEUE_MOST = 256

/**
 * How far one side of a relayed socket may fall behind the other, in bytes, before the relay
 * closes it (1013, "try again later"). Neither side's reading can be paused (Bun's sockets read
 * as data arrives), so this is the backpressure: memory is bounded, and a reader that cannot keep
 * up is told so instead of being fed until the host runs out. A terminal's output, at the pace a
 * person reads, is nowhere near it.
 */
export const SOCKET_BUFFER_MOST = 4 * 1024 * 1024

/** What the proxy is told about one module: where it answers, and the token this host handed it (null: it did not start it). */
export interface ProxyTarget {
  origin: string
  token: string | null
}

/** Which program a route is for: a module, or a pinned version of it (its tag or the tag's slug). */
export interface Wanted {
  id: string
  version?: string
}

export interface ProxyDeps {
  /**
   * Where a module (or a pinned version) answers and its token, or null when nothing is registered
   * under that id or no such version runs. `fresh`: read the registration again, not what was last
   * swept. Asked again fresh once when what it said does not answer as the module: a module bound
   * a new port since the last sweep.
   */
  target(wanted: Wanted, fresh: boolean): ProxyTarget | null | Promise<ProxyTarget | null>
  /**
   * What this host answers on `ADDRESS_CHECK_PATH` under any frame name: a value minted per start,
   * which the page compares with what `/host/module-addresses` told it (`src/host/addressCheck.ts`).
   */
  check?: string
  /** This host's own port: the stable addresses are on it. */
  port: number
  fetch?: typeof fetch
  now?: () => number
}

/** The part of Bun's server a handshake is upgraded with. */
export interface Upgrader {
  upgrade(request: Request, options: { data: SocketData; headers?: Record<string, string> }): boolean
}

/** What `identify` found at a module's origin. */
export type Identity = { ok: true } | { ok: false; status: 502 | 503; why: string }

const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }

/** Never forwarded: they describe one connection, not the request. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Set on a WebSocket handshake by the browser for the connection, never relayed as headers. */
const HANDSHAKE = new Set(['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'sec-websocket-accept'])

/** A refusal as a response: a sentence and a status, and nothing forwarded. */
export function refused(status: number, why: string, sandboxed = false): Response {
  return new Response(`${why}\n`, { status, headers: { ...TEXT, ...(sandboxed ? { 'content-security-policy': 'sandbox' } : {}) } })
}

/** Whether a browser sent this: it says `Origin` or a `Sec-Fetch-*` header on anything a page asks. A program says neither. */
export function fromABrowser(headers: Headers): boolean {
  if (headers.has('origin')) return true
  for (const name of ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) if (headers.has(name)) return true
  return false
}

/** The address the request came by, as an origin plus base path, for putting a `Location` back. */
function cameBy(route: ModuleRoute, port: number): { origin: string | null; base: string } {
  if (route.kind === 'frame') return { origin: frameOriginOf(route, port), base: '' }
  return { origin: `http://127.0.0.1:${port}`, base: new URL(machineBaseFor(route.id, port, route.version)).pathname }
}

/**
 * The headers the module is sent: the client's, without hop-by-hop ones, with `Host` the module's
 * own, and `Origin` and `Referer` the module's own when they named the module's frame address.
 */
export function forwardHeaders(incoming: Headers, route: ModuleRoute, real: URL, port: number, socket = false): Headers {
  const out = new Headers()
  const named = (incoming.get('connection') ?? '').split(',').map((one) => one.trim().toLowerCase()).filter(Boolean)
  for (const [name, value] of incoming) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key) || named.includes(key)) continue
    if (socket && HANDSHAKE.has(key)) continue
    out.set(key, value)
  }
  out.set('host', real.host)
  const own = frameOriginOf(route, port)
  const origin = incoming.get('origin')
  if (origin !== null && own !== null && route.kind === 'frame' && origin === own) out.set('origin', real.origin)
  const referer = incoming.get('referer')
  if (referer !== null && own !== null && route.kind === 'frame' && referer.startsWith(`${own}/`)) out.set('referer', real.origin + referer.slice(own.length))
  return out
}

/** The module's answer as this host sends it on: hop-by-hop headers gone, a `Location` put back on the address it came by. */
function backHeaders(answer: Headers, route: ModuleRoute, real: URL, port: number): Headers {
  const out = new Headers()
  const named = (answer.get('connection') ?? '').split(',').map((one) => one.trim().toLowerCase()).filter(Boolean)
  for (const [name, value] of answer) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key) || named.includes(key)) continue
    /* `Headers` folds repeated headers into one; a cookie each is what a browser reads. */
    if (key === 'set-cookie') continue
    out.set(key, value)
  }
  for (const cookie of answer.getSetCookie?.() ?? []) out.append('set-cookie', cookie)
  const location = answer.get('location')
  if (location && location.startsWith(real.origin) && (location.length === real.origin.length || '/?#'.includes(location[real.origin.length]!))) {
    const by = cameBy(route, port)
    if (by.origin) out.set('location', by.origin + by.base + location.slice(real.origin.length))
  }
  if (route.kind === 'machine') out.append('content-security-policy', 'sandbox')
  return out
}

export class ModuleProxy {
  readonly #deps: ProxyDeps
  readonly #fetch: typeof fetch
  readonly #now: () => number
  /** What `identify` last found, per module, for the origin and token it was found for. */
  readonly #found = new Map<string, { origin: string; token: string | null; at: number; identity: Identity }>()

  constructor(deps: ProxyDeps) {
    this.#deps = deps
    this.#fetch = deps.fetch ?? fetch
    this.#now = deps.now ?? Date.now
  }

  /** Forget what was found about one module (all its versions), or all: its process changed. */
  forget(id?: string): void {
    if (id === undefined) this.#found.clear()
    else for (const key of [...this.#found.keys()]) if (key === id || key.startsWith(`${id}@`)) this.#found.delete(key)
  }

  /** The target and its identity, or a refusal. Asks once more, fresh, when the target did not answer as the module. */
  async #reach(route: ModuleRoute): Promise<{ ok: true; target: ProxyTarget; real: URL } | { ok: false; response: Response }> {
    const wanted: Wanted = { id: route.id, ...(route.version ? { version: route.version } : {}) }
    const name = said(route)
    let target = await this.#deps.target(wanted, false)
    let identity: Identity | null = null
    for (const fresh of [false, true]) {
      if (fresh) {
        const again = await this.#deps.target(wanted, true)
        if (!again || (target && again.origin === target.origin && again.token === target.token)) break
        target = again
      }
      if (!target) break
      identity = await this.identify(name, keyOf(wanted), target)
      if (identity.ok) break
    }
    if (!target) {
      return {
        ok: false,
        response: refused(404, route.version ? `No version ${route.version} of ${route.id} is running on this computer.` : `No module called ${route.id} is registered on this computer.`),
      }
    }
    let real: URL
    try {
      real = new URL(target.origin)
    } catch {
      return { ok: false, response: refused(502, `${name} is registered at ${target.origin}, which is not an address.`) }
    }
    if (!identity || !identity.ok) return { ok: false, response: refused(identity?.status ?? 503, identity?.why ?? `${name} is not running.`) }
    return { ok: true, target, real }
  }

  /**
   * Who answers at a module's origin: this module, or not. Kept for `KEEP_MS` per origin and token.
   * Never throws.
   */
  async identify(name: string, key: string, target: ProxyTarget): Promise<Identity> {
    const kept = this.#found.get(key)
    if (kept && kept.origin === target.origin && kept.token === target.token && this.#now() - kept.at < KEEP_MS) return kept.identity
    const identity = await this.#ask(name, key.split('@')[0]!, target)
    this.#found.set(key, { origin: target.origin, token: target.token, at: this.#now(), identity })
    return identity
  }

  async #ask(name: string, id: string, target: ProxyTarget): Promise<Identity> {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), IDENTIFY_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.#fetch(`${target.origin}${WELL_KNOWN}`, { signal: control.signal, redirect: 'manual' })
    } catch {
      clearTimeout(timer)
      return { ok: false, status: 503, why: `${name} is not running: nothing answers at ${target.origin}.` }
    }
    try {
      const stranger = `Something else is answering at ${target.origin}, where ${name} is registered, so nothing was sent there. ${name} is not running, or moved to another port.`
      if (!response.ok) return { ok: false, status: 502, why: stranger }
      const body = (await response.json().catch(() => null)) as { id?: unknown; build?: unknown } | null
      if (!body || typeof body.id !== 'string' || body.id !== id) return { ok: false, status: 502, why: stranger }
      const said = readBuild(body.build)?.start ?? response.headers.get(START_HEADER)
      if (startVerdict(target.token, said) === 'other') {
        return {
          ok: false,
          status: 502,
          why: `The ${name} answering at ${target.origin} is not the process this host started there, so nothing was sent to it. It may be an older copy that is still running.`,
        }
      }
      return { ok: true }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * A request at one of a module's stable addresses, answered: a response, `upgraded` for a
   * WebSocket handed on to the relay, or null when the request is not for a module. Read before
   * `guard.ts`: a frame's address is a name of its own, which the guard refuses as not this host's.
   * A program's address is on this host's own names (`own`), held to them like every route (the
   * guard's rule 1). `patient` lifts the idle timeout: a module's stream, socket or long call is the
   * module's to end.
   */
  async handle(request: Request, srv: Upgrader, own: ReadonlySet<string>, patient: (request: Request) => void = () => {}): Promise<Response | 'upgraded' | null> {
    const host = request.headers.get('host')
    const pathname = new URL(request.url).pathname
    /* The page's self-check, under any frame name: this host is the one answering there. */
    if (pathname === ADDRESS_CHECK_PATH && isModuleHost(host) && this.#deps.check) {
      return new Response(JSON.stringify({ host: this.#deps.check }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
      })
    }
    const route = routeOf(host, pathname)
    if (!route) return null
    if (route.kind === 'machine' && host !== null && !own.has(host.trim().toLowerCase())) return null
    patient(request)
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const opened = await this.openSocket(request, route)
      if (!opened.ok) return opened.response
      const data = moduleSockets.data(opened.upstream)
      if (srv.upgrade(request, { data, ...(opened.protocol ? { headers: { 'sec-websocket-protocol': opened.protocol } } : {}) })) return 'upgraded'
      opened.upstream.close()
      return refused(400, 'That was not a WebSocket handshake.')
    }
    return this.answer(request, route)
  }

  /** Forward one HTTP request for a module. Never throws; every refusal is a sentence. */
  async answer(request: Request, route: ModuleRoute): Promise<Response> {
    const machine = route.kind === 'machine'
    if (machine && fromABrowser(request.headers)) {
      return refused(403, 'This address is for programs on this computer. A page reaches a module at its own address.', true)
    }
    const reached = await this.#reach(route)
    if (!reached.ok) return machine ? sandbox(reached.response) : reached.response
    const { target, real } = reached
    const url = new URL(request.url)
    const method = request.method.toUpperCase()
    const init: RequestInit & { duplex?: 'half'; decompress?: boolean } = {
      method,
      headers: forwardHeaders(request.headers, route, real, this.#deps.port),
      redirect: 'manual',
      signal: request.signal,
      /* Bytes as the module sent them: decoding would leave a `content-encoding` that lies. */
      decompress: false,
    }
    if (method !== 'GET' && method !== 'HEAD' && request.body) {
      init.body = request.body
      init.duplex = 'half'
    }
    let answer: Response
    try {
      answer = await this.#fetch(`${real.origin}${route.path}${url.search}`, init)
    } catch (error) {
      this.forget(route.id)
      if ((error as Error)?.name === 'AbortError') return refused(499, 'The request was given up before the module answered.', machine)
      return refused(503, `${said(route)} stopped answering at ${target.origin}.`, machine)
    }
    if (startVerdict(target.token, answer.headers.get(START_HEADER)) === 'other') {
      void answer.body?.cancel().catch(() => {})
      this.forget(route.id)
      return refused(502, `That answer came from another process than the ${said(route)} this host started, so it was not passed on.`, machine)
    }
    const status = answer.status
    const body = status === 204 || status === 304 || method === 'HEAD' ? null : answer.body
    return new Response(body, { status, statusText: answer.statusText, headers: backHeaders(answer.headers, route, real, this.#deps.port) })
  }

  /**
   * Open the module's side of a WebSocket for a handshake on one of its addresses, after the same
   * identity check. The client is upgraded only once the module accepted, with the subprotocol
   * the module chose. Resolves to the socket and the protocol, or a refusal.
   */
  async openSocket(
    request: Request,
    route: ModuleRoute,
    open: (url: string, options: { headers: Record<string, string>; protocols: string[] }) => WebSocket = (url, options) =>
      new WebSocket(url, { headers: options.headers, protocols: options.protocols } as unknown as string[]),
  ): Promise<{ ok: true; upstream: WebSocket; protocol: string } | { ok: false; response: Response }> {
    if (route.kind === 'machine' && fromABrowser(request.headers)) {
      return { ok: false, response: refused(403, 'This address is for programs on this computer. A page reaches a module at its own address.', true) }
    }
    const reached = await this.#reach(route)
    if (!reached.ok) return reached
    const { real } = reached
    const url = new URL(request.url)
    const headers: Record<string, string> = {}
    for (const [name, value] of forwardHeaders(request.headers, route, real, this.#deps.port, true)) headers[name] = value
    const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((one) => one.trim()).filter(Boolean)
    const socketUrl = `${real.protocol === 'https:' ? 'wss:' : 'ws:'}//${real.host}${route.path}${url.search}`
    let upstream: WebSocket
    try {
      upstream = open(socketUrl, { headers, protocols })
    } catch {
      return { ok: false, response: refused(502, `${said(route)} did not take the connection.`) }
    }
    upstream.binaryType = 'arraybuffer'
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          upstream.close()
        } catch {
          /* Never opened. */
        }
        resolve({ ok: false, response: refused(504, `${said(route)} did not accept the connection in time.`) })
      }, SOCKET_OPEN_TIMEOUT_MS)
      upstream.addEventListener('open', () => {
        clearTimeout(timer)
        resolve({ ok: true, upstream, protocol: upstream.protocol })
      })
      const fail = () => {
        clearTimeout(timer)
        resolve({ ok: false, response: refused(502, `${said(route)} refused the connection.`) })
      }
      upstream.addEventListener('error', fail)
      upstream.addEventListener('close', fail)
    })
  }
}

/** A route's program in words: the id, and the version when it is one. */
function said(route: ModuleRoute): string {
  return route.version ? `${route.id} ${route.version}` : route.id
}

/** What an identity is kept under: the id, or `id@version`. */
function keyOf(wanted: Wanted): string {
  return wanted.version ? `${wanted.id}@${wanted.version}` : wanted.id
}

/** The same refusal, sandboxed. */
function sandbox(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('content-security-policy', 'sandbox')
  return new Response(response.body, { status: response.status, headers })
}

/* ------------------------------------------------------------------------ *
 * Sockets
 * ------------------------------------------------------------------------ */

/** The part of Bun's `ServerWebSocket` the relay uses. */
export interface ClientSocket {
  readonly data: SocketData
  send(data: string | ArrayBuffer | Uint8Array): number
  close(code?: number, reason?: string): void
  /** Bytes queued to the client and not yet sent. */
  getBufferedAmount(): number
}

/** What a relayed client socket carries: the module's side, the client once it opened, and what arrived before. */
export interface SocketData {
  relay: true
  upstream: WebSocket
  /** The client, from its `open` on. */
  client: ClientSocket | null
  /** Messages from the module that arrived before the client's `open`. */
  early: Array<string | ArrayBuffer>
  /** Their bytes, held to `SOCKET_BUFFER_MOST` with the rest. */
  earlyBytes: number
}

/** A message's size in bytes, near enough to bound a buffer by. */
function bytesOf(payload: string | ArrayBuffer | Uint8Array): number {
  return typeof payload === 'string' ? payload.length * 2 : payload.byteLength
}

/** Close both sides of a relay whose reader fell too far behind. */
function tooFarBehind(data: SocketData): void {
  const why = 'The other side could not keep up, so the connection was closed.'
  try {
    data.upstream.close(1013, why)
  } catch {
    /* Already closing. */
  }
  try {
    data.client?.close(1013, why)
  } catch {
    /* Already closed. */
  }
}

/** Whether a close code may be sent by an endpoint (1005, 1006 and 1015 may only be reported). */
function sendable(code: number): number {
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code
  return code === 1005 ? 1000 : 1011
}

/**
 * The relay between a client socket and the module's, for Bun.serve's `websocket` handlers. Frames
 * go through as they are, text as text and binary as binary. Either side closing closes the
 * other, with its code when that code may be sent.
 */
export const moduleSockets = {
  /**
   * The data a client socket is upgraded with, once the module's side is open. The module's side is
   * wired now, before the client is upgraded, so nothing it sends in between is lost.
   */
  data(upstream: WebSocket): SocketData {
    const data: SocketData = { relay: true, upstream, client: null, early: [], earlyBytes: 0 }
    upstream.addEventListener('message', (event) => {
      const payload = event.data as string | ArrayBuffer
      if (data.client) {
        /* -1 is queued behind backpressure, 0 dropped: either way the client is behind. */
        const sent = data.client.send(payload)
        if (sent === 0 || data.client.getBufferedAmount() > SOCKET_BUFFER_MOST) tooFarBehind(data)
        return
      }
      data.earlyBytes += bytesOf(payload)
      if (data.early.length >= SOCKET_QUEUE_MOST || data.earlyBytes > SOCKET_BUFFER_MOST) {
        try {
          upstream.close(1011, 'The page did not open in time.')
        } catch {
          /* Already closing. */
        }
        return
      }
      data.early.push(payload)
    })
    upstream.addEventListener('close', (event) => {
      try {
        data.client?.close(sendable(event.code), event.reason)
      } catch {
        /* Already closed. */
      }
    })
    return data
  },

  open(socket: ClientSocket): void {
    socket.data.client = socket
    for (const payload of socket.data.early.splice(0)) socket.send(payload)
    socket.data.earlyBytes = 0
    /* The module may have closed while the client was being upgraded. */
    const state = socket.data.upstream.readyState
    if (state === 2 || state === 3) socket.close(1011, 'The module closed the connection.')
  },

  message(socket: ClientSocket, message: string | Buffer | Uint8Array): void {
    const upstream = socket.data.upstream
    if (upstream.readyState !== 1) return
    upstream.send(typeof message === 'string' ? message : new Uint8Array(message))
    /* The module is not reading what the client sends: bounded, as the other way round. */
    if (upstream.bufferedAmount > SOCKET_BUFFER_MOST) tooFarBehind(socket.data)
  },

  close(socket: ClientSocket, code: number, reason: string): void {
    socket.data.client = null
    const upstream = socket.data.upstream
    if (upstream.readyState === 2 || upstream.readyState === 3) return
    try {
      upstream.close(sendable(code), reason)
    } catch {
      /* Already closed. */
    }
  },
}
