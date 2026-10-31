import {
  LIMITS,
  messageReadParams,
  messageReadResult,
  messageSendParams,
  messageSendResult,
  type AgentMessage,
} from 'kehikot-module-protocol'

import type { AgentMessages, Reader } from './agentMessages.ts'
import { sessionIdOf } from './agentMessages.ts'
import { issuerOf, type Here } from './doorPlaces.ts'
import type { Database } from 'bun:sqlite'

/**
 * Messages between agent sessions (protocol 2.41.0): who may send and read,
 * and the page's read-only view. The record is `agentMessages.ts`.
 *
 *  - `messages.send` / `messages.read`, from a module's SERVER through
 *    `/host/server-ask` (`serverAsk.ts` hands them here after the pass and the
 *    grant): the session is the one the call's `token` names, and it must be a
 *    token THIS module issued. The project is the token's — a call cannot name
 *    another, so sessions read and send within their own project only. The
 *    sender is stamped from the token's record: module, registered name,
 *    session, place.
 *  - `POST /host/place` with `messages: true` (`placeRoutes.ts`): the session's
 *    unread, handed for its notes and counted delivered (`forNotes`).
 *  - `GET  /host/messages?project=N[&limit=]` — every message of the project,
 *    newest first, for the person's view. A read, like `/host/inbox`.
 *  - `POST /host/messages/clear` — the person clears them. `PAGE_ONLY`. No MCP
 *    tool sees, deletes or clears; an agent reads only its own through its
 *    module.
 *
 * Nothing here acts on what a message says: no tool, no press, no wake but
 * "the messages changed, read them again".
 */

export interface MessageDeps {
  db: Database
  messages: AgentMessages
  /** The place behind a token, as its module's record says now (`placeDesk.resolve`). */
  resolve(token: string): Promise<{ here: Here | null }>
  /** A module's registered name, for the sender's by-line: the host names no module itself. */
  nameOf(module: string): string | null
  /** The project's messages changed: pages read them again. */
  changed(project: number): void
}

/** What a server question about messages came to: an answer, or a refusal of the project (another host may hold the token). */
export type MessageAsked =
  | { ok: true; data: unknown }
  | { ok: false; refused: 'project'; error: string }
  | { ok: false; reason: 'failed'; error: string }

export const MESSAGE_ROUTE_SAYS = {
  noSession: 'This host holds no session behind that token, so it keeps no messages for it.',
  notYours: 'That token was issued by another module: a module sends and reads only for the sessions it runs. Nothing was done.',
  noPlace: 'The module that issued that token has no record of its session just now, so there is no sender to stamp. Nothing was done.',
  page: 'Messages are an agent session’s, sent and read by the module that runs it through its server (askHost). A page has no session.',
} as const

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const clip = (text: string): string => (text.length > LIMITS.REASON ? `${text.slice(0, LIMITS.REASON - 1)}…` : text)

/** The session a resolved place is, as a reader. */
export function readerOf(here: Here, token: string): Reader {
  return { module: here.module ?? '', session: sessionIdOf(here.conversation, token), epic: here.epic, kehikko: here.key }
}

export function messageDesk(deps: MessageDeps) {
  const { messages, db } = deps

  /** The session behind a token this module issued, or why not. */
  async function sessionFor(module: string, token: string): Promise<{ here: Here } | MessageAsked> {
    const issued = issuerOf(db, token)
    if (!issued) return { ok: false, refused: 'project', error: MESSAGE_ROUTE_SAYS.noSession }
    if (issued.module !== module) return { ok: false, reason: 'failed', error: MESSAGE_ROUTE_SAYS.notYours }
    const { here } = await deps.resolve(token).catch(() => ({ here: null }))
    if (!here || here.via !== 'token') return { ok: false, reason: 'failed', error: MESSAGE_ROUTE_SAYS.noPlace }
    return { here }
  }

  /** `messages.send` or `messages.read`, from a module's server whose pass and grant were held already. */
  async function serverAnswer(module: string, method: string, params: unknown): Promise<MessageAsked> {
    if (method === 'messages.send') {
      const asked = messageSendParams.safeParse(params ?? {})
      if (!asked.success) return { ok: false, reason: 'failed', error: clip(`messages.send: ${asked.error.issues[0]?.path.join('.') || 'params'} — ${asked.error.issues[0]?.message ?? 'malformed'}.`) }
      const found = await sessionFor(module, asked.data.token)
      if (!('here' in found)) return found
      const { here } = found
      const sent = messages.send(
        here.project.id,
        {
          module,
          session: sessionIdOf(here.conversation, asked.data.token),
          name: deps.nameOf(module) ?? module,
          epic: here.epic,
          parts: here.parts,
          kehikko: here.key,
        },
        asked.data.body,
        asked.data.to,
        asked.data.thread ?? null,
      )
      if (sent.ok) deps.changed(here.project.id)
      return { ok: true, data: messageSendResult.parse(sent.ok ? { outcome: 'sent', id: sent.id } : { outcome: 'declined', why: sent.why }) }
    }
    const asked = messageReadParams.safeParse(params ?? {})
    if (!asked.success) return { ok: false, reason: 'failed', error: clip(`messages.read: ${asked.error.issues[0]?.path.join('.') || 'params'} — ${asked.error.issues[0]?.message ?? 'malformed'}.`) }
    const found = await sessionFor(module, asked.data.token)
    if (!('here' in found)) return found
    const reader = readerOf(found.here, asked.data.token)
    const read = messages.read(found.here.project.id, reader, {
      unread: asked.data.unread,
      limit: asked.data.limit,
      ...(asked.data.since !== undefined ? { since: asked.data.since } : {}),
      ...(asked.data.thread !== undefined ? { thread: asked.data.thread } : {}),
    })
    return {
      ok: true,
      data: messageReadResult.parse({
        ...read,
        you: { module, session: reader.session, place: { epic: found.here.epic, parts: found.here.parts, kehikko: found.here.key } },
      }),
    }
  }

  /**
   * The unread messages for a session's notes, counted delivered (`POST /host/place`
   * with `messages: true`). Empty, not absent, when there are none or no record:
   * present says this host keeps messages.
   */
  function forNotes(here: Here | null, token: string): { messages: AgentMessage[]; messagesMore: number } {
    if (!here || here.via !== 'token' || !here.module) return { messages: [], messagesMore: 0 }
    const out = messages.deliver(here.project.id, readerOf(here, token))
    return { messages: out.messages, messagesMore: out.more }
  }

  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/host/messages' && request.method === 'GET') {
      const project = Number(url.searchParams.get('project'))
      if (!Number.isInteger(project) || project <= 0) return reply({ ok: false, error: 'project is a project’s number.' }, 400)
      const limit = Number(url.searchParams.get('limit') ?? LIMITS.MESSAGES_KEPT)
      const all = Number.isInteger(limit) && limit >= 0 ? messages.all(project, limit) : messages.all(project)
      return reply({ ok: true, count: messages.count(project), messages: all })
    }
    if (url.pathname === '/host/messages/clear' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { project?: unknown } | null
      const project = body?.project
      if (typeof project !== 'number' || !Number.isInteger(project) || project <= 0) return reply({ ok: false, error: 'project is a project’s number.' }, 400)
      const cleared = messages.clear(project)
      deps.changed(project)
      return reply({ ok: true, cleared })
    }
    return null
  }

  return { serverAnswer, forNotes, route }
}
