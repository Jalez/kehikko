import type { Build, ModuleCondition, SettingField } from 'kehikot-module-protocol'

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
  /** The format the module writes its project data in. Absent from a host older than versions. */
  dataVersion?: number
  summary: string
  /** The categories the module files itself under. Absent from a host older than tags. */
  tags?: string[]
  /** What this module says its presence implies for an agent. */
  guidance?: string
  entry: string
  icon: string | null
  health: string | null
  mcp: { url: string; transport: string; about: string; as?: string } | null
  /** `global` from a host before 2.29.0; the five words of `MODULE_SCOPES` from one after. */
  modes: { id: string; label: string; scope: 'epic' | 'global' | 'machine' | 'project' | 'part' | 'kehikko'; scopeSays?: string }[]
  extensions: { emits: string[]; consumes: string[] }
  /**
   * The context kinds this module says it reacts to.
   *
   * Optional here where it is required on the server, and the asymmetry is the
   * point of declaring these shapes twice rather than importing one. This
   * arrives as JSON from a server that may be older than the page — a module
   * left running across an upgrade, a bundle cached in a tab — and a page that
   * typed a missing array as a present one would iterate `undefined` on the one
   * machine where it mattered. Read it through `?? []`.
   *
   * The page never gates on it. It is drawn, and only drawn.
   */
  reacts?: string[]
  /**
   * What the module can be asked to show (protocol 2.28.0, `shows`): the page tells
   * `context.show` only to a container whose module says the subject. Absent: nothing.
   */
  shows?: string[]
  /** `skills` (protocol 2.5.0): the Claude Code skills the module offers; absent from older servers and modules. */
  declares: {
    protocol: string
    uses: string[]
    storage: boolean
    prompt?: boolean
    skills?: { name: string; summary: string; version: string }[]
    /**
     * Which scopes the module can show (protocol 2.9.0): `project` is "All
     * epics". Absent means one epic at a time — from an older module, and from
     * an older server. Read through `showsProject`; see `host/scope.ts`.
     */
    scopes?: ('epic' | 'project')[]
    /** The settings the module declared (protocol 2.15.0), drawn as one form. Absent: none. See `host/moduleSettings.ts`. */
    settings?: SettingField[]
    /** What its `view.goto` carries (protocol 2.28.0): `project`, `show`. Absent: neither. See `host/navigate.ts`. */
    navigates?: string[]
  }
  /**
   * What the server answering now is built from: version, commit, when its
   * process started, and the protocol package it has. Null or absent for a
   * module from before build identities, and from an older host.
   */
  build?: Build | null
}

/**
 * Whether the AGENT has been told about a door.
 *
 * Named on its own, rather than only as `Presence['agent']`, because the host's
 * own door has one of these and the host is not a `Presence`: it is not
 * registered, not swept, not `ready` or `silent`, and faking it into one to
 * reuse a component would be a page telling itself something untrue about what
 * is on the canvas. What the plug on a header actually depends on is this
 * union and a name, and `Tools.tsx` now says so in its props.
 */
export type AgentAwareness =
  | { kind: 'none' }
  | { kind: 'told'; as: string }
  | { kind: 'elsewhere'; as: string; pointsAt: string }
  | { kind: 'untold' }
  /* The door is connected under the name the host used to derive (`as`); the module now asks for `to`. */
  | { kind: 'renamed'; as: string; to: string }
  /* The name the module asks for is another door's. The sentence says whose. */
  | { kind: 'refused'; why: string }

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
  lifecycle?: 'starting' | 'installing' | 'updating' | 'restarting' | 'asleep'
  /** When this host started the process that is there, in ms; absent for one it did not start. */
  run?: number
  /** The last lines a module the host started printed, when that start failed. */
  detail?: string[]
  /** What the module calls itself, when the host read a manifest at all. */
  name?: string
  /**
   * What the module is, in a sentence, and where it files itself. Beside
   * `name` and remembered by the host like it, so a module that is asleep is
   * still described and still on its shelf. Absent from an older host.
   */
  summary?: string
  tags?: string[]
  /**
   * The icon the module is drawn with (protocol 2.14.0): a key of
   * `MODULE_ICONS`, already resolved by the server — the module's own, else the
   * official list's — or null. Absent from an older host. Drawn by
   * `ModuleIcon`, which checks it again and never treats it as a URL.
   */
  icon?: string | null
  /**
   * What the host knows the module reacts to while it is NOT answering: what it last said, else the
   * official list. Only on a presence with no `module`. The page reads it for one thing: a placed
   * container that shows pages (`address`) counts as one while it starts, so an address waits for it.
   */
  reactsKnown?: string[]
  /**
   * Whether anything at all answered at the address. A silent module that was
   * reached is an address held by something else; one that was not is simply
   * not running. See `attention` in `moduleMenu.ts`.
   */
  reached?: boolean
  /** Where the registration says the program lives, when it says. */
  dir?: string
  module?: FramedModule
  /** The module itself answered, and its manifest is one this host will not read. See `attention` in `moduleMenu.ts`. */
  refused?: true
  /** The sentence already says what to do; nothing is added to it and nothing offered. See `attention` in `moduleMenu.ts`. */
  remedy?: true
  protocols?: { host: number; module: number | null; range: string }
  /**
   * On an `incompatible` module, which side is behind and the protocol's words
   * for it (`fitSaid`, protocol 2.22.0): drawn in the container in place of the
   * page, and on the module's row. See `Presence.fit` in `server/discover.ts`.
   */
  fit?: {
    kind: 'host-too-old' | 'module-too-old'
    title: string
    line: string
    action: string
    since: string | null
  }
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
  agent?: AgentAwareness
  /**
   * Which folder and branch the module is actually running from — the
   * container's header shows the branch, and marks it when it is not `main`,
   * level, clean and the registered folder. Null when it cannot be read;
   * absent from an older host. See `server/source.ts`.
   */
  source?: import('./source.ts').Source | null
}

/**
 * The host's own MCP door, as the sweep reports it.
 *
 * `id` is what to send to `/host/tools` and `/host/agent` — the server answers
 * it from its own port rather than from the registry; see `hostDoor` in
 * `server/register.ts`. `agent` is read against the same configuration file,
 * in the same sweep, as every module's, which is what lets the strip draw one
 * control with the same states as a container's.
 */
export interface HostDoor {
  id: string
  as: string
  url: string
  agent: AgentAwareness
}

export interface RegistryView {
  /** Which of the host's sweeps this reading is (`swept` in `server/server.ts`). Absent from an older host. */
  swept?: number
  presences: Presence[]
  /**
   * Optional for the reason `reacts` is: a server older than this page answers
   * without it, and the strip then draws no plug rather than a wrong one.
   */
  host?: HostDoor
  sweep: {
    dir: string
    rejected: { file: string; why: string }[]
  }
  protocol: number
  /** What each container pinned to a version is doing — see `server/pins.ts`. Absent from an older host. */
  pins?: import('./versions.ts').PinView[]
}

/**
 * Ask the host's server what is registered.
 *
 * `no-store`, because the answer is a fact about which programs are running
 * right now and a cached one would tell somebody a module is silent for as long
 * as their browser felt like it.
 */
export async function fetchRegistry(signal?: AbortSignal, fresh = false): Promise<RegistryView> {
  /* `fresh`: a person pressed something, so the host asks every module again rather than reading
     the manifests it keeps (`server/manifests.ts`). */
  const response = await fetch(fresh ? '/host/modules?fresh=1' : '/host/modules', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`the host's server answered ${response.status}`)
  const body = registryIn(await response.json())
  if (!body) throw new Error("the host's server answered something else")
  return body
}

/**
 * A reading of the modules, from `/host/modules` or carried by the host's news on `/host/watch`
 * (`{ registry: true, modules }`, sent when its wait for a module it started ended): the one shape
 * check both go through. Null when it is not one.
 */
export function registryIn(value: unknown): RegistryView | null {
  const body = value as RegistryView | null
  if (!body || typeof body !== 'object' || !Array.isArray(body.presences)) return null
  if (body.swept !== undefined && !Number.isInteger(body.swept)) return null
  return body
}

/**
 * Whether `got` may replace `held`. A look's answer and the host's news can cross: a look asked
 * before a module came up may land after the news that it did, and must not put "starting" back.
 * A reading without a number (an older host) is always taken.
 */
export function newerReading(held: RegistryView | null, got: RegistryView): boolean {
  return held?.swept === undefined || got.swept === undefined || got.swept >= held.swept
}
