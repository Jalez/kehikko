import {
  LIMITS,
  messageMineParams,
  messageMineResult,
  messageNotifyParams,
  messageNotifySessionParams,
  messagePostParams,
  messageSayParams,
  messageReadParams,
  messageReadResult,
  messageSendParams,
  messageSendResult,
  messageTellParams,
  type AgentMessage,
} from 'kehikot-module-protocol'
import { TELL_EVERY_MS } from 'kehikot-module-protocol/serve'

import type { AgentMessages, Extras, Reader } from './agentMessages.ts'
import { sessionIdOf } from './agentMessages.ts'
import { issuerOf, type Here } from './doorPlaces.ts'
import type { Database } from 'bun:sqlite'
import { MessageMutes, MUTED_SAYS } from './messageMutes.ts'
import { TRACKER_NEWS_FROM } from '../src/host/trackerNews.ts'

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
 *  - `messages.notify` (protocol 2.54.0), from a module's SERVER: its own
 *    notice to the one session whose token came with its request — any
 *    module's token, since a session hands it to every door it calls. Sent to
 *    that session only, stamped with no session and the asker's place.
 *  - `messages.tell` (protocol 2.75.0), from a module's SERVER naming its
 *    project: its own news to every session at a place (an epic, some of its
 *    parts, a kehikko), stamped with no session and that place. Each session
 *    there is handed at most one from the module a minute; what comes faster
 *    is merged into one digest at the minute's end (`agentMessages.ts`).
 *  - `messages.notifySession` (protocol 2.81.0), from a module's SERVER under
 *    `sessions:observe`: its own notice to one session named by its own id,
 *    found among the sessions this host has seen lately through their tokens
 *    (`saw`); one it does not know is declined. Then as `notify`.
 *  - `POST /host/place` with `messages: true` (`placeRoutes.ts`): the session's
 *    unread, handed for its notes and counted delivered (`forNotes`).
 *  - `GET  /host/messages?project=N[&limit=]` — every message of the project,
 *    newest first, for the person's view. A read, like `/host/inbox`.
 *  - `POST /host/messages/clear` — the person clears them. `PAGE_ONLY`. No MCP
 *    tool sees, deletes or clears; an agent reads only its own through its
 *    module.
 *  - `POST /host/messages/mute` — the person's "Messages to agents" switch for
 *    one module in one project (`messageMutes.ts`). `PAGE_ONLY`; no MCP tool
 *    mutes or unmutes. A muted module's OWN messages (`notify`, `tell`, a
 *    page's `post`) are declined with `MUTED_SAYS`, kept nowhere and wake nothing; the
 *    person's (`say`) and a session's (`send`) are never muted.
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
  /** Whether a project with this id is held here (2.50.0: a page names one by id). */
  hasProject?(project: number): boolean
  /** Whether a module is registered here (the last sweep's callers). */
  known?(module: string): boolean
  /** Whether its manifest, as the last sweep read it, asks for the capability. */
  may?(module: string, capability: string): boolean
  /** Whether the person allowed this module to send as them, as this host saw it (`personGrants.ts`). */
  granted?(module: string): boolean
  /** The id of the project held at a folder `/host/server-ask` already found (2.75.0, `messages.tell`). */
  projectIdAt?(root: string): number | null
  /** Injected by tests: the timer that says the messages changed when held news is due. */
  setTimer?(run: () => void, ms: number): unknown
}

/** What a message's params carry beside the body (protocol 2.50.0). */
const extrasOf = (data: { kind?: Extras['kind']; choices?: string[]; replyTo?: number; once?: boolean }): Extras => ({
  ...(data.kind !== undefined ? { kind: data.kind } : {}),
  ...(data.choices !== undefined ? { choices: data.choices } : {}),
  ...(data.replyTo !== undefined ? { replyTo: data.replyTo } : {}),
  ...(data.once !== undefined ? { once: data.once } : {}),
})

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
  noProject: 'This call is standing in no project this host holds, so there are no messages to read or send.',
  module: 'This host has no module registered under that id.',
  notAsked: (capability: string) => `This module’s manifest does not ask for ${capability} (declares.uses), so this host does not send it.`,
  notAllowed: 'The person has not allowed this module to send messages as them: they turn it on in its settings, in this host. Nothing was sent.',
  noPress: 'A message as the person goes only on their press in this module, and none came with it. Nothing was sent.',
  unknownSession: 'This host has not seen an agent session by that id lately: no module that runs agent sessions has filed it. Nothing was sent.',
} as const

/** How many sessions the host remembers by id for `messages.notifySession`; the least recently seen go first. */
const SESSIONS_SEEN_MAX = 2000

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const clip = (text: string): string => (text.length > LIMITS.REASON ? `${text.slice(0, LIMITS.REASON - 1)}…` : text)

/** The session a resolved place is, as a reader. */
export function readerOf(here: Here, token: string): Reader {
  return { module: here.module ?? '', session: sessionIdOf(here.conversation, token), epic: here.epic, kehikko: here.key, parts: here.parts }
}

export function messageDesk(deps: MessageDeps) {
  const { messages, db } = deps
  const mutes = new MessageMutes(db)
  /** A muted module's own message, declined: nothing kept, nothing woken. */
  const muted = (): { ok: true; data: unknown } => ({ ok: true, data: messageSendResult.parse({ outcome: 'declined', why: MUTED_SAYS }) })

  /**
   * The sessions seen lately, by their own id (protocol 2.81.0): the token each last came with. Filled
   * when a session's place is resolved here — its notes at every prompt, its messages — and only for a
   * session its module's record names (a conversation id, not a digest of the token). In memory: a
   * restarted host learns them again at each session's next prompt.
   */
  const seenSessions = new Map<string, string>()
  function saw(here: Here | null, token: string): void {
    if (!here || here.via !== 'token' || !here.module || !here.conversation) return
    const id = sessionIdOf(here.conversation, token)
    seenSessions.delete(id)
    seenSessions.set(id, token)
    if (seenSessions.size > SESSIONS_SEEN_MAX) seenSessions.delete(seenSessions.keys().next().value as string)
  }

  /** The session behind a token this module issued, or why not. */
  async function sessionFor(module: string, token: string): Promise<{ here: Here } | MessageAsked> {
    const issued = issuerOf(db, token)
    if (!issued) return { ok: false, refused: 'project', error: MESSAGE_ROUTE_SAYS.noSession }
    if (issued.module !== module) return { ok: false, reason: 'failed', error: MESSAGE_ROUTE_SAYS.notYours }
    const { here } = await deps.resolve(token).catch(() => ({ here: null }))
    if (!here || here.via !== 'token') return { ok: false, reason: 'failed', error: MESSAGE_ROUTE_SAYS.noPlace }
    saw(here, token)
    return { here }
  }

  /**
   * `messages.notify` (protocol 2.54.0): a module's own notice to the ONE
   * session whose token came with its request. The token may be any module's:
   * a session hands its token to every door it calls, so a module holds only
   * the tokens of sessions that called it. The notice goes to that session
   * alone, in the token's project, stamped as the asking module's with no
   * session and the asker's place; the module that runs the session delivers
   * it as any message.
   */
  async function notify(module: string, params: unknown): Promise<MessageAsked> {
    const asked = messageNotifyParams.safeParse(params ?? {})
    if (!asked.success) return { ok: false, reason: 'failed', error: clip(`messages.notify: ${asked.error.issues[0]?.path.join('.') || 'params'} — ${asked.error.issues[0]?.message ?? 'malformed'}.`) }
    const { token } = asked.data
    if (!issuerOf(db, token)) return { ok: false, refused: 'project', error: MESSAGE_ROUTE_SAYS.noSession }
    const { here } = await deps.resolve(token).catch(() => ({ here: null }))
    if (!here || here.via !== 'token' || !here.module) return { ok: false, reason: 'failed', error: MESSAGE_ROUTE_SAYS.noPlace }
    saw(here, token)
    if (mutes.has(here.project.id, module)) return muted()
    const to = { session: { module: here.module, session: sessionIdOf(here.conversation, token) } }
    const sent = messages.send(
      here.project.id,
      { module, session: '', name: deps.nameOf(module) ?? module, epic: here.epic, parts: here.parts, kehikko: here.key },
      asked.data.body,
      to,
      asked.data.thread ?? null,
      { ...(asked.data.kind !== undefined ? { kind: asked.data.kind } : {}), notice: true },
    )
    if (sent.ok) deps.changed(here.project.id)
    return { ok: true, data: messageSendResult.parse(sent.ok ? { outcome: 'sent', id: sent.id } : { outcome: 'declined', why: sent.why }) }
  }

  /**
   * `messages.notifySession` (protocol 2.81.0): a module's own notice to ONE
   * session it was never called by, named by the session's own id — a module
   * that watches this computer's processes read it there. The host finds the
   * session among those it has seen lately (`saw`), checks its module's record
   * still names that id, and sends it there as `notify` does: in that session's
   * project, stamped with no session and that session's place, declined while
   * the person muted the module there. A session it does not know is declined,
   * never guessed. Held to `sessions:observe` by `/host/server-ask`; the module
   * asks for `agents:message` too.
   */
  async function notifySession(module: string, params: unknown): Promise<MessageAsked> {
    const asked = messageNotifySessionParams.safeParse(params ?? {})
    if (!asked.success) return { ok: false, reason: 'failed', error: clip(`messages.notifySession: ${asked.error.issues[0]?.path.join('.') || 'params'} — ${asked.error.issues[0]?.message ?? 'malformed'}.`) }
    const declined = (why: string): MessageAsked => ({ ok: true, data: messageSendResult.parse({ outcome: 'declined', why }) })
    if (!(deps.may?.(module, 'agents:message') ?? false)) return declined(MESSAGE_ROUTE_SAYS.notAsked('agents:message'))
    const id = asked.data.session
    const token = seenSessions.get(id)
    if (!token) return declined(MESSAGE_ROUTE_SAYS.unknownSession)
    const { here } = await deps.resolve(token).catch(() => ({ here: null }))
    if (!here || here.via !== 'token' || !here.module || !here.conversation || sessionIdOf(here.conversation, token) !== id) {
      seenSessions.delete(id)
      return declined(MESSAGE_ROUTE_SAYS.unknownSession)
    }
    if (mutes.has(here.project.id, module)) return muted()
    const sent = messages.send(
      here.project.id,
      { module, session: '', name: deps.nameOf(module) ?? module, epic: here.epic, parts: here.parts, kehikko: here.key },
      asked.data.body,
      { session: { module: here.module, session: id } },
      asked.data.thread ?? null,
      { ...(asked.data.kind !== undefined ? { kind: asked.data.kind } : {}), notice: true, observed: true },
    )
    if (sent.ok) deps.changed(here.project.id)
    return { ok: true, data: messageSendResult.parse(sent.ok ? { outcome: 'sent', id: sent.id } : { outcome: 'declined', why: sent.why }) }
  }

  /** One wake per project and module at the minute's end, so the sessions read again and are handed what was held. */
  const wakes = new Set<string>()
  function wakeWhenDue(project: number, module: string): void {
    const key = `${project}\n${module}`
    if (wakes.has(key)) return
    wakes.add(key)
    const timer = (deps.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => {
      wakes.delete(key)
      deps.changed(project)
    }, TELL_EVERY_MS + 1_000)
    ;(timer as { unref?: () => void } | null)?.unref?.()
  }

  /**
   * `messages.tell` (protocol 2.75.0): a module's own news to every session at
   * a place in the project its question named (`root`, found by
   * `/host/server-ask`). Kept once; each session is handed its copy when it
   * reads, at most one from this module a minute, the rest merged.
   */
  function tell(module: string, params: unknown, root: string | null): MessageAsked {
    const asked = messageTellParams.safeParse(params ?? {})
    if (!asked.success) return { ok: false, reason: 'failed', error: clip(`messages.tell: ${asked.error.issues[0]?.path.join('.') || 'params'} — ${asked.error.issues[0]?.message ?? 'malformed'}.`) }
    const project = root === null ? null : (deps.projectIdAt?.(root) ?? null)
    if (project === null) return { ok: false, refused: 'project', error: MESSAGE_ROUTE_SAYS.noProject }
    if (mutes.has(project, module)) return muted()
    const sent = messages.tell(project, { module, name: deps.nameOf(module) ?? module }, asked.data.to.place, asked.data.body, {
      ...(asked.data.kind !== undefined ? { kind: asked.data.kind } : {}),
      ...(asked.data.thread !== undefined ? { thread: asked.data.thread } : {}),
    })
    if (sent.ok) {
      deps.changed(project)
      wakeWhenDue(project, module)
    }
    return { ok: true, data: messageSendResult.parse(sent.ok ? { outcome: 'sent', id: sent.id } : { outcome: 'declined', why: sent.why }) }
  }

  /**
   * Tracker news to agents (`src/host/trackerNews.ts`): the host's OWN news to
   * every session at a place, through the same record and bounds as
   * `messages.tell` — one copy a minute per session, the rest merged, the
   * hourly cap, the wake — stamped `TRACKER_NEWS_FROM`. Muted with the
   * "Messages to agents" switch under that id: then nothing is kept or woken.
   */
  function hostTell(project: number, place: { epic: string; parts?: string[] }, body: string): { ok: true; id: number } | { ok: false; why: string } {
    if (mutes.has(project, TRACKER_NEWS_FROM.module)) return { ok: false, why: MUTED_SAYS }
    const sent = messages.tell(project, { ...TRACKER_NEWS_FROM }, place, body, { kind: 'report' })
    if (sent.ok) {
      deps.changed(project)
      wakeWhenDue(project, TRACKER_NEWS_FROM.module)
    }
    return sent
  }

  /** `messages.send`, `messages.read`, `messages.notify` or `messages.tell`, from a module's server whose pass and grant were held already. */
  async function serverAnswer(module: string, method: string, params: unknown, root: string | null = null): Promise<MessageAsked> {
    if (method === 'messages.notify') return notify(module, params)
    if (method === 'messages.notifySession') return notifySession(module, params)
    if (method === 'messages.tell') return tell(module, params, root)
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
        extrasOf(asked.data),
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
    saw(here, token)
    const out = messages.deliver(here.project.id, readerOf(here, token))
    return { messages: out.messages, messagesMore: out.more }
  }

  /**
   * `messages.mine` and `messages.post` from a module's PAGE (protocol 2.50.0),
   * through `/host/call`, after the module is known and its grant held there:
   * in the project the page stands in (`project`, an id), the module's own
   * mail and a message in its own name — no session's, never the person's.
   */
  function pageAnswer(module: string, method: 'messages.mine' | 'messages.post', params: unknown, project: number | null): { ok: true; data: unknown } | { ok: false; reason: 'failed'; error: string } {
    if (project === null || !(deps.hasProject?.(project) ?? true)) {
      if (method === 'messages.post') return { ok: true, data: messageSendResult.parse({ outcome: 'declined', why: MESSAGE_ROUTE_SAYS.noProject }) }
      return { ok: false, reason: 'failed', error: MESSAGE_ROUTE_SAYS.noProject }
    }
    if (method === 'messages.mine') {
      const asked = messageMineParams.safeParse(params ?? {})
      if (!asked.success) return { ok: false, reason: 'failed', error: clip(`messages.mine: ${asked.error.issues[0]?.path.join('.') || 'params'} — ${asked.error.issues[0]?.message ?? 'malformed'}.`) }
      const read = messages.mine(project, module, { limit: asked.data.limit, ...(asked.data.since !== undefined ? { since: asked.data.since } : {}) })
      return { ok: true, data: messageMineResult.parse(read) }
    }
    const asked = messagePostParams.safeParse(params ?? {})
    if (!asked.success) return { ok: false, reason: 'failed', error: clip(`messages.post: ${asked.error.issues[0]?.path.join('.') || 'params'} — ${asked.error.issues[0]?.message ?? 'malformed'}.`) }
    if (mutes.has(project, module)) return muted()
    const sent = messages.send(
      project,
      { module, session: '', name: deps.nameOf(module) ?? module, epic: null, parts: [], kehikko: null },
      asked.data.body,
      asked.data.to,
      asked.data.thread ?? null,
      extrasOf(asked.data),
    )
    if (sent.ok) deps.changed(project)
    return { ok: true, data: messageSendResult.parse(sent.ok ? { outcome: 'sent', id: sent.id } : { outcome: 'declined', why: sent.why }) }
  }

  /**
   * The PERSON's message (protocol 2.50.0, `messages.say`): `POST
   * /host/messages/say`, in `PAGE_ONLY`, so only this host's own page reaches
   * it — and the page sends it only for a request that came during the
   * person's fresh press in the module's frame (`host/ask.ts`). Here: the page
   * says so (`pressed`), the module is registered and its manifest asks for
   * `messages:as-person`, and the person allowed it in this host's own
   * settings form (`granted`). Then it is stamped `person: true`, with no
   * session. Every refusal is `declined`, with why.
   */
  async function say(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      module?: unknown
      project?: unknown
      pressed?: unknown
      place?: { epic?: unknown; parts?: unknown; kehikko?: unknown } | null
      params?: unknown
    } | null
    const declined = (why: string): Response => reply({ ok: true, data: messageSendResult.parse({ outcome: 'declined', why }) })
    if (!body || typeof body.module !== 'string' || body.module.length > 64) return reply({ ok: false, error: 'A message names a module.' }, 400)
    const module = body.module
    const project = typeof body.project === 'number' && Number.isInteger(body.project) && body.project > 0 ? body.project : null
    if (project === null || !(deps.hasProject?.(project) ?? true)) return declined(MESSAGE_ROUTE_SAYS.noProject)
    if (!(deps.known?.(module) ?? false)) return declined(MESSAGE_ROUTE_SAYS.module)
    if (!(deps.may?.(module, 'messages:as-person') ?? false)) return declined(MESSAGE_ROUTE_SAYS.notAsked('messages:as-person'))
    if (body.pressed !== true) return declined(MESSAGE_ROUTE_SAYS.noPress)
    if (!(deps.granted?.(module) ?? false)) return declined(MESSAGE_ROUTE_SAYS.notAllowed)
    const asked = messageSayParams.safeParse(body.params ?? {})
    if (!asked.success) return reply({ ok: false, reason: 'failed', error: clip(`messages.say: ${asked.error.issues[0]?.path.join('.') || 'params'} — ${asked.error.issues[0]?.message ?? 'malformed'}.`) })
    const place = body.place ?? null
    const slug = (one: unknown): string | null => (typeof one === 'string' && /^[a-z0-9-]{1,80}$/.test(one) ? one : null)
    const sent = messages.send(
      project,
      {
        module,
        session: '',
        name: deps.nameOf(module) ?? module,
        epic: slug(place?.epic),
        parts: Array.isArray(place?.parts) ? place.parts.flatMap((one) => slug(one) ?? []) : [],
        kehikko: typeof place?.kehikko === 'string' && /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(place.kehikko) ? place.kehikko : null,
        person: true,
      },
      asked.data.body,
      asked.data.to,
      asked.data.thread ?? null,
      extrasOf(asked.data),
    )
    if (sent.ok) deps.changed(project)
    return reply({ ok: true, data: messageSendResult.parse(sent.ok ? { outcome: 'sent', id: sent.id } : { outcome: 'declined', why: sent.why }) })
  }

  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/host/messages/say' && request.method === 'POST') return say(request)
    if (url.pathname === '/host/messages' && request.method === 'GET') {
      const project = Number(url.searchParams.get('project'))
      if (!Number.isInteger(project) || project <= 0) return reply({ ok: false, error: 'project is a project’s number.' }, 400)
      const limit = Number(url.searchParams.get('limit') ?? LIMITS.MESSAGES_KEPT)
      const all = Number.isInteger(limit) && limit >= 0 ? messages.all(project, limit) : messages.all(project)
      return reply({ ok: true, count: messages.count(project), messages: all, muted: mutes.muted(project) })
    }
    /* The person's "Messages to agents" switch, one module in one project. `PAGE_ONLY`. */
    if (url.pathname === '/host/messages/mute' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { project?: unknown; module?: unknown; muted?: unknown } | null
      const project = body?.project
      if (typeof project !== 'number' || !Number.isInteger(project) || project <= 0 || !(deps.hasProject?.(project) ?? true)) {
        return reply({ ok: false, error: 'project is a project’s number this host holds.' }, 400)
      }
      const module = typeof body?.module === 'string' && body.module.length > 0 && body.module.length <= 64 ? body.module : null
      if (module === null) return reply({ ok: false, error: 'A mute names the module.' }, 400)
      if (typeof body?.muted !== 'boolean') return reply({ ok: false, error: 'muted is true (take none of its messages) or false (take them again).' }, 400)
      const out = mutes.set(project, module, body.muted)
      if (out.changed) deps.changed(project)
      return reply({ ok: true, changed: out.changed, muted: mutes.muted(project) })
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

  return { serverAnswer, forNotes, route, pageAnswer, mutes, hostTell }
}
