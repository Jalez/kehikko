import type { ModuleCondition } from 'roadmap-module-protocol'

/**
 * What the page knows about what is registered.
 *
 * The shapes here mirror `server/discover.ts`. They are declared rather than
 * imported because the page and the server are two programs that happen to
 * share a repository: the page receives JSON over HTTP, and typing that JSON as
 * the server's own interface would let a change on one side become a wrong
 * belief on the other with nothing failing in between. Everything the page
 * relies on is checked below.
 */

export interface FramedModule {
  id: string
  name: string
  version: string
  summary: string
  /** What this module says its presence implies for an agent. */
  guidance?: string
  entry: string
  icon: string | null
  health: string | null
  mcp: { url: string; transport: string; about: string } | null
  modes: { id: string; label: string; scope: 'epic' | 'global' }[]
  extensions: { emits: string[]; consumes: string[] }
  declares: { protocol: string; uses: string[]; storage: boolean; prompt?: boolean }
}

export interface Presence {
  id: string
  at: string
  condition: ModuleCondition
  line: string
  /**
   * What the host has lately done to this program, when it has done anything.
   *
   * Not a fourth condition, deliberately: `ready`, `incompatible` and `silent`
   * are what the host found out by ASKING, and this is what the host itself
   * DID. It arrives only on a module that is not answering, because that is the
   * only time it changes what a person should read — and `line` has already
   * been changed to match, saying asleep or starting rather than "not running".
   *
   * The page uses it for the icon and the dot, and to know that offering a
   * press to start would be offering to do what is already happening. See
   * `server/lifecycle.ts`.
   */
  lifecycle?: 'starting' | 'asleep'
  /** What the module calls itself, when the host read a manifest at all. */
  name?: string
  module?: FramedModule
  protocols?: { host: number; module: number | null; range: string }
  /**
   * Whatever this host is keeping for the module, or null when it keeps
   * nothing.
   *
   * It travels with the presence because the page is what greets a module and
   * the greeting is where kept state has to be — a module that had to ask for
   * it afterwards would draw its defaults first and then correct them. The page
   * never reads this; it carries it.
   */
  state?: string | null
  /**
   * Whether the AGENT has been told about this module's MCP door.
   *
   * A fact about the agent's configuration, not about the module — which is why
   * it sits beside `condition` rather than inside it. A module can be perfectly
   * `ready`, serving tools, while no agent has been told the door exists.
   */
  agent?:
    | { kind: 'none' }
    | { kind: 'told'; as: string }
    | { kind: 'elsewhere'; as: string; pointsAt: string }
    | { kind: 'untold' }
}

export interface RegistryView {
  presences: Presence[]
  sweep: {
    dir: string
    rejected: { file: string; why: string }[]
  }
  protocol: number
}

/**
 * Ask the host's server what is registered.
 *
 * `no-store`, because the answer is a fact about which programs are running
 * right now and a cached one would tell somebody a module is silent for as long
 * as their browser felt like it.
 */
export async function fetchRegistry(signal?: AbortSignal): Promise<RegistryView> {
  const response = await fetch('/host/modules', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`the host's server answered ${response.status}`)
  const body = (await response.json()) as RegistryView
  if (!body || !Array.isArray(body.presences)) throw new Error("the host's server answered something else")
  return body
}
