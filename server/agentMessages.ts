import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  LIMITS,
  NOTES_MESSAGES_MOST,
  agentMessageSchema,
  messageToSchema,
  type AgentMessage,
  type MessageTo,
} from 'kehikot-module-protocol'

/**
 * Messages between agent sessions (protocol 2.41.0, `agents:message`): the one
 * record, on this machine and not in the project.
 *
 * ## Where it lives, and why there
 *
 * In the host's own database (`frame.sqlite`), per project id, beside the
 * Inbox — never in `<project>/.kehikot/`. A session (its id, its place token,
 * its process) is a fact about THIS machine: a message addressed to one means
 * nothing on a teammate's computer, and a file in the repository would be a way
 * in — a pulled branch could carry lines that read as if another agent wrote
 * them, straight into every session's notes. The host is the only writer; no
 * module keeps a copy. The rows go with the project (`on delete cascade`).
 *
 * ## What it holds
 *
 * `agent_messages`: one row per message, its sender stamped by the host (the
 * module that asked, proved by its pass; its registered name; the session its
 * token names; that session's place) and who it is for (`messageToSchema`).
 * `agent_message_cursors`: per recipient session, the id of the last message
 * handed to it — what "unread" is measured from.
 *
 * Bounded: `LIMITS.MESSAGES_KEPT` per project and `LIMITS.MESSAGES_KEPT_MS`;
 * a session sends at most `MESSAGES_PER_MINUTE` and `MESSAGES_PER_HOUR`.
 */

/** A session as this record knows it: the module that runs it and its id there. */
export interface SessionKey {
  module: string
  session: string
}

/** A session that reads: who it is, and where it is now (a place is matched when it reads). */
export interface Reader extends SessionKey {
  epic: string | null
  kehikko: string | null
}

/** Who sent a message, as the host stamps it. */
export interface Sender extends SessionKey {
  name: string
  epic: string | null
  parts: string[]
  kehikko: string | null
}

/** One message as the person's view lists it: the protocol's shape. */
export type MessageRow = AgentMessage

/**
 * The id a session goes by: the conversation its module's record names, else a
 * digest of its token. Never the token itself — a token is that session's
 * pointer, and is not handed to other agents.
 */
export function sessionIdOf(conversation: string | null | undefined, token: string): string {
  if (conversation) return conversation.slice(0, LIMITS.SHOW_ID)
  return `t-${createHash('sha256').update(token).digest('base64url').slice(0, 16)}`
}

export function ensureAgentMessages(db: Database): void {
  db.exec(`
    create table if not exists agent_messages (
      id           integer primary key autoincrement,
      project      integer not null references projects(id) on delete cascade,
      at           integer not null,
      from_module  text    not null,
      from_name    text    not null default '',
      from_session text    not null,
      from_place   text    not null,
      to_json      text    not null,
      thread       text,
      body         text    not null
    );
    create index if not exists agent_messages_project on agent_messages (project, id);
    create table if not exists agent_message_cursors (
      project integer not null references projects(id) on delete cascade,
      module  text    not null,
      session text    not null,
      last    integer not null,
      used    integer not null,
      primary key (project, module, session)
    );
  `)
}

interface Row {
  id: number
  at: number
  from_module: string
  from_name: string
  from_session: string
  from_place: string
  to_json: string
  thread: string | null
  body: string
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function toMessage(row: Row): AgentMessage | null {
  const place = parse(row.from_place) as { epic?: unknown; parts?: unknown; kehikko?: unknown } | null
  const read = agentMessageSchema.safeParse({
    id: row.id,
    at: new Date(row.at).toISOString(),
    from: {
      module: row.from_module,
      name: row.from_name,
      session: row.from_session,
      place: { epic: place?.epic ?? null, parts: Array.isArray(place?.parts) ? place.parts : [], kehikko: place?.kehikko ?? null },
    },
    to: parse(row.to_json),
    thread: row.thread,
    body: row.body,
  })
  return read.success ? read.data : null
}

/** Whether a message is for this reader: to it, its module, its place as it is now, or the project. */
export function isFor(to: MessageTo, reader: Reader): boolean {
  if (to.project) return true
  if (to.module) return to.module === reader.module
  if (to.session) return to.session.module === reader.module && to.session.session === reader.session
  if (to.place) {
    if (to.place.epic !== undefined && to.place.epic !== reader.epic) return false
    if (to.place.kehikko !== undefined && to.place.kehikko !== reader.kehikko) return false
    return true
  }
  return false
}

const isOwn = (message: AgentMessage, reader: SessionKey): boolean => message.from.module === reader.module && message.from.session === reader.session

/** Body text as kept: line breaks made plain, other control characters gone. Its length was held by the protocol's params. */
export function keptBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
}

export const MESSAGES_SAY = {
  rate: (per: 'minute' | 'hour') =>
    `Too many messages from this session in the last ${per}: at most ${per === 'minute' ? LIMITS.MESSAGES_PER_MINUTE : LIMITS.MESSAGES_PER_HOUR}. Nothing was sent; send fewer, longer ones.`,
  empty: 'A message says something: the body was empty once its control characters were taken out. Nothing was sent.',
} as const

export class AgentMessages {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = () => Date.now(),
  ) {
    ensureAgentMessages(db)
  }

  /** Keep one message, or say why not. `to` absent is the project. */
  send(project: number, from: Sender, body: string, to: MessageTo | undefined, thread: string | null): { ok: true; id: number } | { ok: false; why: string } {
    const now = this.clock()
    const count = (since: number) =>
      this.db
        .query<{ n: number }, [number, string, string, number]>('select count(*) as n from agent_messages where project = ? and from_module = ? and from_session = ? and at > ?')
        .get(project, from.module, from.session, since)!.n
    if (count(now - 60_000) >= LIMITS.MESSAGES_PER_MINUTE) return { ok: false, why: MESSAGES_SAY.rate('minute') }
    if (count(now - 3_600_000) >= LIMITS.MESSAGES_PER_HOUR) return { ok: false, why: MESSAGES_SAY.rate('hour') }
    const text = keptBody(body)
    if (!text) return { ok: false, why: MESSAGES_SAY.empty }
    const target = messageToSchema.parse(to ?? { project: true })
    const row = this.db
      .query<{ id: number }, [number, number, string, string, string, string, string, string | null, string]>(
        `insert into agent_messages (project, at, from_module, from_name, from_session, from_place, to_json, thread, body)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      )
      .get(
        project,
        now,
        from.module,
        from.name.slice(0, 80),
        from.session,
        JSON.stringify({ epic: from.epic, parts: from.parts.slice(0, LIMITS.PARTS), kehikko: from.kehikko }),
        JSON.stringify(target),
        thread,
        text,
      )!
    this.trim(project, now)
    return { ok: true, id: row.id }
  }

  /** The oldest go: past `MESSAGES_KEPT_MS`, then past `MESSAGES_KEPT` per project. */
  private trim(project: number, now: number): void {
    this.db.query('delete from agent_messages where project = ? and at < ?').run(project, now - LIMITS.MESSAGES_KEPT_MS)
    this.db
      .query('delete from agent_messages where project = ? and id not in (select id from agent_messages where project = ? order by id desc limit ?)')
      .run(project, project, LIMITS.MESSAGES_KEPT)
  }

  private rows(project: number, after = 0): AgentMessage[] {
    return this.db
      .query<Row, [number, number]>('select * from agent_messages where project = ? and id > ? order by id')
      .all(project, after)
      .flatMap((row) => toMessage(row) ?? [])
  }

  private cursor(project: number, reader: SessionKey): number {
    return (
      this.db
        .query<{ last: number }, [number, string, string]>('select last from agent_message_cursors where project = ? and module = ? and session = ?')
        .get(project, reader.module, reader.session)?.last ?? 0
    )
  }

  private moveCursor(project: number, reader: SessionKey, last: number): void {
    this.db
      .query(
        `insert into agent_message_cursors (project, module, session, last, used) values (?, ?, ?, ?, ?)
         on conflict (project, module, session) do update set last = max(last, excluded.last), used = excluded.used`,
      )
      .run(project, reader.module, reader.session, last, this.clock())
  }

  /** The reader's unread messages, oldest first: after its cursor, for it, not its own, and not older than `MESSAGES_UNREAD_MS`. */
  unread(project: number, reader: Reader): AgentMessage[] {
    const fresh = this.clock() - LIMITS.MESSAGES_UNREAD_MS
    return this.rows(project, this.cursor(project, reader)).filter((one) => Date.parse(one.at) >= fresh && !isOwn(one, reader) && isFor(one.to, reader))
  }

  /**
   * Hand the reader at most `most` unread messages and count them delivered:
   * the cursor moves past the last one handed. `more` is how many still wait.
   */
  deliver(project: number, reader: Reader, most: number = NOTES_MESSAGES_MOST): { messages: AgentMessage[]; more: number } {
    const all = this.unread(project, reader)
    const messages = all.slice(0, most)
    const last = messages.at(-1)
    if (last) this.moveCursor(project, reader, last.id)
    return { messages, more: all.length - messages.length }
  }

  /**
   * What a session may read: addressed to it (as `isFor` says) or sent by it.
   * After `since` when given, else the latest `limit`; oldest first; optionally
   * one thread. `unread` is `deliver` with the filters.
   */
  read(project: number, reader: Reader, ask: { unread: boolean; since?: number; thread?: string; limit: number }): { messages: AgentMessage[]; unread: number } {
    if (ask.unread) {
      const all = this.unread(project, reader).filter((one) => (ask.since === undefined || one.id > ask.since) && (ask.thread === undefined || one.thread === ask.thread))
      const messages = all.slice(0, ask.limit)
      const last = messages.at(-1)
      if (last) this.moveCursor(project, reader, last.id)
      return { messages, unread: this.unread(project, reader).length }
    }
    const mine = this.rows(project, ask.since ?? 0).filter((one) => (isOwn(one, reader) || isFor(one.to, reader)) && (ask.thread === undefined || one.thread === ask.thread))
    const messages = ask.since === undefined ? mine.slice(-ask.limit) : mine.slice(0, ask.limit)
    return { messages, unread: this.unread(project, reader).length }
  }

  /** Every message of the project, newest first, for the person: they read all of them. */
  all(project: number, limit: number = LIMITS.MESSAGES_KEPT): AgentMessage[] {
    return this.db
      .query<Row, [number, number]>('select * from agent_messages where project = ? order by id desc limit ?')
      .all(project, Math.max(0, Math.min(limit, LIMITS.MESSAGES_KEPT)))
      .flatMap((row) => toMessage(row) ?? [])
  }

  count(project: number): number {
    return this.db.query<{ n: number }, [number]>('select count(*) as n from agent_messages where project = ?').get(project)!.n
  }

  /** The person clears the project's messages. Cursors stay, so nothing comes back as unread. */
  clear(project: number): number {
    return this.db.query('delete from agent_messages where project = ?').run(project).changes
  }
}
