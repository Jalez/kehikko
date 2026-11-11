import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  LIMITS,
  NOTES_MESSAGES_MOST,
  agentMessageSchema,
  messageToSchema,
  type AgentMessage,
  type MessageKind,
  type MessagePlace,
  type MessageTo,
} from 'kehikot-module-protocol'
import { tellDigest, TELL_EVERY_MS } from 'kehikot-module-protocol/serve'

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
 *
 * ## News to a place (protocol 2.75.0, `messages.tell`)
 *
 * A module's own news to every session at a place is kept once, as it came
 * (`tell = 1`, what the person's view lists), and never handed out as it is.
 * When a session there reads, it is handed its own copy (`copy_of`, `for_*`):
 * at most one from each module a minute (`LIMITS.TELLS_PER_MINUTE`). What came
 * since its last one waits for the minute's end, then goes as one digest
 * (`tellDigest`). Nothing is dropped: news older than `MESSAGES_UNREAD_MS`
 * is no longer unread, as any message.
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
  /** The parts of its epic it is at (protocol 2.75.0); none is the whole epic. */
  parts?: string[]
}

/**
 * Who sent a message, as the host stamps it. `session` is `''` for a message
 * that is no session's: a module's own (`messages.post`) or the person's
 * (`messages.say`, `person`), both protocol 2.50.0.
 */
export interface Sender extends SessionKey {
  name: string
  epic: string | null
  parts: string[]
  kehikko: string | null
  /** The person wrote it, through `module`'s page (2.50.0). Only `messageRoutes.ts` sets it, on the page's route. */
  person?: boolean
}

/** What a message may carry beside its body (protocol 2.50.0), as the params held it. */
export interface Extras {
  kind?: MessageKind
  choices?: string[]
  replyTo?: number
  /** A module's introduction: each session is handed at most one from the same module. */
  once?: boolean
  /**
   * The question from the Inbox this message answers (protocol 2.55.0, `answers`), when it was not a
   * message (`replyTo` says that). The host's fact, set only by the Inbox's answer (`inboxRoutes.ts`).
   */
  answers?: string
  /** Protocol 2.54.0: a module's notice to the one session that asked it, bounded per module and receiving session. */
  notice?: boolean
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
    create table if not exists agent_message_once (
      project     integer not null references projects(id) on delete cascade,
      from_module text    not null,
      module      text    not null,
      session     text    not null,
      message     integer not null,
      primary key (project, from_module, module, session)
    );
    create table if not exists agent_message_cursors (
      project integer not null references projects(id) on delete cascade,
      module  text    not null,
      session text    not null,
      last    integer not null,
      used    integer not null,
      primary key (project, module, session)
    );
  `)
  /* Protocol 2.50.0: what a message is, a question's choices, what it answers,
     the person's mark, an introduction, and the copy of one handed to a session. */
  const has = new Set(db.query<{ name: string }, []>('pragma table_info(agent_messages)').all().map((one) => one.name))
  const columns: [string, string][] = [
    ['kind', "text not null default 'note'"],
    ['choices', "text not null default '[]'"],
    ['reply_to', 'integer'],
    ['person', 'integer not null default 0'],
    ['once', 'integer not null default 0'],
    ['copy_of', 'integer'],
    /* Protocol 2.55.0: the Inbox question a person's answer answers. */
    ['answers', 'text'],
    /* Protocol 2.75.0: a module's news to a place, and the session one copy of it is for. */
    ['tell', 'integer not null default 0'],
    ['for_module', 'text'],
    ['for_session', 'text'],
  ]
  for (const [name, type] of columns) if (!has.has(name)) db.exec(`alter table agent_messages add column ${name} ${type}`)
  db.exec(`
    create table if not exists agent_message_tells (
      project     integer not null references projects(id) on delete cascade,
      from_module text    not null,
      module      text    not null,
      session     text    not null,
      last_id     integer not null,
      last_at     integer not null,
      primary key (project, from_module, module, session)
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
  kind: string
  choices: string
  reply_to: number | null
  person: number
  once: number
  copy_of: number | null
  answers: string | null
  tell: number
  for_module: string | null
  for_session: string | null
}

/**
 * Whether a session may be handed this row at all: anything but news to a
 * place, which a session is handed only as its own copy (protocol 2.75.0).
 */
const visibleTo = (row: Row, reader: SessionKey): boolean =>
  row.tell !== 1 || (row.copy_of !== null && row.for_module === reader.module && row.for_session === reader.session)

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
      session: row.from_session || null,
      place: { epic: place?.epic ?? null, parts: Array.isArray(place?.parts) ? place.parts : [], kehikko: place?.kehikko ?? null },
      person: row.person === 1,
    },
    to: parse(row.to_json),
    thread: row.thread,
    body: row.body,
    kind: row.kind,
    choices: parse(row.choices) ?? [],
    replyTo: row.reply_to,
    once: row.once === 1,
    answers: row.answers ?? null,
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
    /* Protocol 2.75.0: to some parts of the epic — a session at any of them, or at the whole epic. */
    const parts = reader.parts ?? []
    if (to.place.parts?.length && parts.length && !parts.some((part) => to.place!.parts!.includes(part))) return false
    return true
  }
  return false
}

const isOwn = (message: AgentMessage, reader: SessionKey): boolean => message.from.module === reader.module && message.from.session === reader.session

/** Whether a message is addressed to this one session. */
const toThisSession = (to: MessageTo, reader: SessionKey): boolean => to.session !== undefined && to.session.module === reader.module && to.session.session === reader.session

/** Body text as kept: line breaks made plain, other control characters gone. Its length was held by the protocol's params. */
export function keptBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
}

export const MESSAGES_SAY = {
  rate: (per: 'minute' | 'hour') =>
    `Too many messages from this session in the last ${per}: at most ${per === 'minute' ? LIMITS.MESSAGES_PER_MINUTE : LIMITS.MESSAGES_PER_HOUR}. Nothing was sent; send fewer, longer ones.`,
  noticeRate: (per: 'minute' | 'hour') =>
    `Too many notices from this module to that session in the last ${per}: at most ${per === 'minute' ? LIMITS.NOTICES_PER_MINUTE : LIMITS.NOTICES_PER_HOUR}. Nothing was sent; send fewer.`,
  tellRate: () => `Too much news from this module in the last hour: at most ${LIMITS.MESSAGES_PER_HOUR}. Nothing was sent; merge it into fewer messages.`,
  personRate: () => `Too many of your messages through this module in the last minute: at most ${LIMITS.PERSON_MESSAGES_PER_MINUTE}. Nothing was sent; wait a moment.`,
  empty: 'A message says something: the body was empty once its control characters were taken out. Nothing was sent.',
} as const

export class AgentMessages {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = () => Date.now(),
  ) {
    ensureAgentMessages(db)
  }

  /**
   * Keep one message, or say why not. `to` absent is the project. `extras`
   * (protocol 2.50.0) were held by the params already. The person's messages
   * (`from.person`) have their own bound; a session's, and a module's own, the
   * per-sender one.
   */
  send(project: number, from: Sender, body: string, to: MessageTo | undefined, thread: string | null, extras: Extras = {}): { ok: true; id: number } | { ok: false; why: string } {
    const now = this.clock()
    const person = from.person === true
    if (person) {
      const recent = this.db
        .query<{ n: number }, [number, string, number]>('select count(*) as n from agent_messages where project = ? and from_module = ? and person = 1 and at > ?')
        .get(project, from.module, now - 60_000)!.n
      if (recent >= LIMITS.PERSON_MESSAGES_PER_MINUTE) return { ok: false, why: MESSAGES_SAY.personRate() }
    } else if (extras.notice && from.session === '' && to?.session) {
      /* A module's notices are counted per receiving session: one busy session does not use up another's. */
      const target = JSON.stringify(messageToSchema.parse(to))
      const count = (since: number) =>
        this.db
          .query<{ n: number }, [number, string, string, number]>("select count(*) as n from agent_messages where project = ? and from_module = ? and from_session = '' and person = 0 and tell = 0 and copy_of is null and to_json = ? and at > ?")
          .get(project, from.module, target, since)!.n
      if (count(now - 60_000) >= LIMITS.NOTICES_PER_MINUTE) return { ok: false, why: MESSAGES_SAY.noticeRate('minute') }
      if (count(now - 3_600_000) >= LIMITS.NOTICES_PER_HOUR) return { ok: false, why: MESSAGES_SAY.noticeRate('hour') }
    } else {
      const count = (since: number) =>
        this.db
          .query<{ n: number }, [number, string, string, number]>('select count(*) as n from agent_messages where project = ? and from_module = ? and from_session = ? and person = 0 and tell = 0 and copy_of is null and at > ?')
          .get(project, from.module, from.session, since)!.n
      if (count(now - 60_000) >= LIMITS.MESSAGES_PER_MINUTE) return { ok: false, why: MESSAGES_SAY.rate('minute') }
      if (count(now - 3_600_000) >= LIMITS.MESSAGES_PER_HOUR) return { ok: false, why: MESSAGES_SAY.rate('hour') }
    }
    const text = keptBody(body)
    if (!text) return { ok: false, why: MESSAGES_SAY.empty }
    const target = messageToSchema.parse(to ?? { project: true })
    const choices = extras.kind === 'question' && extras.choices?.length ? extras.choices : []
    const id = this.insert(project, now, {
      module: from.module,
      name: from.name.slice(0, 80),
      session: person ? '' : from.session,
      place: JSON.stringify({ epic: from.epic, parts: from.parts.slice(0, LIMITS.PARTS), kehikko: from.kehikko }),
      to: JSON.stringify(target),
      thread,
      body: text,
      kind: extras.kind ?? 'note',
      choices: JSON.stringify(choices),
      replyTo: extras.replyTo ?? null,
      person,
      /* An introduction is a module's own, never a session's or the person's. */
      once: Boolean(extras.once) && !person && from.session === '',
      copyOf: null,
      /* What it answers is the person's alone: an answer from the Inbox, with no message to reply to. */
      answers: person && extras.answers && extras.replyTo === undefined ? extras.answers.slice(0, LIMITS.ACTIVITY_QUESTION) : null,
    })
    this.trim(project, now)
    return { ok: true, id }
  }

  /**
   * A module's own news to every session at a place (protocol 2.75.0,
   * `messages.tell`): kept once, as it came, stamped with no session and the
   * place as where it is from. Each session there is handed its own copy when
   * it reads (`handTells`), at most one from this module a minute.
   */
  tell(project: number, from: { module: string; name: string }, place: MessagePlace, body: string, extras: { kind?: 'note' | 'report'; thread?: string } = {}): { ok: true; id: number } | { ok: false; why: string } {
    const now = this.clock()
    const recent = this.db
      .query<{ n: number }, [number, string, number]>('select count(*) as n from agent_messages where project = ? and from_module = ? and tell = 1 and copy_of is null and at > ?')
      .get(project, from.module, now - 3_600_000)!.n
    if (recent >= LIMITS.MESSAGES_PER_HOUR) return { ok: false, why: MESSAGES_SAY.tellRate() }
    const text = keptBody(body)
    if (!text) return { ok: false, why: MESSAGES_SAY.empty }
    const target = messageToSchema.parse({ place })
    const id = this.insert(project, now, {
      module: from.module,
      name: from.name.slice(0, 80),
      session: '',
      place: JSON.stringify({ epic: place.epic ?? null, parts: (place.parts ?? []).slice(0, LIMITS.PARTS), kehikko: place.kehikko ?? null }),
      to: JSON.stringify(target),
      thread: extras.thread ?? null,
      body: text,
      kind: extras.kind ?? 'note',
      choices: '[]',
      replyTo: null,
      person: false,
      once: false,
      copyOf: null,
      tell: true,
    })
    this.trim(project, now)
    return { ok: true, id }
  }

  /**
   * Hand this reader the news it is due (protocol 2.75.0): per sending module,
   * the news to its place since the last it was handed, as ONE copy addressed
   * like the news — itself when it is one, a digest when it is more — and
   * only when a minute has passed since that module's last copy to it. Until
   * then it waits, and is handed at the minute's end, merged.
   */
  private handTells(project: number, reader: Reader): void {
    const fresh = this.clock() - LIMITS.MESSAGES_UNREAD_MS
    const rows = this.db
      .query<Row, [number, number]>('select * from agent_messages where project = ? and tell = 1 and copy_of is null and at >= ? order by id')
      .all(project, fresh)
    const byModule = new Map<string, Row[]>()
    for (const row of rows) {
      const message = toMessage(row)
      if (!message || !isFor(message.to, reader)) continue
      const list = byModule.get(row.from_module) ?? []
      list.push(row)
      byModule.set(row.from_module, list)
    }
    const now = this.clock()
    for (const [module, all] of byModule) {
      const mark = this.db
        .query<{ last_id: number; last_at: number }, [number, string, string, string]>('select last_id, last_at from agent_message_tells where project = ? and from_module = ? and module = ? and session = ?')
        .get(project, module, reader.module, reader.session)
      const due = all.filter((row) => row.id > (mark?.last_id ?? 0))
      const newest = due.at(-1)
      if (!newest) continue
      if (mark && now - mark.last_at < TELL_EVERY_MS) continue
      const threads = new Set(due.map((row) => row.thread))
      this.insert(project, now, {
        module,
        name: newest.from_name,
        session: '',
        place: newest.from_place,
        to: newest.to_json,
        thread: threads.size === 1 ? newest.thread : null,
        body: tellDigest(due.map((row) => row.body)),
        kind: due.some((row) => row.kind === 'report') ? 'report' : 'note',
        choices: '[]',
        replyTo: null,
        person: false,
        once: false,
        copyOf: newest.id,
        tell: true,
        for: reader,
      })
      this.db
        .query(
          `insert into agent_message_tells (project, from_module, module, session, last_id, last_at) values (?, ?, ?, ?, ?, ?)
           on conflict (project, from_module, module, session) do update set last_id = excluded.last_id, last_at = excluded.last_at`,
        )
        .run(project, module, reader.module, reader.session, newest.id, now)
    }
  }

  /** When news held for a session goes at the latest: a minute after the last copy any session was handed. */
  tellsDueBy(project: number, module: string): number | null {
    const last = this.db
      .query<{ at: number | null }, [number, string]>('select max(last_at) as at from agent_message_tells where project = ? and from_module = ?')
      .get(project, module)?.at
    return last === null || last === undefined ? null : last + TELL_EVERY_MS
  }

  private insert(
    project: number,
    at: number,
    row: { module: string; name: string; session: string; place: string; to: string; thread: string | null; body: string; kind: string; choices: string; replyTo: number | null; person: boolean; once: boolean; copyOf: number | null; answers?: string | null; tell?: boolean; for?: SessionKey },
  ): number {
    return this.db
      .query<{ id: number }, [number, number, string, string, string, string, string, string | null, string, string, string, number | null, number, number, number | null, string | null, number, string | null, string | null]>(
        `insert into agent_messages (project, at, from_module, from_name, from_session, from_place, to_json, thread, body, kind, choices, reply_to, person, once, copy_of, answers, tell, for_module, for_session)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      )
      .get(project, at, row.module, row.name, row.session, row.place, row.to, row.thread, row.body, row.kind, row.choices, row.replyTo, row.person ? 1 : 0, row.once ? 1 : 0, row.copyOf, row.answers ?? null, row.tell ? 1 : 0, row.for?.module ?? null, row.for?.session ?? null)!.id
  }

  /** The once-message from `from` that this reader was handed (its id), or null: at most one per sending module, ever. */
  private introduced(project: number, from: string, reader: SessionKey): number | null {
    return (
      this.db
        .query<{ message: number }, [number, string, string, string]>('select message from agent_message_once where project = ? and from_module = ? and module = ? and session = ?')
        .get(project, from, reader.module, reader.session)?.message ?? null
    )
  }

  /**
   * Hand this reader the introductions it is due (protocol 2.50.0, `once`): for
   * each module with a kept once-message for it (to it, its module, its place
   * now, or the project) and none handed to it yet, the earliest one. One
   * addressed to this session is recorded as it is; any other is copied to it,
   * addressed to it, as a new message, so it reads as new whatever its cursor
   * says and however old the original is. Recorded first: never twice.
   */
  private introduce(project: number, reader: Reader): void {
    const rows = this.db.query<Row, [number]>('select * from agent_messages where project = ? and once = 1 and copy_of is null order by id').all(project)
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.from_module)) continue
      const message = toMessage(row)
      if (!message || isOwn(message, reader) || !isFor(message.to, reader)) continue
      seen.add(row.from_module)
      if (this.introduced(project, row.from_module, reader) !== null) continue
      const id = toThisSession(message.to, reader)
        ? row.id
        : this.insert(project, this.clock(), {
          module: row.from_module,
          name: row.from_name,
          session: row.from_session,
          place: row.from_place,
          to: JSON.stringify({ session: { module: reader.module, session: reader.session } }),
          thread: row.thread,
          body: row.body,
          kind: row.kind,
          choices: row.choices,
          replyTo: row.reply_to,
          person: false,
          once: true,
          copyOf: row.id,
        })
      this.db
        .query('insert or ignore into agent_message_once (project, from_module, module, session, message) values (?, ?, ?, ?, ?)')
        .run(project, row.from_module, reader.module, reader.session, id)
    }
  }

  /** Whether this reader may be handed a message: anything but a once-message that is not the one it was introduced by. */
  private mayHand(project: number, message: AgentMessage, reader: SessionKey): boolean {
    return !message.once || this.introduced(project, message.from.module, reader) === message.id
  }

  /** The oldest go: past `MESSAGES_KEPT_MS`, then past `MESSAGES_KEPT` per project. */
  private trim(project: number, now: number): void {
    this.db.query('delete from agent_messages where project = ? and at < ?').run(project, now - LIMITS.MESSAGES_KEPT_MS)
    this.db
      .query('delete from agent_messages where project = ? and id not in (select id from agent_messages where project = ? order by id desc limit ?)')
      .run(project, project, LIMITS.MESSAGES_KEPT)
  }

  private rows(project: number, after: number, reader: SessionKey): AgentMessage[] {
    return this.db
      .query<Row, [number, number]>('select * from agent_messages where project = ? and id > ? order by id')
      .all(project, after)
      .flatMap((row) => (visibleTo(row, reader) ? (toMessage(row) ?? []) : []))
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

  /**
   * The reader's unread messages, oldest first: after its cursor, for it, not
   * its own, and not older than `MESSAGES_UNREAD_MS`. Its introductions are
   * handed first (`introduce`), so they are among them.
   */
  unread(project: number, reader: Reader): AgentMessage[] {
    this.introduce(project, reader)
    this.handTells(project, reader)
    const fresh = this.clock() - LIMITS.MESSAGES_UNREAD_MS
    return this.rows(project, this.cursor(project, reader), reader).filter(
      (one) => Date.parse(one.at) >= fresh && !isOwn(one, reader) && isFor(one.to, reader) && this.mayHand(project, one, reader),
    )
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
    const unread = this.unread(project, reader).length
    const mine = this.rows(project, ask.since ?? 0, reader).filter(
      (one) => (isOwn(one, reader) || (isFor(one.to, reader) && this.mayHand(project, one, reader))) && (ask.thread === undefined || one.thread === ask.thread),
    )
    const messages = ask.since === undefined ? mine.slice(-ask.limit) : mine.slice(0, ask.limit)
    return { messages, unread }
  }

  /**
   * What a module's page reads (protocol 2.50.0, `messages.mine`): the messages
   * addressed to the module (`to: { module }`) and the ones sent in its name —
   * its own and the person's through it — never a copy handed to a session.
   * Oldest first: after `since`, the first `limit`; otherwise the latest `limit`.
   * `more` is how many after the last one handed.
   */
  mine(project: number, module: string, ask: { since?: number; limit: number }): { messages: AgentMessage[]; more: number } {
    const all = this.db
      .query<Row, [number, number]>('select * from agent_messages where project = ? and id > ? and copy_of is null order by id')
      .all(project, ask.since ?? 0)
      .flatMap((row) => toMessage(row) ?? [])
      .filter((one) => one.to.module === module || (one.from.module === module && one.from.session === null))
    if (ask.since === undefined) return { messages: all.slice(-ask.limit), more: 0 }
    const messages = all.slice(0, ask.limit)
    return { messages, more: all.length - messages.length }
  }

  /** Every message of the project, newest first, for the person: they read all of them. */
  all(project: number, limit: number = LIMITS.MESSAGES_KEPT): AgentMessage[] {
    /* An introduction's copies are one message to the person: the original. */
    return this.db
      .query<Row, [number, number]>('select * from agent_messages where project = ? and copy_of is null order by id desc limit ?')
      .all(project, Math.max(0, Math.min(limit, LIMITS.MESSAGES_KEPT)))
      .flatMap((row) => toMessage(row) ?? [])
  }

  count(project: number): number {
    return this.db.query<{ n: number }, [number]>('select count(*) as n from agent_messages where project = ? and copy_of is null').get(project)!.n
  }

  /** The person clears the project's messages. Cursors stay, so nothing comes back as unread. */
  clear(project: number): number {
    return this.db.query('delete from agent_messages where project = ?').run(project).changes
  }
}
