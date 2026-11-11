import type { Database } from 'bun:sqlite'
import { doorsHanded, meetingSkill } from '../src/host/connections.ts'
import { LIMITS, installsSkills, isKehikkoBound, oneLine, skillsThatLoad, type AbsentModule, type AgentChange, type EverywhereSkill, type HostChanges, type Guard, type ModuleSkill, type PlacedGuard, GUARD_LIMITS } from 'kehikot-module-protocol'

import { asRead, loadsSkillsHere, type ReadManifest } from '../src/host/providers.ts'

import { awarenessOf, type AgentAwareness } from './agents.ts'
import { listCanvases, type Canvas } from './canvases.ts'
import {
  doorPlaceOf,
  ensureDoorPlaces,
  hereOf,
  issue,
  issuerOf,
  lookingAt,
  openSession,
  PLACE_PARAM,
  projectByUid,
  record,
  RECORDED_PLACE_PATH,
  resolveHere,
  sessionOf,
  settledPlace,
  wellFormed,
  type AskRecord,
  type Here,
  type Recorded,
  type Unrecorded,
} from './doorPlaces.ts'
import { epicSlugs } from './holdings.ts'
import { skillsForSession } from './kehikkoSkills.ts'
import type { Inbox } from './inbox.ts'
import { HOST_ID } from './kehikot.ts'
import { projectAt, type Project } from './projects.ts'
import { doorName } from './register.ts'

/**
 * The routes of a conversation's place (protocol 2.4.0), and the asks in the Inbox.
 *
 *  - `GET  /host/place?kehikot-place=<token>` — the place the record behind a
 *    token says, with what the person is looking at: `placeResult`. For a
 *    module's door, which is handed the token on its own URL
 *    (`resolveDoorPlace` in the protocol). The host asks the module that
 *    issued the token (`RECORDED_PLACE_PATH`); it keeps no place of its own.
 *  - `POST /host/place` — a module that starts conversations and keeps their
 *    records says it issued a token, in a project, and gets every Kehikot door
 *    the session should have with the token on its URL (`placeDoorsSchema`),
 *    and beside them the modules on that kehikko (`modulesOn`), so the session
 *    can be told what it has around it from its first turn, and the installed modules that are
 *    not on it but say something there (`absentFrom`, 2.36.0) — and, to a module that installs
 *    skills for its own agent (2.23.0), `everywhere`: the skills the person keeps in every
 *    conversation (`everywhereFor` in skills.ts) — and, when the place has a
 *    kehikko, `kehikkoSkills` (2.53.0): the skills the person wrote for that
 *    kehikko (`kehikkoSkills.ts`), to every module that asks, so every
 *    session on it loads them. A program's: a
 *    token grants nothing a call could not do by naming the place
 *    (`doorPlaces.ts`), and asking again with the same token is how a module
 *    learns that the kehikko changed.
 *
 * A connection with no readable record is settled in a place on its first tool
 * call, with nobody asked (`settledPlace` in doorPlaces.ts): the person is never
 * asked which epic a conversation is for. Asks of that kind left in an Inbox by
 * an older host are taken out of the record when this desk starts.
 */

const KEY = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{6,62}[a-z0-9]$/
/** The id prefix of the asks older hosts filed in the Inbox ("which epic is this conversation for?"): taken out on start. */
export const ASK_PREFIX = 'place-ask:'
const BODY_MAX = 16 * 1024

/** A registered module as a session is told of it: what the host knows of it whether or not it answers. */
export interface ModuleAbout {
  id: string
  /** What it calls itself; null when the host never learnt. */
  name: string | null
  /** Its own one line of what it is for, when it has one. */
  summary?: string
  /** What it says to agents on a kehikko it is on (`agentSays`, protocol 2.36.0), when it says anything. */
  agentSays?: string
  /** What it says to agents on a kehikko it is NOT on (`absentSays`, protocol 2.36.0), when it says anything. */
  absentSays?: string
  /** The shell commands it guards in agent sessions on a kehikko it is placed on (`guards`, protocol 2.61.0). */
  guards?: readonly Guard[]
  /** Whether it is on the official list this host vouches for: only such a module is heard where it is absent. */
  official?: boolean
  /** The skills it declares (protocol 2.5.0); empty for one that is not answering. */
  skills: readonly Pick<ModuleSkill, 'name' | 'needs'>[]
  /**
   * What its manifest says that a skill's needs are matched against (protocol 2.21.0): `reacts`,
   * `declares.uses`, `declares.provides`, `declares.agentSessions`, `mcp.subjects` and `build`.
   * Absent for one that is not answering: it meets only a need that names its id.
   */
  manifest?: Omit<ReadManifest, 'id'>
  /** The version its copy runs (protocol 2.61.0, `agentChanges.ts`), when its `package.json` says one. */
  version?: string
  /** What its releases up to it say to agents, newest first (protocol 2.61.0). */
  changes?: readonly AgentChange[]
}

/** One container on a session's kehikko, as `POST /host/place` lists it. */
export interface ModuleOn {
  module: string
  name: string
  /** The module's one line, clipped; empty when it has none. Its words, to be read as text. */
  summary: string
  /** What it says to agents (`agentSays`, protocol 2.36.0), clipped; absent when it says nothing. */
  says?: string
  /** The name its MCP door has in the session's config (one of `doors`), or null for a module with none. */
  door: string | null
  /**
   * The skills it offers that can work on this kehikko: every need a skill lists is met by a
   * container's manifest here (`skillsThatLoad`, protocol 2.44.0 — the same rule the module that
   * loads skills runs). Kehikko-bound ones only for a session started by a module that loads skills
   * (`loadsSkillsHere`): that is where such a skill is routed. What CAN load now, not what a session
   * holds: the module that runs it knows that, and says apart what its session lacks (`holds` in the
   * protocol's notes, 2.44.0).
   */
  skills: string[]
  /** The version it runs, and what its releases up to it say to agents (protocol 2.61.0): told once to a session started before an update. */
  version?: string
  changes?: AgentChange[]
}

const SUMMARY_MAX = 200

/**
 * The containers on a session's kehikko, in the order the canvas is read (top to bottom, then left
 * to right, as `read_canvas` lists them), each with its name, its one line, its door's name in the
 * session's config and the skills it offers there. A module the host has never seen answer is
 * still listed — the container is there — by its id, with no door and no skills.
 */
export function modulesOn(
  canvas: (Pick<Canvas, 'placements'> & Partial<Pick<Canvas, 'connections'>>) | null,
  about: readonly ModuleAbout[],
  doors: readonly { module: string; name: string }[],
  /** Whether the module the session is for loads kehikko-bound skills into it. */
  loadsBound = true,
): ModuleOn[] {
  if (!canvas) return []
  const known = new Map(about.map((one) => [one.id, one]))
  /* What is on the kehikko, as a skill's needs are matched against it: each container's manifest, read with the pre-2.21 table. */
  const on = [...new Set(canvas.placements.map((p) => p.i))].map((id) => asRead({ ...(known.get(id)?.manifest ?? {}), id }))
  const seen = new Set<string>()
  const out: ModuleOn[] = []
  for (const p of [...canvas.placements].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (seen.has(p.i)) continue
    seen.add(p.i)
    const one = known.get(p.i)
    const says = oneLine(one?.agentSays, SUMMARY_MAX)
    out.push({
      module: p.i,
      name: oneLine(one?.name, 80) || p.i,
      summary: oneLine(one?.summary, SUMMARY_MAX),
      ...(says ? { says } : {}),
      door: doors.find((door) => door.module === p.i)?.name ?? null,
      skills: (one?.skills ?? [])
        /* A need is met only by a module whose connection to this skill the person left on here
           (`meetingSkill`, `src/host/connections.ts`): one switched off is as if it were not here. */
        .filter(
          (skill) =>
            (loadsBound || !isKehikkoBound(skill)) &&
            skillsThatLoad([skill], meetingSkill(canvas.connections, p.i, skill.name, on)).load.length === 1,
        )
        .map((skill) => skill.name),
      ...(one?.version ? { version: one.version, changes: [...(one.changes ?? [])] } : {}),
    })
  }
  return out
}

/**
 * The modules installed here that are NOT on a session's kehikko and say something to sessions
 * there (`absentSays`, protocol 2.36.0), in the order the host knows them. Only a module on the
 * official list: an absent line reaches sessions on every kehikko of every project, where nobody
 * placed the module, so it is heard only from a module this host vouches for. Never the module the
 * session is for, never one on the kehikko, and nothing for a place with no kehikko. Each line is
 * one line of text, clipped (`oneLine`); at most `LIMITS.ABSENT_MODULES`.
 */
export function absentFrom(canvas: Pick<Canvas, 'placements'> | null, about: readonly ModuleAbout[], asker: string): AbsentModule[] {
  if (!canvas) return []
  const on = new Set(canvas.placements.map((p) => p.i))
  const out: AbsentModule[] = []
  for (const one of about) {
    if (one.id === asker || on.has(one.id) || !one.official) continue
    const says = oneLine(one.absentSays, SUMMARY_MAX)
    if (!says) continue
    out.push({ module: one.id, name: oneLine(one.name, 80) || one.id, says })
    if (out.length >= LIMITS.ABSENT_MODULES) break
  }
  return out
}

/**
 * The guards of the modules PLACED on a session's kehikko (protocol 2.61.0), in the order the canvas
 * is read, each with its module's id and name: what the module that runs the session holds every
 * shell command to. Only placed modules — one installed but not on the kehikko guards nothing — and
 * nothing for a place with no kehikko. At most `GUARD_LIMITS.PLACED`.
 */
export function guardsOn(canvas: Pick<Canvas, 'placements'> | null, about: readonly ModuleAbout[]): PlacedGuard[] {
  if (!canvas) return []
  const known = new Map(about.map((one) => [one.id, one]))
  const out: PlacedGuard[] = []
  const seen = new Set<string>()
  for (const p of [...canvas.placements].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (seen.has(p.i)) continue
    seen.add(p.i)
    const one = known.get(p.i)
    for (const guard of one?.guards ?? []) {
      if (out.length >= GUARD_LIMITS.PLACED) return out
      out.push({ module: p.i, name: oneLine(one?.name, 80) || p.i, guard })
    }
  }
  return out
}

/** What a door is, as far as handing it to a session goes. */
export interface DoorSeen {
  module: string
  /** The name the module declares (`mcp.as`), or null. */
  declared: string | null
  url: string
  transport: 'http' | 'sse'
}

export interface PlaceDeps {
  db: Database
  inbox?: Inbox
  /** The host's own door. */
  hostUrl(): string
  /** Every registered module's MCP door, as the last sweep saw it. */
  doors(): Promise<DoorSeen[]>
  /** Every registered module, as the last sweep saw it: what a session is told of the ones on its kehikko. */
  modules?(): Promise<ModuleAbout[]>
  /**
   * The skills this host keeps for every conversation, as said to `asker` (`everywhereFor` in
   * skills.ts, protocol 2.23.0). Asked only for a module that installs skills itself.
   */
  everywhere?(asker: string): Promise<EverywhereSkill[]>
  /** What the person's agent config holds (`agentKnows`). */
  known(): Map<string, unknown>
  /** The kehikko a page has open, or null. */
  open(): number | null
  /** The project's inbox changed. */
  changed(project: number, rev: number): void
  /** A registered module's origin, or null. */
  originOf(module: string): Promise<string | null>
  /**
   * The session's unread messages for its notes, counted delivered (protocol 2.41.0), asked when the
   * module says `messages: true`. Absent: this host keeps none, and the answer carries no `messages`.
   */
  messagesFor?(here: Here | null, token: string): { messages: unknown[]; messagesMore: number }
  /** Kehikot's own changes for agents (protocol 2.61.0, `hostChanges` in agentChanges.ts); absent or null: none said. */
  host?(): HostChanges | null
  /** Injected by tests. */
  fetch?: typeof fetch
}

/** How long a module gets to say what its record holds. */
const RECORD_ASK_MS = 1500
/** How long one module's answer about a token is reused: one tool call reads it several times. */
const RECORD_KEEP_MS = 2000

/**
 * The name a door goes under in a session's config: the name the person's
 * agent config ALREADY uses for it — so the session's entry replaces theirs by
 * name instead of adding a second server with the same tools — and otherwise
 * the name the plug in the container header would register it under.
 */
export function nameFor(door: DoorSeen, known: Map<string, unknown>): string {
  const told: AgentAwareness = awarenessOf(door.url, door.module, known, door.declared)
  if (told.kind === 'told' || told.kind === 'renamed' || told.kind === 'elsewhere') return told.as
  return door.module === HOST_ID ? HOST_ID : doorName(door.module, door.declared)
}

/** A door's URL with the token on it. */
export function withToken(url: string, token: string): string {
  const at = new URL(url)
  at.searchParams.set(PLACE_PARAM, token)
  return at.toString()
}

/** Every door a session in this place gets: the host's, and those of the modules on the place's kehikko. */
export function doorsFor(
  here: Pick<Here, 'canvas' | 'token'> & { token: string },
  hostUrl: string,
  seen: readonly DoorSeen[],
  known: Map<string, unknown>,
): { module: string; name: string; url: string; transport: 'http' | 'sse' }[] {
  const on = new Set(here.canvas?.placements.map((p) => p.i) ?? [])
  const doors: DoorSeen[] = [{ module: HOST_ID, declared: null, url: hostUrl, transport: 'http' }, ...seen.filter((one) => on.has(one.module))]
  const named = new Set<string>()
  const out: { module: string; name: string; url: string; transport: 'http' | 'sse' }[] = []
  for (const door of doors) {
    const name = nameFor(door, known)
    /* Two doors under one name would be one server in the config; the first keeps it. */
    if (named.has(name)) continue
    named.add(name)
    out.push({ module: door.module, name, url: withToken(door.url, here.token), transport: door.transport })
  }
  return out
}

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => '')
  if (!text || text.length > BODY_MAX) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function placeDesk(deps: PlaceDeps) {
  const { db } = deps
  ensureDoorPlaces(db)
  const kept = new Map<string, { at: number; said: Omit<Recorded, 'projectUid'> | null }>()
  /**
   * The last place each module said for a token. A module that did not answer (restarting, busy
   * past `RECORD_ASK_MS`) is answered for by what it said last, so a conversation it started keeps
   * its place instead of losing it for one call. One that answers "no record" is believed.
   */
  const lastSaid = new Map<string, Omit<Recorded, 'projectUid'>>()

  /** What the module that issued a token records for it now (`RECORDED_PLACE_PATH`). */
  const ask: AskRecord = async (module, token, project) => {
    const had = kept.get(token)
    if (had && Date.now() - had.at < RECORD_KEEP_MS) return had.said
    const origin = await deps.originOf(module)
    if (!origin) return lastSaid.get(token) ?? null
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), RECORD_ASK_MS)
    let said: Omit<Recorded, 'projectUid'> | null = null
    let answered = false
    try {
      const url = `${origin}${RECORDED_PLACE_PATH}?${PLACE_PARAM}=${encodeURIComponent(token)}&project=${encodeURIComponent(project.path)}`
      const response = await (deps.fetch ?? fetch)(url, { signal: control.signal })
      const body = response.ok ? ((await response.json()) as { ok?: unknown; place?: Record<string, unknown> | null }) : null
      answered = body?.ok === true
      const place = body?.ok === true ? body.place : null
      if (place && wellFormed({ epic: place.epic ?? null, parts: place.parts ?? [], kehikko: place.kehikko ?? null })) {
        said = {
          epic: (place.epic as string | null) ?? null,
          parts: (place.parts as string[]) ?? [],
          kehikko: (place.kehikko as string | null) ?? null,
          conversation: typeof place.conversation === 'string' ? place.conversation.slice(0, 128) : null,
        }
      }
    } catch {
      said = null
    } finally {
      clearTimeout(timer)
    }
    if (said) lastSaid.set(token, said)
    else if (answered) lastSaid.delete(token)
    else said = lastSaid.get(token) ?? null
    if (lastSaid.size > 500) lastSaid.delete(lastSaid.keys().next().value!)
    kept.set(token, { at: Date.now(), said })
    if (kept.size > 500) kept.delete(kept.keys().next().value!)
    return said
  }

  /* The asks an older host filed in the Inbox ("which epic is this conversation for?") go, once: nothing files them now. */
  if (deps.inbox) for (const gone of deps.inbox.forgetAll(HOST_ID, ASK_PREFIX)) deps.changed(gone.project, gone.rev)

  /**
   * Settle a connection with no readable record in a place, with nobody asked (`settledPlace`):
   * the project its token names, or else the one on screen. Null when it has a record already,
   * or no project can be named.
   */
  function settle(session: string, token: unknown): Here | null {
    const had = sessionOf(db, session)
    if (!had || had.place) return null
    const issued = issuerOf(db, token)
    const open = lookingAt(db, deps.open())
    const project = issued ? projectByUid(db, issued.projectUid) : (open?.project ?? null)
    const place = settledPlace(project, project ? epicSlugs(project.path) : null, open?.canvas ?? null)
    if (!place || !place.project.uid) return null
    const stored: Recorded = { projectUid: place.project.uid, epic: place.epic, parts: place.parts, kehikko: place.kehikko }
    return record(db, session, stored) ? hereOf(db, stored, 'session') : null
  }

  /**
   * The place a door call is in, from its token or its MCP session's record. With `settling` (a
   * tool call at the door), a session with neither is settled in one now, and `settled` says so.
   */
  async function resolve(token: unknown, session: unknown, settling = false): Promise<{ here: Here | null; unrecorded: Unrecorded | null; settled?: boolean }> {
    const found = await resolveHere(db, token, session, ask)
    if (found.here || !settling || typeof session !== 'string') return found
    const here = settle(session, token)
    return here ? { ...found, here, settled: true } : found
  }

  function recordFor(session: string, project: Project, place: { epic: string | null; parts: string[]; kehikko: string | null }): Here | null {
    if (!project.uid) return null
    const stored: Recorded = { projectUid: project.uid, ...place }
    if (!record(db, session, stored)) return null
    return hereOf(db, stored, 'session')
  }

  /** What the MCP door is handed: sessions and records. */
  const places = {
    open: (client: string) => openSession(db, client),
    bind: recordFor,
  }

  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/host/place' && request.method === 'GET') {
      const { here, unrecorded } = await resolve(url.searchParams.get(PLACE_PARAM), null)
      return reply({ ok: true, place: here ? doorPlaceOf(here, lookingAt(db, deps.open())) : null, ...(unrecorded ? { why: `No record: ${unrecorded.why}.` } : {}) })
    }

    if (url.pathname === '/host/place' && request.method === 'POST') {
      const body = await bodyOf(request)
      if (!body) return reply({ ok: false, error: 'A token is issued as a JSON object: module, token, project, kehikko.' }, 400)
      const uid = typeof body.projectId === 'string' && PROJECT_ID.test(body.projectId) ? body.projectId : null
      const byUid = uid ? projectByUid(db, uid) : null
      const at = byUid ? null : projectAt(db, body.project)
      const project = byUid ?? (at?.uid ? projectByUid(db, at.uid) : null)
      if (!project || !project.uid) return reply({ ok: false, error: 'That is not a project this host holds, or it has no id yet.' }, 404)
      const kehikko = body.kehikko === null || body.kehikko === undefined ? null : body.kehikko
      if (kehikko !== null && (typeof kehikko !== 'string' || !KEY.test(kehikko))) return reply({ ok: false, error: 'kehikko is a kehikko’s key, or null.' }, 400)
      const token = typeof body.token === 'string' ? body.token : ''
      const module = typeof body.module === 'string' ? body.module : ''
      if (!issue(db, token, module, project.uid)) return reply({ ok: false, error: 'token is 22 to 64 URL-safe characters and module a module id.' }, 400)
      kept.delete(token)
      const canvas = kehikko === null ? null : (listCanvases(db).find((one) => one.project === project.id && one.key === kehikko) ?? null)
      /* The doors of modules whose tools the person switched off for this agent module here are
         not handed to its session (`doorsHanded`, `src/host/connections.ts`). */
      const doors = doorsHanded(canvas?.connections, module, doorsFor({ token, canvas }, deps.hostUrl(), await deps.doors(), deps.known()))
      const about = deps.modules ? await deps.modules() : undefined
      const asker = about?.find((one) => one.id === module)
      const modules = about ? modulesOn(canvas, about, doors, loadsSkillsHere({ ...(asker?.manifest ?? {}), id: module })) : undefined
      /* And the installed ones not on it that say something there (2.36.0): only with a kehikko. */
      const absent = about && canvas ? absentFrom(canvas, about, module) : undefined
      /* A module that installs skills for its own agent is told which ones the person keeps in every conversation (2.23.0). */
      const everywhere = deps.everywhere && asker?.manifest && installsSkills(asker.manifest) ? await deps.everywhere(module) : undefined
      /* Its unread messages, for the notes (2.41.0): only to a module that says it says them, and only then counted delivered. */
      const told = body.messages === true && deps.messagesFor ? deps.messagesFor((await resolve(token, null)).here, token) : undefined
      /* The person's skills for that kehikko (2.53.0): to every module, whatever epic the session is on. Read on every ask, so an edit reaches the next one. */
      const kehikkoSkills = canvas ? skillsForSession(project.path, canvas.key) : undefined
      /* Kehikot's own changes for agents (2.62.0): to every session, which is told those after the ones it was told, once. */
      const host = deps.host?.() ?? null
      /* The guards of the modules placed there (2.61.0): only placed ones, none without a kehikko. */
      const guards = about ? guardsOn(canvas, about) : undefined
      return reply({ ok: true, token, doors, ...(host ? { host } : {}), ...(modules ? { modules } : {}), ...(absent ? { absent } : {}), ...(everywhere ? { everywhere } : {}), ...(kehikkoSkills ? { kehikkoSkills } : {}), ...(guards ? { guards } : {}), ...(told ?? {}) })
    }

    return null
  }

  return { route, places, resolve }
}
