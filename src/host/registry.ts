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
  entry: string
  icon: string | null
  health: string | null
  mcp: { url: string; transport: string; about: string } | null
  modes: { id: string; label: string; scope: 'epic' | 'global' }[]
  extensions: { emits: string[]; consumes: string[] }
  declares: { protocol: string; uses: string[]; storage: boolean }
}

export interface Presence {
  id: string
  at: string
  condition: ModuleCondition
  line: string
  /** What the module calls itself, when the host read a manifest at all. */
  name?: string
  module?: FramedModule
  protocols?: { host: number; module: number | null; range: string }
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
