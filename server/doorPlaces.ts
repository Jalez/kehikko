import { randomBytes } from 'node:crypto'
import type { Database } from 'bun:sqlite'

import { listCanvases, readSubject, type Canvas } from './canvases.ts'
import { projectById, type Project } from './projects.ts'

/**
 * Whose place is this conversation? (protocol 2.4.0, `PLACE_PARAM`)
 *
 * A person runs several agent sessions, each about its own epic, and switches
 * the epic on screen while they work. The door used to answer every session
 * about the open kehikko and the project's epic — what the person looked at
 * last — so a session working on "methods" was told about "results" the moment
 * the person looked there.
 *
 * ## Records, never guesses
 *
 * A conversation's place is what a RECORD says, and only that. Nothing here
 * takes a folder or the screen as a stand-in. There are two records, each with
 * one owner and its own key, so no two stores can disagree about one thing:
 *
 *  - **A conversation a module started** (Claude's, from a place): the module
 *    that keeps the conversation records owns them — `<project>/.kehikot/claude/places.json`
 *    for Claude — and hands the session a token on every Kehikot door's URL.
 *    The host keeps only where to ASK about a token (`door_tokens`: the token,
 *    the module that issued it, the project's id), never the place. A call
 *    with the token is answered from the module's record as it is NOW
 *    (`RECORDED_PLACE_PATH` on the module), so a conversation moved to another
 *    place, or carried on under a new id, is answered right.
 *  - **A connection nothing started** — an agent the person opened elsewhere.
 *    Claude Code does not tell an MCP server which conversation is calling
 *    (measured on 2.1.304: no header, no `initialize` field, and
 *    `${CLAUDE_CODE_SESSION_ID}` in a config is not expanded to the session's
 *    own id). What the door CAN know is the MCP session it handed out at
 *    `initialize` (`Mcp-Session-Id`). The record for one is the host's
 *    (`door_sessions`), and it is made only by an explicit act: `set_my_place`
 *    (the agent writing what the person told it) or the person's press on the
 *    Inbox's ask. A client that reconnects is a new MCP session with no record
 *    — said in `my_place`, and the re-ask is one press.
 *
 * ## What a token is, and is not
 *
 * A pointer, not a credential. It names one conversation's record and grants
 * nothing a call could not do by naming the same kehikko and epic in its
 * arguments — the door is open to every program on this machine already. It
 * is random so that two conversations never share one by accident.
 *
 * Both tables are in `frame.sqlite`, so a restarted host answers a running
 * session's next call as before. A project is kept by its id (`uid`, protocol
 * 2.1.0), so a renamed folder is followed. Nothing here is written into a
 * project.
 */

/** More tokens than conversations anybody keeps; the least recently used go first. */
const TOKENS_MAX = 4000
/** More MCP sessions than a machine holds open; the least recently used go first. */
const SESSIONS_MAX = 2000
/** How long an unrecorded session's ask stays in the Inbox without being asked again. */
export const ASK_MS = 12 * 60 * 60 * 1000

export const PLACE_TOKEN = /^[A-Za-z0-9_-]{22,64}$/
/** The query parameter, as the protocol (2.4.0) spells it: `PLACE_PARAM`. */
export const PLACE_PARAM = 'kehikot-place'
/** Where a module that keeps conversation records answers for a token (protocol 2.4.0, `RECORDED_PLACE_PATH`). */
export const RECORDED_PLACE_PATH = '/api/kehikot/place'
const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/
const SLUG = /^[a-z0-9-]{1,80}$/
const KEY = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/
const MODULE_ID = /^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/

export function ensureDoorPlaces(db: Database): void {
  db.exec(`
    create table if not exists door_tokens (
      token       text primary key,
      module      text not null,
      project_uid text not null,
      made        integer not null,
      used        integer not null
    );
    create table if not exists door_sessions (
      id          text primary key,
      client      text not null default '',
      place       text,
      asked       integer,
      project_uid text,
      made        integer not null,
      used        integer not null
    );
  `)
}

/** A place as a record says it: the project by id, the epic, the parts, the kehikko by key. */
export interface Recorded {
  projectUid: string
  epic: string | null
  parts: string[]
  kehikko: string | null
  /** The conversation the record is about, when the record names one (a module's: Claude Code's session id). */
  conversation?: string | null
}

export interface DoorSession {
  id: string
  client: string
  place: Recorded | null
  asked: number | null
  projectUid: string | null
}

const fresh = (bytes: number) => randomBytes(bytes).toString('base64url')

/** Whether a place read off a module or a body is spelled as one. */
export function wellFormed(place: { epic: unknown; parts: unknown; kehikko: unknown }): boolean {
  if (place.epic !== null && (typeof place.epic !== 'string' || !SLUG.test(place.epic))) return false
  if (!Array.isArray(place.parts) || place.parts.length > 128 || place.parts.some((one) => typeof one !== 'string' || !SLUG.test(one))) return false
  return place.kehikko === null || (typeof place.kehikko === 'string' && KEY.test(place.kehikko))
}

/** Where to ask about a token: the module that issued it, in a project. Kept again on every issue. */
export function issue(db: Database, token: string, module: string, projectUid: string, now = Date.now()): boolean {
  if (!PLACE_TOKEN.test(token) || !MODULE_ID.test(module) || !projectUid) return false
  db.query(
    `insert into door_tokens (token, module, project_uid, made, used) values (?, ?, ?, ?, ?)
     on conflict (token) do update set module = excluded.module, project_uid = excluded.project_uid, used = excluded.used`,
  ).run(token, module, projectUid, now, now)
  trim(db, 'door_tokens', 'token', TOKENS_MAX)
  return true
}

/** Who issued a token, or null. Touches it. */
export function issuerOf(db: Database, token: unknown, now = Date.now()): { token: string; module: string; projectUid: string } | null {
  if (typeof token !== 'string' || !PLACE_TOKEN.test(token)) return null
  const row = db.query<{ module: string; project_uid: string }, [string]>('select module, project_uid from door_tokens where token = ?').get(token)
  if (!row) return null
  db.query('update door_tokens set used = ? where token = ?').run(now, token)
  return { token, module: row.module, projectUid: row.project_uid }
}

function trim(db: Database, table: 'door_tokens' | 'door_sessions', key: string, max: number): void {
  const n = db.query<{ n: number }, []>(`select count(*) as n from ${table}`).get()!.n
  if (n <= max) return
  db.query(`delete from ${table} where ${key} in (select ${key} from ${table} order by used asc limit ?)`).run(n - max)
}

/** A new MCP session, given at `initialize`. `client` is what the client called itself, for the Inbox's sentence. */
export function openSession(db: Database, client: string, now = Date.now()): string {
  const id = fresh(24)
  db.query('insert into door_sessions (id, client, made, used) values (?, ?, ?, ?)').run(id, client.slice(0, 80), now, now)
  trim(db, 'door_sessions', 'id', SESSIONS_MAX)
  return id
}

function placeFrom(raw: string | null): Recorded | null {
  if (!raw) return null
  try {
    const read = JSON.parse(raw) as Recorded
    return read && typeof read.projectUid === 'string' && wellFormed(read) ? read : null
  } catch {
    return null
  }
}

export function sessionOf(db: Database, id: unknown, now = Date.now()): DoorSession | null {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) return null
  const row = db
    .query<{ id: string; client: string; place: string | null; asked: number | null; project_uid: string | null }, [string]>(
      'select id, client, place, asked, project_uid from door_sessions where id = ?',
    )
    .get(id)
  if (!row) return null
  db.query('update door_sessions set used = ? where id = ?').run(now, id)
  return { id: row.id, client: row.client, place: placeFrom(row.place), asked: row.asked, projectUid: row.project_uid }
}

/** Record an MCP session's place. The ask, if there was one, is answered. */
export function record(db: Database, id: string, place: Recorded): boolean {
  if (!wellFormed(place)) return false
  const parts = [...new Set(place.parts)].sort()
  return db.query('update door_sessions set place = ?, asked = null where id = ?').run(JSON.stringify({ ...place, parts }), id).changes > 0
}

/** Record that an unrecorded session asked which epic it is for, in a project. False when it already had. */
export function markAsked(db: Database, id: string, projectUid: string, now = Date.now()): boolean {
  const had = sessionOf(db, id, now)
  if (!had || had.place) return false
  if (had.asked !== null && had.projectUid === projectUid && now - had.asked < ASK_MS) return false
  db.query('update door_sessions set asked = ?, project_uid = ? where id = ?').run(now, projectUid, id)
  return true
}

/** The unrecorded sessions asking in a project, oldest first. */
export function askingIn(db: Database, projectUid: string, now = Date.now()): DoorSession[] {
  return db
    .query<{ id: string; client: string; asked: number; project_uid: string }, [string, number]>(
      'select id, client, asked, project_uid from door_sessions where project_uid = ? and place is null and asked is not null and asked > ? order by asked',
    )
    .all(projectUid, now - ASK_MS)
    .map((row) => ({ id: row.id, client: row.client, place: null, asked: row.asked, projectUid: row.project_uid }))
}

/** The project a uid names on this host, or null. */
export function projectByUid(db: Database, uid: string): Project | null {
  const row = db.query<{ id: number }, [string]>('select id from projects where uid = ?').get(uid)
  return row ? projectById(db, row.id) : null
}

/** A place, read against this host now. */
export interface Here {
  /** The token the call carried, or null for a recorded MCP session. */
  token: string | null
  /** Whose record it is: a module's (by token), or the host's record of this MCP session. */
  via: 'token' | 'session'
  /** The module that keeps the record, for `via: 'token'`. */
  module: string | null
  conversation: string | null
  project: Project
  epic: string | null
  parts: string[]
  /** The key the place was recorded with; `canvas` is null when no kehikko of the project has it any more. */
  key: string | null
  canvas: Canvas | null
}

/** A recorded place, as this host holds it now, or null when its project is not here any more. */
export function hereOf(db: Database, stored: Recorded, via: Here['via'], token: string | null = null, module: string | null = null): Here | null {
  const project = projectByUid(db, stored.projectUid)
  if (!project) return null
  const canvas = stored.kehikko === null ? null : (listCanvases(db).find((c) => c.project === project.id && c.key === stored.kehikko) ?? null)
  return { token, via, module, conversation: stored.conversation ?? null, project, epic: stored.epic, parts: [...stored.parts], key: stored.kehikko, canvas }
}

/** Asks the module that issued a token what its record says now. Null: no record, or the module did not answer. */
export type AskRecord = (module: string, token: string, project: Project) => Promise<Omit<Recorded, 'projectUid'> | null>

/** Why a call that carried a token has no place: said in the answer rather than guessed past. */
export interface Unrecorded {
  token: string
  module: string
  why: string
}

/**
 * The place a door call is in — the record its token names, or its MCP
 * session's — or null with, for a token that could not be read, why.
 */
export async function resolveHere(
  db: Database,
  token: unknown,
  session: unknown,
  ask: AskRecord,
): Promise<{ here: Here | null; unrecorded: Unrecorded | null }> {
  const issued = issuerOf(db, token)
  if (issued) {
    const project = projectByUid(db, issued.projectUid)
    if (!project) return { here: null, unrecorded: { token: issued.token, module: issued.module, why: 'its project is not on this host any more' } }
    const said = await ask(issued.module, issued.token, project).catch(() => null)
    if (!said) return { here: null, unrecorded: { token: issued.token, module: issued.module, why: `${issued.module} has no record for it, or did not answer` } }
    return { here: hereOf(db, { ...said, projectUid: issued.projectUid }, 'token', issued.token, issued.module), unrecorded: null }
  }
  const bound = sessionOf(db, session)
  if (bound?.place) return { here: hereOf(db, bound.place, 'session'), unrecorded: null }
  return { here: null, unrecorded: null }
}

/** What the person has on screen: the open kehikko, its project, and that project's epic and parts. */
export interface Looking {
  canvas: Canvas
  project: Project | null
  epic: string | null
  /** `'project'` when the person has "All epics" open: then `epic` is null and that is not "no epic". */
  scope: 'epic' | 'project'
  parts: string[]
}

export function lookingAt(db: Database, open: number | null): Looking | null {
  if (open === null) return null
  const canvas = listCanvases(db).find((c) => c.id === open)
  if (!canvas) return null
  const project = canvas.project === null ? null : projectById(db, canvas.project)
  const subject = canvas.project === null ? null : readSubject(db, canvas.project)
  return { canvas, project, epic: subject?.epic ?? null, scope: subject?.scope ?? 'epic', parts: subject?.parts ?? [] }
}

/** Whether the person is looking at exactly this place. */
export function sameAsLooking(here: Here, looking: Looking | null): boolean {
  if (!looking || looking.project?.id !== here.project.id) return false
  if (looking.epic !== here.epic) return false
  /* "All epics" is not a place a conversation can belong to, so it is never the same as one. */
  if (looking.scope === 'project') return false
  if (here.canvas && looking.canvas.id !== here.canvas.id) return false
  return [...looking.parts].sort().join('+') === [...here.parts].sort().join('+')
}

const placeWords = (
  epic: string | null,
  parts: readonly string[],
  kehikko: { name: string } | null,
  scope: 'epic' | 'project' = 'epic',
): string =>
  `${scope === 'project' ? 'all epics (scope: project)' : epic ? `epic ${epic}` : 'no epic'}${parts.length ? ` (parts ${parts.join(', ')})` : ''}${kehikko ? ` on kehikko "${kehikko.name}"` : ''}`

/** "This conversation belongs to …" — the protocol's `DOOR_PLACE_SAYS.belongs`, in the host's words for a project. */
export function belongsWords(here: Here): string {
  const lost = here.key && !here.canvas ? ` (its kehikko ${here.key} is not in the project any more)` : ''
  const whose = here.via === 'token' ? `as ${here.module ?? 'the module that started it'} records it` : 'as recorded for this connection'
  return `This conversation belongs to ${here.project.name} (${here.project.path}), ${placeWords(here.epic, here.parts, here.canvas)}${lost} — ${whose}.`
}

/** Whether the person is looking at it, and what they are on if not. */
export function lookingWords(here: Here | null, looking: Looking | null): string {
  if (!looking) return 'No page of Kehikot has a kehikko open, so the person is not looking at anything there now.'
  const where = `${looking.project && looking.project.id !== here?.project.id ? `${looking.project.name}, ` : ''}${placeWords(looking.epic, looking.parts, looking.canvas, looking.scope)}`
  if (!here) return `The person is looking at ${where}.`
  if (sameAsLooking(here, looking)) return 'The person is looking at this place now.'
  return `The person is looking at something else now (${where}); this conversation's place has not changed.`
}

/** The place as `GET /host/place` answers it: the protocol's `DoorPlace` (2.4.0). */
export function doorPlaceOf(here: Here, looking: Looking | null): Record<string, unknown> {
  const kehikko = (canvas: Canvas | null, key: string | null) => (key ? { key, ...(canvas ? { name: canvas.name } : {}) } : null)
  return {
    token: here.token,
    ...(here.conversation ? { conversation: here.conversation } : {}),
    projectId: here.project.uid,
    project: here.project.path,
    projectName: here.project.name,
    epic: here.epic,
    parts: here.parts,
    kehikko: kehikko(here.canvas, here.key),
    looking: looking
      ? {
          projectId: looking.project?.uid ?? null,
          project: looking.project?.path ?? null,
          epic: looking.epic,
          parts: looking.parts,
          kehikko: kehikko(looking.canvas, looking.canvas.key ?? null),
        }
      : null,
  }
}
