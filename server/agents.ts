import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Whether the agent has been told about a module's MCP door.
 *
 * ## The gap this closes
 *
 * A module may serve an MCP door and say so in its manifest. That says nothing
 * about whether the AGENT knows the door exists — those are two different
 * programs with two different configurations, and nothing has ever connected
 * them. So a person could have five modules on a canvas, every one of them
 * offering tools, and an agent that can reach none of them, with no way to find
 * out short of asking the agent what tools it has.
 *
 * It is a silent failure of exactly the kind this codebase keeps meeting: the
 * module is running, the manifest is right, the door answers, and the tools are
 * simply absent from the conversation. Nothing errors.
 *
 * ## Read here, and never written here
 *
 * This file reads the agent's configuration and does not touch it. A host that
 * QUIETLY edited a person's agent config would be a host that reaches outside
 * itself — the same line `launch.ts` draws around starting a program. Telling
 * somebody their agent has not been told is useful on its own; doing something
 * about it is a press, and a separate decision.
 *
 * That press now exists, and it deliberately lives somewhere else —
 * `server/register.ts` — which is the shape the sentence above asked for. What
 * stays true is the word "quietly": nothing writes on a sweep, on a page load,
 * or because the host noticed something missing. A write happens when somebody
 * presses a button in a window that has already named the server, the address
 * and the scope it will use, and it goes through the `claude` CLI rather than
 * through this file's parser. Keeping the two apart is what makes that
 * checkable: everything in HERE runs on every sweep, and everything in here can
 * only read.
 *
 * ## Why the file and not `claude mcp list`
 *
 * The CLI is authoritative and it health-checks every server, which means
 * network calls to remote MCP endpoints on every sweep. This host sweeps
 * whenever a person asks it to look again, and making that wait on somebody's
 * Google Drive connection would be a host that hangs for reasons it cannot
 * explain. The file says what has been CONFIGURED, which is the question being
 * asked here; whether a configured server is currently healthy is the agent's
 * business and it already reports it.
 */

/** Where Claude Code keeps what it has been told. `CLAUDE_CONFIG` overrides it, for tests. */
export function agentConfigFile(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG ?? join(homedir(), '.claude.json')
}

/**
 * What the agent knows, as a map from server name to whatever it was given.
 *
 * Both scopes are read and flattened. A module's door registered globally and
 * one registered under a project are equally "the agent has been told"; which
 * scope it was is a question about how somebody arranged their machine, and not
 * one this host has an opinion on.
 */
export function agentKnows(file = agentConfigFile()): Map<string, unknown> {
  const known = new Map<string, unknown>()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    /* No config, unreadable, or not JSON. Reported as "nothing known" rather
       than as an error: an agent that has never been configured is an ordinary
       state, and the sentence a person needs is the same either way. */
    return known
  }
  if (!parsed || typeof parsed !== 'object') return known

  const root = parsed as { mcpServers?: unknown; projects?: unknown }
  for (const [name, value] of Object.entries((root.mcpServers ?? {}) as Record<string, unknown>)) {
    known.set(name, value)
  }
  for (const project of Object.values((root.projects ?? {}) as Record<string, { mcpServers?: unknown }>)) {
    for (const [name, value] of Object.entries((project?.mcpServers ?? {}) as Record<string, unknown>)) {
      if (!known.has(name)) known.set(name, value)
    }
  }
  return known
}

/**
 * What the agent has been told about one module's door.
 *
 * Three answers, and keeping them apart is the whole value of this file:
 *
 * - `told` — a server is configured whose url is this module's door.
 * - `elsewhere` — a server is configured under a name that matches this module,
 *   and it points somewhere else. Almost always a module that has moved port;
 *   the agent will reach the old address and get nothing, which looks like a
 *   broken module rather than a stale line in a config file.
 * - `untold` — nothing is configured for it. The tools simply are not there.
 *
 * A module that declares no MCP door at all gets `none`, which is not a
 * problem and must not be drawn as one.
 */
export type AgentAwareness =
  | { kind: 'none' }
  | { kind: 'told'; as: string }
  | { kind: 'elsewhere'; as: string; pointsAt: string }
  | { kind: 'untold' }

/**
 * Compare one module's door against what the agent knows.
 *
 * Matched on URL first and on name second, deliberately in that order. A name
 * is a label somebody chose and two people will choose differently; the url is
 * the thing that decides whether a request arrives. So a server pointing at
 * this door counts as told whatever it is called, and a server NAMED for this
 * module while pointing elsewhere is the interesting failure rather than a
 * match.
 */
export function awarenessOf(mcpUrl: string | null, id: string, known: Map<string, unknown>): AgentAwareness {
  if (!mcpUrl) return { kind: 'none' }

  const wanted = normalise(mcpUrl)
  for (const [name, value] of known) {
    const url = urlOf(value)
    if (url && normalise(url) === wanted) return { kind: 'told', as: name }
  }

  /* Nothing points here. Is something wearing this module's name? Checked
     against both the id and its last segment, since `claude mcp add` is usually
     given a short name and `roadmap.checklist` is a mouthful. */
  const tail = id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id
  for (const [name, value] of known) {
    if (name !== id && name !== tail) continue
    const url = urlOf(value)
    if (url) return { kind: 'elsewhere', as: name, pointsAt: url }
  }

  return { kind: 'untold' }
}

/** The url out of whatever shape a configured server happens to have. */
function urlOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const server = value as { url?: unknown; type?: unknown }
  return typeof server.url === 'string' ? server.url : null
}

/** Trailing slashes are not a difference anybody means. */
function normalise(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase()
}

/**
 * Which scope a configured server actually sits in.
 *
 * `agentKnows` flattens the two on purpose, and for the question it answers —
 * has the agent been told? — flattening is right. The moment a person is about
 * to press a button that CHANGES one of these, the flattening stops being
 * helpful: "a server called checklist points somewhere else" is a different
 * sentence depending on whether it is global or belongs to one directory, and
 * somebody deciding whether to let the host rewrite it is owed the difference.
 *
 * So this is the un-flattening. It is read by the modal and by nothing on the
 * sweep. `null` when no server of that name is configured anywhere.
 */
export type ConfiguredIn = { scope: 'user' } | { scope: 'local'; project: string }

export function scopeOf(name: string, file = agentConfigFile()): ConfiguredIn | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const root = parsed as { mcpServers?: unknown; projects?: unknown }
  const global = (root.mcpServers ?? {}) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(global, name)) return { scope: 'user' }

  /* Global first, then projects, in the same order `agentKnows` reads them, so
     the scope reported is the scope of the entry that reading found. A name in
     both would otherwise be described as living in whichever this happened to
     look at second. */
  for (const [project, value] of Object.entries(
    (root.projects ?? {}) as Record<string, { mcpServers?: unknown }>,
  )) {
    const servers = (value?.mcpServers ?? {}) as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(servers, name)) return { scope: 'local', project }
  }
  return null
}
