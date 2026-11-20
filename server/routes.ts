/**
 * A desk's routes, declared as a table: which method and path each answers, and
 * whether only this host's page may write to it.
 *
 * The declaration is plain data, apart from the handlers, so `guard.ts` can read
 * it without building a desk: `PAGE_ONLY` there is the routes declared
 * `pageOnly` here, plus the ones not yet moved into a table. A desk binds a
 * handler to every name its table declares (the type says so), and `route`
 * answers a request whose method and path one of them names, or null.
 *
 * A route is matched on its exact method and path, the way `answerRequest`
 * matched them inline: a `HEAD` is not a `GET`, and a path with a trailing
 * slash is another path.
 */

/** The methods this host routes on. */
export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'

export interface RouteSpec {
  readonly method: Method
  readonly path: string
  /**
   * Only this host's page may write here (`PAGE_ONLY` in `guard.ts`). Only for a
   * method that writes: the guard holds writes, and a GET is answered to anyone
   * who may read.
   */
  readonly pageOnly?: true
}

/** A desk's routes by name. */
export type RouteTable = Readonly<Record<string, RouteSpec>>

export type RouteHandler = (request: Request, url: URL) => Response | Promise<Response>

/** One handler for every route a table declares. */
export type RouteHandlers<T extends RouteTable> = { readonly [K in keyof T]: RouteHandler }

export interface Desk {
  /** The answer of the route this request names, or null when it names none of this desk's. */
  route(request: Request, url: URL): Promise<Response | null>
}

/** A JSON answer, never cached: how every route of this host answers. */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

/** The module id out of a request, bounded before it is looked at. */
export function moduleIn(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null
}

const keyOf = (method: string, path: string) => `${method} ${path}`

/** A desk answering the routes of `table`, each with its handler. Two routes on one method and path are a mistake, said at once. */
export function routes<T extends RouteTable>(table: T, handlers: RouteHandlers<T>): Desk {
  const byKey = new Map<string, RouteHandler>()
  for (const [name, spec] of Object.entries(table)) {
    const key = keyOf(spec.method, spec.path)
    if (byKey.has(key)) throw new Error(`Two routes answer ${key}.`)
    if (spec.pageOnly && spec.method === 'GET') throw new Error(`${key} is a GET: the page-only rule holds writes only.`)
    const handler = handlers[name as keyof T]
    if (typeof handler !== 'function') throw new Error(`No handler for ${key} (${name}).`)
    byKey.set(key, handler)
  }
  return {
    async route(request, url) {
      const handler = byKey.get(keyOf(request.method, url.pathname))
      return handler ? handler(request, url) : null
    },
  }
}

/** The paths of every route these tables declare `pageOnly`, once each. */
export function pageOnlyPaths(...tables: readonly RouteTable[]): string[] {
  const paths = new Set<string>()
  for (const table of tables) for (const spec of Object.values(table)) if (spec.pageOnly) paths.add(spec.path)
  return [...paths]
}
