import type { Database } from 'bun:sqlite'
import { doorsHanded, meetingSkill } from '../src/host/connections.ts'
import { LIMITS, installsSkills, isKehikkoBound, missingNeeds, oneLine, type AbsentModule, type EverywhereSkill, type ModuleSkill } from 'kehikot-module-protocol'

import { asRead, loadsSkillsHere, type ReadManifest } from '../src/host/providers.ts'

import { awarenessOf, type AgentAwareness } from './agents.ts'
import { listCanvases, type Canvas } from './canvases.ts'
import {
  askingIn,
  doorPlaceOf,
  ensureDoorPlaces,
  hereOf,
  issue,
  lookingAt,
  markAsked,
  openSession,
  PLACE_PARAM,
  projectByUid,
  record,
  RECORDED_PLACE_PATH,
  resolveHere,
  sessionOf,
  wellFormed,
  type AskRecord,
  type Here,
  type Recorded,
} from './doorPlaces.ts'
import { readParts } from './holdings.ts'
import type { Inbox } from './inbox.ts'
import { HOST_ID } from './kehikot.ts'
import { projectAt, projectById, type Project } from './projects.ts'
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
 *    conversation (`everywhereFor` in skills.ts). A program's: a
 *    token grants nothing a call could not do by naming the place
 *    (`doorPlaces.ts`), and asking again with the same token is how a module
 *    learns that the kehikko changed.
 *  - `POST /host/place/answer` — the person's answer to an ask in the Inbox:
 *    which epic an unplaced conversation is for. The page's alone
 *    (`PAGE_ONLY`): no program, and no MCP tool, answers for the person.
 *
 * The asks are the host's own list in the Inbox (module `HOST_ID`): one item
 * per unbound session that asked, in the project it asked in, reported whole
 * every time it changes, so a bound session's item closes by the same rule a
 * module's dropped item does.
 */

const KEY = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{6,62}[a-z0-9]$/
/** An ask's item id in the Inbox: `place-ask:<session>`. The page draws its choices by it. */
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
   * container here (`missingNeeds`, protocol 2.21.0: by id, or by what a module provides, says or
   * asks for). Kehikko-bound ones only for a session started by a module that loads skills
   * (`loadsSkillsHere`): that is where such a skill is routed.
   */
  skills: string[]
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
            missingNeeds(skill, meetingSkill(canvas.connections, p.i, skill.name, on)).length === 0,
        )
        .map((skill) => skill.name),
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

  /** What the module that issued a token records for it now (`RECORDED_PLACE_PATH`). */
  const ask: AskRecord = async (module, token, project) => {
    const had = kept.get(token)
    if (had && Date.now() - had.at < RECORD_KEEP_MS) return had.said
    const origin = await deps.originOf(module)
    if (!origin) return null
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), RECORD_ASK_MS)
    let said: Omit<Recorded, 'projectUid'> | null = null
    try {
      const url = `${origin}${RECORDED_PLACE_PATH}?${PLACE_PARAM}=${encodeURIComponent(token)}&project=${encodeURIComponent(project.path)}`
      const response = await (deps.fetch ?? fetch)(url, { signal: control.signal })
      const body = response.ok ? ((await response.json()) as { ok?: unknown; place?: Record<string, unknown> | null }) : null
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
    kept.set(token, { at: Date.now(), said })
    if (kept.size > 500) kept.delete(kept.keys().next().value!)
    return said
  }

  /** The place a door call is in, from its token or its MCP session's record. */
  const resolve = (token: unknown, session: unknown) => resolveHere(db, token, session, ask)

  /** The host's list in a project's Inbox: one ask per unrecorded session that asked there. */
  function report(project: Project): void {
    if (!deps.inbox || !project.uid) return
    const items = askingIn(db, project.uid).map((one) => ({
      id: `${ASK_PREFIX}${one.id}`,
      state: 'attention' as const,
      label: `${one.client ? `A ${one.client.slice(0, 40)}` : 'An agent'} session asks which epic it is for`.slice(0, 120),
      detail: 'Your answer is recorded for that conversation, and it then answers about that epic whatever is on screen.',
      since: one.asked ?? undefined,
    }))
    const out = deps.inbox.report(project.id, HOST_ID, 'Kehikot', items)
    deps.changed(project.id, out.rev)
  }

  function recordFor(session: string, project: Project, place: { epic: string | null; parts: string[]; kehikko: string | null }): Here | null {
    if (!project.uid) return null
    const stored: Recorded = { projectUid: project.uid, ...place }
    if (!record(db, session, stored)) return null
    report(project)
    return hereOf(db, stored, 'session')
  }

  /** What the MCP door is handed: sessions, records, asking. */
  const places = {
    open: (client: string) => openSession(db, client),
    bind: recordFor,
    ask(session: string, project: Project): void {
      if (project.uid && markAsked(db, session, project.uid)) report(project)
    },
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
      return reply({ ok: true, token, doors, ...(modules ? { modules } : {}), ...(absent ? { absent } : {}), ...(everywhere ? { everywhere } : {}) })
    }

    if (url.pathname === '/host/place/answer' && request.method === 'POST') {
      const body = await bodyOf(request)
      const project = typeof body?.project === 'number' ? projectById(db, body.project) : null
      const session = sessionOf(db, typeof body?.session === 'string' ? body.session.replace(ASK_PREFIX, '') : null)
      if (!project || !project.uid || !session) return reply({ ok: false, error: 'No such ask.' }, 404)
      if (session.place) return reply({ ok: true, already: true })
      if (session.projectUid !== project.uid) return reply({ ok: false, error: 'That conversation asked in another project.' }, 409)
      const epic = body?.epic === null ? null : body?.epic
      if (epic !== null && (typeof epic !== 'string' || epic.length > 80 || readParts(project.path, epic) === null)) {
        return reply({ ok: false, error: 'That is not an epic of the project.' }, 400)
      }
      const parts = Array.isArray(body?.parts) && epic ? (body.parts as unknown[]).filter((one): one is string => typeof one === 'string') : []
      const has = new Set(epic ? (readParts(project.path, epic) ?? []).map((part) => part.id) : [])
      const kehikkoId = typeof body?.kehikko === 'number' ? body.kehikko : null
      const canvas = listCanvases(db).find((one) => one.id === kehikkoId && one.project === project.id) ?? null
      const here = recordFor(session.id, project, { epic, parts: parts.filter((one) => has.has(one)), kehikko: canvas?.key ?? null })
      return here ? reply({ ok: true }) : reply({ ok: false, error: 'The record could not be kept.' }, 500)
    }

    return null
  }

  return { route, places, report, resolve }
}
