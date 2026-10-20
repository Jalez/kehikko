import type { Database } from 'bun:sqlite'
import { readdirSync } from 'node:fs'

import type { ModuleSkill } from 'kehikot-module-protocol'

import {
  active,
  automatic,
  EMPTY_STATUS,
  SETTINGS_INBOX_MODULE,
  SYNC_TROUBLE_ID,
  type AgentSettings,
  type ModuleSync,
  type SkillState,
  type SyncStatus,
  type ToolState,
} from '../src/host/agentSettings.ts'
import type { Inbox } from './inbox.ts'
import { forgetLeft, forgetMade, leftSkills, madeEntries, readSettings, recordLeft, recordMade, type Made } from './agentSettings.ts'
import { awarenessAt, connect, disconnect, repoint, runClaude, type Door, type Ran, type Runner } from './register.ts'
import { fetchSkillText, readLocal, sha256, statusOf, syncSkill } from './skills.ts'

/**
 * Keeping every module's tools and skills set up in the person's agent, as the
 * Settings say (`src/host/agentSettings.ts`), so nobody presses Connect or
 * Install once per module.
 *
 * ## When it runs
 *
 * On host start, whenever a sweep finds the registered modules, their doors,
 * their versions or their skills different from the last time (`saw`), and
 * when the settings change (`poke`). Runs are serialized — one at a time, and a
 * reason that arrives during one runs once after it — and debounced, so a burst
 * of reasons is one run. A run that could not do something it should have (the
 * `claude` command failed, a module did not serve a skill's text) is tried
 * again later, waiting longer each time. Nothing here is awaited by startup.
 *
 * ## What it touches, and what it never does
 *
 * Nothing at all before the one-time question was answered (`asked`), nor with
 * Claude Code switched off, nor for a module the person left out.
 *
 * Tools: every answering module with an MCP door is connected at user scope
 * (`connect` in `register.ts`, the same `claude mcp add` the Tools window
 * runs). An entry this host made (`agent_made`) whose door moved is re-pointed;
 * one whose module is no longer registered is removed. Any other entry —
 * something the person or another program added — is never changed or
 * removed: a name that is taken is a problem said, not a press made. An entry
 * found pointing EXACTLY at a module's door is adopted as Kehikot's: an entry
 * whose address is the door can only be that door.
 *
 * Skills: every skill an answering module declares is installed or updated
 * through `syncSkill`, which holds every safety rule: a skill the person edited
 * and a name Kehikot did not install are never written over. Those are said,
 * and left.
 *
 * A module that is not running is connected from the door it had when it last
 * ran (`knownDoors` in `known.ts`), at the address its registration gives now;
 * when it starts and its door is somewhere else, Kehikot's entry is re-pointed.
 *
 * Skills of a module that is no longer registered (`tidySkills`) are removed —
 * whatever the settings say, because Kehikot installed them — but only an
 * untouched install whose marker names that module. One the person changed is
 * left, and said once.
 *
 * Every change is one line in the Inbox (`tell`). What could not be done is the
 * one quiet item (`trouble`), cleared when nothing is wrong.
 */

/** One registered module (or the host itself) as the last sweep saw it. */
export interface ModuleSeen {
  id: string
  name: string
  answering: boolean
  /** Its manifest's version, for noticing a change. */
  version: string | null
  /** The door to connect, or null: no door, not answering, or its name refused. */
  door: Door | null
  /** Why its declared door name cannot be used (`nameRefusal`), or null. */
  refusal: string | null
  /** The registration's origin, where its skills are fetched. */
  origin: string
  skills: readonly ModuleSkill[]
}

export interface SyncDeps {
  db: Database
  /** Every registered module now, and the host's own door. */
  modules(): Promise<ModuleSeen[]>
  /** The agent's MCP servers as read now (`agentKnows`). */
  known(): Map<string, unknown>
  /** How `claude` is run. Tests pass their own. */
  run?: Runner
  /** Where skills are installed (`claudeSkillsDir`). */
  skillsRoot(): string
  fetcher?: typeof fetch
  /** One change made: one line in the Inbox. */
  tell(line: string): void
  /** What could not be done, as the one quiet item; empty clears it. */
  trouble(problems: string[]): void
  /**
   * Every module id the registry holds now, a file it would not read included,
   * or null when the registry could not be read. Asked after `modules`. Absent:
   * no skill is ever tidied away.
   */
  registry?(): ReadonlySet<string> | null
}

/** What one run found and did. `transient`: something is worth trying again. */
export interface Ran1 {
  status: SyncStatus
  told: string[]
  transient: boolean
}

/** What changes in a sweep that is worth a run. */
export function fingerprintOf(seen: readonly ModuleSeen[]): string {
  return JSON.stringify(
    [...seen]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((one) => [
        one.id,
        one.answering,
        one.version,
        one.door ? [one.door.as, one.door.url, one.door.transport] : null,
        one.refusal ? 1 : 0,
        one.skills.map((skill) => `${skill.name}@${skill.version}`),
      ]),
  )
}

const normal = (url: string) => url.replace(/\/+$/, '').toLowerCase()
const urlOf = (value: unknown): string | null =>
  value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string' ? (value as { url: string }).url : null

const failed = (ran: Ran) => ran.said || 'The claude command did not say why.'

/** One run: read, compare, act where the settings say so. */
export async function syncOnce(deps: SyncDeps, settings: AgentSettings = readSettings(deps.db)): Promise<Ran1> {
  const run = deps.run ?? runClaude
  const told: string[] = []
  const problems: string[] = []
  let transient = false
  const tell = (line: string) => {
    told.push(line)
    deps.tell(line)
  }

  const seen = await deps.modules()
  const known = deps.known()
  const made = new Map(madeEntries(deps.db).map((one) => [one.module, one]))
  const rows: ModuleSync[] = []

  for (const one of seen) {
    const row: ModuleSync = { id: one.id, name: one.name, tools: null, skills: [], answering: one.answering }
    rows.push(row)
    row.tools = await toolsFor(one)
    if (one.answering) row.skills = await skillsFor(one)
  }

  /* Entries made for modules no longer registered: removed when they still point where they were made to. */
  if (active(settings, 'tools')) {
    const registered = new Set(seen.map((one) => one.id))
    for (const mine of made.values()) {
      if (registered.has(mine.module) || settings.tools.except.includes(mine.module)) continue
      const there = urlOf(known.get(mine.name))
      if (!there || normal(there) !== normal(mine.url)) {
        forgetMade(deps.db, mine.module)
        continue
      }
      const ran = await disconnect(mine.name, run)
      if (ran.ok) {
        forgetMade(deps.db, mine.module)
        tell(`Removed ${mine.title || mine.module}’s tools from Claude Code: the module is no longer installed`)
      } else {
        transient = true
        problems.push(`Could not remove ${mine.title || mine.module}’s tools (“${mine.name}”) from Claude Code: ${failed(ran)}`)
      }
    }
  }

  async function toolsFor(one: ModuleSeen): Promise<ToolState | null> {
    const auto = automatic(settings, 'tools', one.id)
    const excepted = active(settings, 'tools') && !auto
    if (one.refusal) {
      if (auto) problems.push(one.refusal)
      return excepted ? 'excepted' : 'refused'
    }
    /* Not running and no door remembered: nothing to connect yet. One that is
       not running WITH a door is connected from it, as if it were. */
    if (!one.answering && !one.door) return excepted ? 'excepted' : 'asleep'
    const door = one.door
    if (!door) return null
    const aw = awarenessAt(door, known)
    const mine = made.get(one.id)
    const record = (name: string) => {
      const next: Made = { module: one.id, name, url: door.url, title: one.name }
      if (!mine || mine.name !== name || mine.url !== door.url || mine.title !== one.name) recordMade(deps.db, next)
    }

    if (aw.kind === 'told') {
      if (auto) record(aw.as)
      return 'connected'
    }
    if (!auto) return excepted ? 'excepted' : aw.kind === 'renamed' ? 'connected' : 'missing'

    const did = async (ran: Ran, line: string, name: string): Promise<ToolState> => {
      if (ran.ok) {
        record(name)
        tell(line)
        return 'connected'
      }
      transient = true
      problems.push(`Could not connect ${one.name}’s tools for Claude Code: ${failed(ran)}`)
      return 'failed'
    }

    if (aw.kind === 'renamed') {
      /* Points at this door under the name it had; renamed only when Kehikot made it. */
      if (mine?.name !== aw.as) return 'connected'
      return did(await repoint(aw.as, door, run), `Renamed ${one.name}’s tools for Claude Code to “${door.as}”`, door.as)
    }
    if (aw.kind === 'elsewhere') {
      if (mine && mine.name === aw.as && normal(mine.url) === normal(aw.pointsAt)) {
        return did(await repoint(aw.as, door, run), `Re-pointed ${one.name}’s tools for Claude Code to its new address`, door.as)
      }
      problems.push(
        `Claude Code already has a server called “${aw.as}” pointing at ${aw.pointsAt}, and Kehikot did not add it, so ${one.name}’s tools were not connected. Re-point it from ${one.name}’s Tools window if it is meant to be this one.`,
      )
      return 'conflict'
    }
    if (aw.kind === 'untold') {
      /* Kehikot's entry under an older name and address, both since changed: moved, not doubled. */
      const old = mine ? urlOf(known.get(mine.name)) : null
      if (mine && old && normal(old) === normal(mine.url)) {
        return did(await repoint(mine.name, door, run), `Re-pointed ${one.name}’s tools for Claude Code to its new address`, door.as)
      }
      return did(await connect(door, run), `Connected ${one.name}’s tools for Claude Code`, door.as)
    }
    return null
  }

  async function skillsFor(one: ModuleSeen): Promise<{ name: string; state: SkillState }[]> {
    const root = deps.skillsRoot()
    const auto = automatic(settings, 'skills', one.id)
    const excepted = active(settings, 'skills') && !auto
    const out: { name: string; state: SkillState }[] = []
    for (const skill of one.skills) {
      const local = readLocal(root, skill.name, one.id)
      const where = `${root}/${skill.name}`
      if (excepted) {
        out.push({ name: skill.name, state: 'excepted' })
        continue
      }
      if (local.kind === 'taken') {
        if (auto) problems.push(`The /${skill.name} skill from ${one.name} was not installed: ${where} is ${local.who}. Kehikot left it alone.`)
        out.push({ name: skill.name, state: 'taken' })
        continue
      }
      if (local.kind === 'edited') {
        if (auto) problems.push(`The /${skill.name} skill from ${one.name} was changed by you, so Kehikot does not update it (${where}).`)
        out.push({ name: skill.name, state: 'edited' })
        continue
      }
      if (!auto) {
        out.push({ name: skill.name, state: statusOf(local, null) })
        continue
      }
      const fetched = await fetchSkillText(one.origin, skill.name, deps.fetcher)
      if (!fetched.ok) {
        transient = true
        problems.push(`The /${skill.name} skill from ${one.name} could not be read: ${fetched.why}`)
        out.push({ name: skill.name, state: 'failed' })
        continue
      }
      if (local.kind === 'ours' && local.marker!.sha256 === sha256(fetched.text)) {
        out.push({ name: skill.name, state: 'installed' })
        continue
      }
      const mode = local.kind === 'absent' ? 'install' : 'update'
      const done = syncSkill(root, one.id, skill, mode, fetched.text)
      if (done.ok) {
        tell(`${mode === 'install' ? 'Installed' : 'Updated'} the /${skill.name} skill (Claude)`)
        out.push({ name: skill.name, state: 'installed' })
      } else {
        transient = true
        problems.push(`The /${skill.name} skill from ${one.name} could not be ${mode === 'install' ? 'installed' : 'updated'}: ${done.why}`)
        out.push({ name: skill.name, state: 'failed' })
      }
    }
    return out
  }

  const registry = deps.registry?.() ?? null
  if (registry) {
    const tidied = tidySkills(deps.db, deps.skillsRoot(), registry, tell)
    problems.push(...tidied.problems)
    if (tidied.problems.length) transient = true
  }

  deps.trouble(problems)
  return { status: { at: Date.now(), running: false, modules: rows, problems }, told, transient }
}

/**
 * The skills of modules no longer registered: each untouched install whose
 * marker names such a module is removed through `syncSkill`, which refuses
 * anything else; one the person changed is left and said once (`skill_left`).
 *
 * Not held to the settings: Kehikot installed these — from the sync or from a
 * press in a module's Skills window — so it takes them away with the module.
 * A folder with no marker, or one naming a module still registered, is never
 * looked at twice.
 */
export function tidySkills(
  db: Database,
  root: string,
  registry: ReadonlySet<string>,
  tell: (line: string) => void,
): { removed: string[]; left: string[]; problems: string[] } {
  const removed: string[] = []
  const left: string[] = []
  const problems: string[] = []
  const said = leftSkills(db)
  let names: string[]
  try {
    names = readdirSync(root, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []))
  } catch {
    names = []
  }
  const still = new Set<string>()
  for (const name of names.sort()) {
    const marker = readLocal(root, name, '').marker
    if (!marker || registry.has(marker.module)) continue
    const local = readLocal(root, name, marker.module)
    if (local.kind === 'edited') {
      still.add(name)
      left.push(name)
      if (said.get(name) !== marker.module) {
        recordLeft(db, name, marker.module)
        tell(`Left the /${name} skill (${root}/${name}): ${marker.module}, which installed it, is no longer installed, and you changed it`)
      }
      continue
    }
    if (local.kind !== 'ours') continue
    const done = syncSkill(root, marker.module, { name, summary: '', version: marker.version }, 'remove')
    if (done.ok) {
      removed.push(name)
      tell(`Removed the /${name} skill: ${marker.module}, which installed it, is no longer installed`)
    } else {
      problems.push(`The /${name} skill of ${marker.module}, which is no longer installed, could not be removed: ${done.why}`)
    }
  }
  for (const name of said.keys()) if (!still.has(name)) forgetLeft(db, name)
  return { removed, left, problems }
}

export interface SyncTiming {
  /** How long a burst of reasons is gathered into one run. */
  debounceMs: number
  /** The first wait before trying a failed run again; doubled each time. */
  retryMs: number
  retryMaxMs: number
}

const TIMING: SyncTiming = { debounceMs: 1_500, retryMs: 30_000, retryMaxMs: 30 * 60_000 }

/** The loop around `syncOnce`: debounced, one run at a time, retried with backoff. */
export class AgentSync {
  #status: SyncStatus = EMPTY_STATUS
  #timer: ReturnType<typeof setTimeout> | null = null
  #retry: ReturnType<typeof setTimeout> | null = null
  #running: Promise<void> | null = null
  #again = false
  #lastSeen: string | null = null
  #seenDuring: string | null = null
  #failures = 0
  #stopped = false
  readonly #timing: SyncTiming

  constructor(
    private readonly deps: SyncDeps,
    timing: Partial<SyncTiming> = {},
  ) {
    this.#timing = { ...TIMING, ...timing }
  }

  status(): SyncStatus {
    return { ...this.#status, running: this.#running !== null }
  }

  /** A reason to run: gathered for `debounceMs`, then run once. */
  poke(): void {
    if (this.#stopped) return
    if (this.#running) {
      this.#again = true
      return
    }
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.now()
    }, this.#timing.debounceMs)
    ;(this.#timer as { unref?: () => void }).unref?.()
  }

  /** What a sweep found. A run only when it differs from what the last run worked from. */
  saw(seen: readonly ModuleSeen[]): void {
    const print = fingerprintOf(seen)
    if (this.#running) {
      this.#seenDuring = print
      return
    }
    if (print === this.#lastSeen) return
    this.#lastSeen = print
    this.poke()
  }

  /** Run now, or wait for the run in flight and then run again. */
  async now(): Promise<void> {
    if (this.#stopped) return
    if (this.#running) {
      this.#again = true
      return this.#running
    }
    this.#running = this.#once().finally(() => {
      this.#running = null
      const moved = this.#seenDuring !== null && this.#seenDuring !== this.#lastSeen
      this.#seenDuring = null
      if (this.#again || moved) {
        this.#again = false
        this.poke()
      }
    })
    return this.#running
  }

  async #once(): Promise<void> {
    let transient = false
    try {
      const deps: SyncDeps = {
        ...this.deps,
        modules: async () => {
          const seen = await this.deps.modules()
          this.#lastSeen = fingerprintOf(seen)
          return seen
        },
      }
      const ran = await syncOnce(deps)
      this.#status = ran.status
      transient = ran.transient
    } catch (error) {
      transient = true
      this.#status = { ...this.#status, at: Date.now(), problems: [`Kehikot could not check your agent’s setup: ${(error as Error).message}`] }
      try {
        this.deps.trouble(this.#status.problems)
      } catch {
        /* Said next time. */
      }
    }
    if (this.#retry) clearTimeout(this.#retry)
    this.#retry = null
    if (!transient) {
      this.#failures = 0
      return
    }
    this.#failures += 1
    const wait = Math.min(this.#timing.retryMs * 2 ** (this.#failures - 1), this.#timing.retryMaxMs)
    this.#retry = setTimeout(() => {
      this.#retry = null
      this.poke()
    }, wait)
    ;(this.#retry as { unref?: () => void }).unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
    if (this.#retry) clearTimeout(this.#retry)
  }
}

/**
 * The sync's two ways of speaking, in the Inbox: a change is one notice line,
 * born done, filed under `SETTINGS_INBOX_MODULE` with the by-line Kehikot; what
 * could not be done is ONE quiet item (low priority) in that module's list,
 * replaced on every run and cleared when nothing is wrong — also in a project
 * it was put in that is no longer the one being looked at.
 *
 * `where` is the projects to speak in (the open ones). Nothing is said when
 * there is no project at all.
 */
export function settingsInbox(
  inbox: Pick<Inbox, 'notice' | 'report'>,
  where: () => number[],
  changed: (project: number, rev: number) => void,
): Pick<SyncDeps, 'tell' | 'trouble'> {
  const holding = new Set<number>()
  let said = ''
  return {
    tell(line) {
      for (const project of where()) {
        const out = inbox.notice(project, SETTINGS_INBOX_MODULE, 'Kehikot', { epic: '', message: line, level: 'done' })
        changed(project, out.rev)
      }
    },
    trouble(problems) {
      const now = where()
      const text = problems.join('\n')
      if (text === said && now.every((project) => holding.has(project) === (problems.length > 0))) return
      said = text
      const items = problems.length
        ? [
            {
              id: SYNC_TROUBLE_ID,
              state: 'attention' as const,
              priority: 'low' as const,
              label: problems.length === 1 ? 'One thing in your agent’s setup was left alone' : `${problems.length} things in your agent’s setup were left alone`,
              detail: problems.join(' ').slice(0, 400),
            },
          ]
        : []
      for (const project of new Set([...holding, ...now])) {
        const out = inbox.report(project, SETTINGS_INBOX_MODULE, 'Kehikot', items)
        changed(project, out.rev)
      }
      holding.clear()
      if (items.length) for (const project of now) holding.add(project)
    },
  }
}
