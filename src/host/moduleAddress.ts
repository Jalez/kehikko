import { MODULE_ID } from 'kehikot-module-protocol'

/**
 * A module's STABLE address: where a module is reached through this host, whatever port it bound.
 *
 * A module's port is a number anything can take. Another module that drifted, a dev server somebody
 * started, or an older copy of the module can all be holding it. A frame or an agent's door that
 * names the port reaches whatever holds it. The stable address names the MODULE, and this host
 * forwards to the process it knows is that module (`server/moduleProxy.ts`).
 *
 * There are two kinds of address, both on this host's own port:
 *
 *  - **A frame's**, `http://<label>.kehikot.localhost:<port>/`: a name of the module's own, so
 *    each module keeps its own origin, as it has on its own port today. A frame on one is not the
 *    same origin as another module or as this host's page. `*.localhost` is loopback by rule
 *    (RFC 6761); macOS resolves it to `::1` first, then `127.0.0.1`.
 *  - **A program's**, `http://127.0.0.1:<port>/m/<id>/…`: for this host's own requests and for
 *    agents' MCP doors. An agent runtime may try `::1` first, or may not resolve `*.localhost` at
 *    all, so a program gets a literal address. Only programs use it: it is this host's own origin,
 *    so a page there would be this host's page. The proxy refuses a browser there and sandboxes
 *    whatever it serves.
 *
 * Pure, so the page and the server share it.
 */

/** The name every module's frame address sits under. */
export const MODULE_HOST_SUFFIX = 'kehikot.localhost'

/** The path a program reaches a module under on this host: `/m/<id>/…`. */
export const MODULE_PATH_PREFIX = '/m/'

/** One DNS label as a browser keeps it: lowercase letters, digits and inner dashes, at most 63. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** The host's own first label: `kehikot.<name>` is spelled `<name>`, so a host can never be a module's label prefix. */
const OWN_PREFIX = 'kehikot'

/**
 * The labels a module's frame address puts before `kehikot.localhost`, or null when the id has none.
 *
 *  - `kehikot.<name>` (no further dot) is `<name>`. That covers every official module.
 *  - Any other id of two or more parts that does not start with `kehikot` is spelled as it is:
 *    `someone.tool` is `someone.tool.kehikot.localhost`.
 *  - A dotless id, `kehikot.a.b`, or an id with a part that is not a DNS label has no frame
 *    address. It is reached by its path, and a frame of one stays on its port (phase 3 says how).
 *
 * The mapping goes both ways (`idOfHost`), so a label never names two modules.
 */
export function labelFor(id: string): string | null {
  if (!MODULE_ID.test(id)) return null
  const parts = id.split('.')
  if (parts.length < 2 || !parts.every((part: string) => LABEL.test(part))) return null
  if (parts[0] === OWN_PREFIX) return parts.length === 2 ? parts[1]! : null
  return id
}

/** The hostname alone, lowercased, without a port; null when `host` is not a host. */
function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host.trim()}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** The module a `Host` names under `kehikot.localhost`, or null: another name, or labels no module has. */
export function idOfHost(host: string | null): string | null {
  if (!host) return null
  const name = hostnameOf(host)
  if (!name || !name.endsWith(`.${MODULE_HOST_SUFFIX}`)) return null
  const labels = name.slice(0, -(MODULE_HOST_SUFFIX.length + 1)).split('.')
  if (labels.length === 0 || !labels.every((label) => LABEL.test(label))) return null
  const id = labels.length === 1 ? `${OWN_PREFIX}.${labels[0]}` : labels[0] === OWN_PREFIX ? null : labels.join('.')
  if (id === null || !MODULE_ID.test(id)) return null
  /* One spelling per module: whatever does not come back as itself names nothing. */
  return labelFor(id) === labels.join('.') ? id : null
}

/** The origin a module's frame is given on this host, or null when the id has no frame address. */
export function frameOriginFor(id: string, port: number): string | null {
  const label = labelFor(id)
  return label === null ? null : `http://${label}.${MODULE_HOST_SUFFIX}:${port}`
}

/** The base a program reaches a module at through this host, without a trailing slash. */
export function machineBaseFor(id: string, port: number): string {
  return `http://127.0.0.1:${port}${MODULE_PATH_PREFIX}${id}`
}

/** What a request asks of the proxy: a module, the path it asks there, and which address it came by. */
export interface ModuleRoute {
  kind: 'frame' | 'machine'
  id: string
  /** The path at the module, from `/`, without the query. */
  path: string
}

/**
 * Which module a request is for, or null when it is not for one.
 *
 * A `Host` under `kehikot.localhost` is a frame's address, whatever its path. Anything else is a
 * program's address when its path is under `/m/<id>`. The caller holds the program's `Host` to
 * this host's own names (`guard.ts`).
 */
export function routeOf(host: string | null, pathname: string): ModuleRoute | null {
  const framed = idOfHost(host)
  if (framed) return { kind: 'frame', id: framed, path: pathname || '/' }
  if (host && hostnameOf(host)?.endsWith(`.${MODULE_HOST_SUFFIX}`)) return null
  if (!pathname.startsWith(MODULE_PATH_PREFIX)) return null
  const rest = pathname.slice(MODULE_PATH_PREFIX.length)
  const slash = rest.indexOf('/')
  const raw = slash === -1 ? rest : rest.slice(0, slash)
  let named: string
  try {
    named = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!MODULE_ID.test(named)) return null
  return { kind: 'machine', id: named, path: slash === -1 ? '/' : rest.slice(slash) }
}

/** Whether a `Host` names a frame address under `kehikot.localhost`, a module's or not. */
export function isModuleHost(host: string | null): boolean {
  if (!host) return false
  return hostnameOf(host)?.endsWith(`.${MODULE_HOST_SUFFIX}`) === true
}
