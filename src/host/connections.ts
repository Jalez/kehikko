import { MODULE_ID, meetsNeed, type SkillNeed } from 'kehikot-module-protocol'
import { z } from 'zod'

import { asRead, loadsSkillsHere, providesHere, type ReadManifest } from './providers.ts'

/**
 * How the modules on a kehikko affect each other, and which of those the person switched off.
 * Pure, shared by the page (the Providers & Consumers window, and what each frame is told), the
 * server (what a session is handed at `POST /host/place`, and `read_canvas`) and the file
 * (`kehikot.json`).
 *
 * ## Derived, never written by hand
 *
 * Every connection is read off the manifests of the modules on the kehikko, as they say it:
 *
 * - **passage, selection, location** — A sets it (`passage:set`, `selection:set`, `location:set`)
 *   and B reacts to it (`reacts`).
 * - **address** — A opens addresses (`address:open`) and B shows pages (`reacts: address`).
 * - **steps** — A provides an epic's steps (`declares.provides`, `providesHere`) and B reads them
 *   (`steps:read`).
 * - **extension** — A emits a format (`extensions.emits`) and B consumes it.
 * - **skill** — one of B's skills needs something (`skills[].needs`) and A meets it (`meetsNeed`).
 * - **agent** — B runs agent sessions (`declares.agentSessions`, `loadsSkillsHere`) and A has an MCP
 *   door: B's sessions are handed A's door.
 * - **parts** — Kehikot (the bar's pick) to every module that narrows to parts; and, drawn but not
 *   switchable, A edits the epic's list (`parts:set`) that B narrows to.
 * - **tracker** and **inbox** — Kehikot's tracker reading to the modules that read it, and the
 *   modules that report activity to Kehikot's Inbox. Drawn, never switchable.
 *
 * A connection is FROM what provides TO what takes it, whatever the arrow means in words: an
 * agent's edge is from the module whose door it is to the agent module that is handed it.
 *
 * ## Switched off, for this kehikko
 *
 * The person may turn a connection off (`off`), or say a consumer takes one kind only from some
 * providers (`only`). Both are the kehikko's, kept in `kehikot.json` with its arrangement
 * (`server/kehikot.ts`), and travel with the project. `delivered` is the one rule every
 * enforcement asks; an off connection behaves as if its provider were not on the kehikko.
 */

/** Kehikot's own id, as a node: the tracker it keeps, the Inbox, the bar's picked parts. */
export const HOST_NODE = 'kehikko'
export const HOST_NODE_NAME = 'Kehikot'

export const CONNECTION_KINDS = [
  'passage',
  'selection',
  'location',
  'address',
  'steps',
  'extension',
  'parts',
  'skill',
  'agent',
  'tracker',
  'inbox',
] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]

/** The kinds a person can switch, and the kinds whose provider can be chosen (`only`). */
export const SWITCHABLE: ReadonlySet<ConnectionKind> = new Set([
  'passage',
  'selection',
  'location',
  'address',
  'steps',
  'extension',
  'parts',
  'skill',
  'agent',
])
export const CHOOSABLE: ReadonlySet<ConnectionKind> = new Set(['passage', 'selection', 'location', 'address', 'steps', 'extension'])

/** What each kind is, as a heading in the window and in `read_canvas`. */
export const KIND_SAID: Record<ConnectionKind, string> = {
  passage: 'A passage in a document',
  selection: 'Picked references',
  location: 'A place in a change’s code',
  address: 'Web pages to show',
  steps: 'The epic’s steps',
  extension: 'Published results',
  parts: 'The picked parts',
  skill: 'Skills',
  agent: 'Tools for agent sessions',
  tracker: 'The tracker reading',
  inbox: 'The Inbox',
}

/** Why a drawn connection has no switch. */
const FIXED_WHY: Partial<Record<ConnectionKind, string>> = {
  parts: 'The parts are the epic’s list, whoever edited it; the host cannot hold back one module’s edits.',
  tracker: 'The tracker reading is the project’s, kept by Kehikot, not a module’s to withhold.',
  inbox: 'What a module says it is doing goes to the Inbox, which is the person’s record; it is never withheld.',
}

const MAX_ENTRIES = 512
const word = z.string().min(1).max(120)
const node = z.string().refine((id) => id === HOST_NODE || MODULE_ID.test(id), 'is not a module id')
const kind = z.enum(CONNECTION_KINDS)

/** One connection switched off: from a provider, to a consumer, of one kind (and one format or skill). */
export const switchedOffSchema = z
  .object({ kind, from: node, to: node, about: word.optional() })
  .strict()
export type SwitchedOff = z.infer<typeof switchedOffSchema>

/** A consumer that takes one kind only from these providers (the window's "From: only …"). */
export const onlyFromSchema = z
  .object({ kind, to: node, about: word.optional(), from: z.array(node).max(64) })
  .strict()
export type OnlyFrom = z.infer<typeof onlyFromSchema>

/** What a kehikko says about its connections: as `kehikot.json` writes it, and as the page sends it. */
export const connectionsSettingSchema = z
  .object({
    off: z.array(switchedOffSchema).max(MAX_ENTRIES).default([]),
    only: z.array(onlyFromSchema).max(MAX_ENTRIES).default([]),
  })
  .strict()
export type ConnectionsSetting = z.infer<typeof connectionsSettingSchema>

export const AUTOMATIC: ConnectionsSetting = { off: [], only: [] }

/** A setting from anywhere — a file, a request, a database column — or automatic when it will not read. */
export function settingIn(value: unknown): ConnectionsSetting {
  if (typeof value === 'string') {
    if (!value) return AUTOMATIC
    try {
      return settingIn(JSON.parse(value))
    } catch {
      return AUTOMATIC
    }
  }
  const read = connectionsSettingSchema.safeParse(value ?? {})
  return read.success ? tidy(read.data) : AUTOMATIC
}

/** Whether the kehikko has every connection as the manifests say: what is written as nothing. */
export function isAutomatic(setting: ConnectionsSetting | null | undefined): boolean {
  return !setting || (setting.off.length === 0 && setting.only.length === 0)
}

const aboutOf = (about: string | undefined): string => about ?? ''

/** Each entry once, in a fixed order, so the same setting is the same bytes in the file. */
export function tidy(setting: ConnectionsSetting): ConnectionsSetting {
  const offs = new Map<string, SwitchedOff>()
  for (const one of setting.off) {
    if (!SWITCHABLE.has(one.kind) || one.from === one.to) continue
    offs.set(`${one.kind}|${one.from}|${one.to}|${aboutOf(one.about)}`, one.about ? one : { kind: one.kind, from: one.from, to: one.to })
  }
  const onlys = new Map<string, OnlyFrom>()
  for (const one of setting.only) {
    if (!CHOOSABLE.has(one.kind)) continue
    const from = [...new Set(one.from)].sort()
    onlys.set(`${one.kind}|${one.to}|${aboutOf(one.about)}`, { kind: one.kind, to: one.to, ...(one.about ? { about: one.about } : {}), from })
  }
  const order = <T,>(map: Map<string, T>) => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v)
  return { off: order(offs), only: order(onlys) }
}

/**
 * THE rule: does `to` take this kind (and format or skill) from `from` on this kehikko? True unless the
 * person switched that connection off or chose other providers for it. Every enforcement asks this.
 */
export function delivered(
  setting: ConnectionsSetting | null | undefined,
  kind: ConnectionKind,
  from: string,
  to: string,
  about = '',
): boolean {
  if (!setting || from === to) return true
  if (setting.off.some((one) => one.kind === kind && one.from === from && one.to === to && aboutOf(one.about) === about)) return false
  const only = setting.only.find((one) => one.kind === kind && one.to === to && aboutOf(one.about) === about)
  return !only || only.from.includes(from)
}

/** Switch one connection on or off. */
export function switched(setting: ConnectionsSetting, edge: Pick<Connection, 'kind' | 'from' | 'to' | 'about'>, on: boolean): ConnectionsSetting {
  const same = (one: SwitchedOff) => one.kind === edge.kind && one.from === edge.from && one.to === edge.to && aboutOf(one.about) === edge.about
  const off = setting.off.filter((one) => !same(one))
  /* Turning one on that an `only` excludes widens the `only` to take it. */
  const only = on
    ? setting.only.map((one) =>
        one.kind === edge.kind && one.to === edge.to && aboutOf(one.about) === edge.about && !one.from.includes(edge.from)
          ? { ...one, from: [...one.from, edge.from] }
          : one,
      )
    : setting.only
  return tidy({
    off: on ? off : [...off, { kind: edge.kind, from: edge.from, to: edge.to, ...(edge.about ? { about: edge.about } : {}) }],
    only,
  })
}

/**
 * The consumer `to` takes this kind from `from` only (a list), or from any provider (`null`). Clears the
 * pair switches of that row, so the choice is the one thing said about it.
 */
export function chosen(setting: ConnectionsSetting, row: { kind: ConnectionKind; to: string; about: string }, from: readonly string[] | null): ConnectionsSetting {
  const inRow = (one: { kind: string; to: string; about?: string }) => one.kind === row.kind && one.to === row.to && aboutOf(one.about) === row.about
  return tidy({
    off: setting.off.filter((one) => !inRow(one)),
    only: [
      ...setting.only.filter((one) => !inRow(one)),
      ...(from === null ? [] : [{ kind: row.kind, to: row.to, ...(row.about ? { about: row.about } : {}), from: [...from] }]),
    ],
  })
}

/** "Reset to automatic" for one row of the window: every switch and choice about these connections. */
export function reset(setting: ConnectionsSetting, edges: readonly Pick<Connection, 'kind' | 'from' | 'to' | 'about'>[]): ConnectionsSetting {
  const touches = (one: { kind: string; to: string; about?: string; from?: string | string[] }) =>
    edges.some(
      (edge) =>
        edge.kind === one.kind &&
        edge.to === one.to &&
        edge.about === aboutOf(one.about) &&
        (typeof one.from !== 'string' || one.from === edge.from),
    )
  return tidy({ off: setting.off.filter((one) => !touches(one)), only: setting.only.filter((one) => !touches(one)) })
}

/** The least of a manifest the derivation reads. A parsed manifest, the page's `FramedModule`, or a fixture. */
export interface ConnectionModule extends ReadManifest {
  name?: string
  extensions?: { emits?: readonly string[]; consumes?: readonly string[] } | null
  mcp?: { subjects?: readonly { kind: string }[] } | null
  declares?: ReadManifest['declares'] & {
    skills?: readonly { name: string; needs?: readonly SkillNeed[] }[]
  }
}

/** One module on the kehikko: its id, the name it is shown by, and its manifest when the host has read one. */
export interface OnKehikko {
  id: string
  name: string
  manifest: ConnectionModule | null
}

export interface Connection {
  /** `kind|from|to|about`: one connection's identity, the same on the page and the server. */
  key: string
  kind: ConnectionKind
  from: string
  to: string
  /** The format (`extension`) or the skill (`skill`); `''` for every other kind. */
  about: string
  /** What it does, in a sentence: "Notes follows the passage Paper points at." */
  said: string
  /** What switching it off does: "Notes doesn't follow Paper's passage here." */
  offSaid: string
  /** Whether the person can switch it. */
  switchable: boolean
  /** Why it cannot be switched, for one that cannot. */
  why?: string
  /** Whether it is delivered on this kehikko. Always true for one that cannot be switched. */
  on: boolean
}

const has = (list: readonly string[] | undefined, one: string) => (list ?? []).includes(one)
const usesOf = (m: ConnectionModule | null) => m?.declares?.uses ?? []
const reactsOf = (m: ConnectionModule | null) => m?.reacts ?? []

/** Possessive, plainly: "Paper's", "Kehikot's". */
const of = (name: string) => `${name}’s`

/** The sentences, per kind. `a` provides, `b` takes; `about` is a format or a skill. */
function sentences(kind: ConnectionKind, a: string, b: string, about: string): { said: string; offSaid: string } {
  switch (kind) {
  case 'passage':
    return { said: `${b} follows the passage ${a} points at.`, offSaid: `${b} doesn’t follow ${of(a)} passage here.` }
  case 'selection':
    return { said: `${b} follows the references ${a} picks out.`, offSaid: `${b} doesn’t follow what ${a} picks out here.` }
  case 'location':
    return { said: `${b} goes to the place in the code ${a} points at.`, offSaid: `${b} doesn’t follow ${of(a)} code locations here.` }
  case 'address':
    return { said: `${b} shows the pages ${a} opens.`, offSaid: `${b} doesn’t show ${of(a)} pages here; with nobody else showing them, the person is offered them.` }
  case 'steps':
    return { said: `${b} reads the epic’s steps ${a} keeps.`, offSaid: `${b} isn’t given ${of(a)} steps here.` }
  case 'extension':
    return about === 'kehikot.notifications@1'
      ? { said: `${b} shows ${of(a)} notifications.`, offSaid: `${b} doesn’t get ${of(a)} notifications here.` }
      : { said: `${b} takes what ${a} publishes as ${about}.`, offSaid: `${b} doesn’t get ${of(a)} ${about} here.` }
  case 'skill':
    return { said: `${of(b)} /${about} works here because ${a} is here.`, offSaid: `${of(b)} /${about} doesn’t count on ${a} here; without another module that meets the need, it isn’t offered.` }
  case 'agent':
    return { said: `${of(b)} agent sessions are handed ${of(a)} tools.`, offSaid: `${of(b)} sessions aren’t handed ${of(a)} tools here.` }
  case 'parts':
    return a === HOST_NODE_NAME
      ? { said: `${b} narrows to the parts picked in the bar.`, offSaid: `${b} shows the whole epic here, whatever parts are picked.` }
      : { said: `${a} edits the epic’s parts, which ${b} narrows to.`, offSaid: '' }
  case 'tracker':
    return { said: `${b} reads the tracker ${a} keeps.`, offSaid: '' }
  case 'inbox':
    return { said: `${a} tells ${of(b)} Inbox what it is doing.`, offSaid: '' }
  }
}

/** What `REACTS_TO`-word a kind is reacted to by, for the context kinds. */
const SET_REACT: Partial<Record<ConnectionKind, { uses: string; reacts: string }>> = {
  passage: { uses: 'passage:set', reacts: 'passage' },
  selection: { uses: 'selection:set', reacts: 'selection' },
  location: { uses: 'location:set', reacts: 'location' },
  address: { uses: 'address:open', reacts: 'address' },
}

/** Whether a module runs agent sessions, as its manifest says (or, before 2.21.0, the one that did). */
export function runsAgents(manifest: ConnectionModule | null): boolean {
  if (!manifest) return false
  return (manifest.declares?.agentSessions !== undefined && manifest.declares?.agentSessions !== null) || loadsSkillsHere(manifest)
}

/**
 * Every connection among the modules on one kehikko, with whether it is on. In a fixed order: by kind
 * (`CONNECTION_KINDS`), then provider, then consumer, as the modules are listed.
 */
export function connectionsOf(modules: readonly OnKehikko[], setting: ConnectionsSetting | null | undefined = AUTOMATIC): Connection[] {
  const here = [...new Map(modules.map((one) => [one.id, one])).values()]
  const nameOf = (id: string) => (id === HOST_NODE ? HOST_NODE_NAME : (here.find((one) => one.id === id)?.name ?? id))
  const out: Connection[] = []
  const add = (kind: ConnectionKind, from: string, to: string, about = '', fixed = false) => {
    if (from === to) return
    const switchable = !fixed && SWITCHABLE.has(kind)
    const words = sentences(kind, nameOf(from), nameOf(to), about)
    out.push({
      key: `${kind}|${from}|${to}|${about}`,
      kind,
      from,
      to,
      about,
      ...words,
      switchable,
      ...(switchable ? {} : { why: FIXED_WHY[kind] ?? 'This connection is drawn, not switched.' }),
      on: switchable ? delivered(setting, kind, from, to, about) : true,
    })
  }

  for (const kind of CONNECTION_KINDS) {
    const pair = SET_REACT[kind]
    if (pair) {
      for (const a of here) {
        if (!has(usesOf(a.manifest), pair.uses)) continue
        for (const b of here) if (has(reactsOf(b.manifest), pair.reacts)) add(kind, a.id, b.id)
      }
      continue
    }
    switch (kind) {
    case 'steps':
      for (const a of here) {
        if (!a.manifest || !providesHere(a.manifest).includes('steps')) continue
        for (const b of here) if (has(usesOf(b.manifest), 'steps:read')) add(kind, a.id, b.id)
      }
      break
    case 'extension':
      for (const a of here) {
        for (const format of a.manifest?.extensions?.emits ?? []) {
          for (const b of here) if (has(b.manifest?.extensions?.consumes as string[] | undefined, format)) add(kind, a.id, b.id, format)
        }
      }
      break
    case 'parts':
      for (const b of here) if (has(reactsOf(b.manifest), 'parts')) add(kind, HOST_NODE, b.id)
      for (const a of here) {
        if (!has(usesOf(a.manifest), 'parts:set')) continue
        for (const b of here) if (has(reactsOf(b.manifest), 'parts')) add(kind, a.id, b.id, '', true)
      }
      break
    case 'skill':
      for (const b of here) {
        for (const skill of b.manifest?.declares?.skills ?? []) {
          for (const need of skill.needs ?? []) {
            for (const a of here) {
              if (a.id !== b.id && meetsNeed(need, asRead({ ...(a.manifest ?? {}), id: a.id })) && !out.some((one) => one.key === `skill|${a.id}|${b.id}|${skill.name}`)) {
                add(kind, a.id, b.id, skill.name)
              }
            }
          }
        }
      }
      break
    case 'agent':
      for (const b of here) {
        if (!runsAgents(b.manifest)) continue
        for (const a of here) if (a.manifest?.mcp) add(kind, a.id, b.id)
      }
      break
    case 'tracker':
      for (const b of here) {
        if (has(reactsOf(b.manifest), 'tracker') || has(usesOf(b.manifest), 'trackers:read')) add(kind, HOST_NODE, b.id)
      }
      break
    case 'inbox':
      for (const a of here) if (has(usesOf(a.manifest), 'activity:report')) add(kind, a.id, HOST_NODE)
      break
    }
  }
  return out
}

/** One module's side of the window: what it provides (each with its consumers) and what it takes (each with its providers). */
export interface ModuleSide {
  id: string
  name: string
  provides: Row[]
  consumes: Row[]
}

/** One row: one kind (and format or skill) between one module and the others. */
export interface Row {
  /** `kind|about|side|module`. */
  key: string
  kind: ConnectionKind
  about: string
  /** The connections of this row: to its consumers (provides) or from its providers (consumes). */
  edges: Connection[]
  /** Whether the consumer chose providers for this row (`only`), and which. Consumes rows only. */
  only: readonly string[] | null
}

/** The window's list: every module on the kehikko (and Kehikot when it is part of a connection), its two sides. */
export function sidesOf(modules: readonly OnKehikko[], connections: readonly Connection[], setting: ConnectionsSetting | null | undefined): ModuleSide[] {
  const ids = modules.map((one) => one.id)
  const touchesHost = connections.some((one) => one.from === HOST_NODE || one.to === HOST_NODE)
  const all = touchesHost ? [...ids, HOST_NODE] : ids
  const nameOf = (id: string) => (id === HOST_NODE ? HOST_NODE_NAME : (modules.find((one) => one.id === id)?.name ?? id))
  const rows = (id: string, side: 'provides' | 'consumes'): Row[] => {
    const mine = connections.filter((one) => (side === 'provides' ? one.from === id : one.to === id))
    const grouped = new Map<string, Connection[]>()
    for (const one of mine) {
      const key = `${one.kind}|${one.about}|${side}|${id}`
      grouped.set(key, [...(grouped.get(key) ?? []), one])
    }
    return [...grouped.entries()].map(([key, edges]) => {
      const first = edges[0]!
      const only =
        side === 'consumes'
          ? (setting?.only.find((one) => one.kind === first.kind && one.to === id && aboutOf(one.about) === first.about)?.from ?? null)
          : null
      return { key, kind: first.kind, about: first.about, edges, only }
    })
  }
  return all.map((id) => ({ id, name: nameOf(id), provides: rows(id, 'provides'), consumes: rows(id, 'consumes') }))
}

/** Every connection, a line each, on or off: what `read_canvas` says. */
export function connectionsText(connections: readonly Connection[]): string[] {
  if (!connections.length) return ['connections between modules here: none — no module here sets or publishes what another takes.']
  const lines = [
    'connections between modules here (derived from their manifests; [off] is switched off by the person for this kehikko, '
      + 'and only the person changes these — there is no tool for it):',
  ]
  for (const one of connections) {
    lines.push(`  ${one.on ? '[on] ' : '[off]'} ${one.kind}: ${one.on ? one.said : one.offSaid}${one.switchable ? '' : ' (not switchable)'}`)
  }
  return lines
}

/**
 * The steps answer as one consumer may be handed it: without the steps, phases and providers of a module
 * whose steps it does not take here (`steps.list`, and the steps `epic.get` carries). The same object when
 * nothing is withheld.
 */
export function stepsWithheld(data: unknown, takes: (provider: string) => boolean): unknown {
  if (!data || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  let changed = false
  const keep = (list: unknown) => {
    if (!Array.isArray(list)) return list
    const kept = list.filter((one) => !(one && typeof one === 'object' && typeof (one as { module?: unknown }).module === 'string' && !takes((one as { module: string }).module)))
    if (kept.length !== list.length) changed = true
    return kept
  }
  const next = { ...record, steps: keep(record.steps), ...(record.phases !== undefined ? { phases: keep(record.phases) } : {}), ...(record.providers !== undefined ? { providers: keep(record.providers) } : {}) }
  if (record.steps === undefined) delete (next as { steps?: unknown }).steps
  return changed ? next : data
}

/**
 * What one receiver is NOT told on this kehikko, from the facts of who set what: the modules whose
 * passage it does not follow, and whether the selection, the code location, the address and the
 * picked parts are held back from it. `null` when it is told everything — the shared context.
 */
export interface Withheld {
  passageFrom: ReadonlySet<string>
  selection: boolean
  location: boolean
  address: boolean
  parts: boolean
}

export function withheldFor(
  setting: ConnectionsSetting | null | undefined,
  receiver: string,
  facts: { placed: readonly string[]; selectedBy: string | null; locationBy: string | null; addressBy: string | null },
): Withheld | null {
  if (isAutomatic(setting)) return null
  const passageFrom = new Set(facts.placed.filter((id) => !delivered(setting, 'passage', id, receiver)))
  const selection = facts.selectedBy !== null && !delivered(setting, 'selection', facts.selectedBy, receiver)
  /* A location stands only while its change is picked out (`locationStands`), so a held-back
     selection takes it with it. */
  const location = selection || (facts.locationBy !== null && !delivered(setting, 'location', facts.locationBy, receiver))
  const address = facts.addressBy !== null && !delivered(setting, 'address', facts.addressBy, receiver)
  const parts = !delivered(setting, 'parts', HOST_NODE, receiver)
  if (!passageFrom.size && !selection && !location && !address && !parts) return null
  return { passageFrom, selection, location, address, parts }
}

/** The readers an address is handed to: those that take this asker's addresses here. */
export function readersFor(setting: ConnectionsSetting | null | undefined, asker: string | null, readers: readonly string[]): string[] {
  return asker === null ? [...readers] : readers.filter((reader) => delivered(setting, 'address', asker, reader))
}

/** The modules a skill's needs are matched against for `owner`: those whose connection to that skill is on. */
export function meetingSkill<T extends { id: string }>(setting: ConnectionsSetting | null | undefined, owner: string, skill: string, on: readonly T[]): T[] {
  return on.filter((one) => one.id === owner || delivered(setting, 'skill', one.id, owner, skill))
}

/** The doors an agent module's session is handed: those of modules whose tools it is still handed here. */
export function doorsHanded<T extends { module: string }>(setting: ConnectionsSetting | null | undefined, agent: string, doors: readonly T[]): T[] {
  return doors.filter((door) => door.module === HOST_NODE || delivered(setting, 'agent', door.module, agent))
}
