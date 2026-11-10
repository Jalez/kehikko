import { MODULE_ID } from 'kehikot-module-protocol'

/**
 * A module's STABLE address: where a module is reached through this host, whatever port it bound.
 *
 * A module's port is a number anything can take. Another module that drifted, a dev server somebody
 * started, or an older copy of the module can all be holding it. A frame or an agent's door that
 * names the port reaches whatever holds it. The stable address names the MODULE, and this host
 * forwards to the process it knows is that module (`server/moduleProxy.ts`).
 *
 * There are two kinds of address, both on this host's own port. A pinned version of a module has
 * its own of each (`at--<tag>.<label>…`, `/m/<id>@<tag>/…`):
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

/** The path a program reaches a module under on this host: `/m/<id>/…`, or `/m/<id>@<tag>/…` for a pinned version. */
export const MODULE_PATH_PREFIX = '/m/'

/**
 * The path this host answers on EVERY name under `kehikot.localhost`, a module's or not: the page's
 * self-check that a frame's address reaches this host (`src/host/addressCheck.ts`). Never forwarded.
 */
export const ADDRESS_CHECK_PATH = '/.well-known/kehikot-host-check'

/** The name the page's self-check asks under. No module has it: `idOfHost` refuses the `self-check` label's prefix. */
export const ADDRESS_CHECK_LABEL = 'at--self-check'

/** One DNS label as a browser keeps it: lowercase letters, digits and inner dashes, at most 63. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** The host's own first label: `kehikot.<name>` is spelled `<name>`, so a host can never be a module's label prefix. */
const OWN_PREFIX = 'kehikot'

/** The first label of a pinned version's frame address: `at--<tag>`. No module's label starts with it. */
const VERSION_PREFIX = 'at--'

/**
 * The labels a module's frame address puts before `kehikot.localhost`, or null when the id has none.
 *
 *  - `kehikot.<name>` (no further dot) is `<name>`. That covers every official module.
 *  - Any other id of two or more parts that does not start with `kehikot` is spelled as it is:
 *    `someone.tool` is `someone.tool.kehikot.localhost`.
 *  - A dotless id, `kehikot.a.b`, an id with a part that is not a DNS label, or one with a part
 *    starting `at--` (a version's) has no frame address. It is reached by its path, and a frame of
 *    one stays on its port.
 *
 * The mapping goes both ways (`idOfHost`), so a label never names two modules.
 */
export function labelFor(id: string): string | null {
  if (!MODULE_ID.test(id)) return null
  const parts = id.split('.')
  if (parts.length < 2 || !parts.every((part: string) => LABEL.test(part) && !part.startsWith(VERSION_PREFIX))) return null
  if (parts[0] === OWN_PREFIX) return parts.length === 2 ? parts[1]! : null
  return id
}

/**
 * A version's tag as one DNS label's tail: lowercased, every run of other characters one dash.
 * `v1.2.0` is `v1-2-0`. Not reversible, and it need not be: a version is found by comparing the slug
 * of each running version's tag (`sameVersion`). Null when nothing usable is left.
 */
export function versionSlug(tag: string): string | null {
  const slug = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63 - VERSION_PREFIX.length)
  return slug && LABEL.test(`${VERSION_PREFIX}${slug}`) ? slug : null
}

/** Whether a route's version (a tag, from a path, or a slug, from a frame's name) names `tag`. */
export function sameVersion(said: string, tag: string): boolean {
  return said === tag || said === versionSlug(tag)
}

/** The hostname alone, lowercased, without a port; null when `host` is not a host. */
function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host.trim()}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** The module, and the version slug when it is a pinned version's, a `Host` names under `kehikot.localhost`. */
export function frameOfHost(host: string | null): { id: string; version?: string } | null {
  if (!host) return null
  const name = hostnameOf(host)
  if (!name || !name.endsWith(`.${MODULE_HOST_SUFFIX}`)) return null
  let labels = name.slice(0, -(MODULE_HOST_SUFFIX.length + 1)).split('.')
  if (labels.length === 0 || !labels.every((label) => LABEL.test(label))) return null
  let version: string | undefined
  if (labels[0]!.startsWith(VERSION_PREFIX)) {
    version = labels[0]!.slice(VERSION_PREFIX.length)
    labels = labels.slice(1)
    if (!version || labels.length === 0) return null
  }
  const id = labels.length === 1 ? `${OWN_PREFIX}.${labels[0]}` : labels[0] === OWN_PREFIX ? null : labels.join('.')
  if (id === null || !MODULE_ID.test(id)) return null
  /* One spelling per module: whatever does not come back as itself names nothing. */
  if (labelFor(id) !== labels.join('.')) return null
  return version ? { id, version } : { id }
}

/** The module a `Host` names under `kehikot.localhost` (a pinned version's too), or null: another name, or labels no module has. */
export function idOfHost(host: string | null): string | null {
  return frameOfHost(host)?.id ?? null
}

/**
 * The origin a module's frame is given on this host, or null when the id has no frame address. A
 * pinned version (`tag`) is another origin, `at--<tag>.<label>.kehikot.localhost`, as it is
 * another program on its own port.
 */
export function frameOriginFor(id: string, port: number, tag?: string | null): string | null {
  const label = labelFor(id)
  if (label === null) return null
  if (!tag) return `http://${label}.${MODULE_HOST_SUFFIX}:${port}`
  const slug = versionSlug(tag)
  return slug === null ? null : `http://${VERSION_PREFIX}${slug}.${label}.${MODULE_HOST_SUFFIX}:${port}`
}

/** The base a program reaches a module (or a pinned version of it) at through this host, without a trailing slash. */
export function machineBaseFor(id: string, port: number, tag?: string | null): string {
  return `http://127.0.0.1:${port}${MODULE_PATH_PREFIX}${id}${tag ? `@${encodeURIComponent(tag)}` : ''}`
}

/**
 * A module's door, as an agent is given it: the door's path under the module's program address,
 * so the agent's entry outlives the module moving port. `url` is the door on the module's own
 * origin (the manifest's `mcp.url`, resolved); null when it is not a URL.
 */
export function stableDoorUrl(id: string, url: string, port: number): string | null {
  try {
    const at = new URL(url)
    return `${machineBaseFor(id, port)}${at.pathname}${at.search}`
  } catch {
    return null
  }
}

/** A frame's entry moved onto its stable frame address: the same path, query and fragment. */
export function stableEntry(entry: string, address: string): string | null {
  try {
    const at = new URL(entry)
    return `${new URL(address).origin}${at.pathname}${at.search}${at.hash}`
  } catch {
    return null
  }
}

/** What a request asks of the proxy: a module (or a pinned version of it), the path it asks there, and which address it came by. */
export interface ModuleRoute {
  kind: 'frame' | 'machine'
  id: string
  /** A pinned version: its tag (from a program's path) or its slug (from a frame's name). Absent: the module's own. */
  version?: string
  /** The path at the module, from `/`, without the query. */
  path: string
}

/** The frame origin a route's own frame has, or null (a program's route, or an id without one). */
export function frameOriginOf(route: ModuleRoute, port: number): string | null {
  if (route.kind !== 'frame') return null
  const label = labelFor(route.id)
  if (label === null) return null
  return route.version ? `http://${VERSION_PREFIX}${route.version}.${label}.${MODULE_HOST_SUFFIX}:${port}` : `http://${label}.${MODULE_HOST_SUFFIX}:${port}`
}

/**
 * Which module a request is for, or null when it is not for one.
 *
 * A `Host` under `kehikot.localhost` is a frame's address, whatever its path. Anything else is a
 * program's address when its path is under `/m/<id>` or `/m/<id>@<tag>`. The caller holds the
 * program's `Host` to this host's own names (`guard.ts`).
 */
export function routeOf(host: string | null, pathname: string): ModuleRoute | null {
  const framed = frameOfHost(host)
  if (framed) return { kind: 'frame', ...framed, path: pathname || '/' }
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
  const at = named.indexOf('@')
  const id = at === -1 ? named : named.slice(0, at)
  const version = at === -1 ? undefined : named.slice(at + 1)
  if (!MODULE_ID.test(id)) return null
  if (version !== undefined && (!version || version.length > 128 || /[\s/]/.test(version))) return null
  return { kind: 'machine', id, ...(version ? { version } : {}), path: slash === -1 ? '/' : rest.slice(slash) }
}

/** Whether a `Host` names a frame address under `kehikot.localhost`, a module's or not. */
export function isModuleHost(host: string | null): boolean {
  if (!host) return false
  return hostnameOf(host)?.endsWith(`.${MODULE_HOST_SUFFIX}`) === true
}
