/**
 * What a request must be before this host looks at it.
 *
 * This host holds no credential, so nothing here is a check of WHO is asking.
 * It is a check of where a request came from, made once, before any route is
 * chosen, so a route added later is covered without remembering to ask.
 *
 * ## Who talks to this host
 *
 *  - **Its own page.** A browser showing the page this host serves. A browser
 *    says where a request came from (`Origin`, `Sec-Fetch-Site`) and the page
 *    it is showing cannot change what it says.
 *  - **Programs with no browser in them.** The desktop shell asking
 *    `/host/health`, another copy of this host asking `/host/hello`, this host
 *    asking its own door what it offers, an agent at `/mcp`, the scripts in
 *    `dev/` and the test suite. A program sends neither header.
 *
 * ## The rule
 *
 *  1. `Host`, when a request carries one, names this machine by a loopback
 *     name and one of this host's own ports.
 *  2. `/mcp` is for programs: a request there carries no `Origin`, no
 *     `Sec-Fetch-Site` other than `none`, and — being a POST — JSON.
 *  3. Under `/host/`, and for every request that is not a GET, HEAD or
 *     OPTIONS wherever it is addressed:
 *       - an `Origin`, when there is one, is one of the page's own;
 *       - with no `Origin`, a `Sec-Fetch-Site` is `same-origin` or `none` — and
 *         a request that changes something and carries `Sec-Fetch-Site` at all
 *         must carry the `Origin` as well;
 *       - a request that changes something and has a body says the body is
 *         JSON.
 *     With neither `Origin` nor `Sec-Fetch-Site` the request is a program's,
 *     and is answered: a browser states both on anything it sends that is not
 *     its own page talking to itself.
 *  4. A few routes are the page's alone (`PAGE_ONLY`): a press that restarts
 *     a module its registration says to keep, and what the page says about
 *     its modules' headers and about a press it was asked to make. There a
 *     program is refused too — the request carries an `Origin` of the page's
 *     and JSON, or it is not answered.
 *  5. Everything else is a GET for the page, and is answered.
 *
 * This is the only place any of that is decided. A route does not ask again.
 *
 * The rule covers GETs under `/host/` as well as writes, because several of
 * them do work when asked: `/host/modules` and `/host/quiet` sweep and may
 * start a module on an open kehikko, `/host/canvases` reconciles the kehikot
 * files and records `?open=`, `/host/watch` records what a page has open,
 * `/host/updates?fetch=1`, `/host/versions?fresh=1` and `/host/official` ask
 * a remote, and `/host/tools` asks a module's door.
 *
 * A refusal is a sentence and a status, and nothing has happened.
 */

/** The request, as much of it as the rule reads. */
export interface Asked {
  method: string
  pathname: string
  headers: Headers
}

/** What this host knows about itself, worked out once at startup. */
export interface Own {
  /** Every origin this host's page is served from. */
  origins: readonly string[]
  /** Every `Host` value this host answers to: a loopback name and one of its ports. */
  hosts: ReadonlySet<string>
}

export interface Refusal {
  status: 403 | 415
  why: string
}

/**
 * The routes only this host's page may write to. A program with no browser in
 * it is let through everywhere else; not here.
 *
 *  - `/host/restart-anyway` — a person's two presses (`anyway.ts`). There is
 *    no tool for it at the door, and a script is not a person pressing.
 *  - `/host/headers`, `/host/pressed` — a browser's word about what a frame
 *    said, and what came of a press (`headers.ts`). A module's frame is
 *    another origin, and so is every other site.
 *  - `/host/inbox/report`, `/host/inbox/notice`, `/host/inbox/act`,
 *    `/host/inbox/migrate` — what the page says its modules are doing, and
 *    what a person did with it: seen, put away, forgotten (`inbox.ts`). The
 *    last is the person's, so no program may make it.
 *  - `/host/place/answer` — a person's answer to "which epic is this
 *    conversation for?" in the Inbox (`placeRoutes.ts`). An agent says its own
 *    with `set_my_place`; it never answers the person's ask.
 *  - `/host/storage` — the storage overview (`storage.ts`): every project's
 *    folders and sizes, for the page's Storage view. Read-only; an agent asks
 *    the door's `storage` tool instead.
 *  - `/host/trackers` — a person's edit of the project's tracker sources, which
 *    writes a file that travels with the repository, and the "Check" before
 *    it, which spends their login's rate limit.
 *  - `/host/mine/check`, `/host/mine/add`, `/host/mine/install`,
 *    `/host/mine/remove`, `/host/mine/adopt` — the person's own modules
 *    (`myModules.ts`): a repository read with their login, cloned and run on
 *    this machine, or deleted from it. A program that could add one could run
 *    any code it liked, so only a press in the page does it.
 */
export const PAGE_ONLY: readonly string[] = [
  '/host/restart-anyway',
  '/host/headers',
  '/host/pressed',
  '/host/inbox/report',
  '/host/inbox/notice',
  '/host/inbox/act',
  '/host/inbox/migrate',
  '/host/trackers',
  '/host/mine/check',
  '/host/mine/add',
  '/host/mine/install',
  '/host/mine/remove',
  '/host/mine/adopt',
  '/host/projects/locate',
  '/host/projects/followed',
  '/host/place/answer',
  '/host/storage',
  '/host/skills',
  '/host/settings',
  '/host/layouts',
  '/host/onboarding',
  '/host/whats-new',
]

/** The names a browser on this machine reaches a loopback listener by. This host binds 127.0.0.1 only. */
const LOOPBACK = ['127.0.0.1', 'localhost'] as const

/** The origins of the desktop window itself, which loads the page from this host. */
const WINDOW_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'] as const

const words = (value: string | undefined) => (value ?? '').split(/\s+/).filter(Boolean)

/**
 * Every origin this host's page is served from: where this host itself serves
 * it (`page`), what whoever started the host said (`KEHIKOT_ORIGINS` and
 * `KEHIKOT_ORIGIN`, which the desktop shell passes), and the desktop window's
 * own.
 *
 * Narrower than `originEnv` in `launch.ts`, on purpose. That list is who may
 * FRAME a module, and includes the default ports of every host on this
 * machine; this one is whose requests THIS host acts on, and another host's
 * page is not this host's.
 */
export function pageOriginsOf(env: Record<string, string | undefined>, page: readonly string[]): string[] {
  return [
    ...new Set([
      ...page,
      ...words(env.KEHIKOT_ORIGINS),
      ...words(env.KEHIKOT_ORIGIN),
      ...WINDOW_ORIGINS,
    ]),
  ]
}

/**
 * Every `Host` this host answers to: a loopback name with its own port, or
 * with the port of one of its page's loopback origins — in development the
 * page is on the next port up and its server passes `Host` through unchanged.
 */
export function ownHosts(port: number, origins: readonly string[]): Set<string> {
  const ports = new Set<string>([String(port)])
  for (const origin of origins) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' || !(LOOPBACK as readonly string[]).includes(url.hostname)) continue
    ports.add(url.port || '80')
  }
  const hosts = new Set<string>()
  for (const name of LOOPBACK) for (const one of ports) hosts.add(`${name}:${one}`)
  return hosts
}

export function own(env: Record<string, string | undefined>, port: number, page: readonly string[]): Own {
  const origins = pageOriginsOf(env, page)
  return { origins, hosts: ownHosts(port, origins) }
}

/** Whether the headers say the body is JSON. */
export function saysJson(headers: Headers): boolean {
  const type = ((headers.get('content-type') ?? '').toLowerCase().split(';')[0] ?? '').trim()
  return type === 'application/json'
}

/** Whether a request has a body at all, by what it says about one. */
export function hasBody(headers: Headers): boolean {
  if (headers.has('transfer-encoding')) return true
  const length = headers.get('content-length')
  /* A length that is not a plain zero is treated as a body, including one that does not parse. */
  return length !== null && length.trim() !== '0'
}

/** GET, HEAD and OPTIONS ask; everything else may change something. */
export function changes(method: string): boolean {
  const verb = method.toUpperCase()
  return verb !== 'GET' && verb !== 'HEAD' && verb !== 'OPTIONS'
}

const NOT_HERE: Refusal = {
  status: 403,
  why: 'This host answers at its own address on this machine, and this request named another. Nothing was done.',
}
const NOT_THE_PAGE: Refusal = {
  status: 403,
  why: 'This host answers its own page and programs on this machine, and this request came from neither. Nothing was done.',
}
const NOT_A_PROGRAM: Refusal = {
  status: 403,
  why: 'This door is for programs and not for pages: a request to it comes from no page. Nothing was done.',
}
const NOT_A_PRESS: Refusal = {
  status: 403,
  why: 'Only this host’s own page says this, and this request did not come from there. Nothing was done.',
}
const NOT_JSON: Refusal = {
  status: 415,
  why: 'A request that changes something here says its body is JSON (content-type: application/json). Nothing was done.',
}

/** Why this request is not answered, or null when it is. Reads headers only; touches nothing. */
export function refusal(asked: Asked, self: Own): Refusal | null {
  const { headers } = asked
  const writes = changes(asked.method)

  /* 1. Addressed to this host by its own name. A program that sends no `Host`
        at all (HTTP/1.0) is not a browser, and is let on to the rest. */
  const host = headers.get('host')
  if (host !== null && !self.hosts.has(host.trim().toLowerCase())) return NOT_HERE

  const origin = headers.get('origin')
  const site = headers.get('sec-fetch-site')?.trim().toLowerCase() ?? null

  /* 2. The door. */
  if (asked.pathname === '/mcp') {
    if (origin !== null) return NOT_A_PROGRAM
    if (site !== null && site !== 'none') return NOT_A_PROGRAM
    if (writes && !saysJson(headers)) return NOT_JSON
    return null
  }

  /* 5. A GET for the page. */
  if (!writes && !asked.pathname.startsWith('/host/')) return null

  /* 3. The page's vocabulary, and anything that may change something. */
  if (origin !== null) {
    if (!self.origins.includes(origin)) return NOT_THE_PAGE
  } else if (site !== null) {
    /* A browser, saying only how the request relates to the page that sent it.
       One that changes something states the origin too, so its absence is not
       taken on trust. */
    if (writes) return NOT_THE_PAGE
    if (site !== 'same-origin' && site !== 'none') return NOT_THE_PAGE
  }
  /* 4. The page's alone: a program is not let through, and neither is anything but JSON. */
  if (writes && PAGE_ONLY.includes(asked.pathname) && !pressedInThePage(headers, self.origins)) return NOT_A_PRESS
  if (writes && hasBody(headers) && !saysJson(headers)) return NOT_JSON
  return null
}

/**
 * Whether a request is a press in this host's page and nothing else: a browser
 * said it came from one of the page's origins, and it is JSON. What `refusal`
 * asks of the routes in `PAGE_ONLY`.
 */
function pressedInThePage(headers: Headers, origins: readonly string[]): boolean {
  const origin = headers.get('origin')
  return origin !== null && origins.includes(origin) && saysJson(headers)
}
