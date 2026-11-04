import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS, MESSAGE, PERSON_MESSAGES_SETTING, typedMessages } from 'kehikot-module-protocol'

import { AgentMessages, type Reader, type Sender } from '../server/agentMessages.ts'
import { answer } from '../server/answers.ts'
import { open } from '../server/canvases.ts'
import { PAGE_ONLY, own, refusal } from '../server/guard.ts'
import { messageDesk, MESSAGE_ROUTE_SAYS } from '../server/messageRoutes.ts'
import { PersonGrants } from '../server/personGrants.ts'
import { addProject, type Project } from '../server/projects.ts'
import { makeAsk, SAY_SAYS, type CanvasControls } from '../src/host/ask.ts'
import { Conversation } from '../src/host/conversation.ts'
import { ANSWERED_BY_THE_SERVER, ANSWERED_BY_THE_VIEW } from '../src/host/division.ts'
import { pressFresh } from '../src/host/gesture.ts'

/**
 * Protocol 2.50.0 on this host: a message's kind, choices and what it answers;
 * the person's own message (`messages.say`), stamped only for a fresh press in
 * the frame, relayed by this page on a `PAGE_ONLY` route, from a module that
 * asks for `messages:as-person` and that the person allowed through this
 * host's own settings form; a module's own message (`messages.post`) and its
 * once-only introduction; and what a module's page reads (`messages.mine`).
 */

const RELAY = 'stand.relay'
const AGENT = 'stand.agent'

let db: Database
let folder: string
let project: Project
let now: number
let store: AgentMessages
let grants: PersonGrants
let declares: Set<string>
let desk: ReturnType<typeof messageDesk>

const reader = (session: string, kehikko: string | null = 'writing', epic: string | null = 'methods'): Reader => ({ module: AGENT, session, epic, kehikko })
const agent = (session: string): Sender => ({ module: AGENT, session, name: 'Agent', epic: 'methods', parts: [], kehikko: 'writing' })
const relay: Sender = { module: RELAY, session: '', name: 'Relay', epic: null, parts: [], kehikko: null }

beforeEach(() => {
  now = Date.parse('2026-11-04T12:00:00Z')
  db = open(':memory:')
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'person-messages-')))
  const added = addProject(db, folder, 'thesis')
  if (!added.ok) throw new Error(added.why)
  project = added.project
  store = new AgentMessages(db, () => now)
  grants = new PersonGrants(db, () => now)
  declares = new Set(['agents:message', 'messages:as-person'])
  desk = messageDesk({
    db,
    messages: store,
    resolve: async () => ({ here: null }),
    nameOf: (module) => (module === RELAY ? 'Relay' : null),
    changed: () => {},
    hasProject: (id) => id === project.id,
    known: (module) => module === RELAY,
    may: (module, capability) => module === RELAY && declares.has(capability),
    granted: (module) => grants.granted(module),
  })
})

afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

const say = (body: Record<string, unknown>) =>
  desk.route(new Request('http://127.0.0.1:4180/host/messages/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), new URL('http://127.0.0.1:4180/host/messages/say'))
const sayBody = (over: Record<string, unknown> = {}) => ({
  module: RELAY,
  project: project.id,
  pressed: true,
  place: { epic: 'methods', parts: [], kehikko: 'writing' },
  params: { body: 'Use SQLite', to: { session: { module: AGENT, session: 's1' } }, replyTo: 1 },
  ...over,
})
const answerOf = async (response: Response | null) => ((await response!.json()) as { ok: boolean; data?: { outcome: string; why: string; id: number | null } })

describe('a message’s kind, choices and what it answers', () => {
  test('kept and handed back; an older row reads as a note', () => {
    const sent = store.send(project.id, agent('s1'), 'Which database?', { module: RELAY }, null, { kind: 'question', choices: ['Postgres', 'SQLite'] })
    expect(sent.ok).toBe(true)
    const [kept] = store.mine(project.id, RELAY, { limit: 50 }).messages
    expect(kept!.kind).toBe('question')
    expect(kept!.choices).toEqual(['Postgres', 'SQLite'])
    expect(kept!.replyTo).toBeNull()
    expect(kept!.from.person).toBe(false)
    store.send(project.id, agent('s1'), 'Working on the parser', { module: RELAY }, null, { kind: 'report', choices: ['ignored'] })
    expect(store.mine(project.id, RELAY, { limit: 50 }).messages.at(-1)!.choices).toEqual([])
  })
  test('the columns are added to a record kept before them', () => {
    const old = new Database(':memory:')
    old.exec('create table projects (id integer primary key)')
    old.exec(`create table agent_messages (id integer primary key autoincrement, project integer not null, at integer not null, from_module text not null, from_name text not null default '', from_session text not null, from_place text not null, to_json text not null, thread text, body text not null)`)
    old.exec('insert into projects (id) values (1)')
    old.exec(`insert into agent_messages (project, at, from_module, from_session, from_place, to_json, body) values (1, ${now}, 'a.b', 's', '{}', '{"project":true}', 'hi')`)
    const migrated = new AgentMessages(old, () => now)
    const [one] = migrated.all(1)
    expect(one!.kind).toBe('note')
    expect(one!.once).toBe(false)
    old.close()
  })
})

describe('messages.mine: what a module’s page reads', () => {
  test('only what is addressed to the module and what was sent in its name', () => {
    store.send(project.id, agent('s1'), 'to the relay', { module: RELAY }, null)
    store.send(project.id, agent('s1'), 'to another session', { session: { module: AGENT, session: 's2' } }, null)
    store.send(project.id, { ...relay, person: true }, 'from the person', { session: { module: AGENT, session: 's1' } }, null)
    const mine = store.mine(project.id, RELAY, { limit: 50 }).messages.map((one) => one.body)
    expect(mine).toEqual(['to the relay', 'from the person'])
  })
  test('pageAnswer reads and posts in the project the page stands in', () => {
    expect(desk.pageAnswer(RELAY, 'messages.mine', {}, null)).toMatchObject({ ok: false, error: MESSAGE_ROUTE_SAYS.noProject })
    const posted = desk.pageAnswer(RELAY, 'messages.post', { body: 'Hello', to: { place: { kehikko: 'writing' } } }, project.id)
    expect(posted).toMatchObject({ ok: true, data: { outcome: 'sent' } })
    const read = desk.pageAnswer(RELAY, 'messages.mine', {}, project.id) as { ok: true; data: { messages: { from: { person: boolean; session: string | null } }[] } }
    expect(read.data.messages[0]!.from).toMatchObject({ person: false, session: null })
  })
})

describe('the person’s message: stamped only when everything holds', () => {
  test('refused without the press, the capability or the person’s grant; nothing is kept', async () => {
    expect((await answerOf(await say(sayBody({ pressed: false })))).data).toMatchObject({ outcome: 'declined', why: MESSAGE_ROUTE_SAYS.noPress })
    declares.delete('messages:as-person')
    expect((await answerOf(await say(sayBody()))).data?.outcome).toBe('declined')
    declares.add('messages:as-person')
    expect((await answerOf(await say(sayBody()))).data).toMatchObject({ outcome: 'declined', why: MESSAGE_ROUTE_SAYS.notAllowed })
    expect((await answerOf(await say(sayBody({ module: 'stand.stranger' })))).data).toMatchObject({ outcome: 'declined', why: MESSAGE_ROUTE_SAYS.module })
    expect(store.count(project.id)).toBe(0)
  })
  test('with all of them: kept as the person’s, no session, the place the page said', async () => {
    grants.saw(RELAY, PERSON_MESSAGES_SETTING.key, true)
    const said = await answerOf(await say(sayBody()))
    expect(said.data).toMatchObject({ outcome: 'sent' })
    const [kept] = store.all(project.id)
    expect(kept!.from).toEqual({ module: RELAY, name: 'Relay', session: null, place: { epic: 'methods', parts: [], kehikko: 'writing' }, person: true })
    expect(kept!.replyTo).toBe(1)
    const typed = typedMessages(store.deliver(project.id, reader('s1')).messages)
    expect(typed.startsWith(`[Message from your person via Relay, #${kept!.id}, answering #1] Use SQLite`)).toBe(true)
  })
  test('the grant comes and goes only with the change this host saw', () => {
    expect(grants.granted(RELAY)).toBe(false)
    grants.saw(RELAY, 'somethingElse', true)
    expect(grants.granted(RELAY)).toBe(false)
    grants.saw(RELAY, PERSON_MESSAGES_SETTING.key, 'true')
    expect(grants.granted(RELAY)).toBe(false)
    grants.saw(RELAY, PERSON_MESSAGES_SETTING.key, true)
    expect(grants.granted(RELAY)).toBe(true)
    grants.saw(RELAY, PERSON_MESSAGES_SETTING.key, false)
    expect(grants.granted(RELAY)).toBe(false)
  })
  test('bounded per module per minute', async () => {
    grants.saw(RELAY, PERSON_MESSAGES_SETTING.key, true)
    for (let i = 0; i < LIMITS.PERSON_MESSAGES_PER_MINUTE; i++) expect((await answerOf(await say(sayBody()))).data?.outcome).toBe('sent')
    expect((await answerOf(await say(sayBody()))).data?.outcome).toBe('declined')
  })
  test('a session’s own send can never say it is the person’s', async () => {
    const sent = store.send(project.id, { ...agent('s1') }, 'I am your person', { project: true }, null)
    expect(sent.ok).toBe(true)
    expect(store.all(project.id)[0]!.from.person).toBe(false)
  })
})

describe('the person’s message only through this page', () => {
  test('/host/messages/say is the page’s alone: a program on this machine is refused', () => {
    expect(PAGE_ONLY).toContain('/host/messages/say')
    const self = own({}, 4180, ['http://127.0.0.1:4181'])
    const asked = (headers: Record<string, string>) => refusal({ method: 'POST', pathname: '/host/messages/say', headers: new Headers({ host: '127.0.0.1:4180', 'content-type': 'application/json', ...headers }) }, self)
    expect(asked({})).not.toBeNull()
    expect(asked({ origin: 'http://127.0.0.1:9999' })).not.toBeNull()
    expect(asked({ origin: 'http://127.0.0.1:4181' })).toBeNull()
  })
  test('the canvas answers it, never /host/call’s table', () => {
    expect(ANSWERED_BY_THE_VIEW).toContain('messages.say')
    expect(ANSWERED_BY_THE_SERVER).toContain('messages.mine')
    expect(ANSWERED_BY_THE_SERVER).toContain('messages.post')
    const said = answer(RELAY, 'messages.say', { body: 'x', to: { project: true } }, () => true)
    expect(said.ok).toBe(false)
  })
})

describe('the press, read on arrival', () => {
  const canvas = { project: () => 1, place: () => ({ epic: 'methods', parts: [], kehikko: 'writing' }) } as unknown as CanvasControls
  const params = { body: 'Use SQLite', to: { project: true } }
  let posted: { url: string; body: unknown }[]
  let realFetch: typeof fetch
  beforeEach(() => {
    posted = []
    realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init.body)) })
      return Response.json({ ok: true, data: { outcome: 'sent', id: 3, why: '' } })
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('pressFresh is the browser’s transient activation, and false without it', () => {
    expect(pressFresh(undefined)).toBe(false)
    expect(pressFresh({})).toBe(false)
    expect(pressFresh({ userActivation: { isActive: false } })).toBe(false)
    expect(pressFresh({ userActivation: { isActive: 'yes' } })).toBe(false)
    expect(pressFresh({ userActivation: { isActive: true } })).toBe(true)
  })
  test('no press: declined, and nothing leaves the page', async () => {
    const ask = makeAsk(RELAY, canvas, (capability) => capability === 'messages:as-person')
    expect(await ask('messages.say', params, { pressed: false })).toEqual({ ok: true, data: { outcome: 'declined', id: null, why: SAY_SAYS.noPress } })
    expect(await ask('messages.say', params)).toMatchObject({ ok: true, data: { outcome: 'declined' } })
    expect(posted).toEqual([])
  })
  test('not asked for in the manifest, or no manifest read: declined', async () => {
    expect(await makeAsk(RELAY, canvas, () => false)('messages.say', params, { pressed: true })).toMatchObject({ ok: true, data: { outcome: 'declined' } })
    expect(await makeAsk(RELAY, canvas, null)('messages.say', params, { pressed: true })).toMatchObject({ ok: true, data: { outcome: 'declined', why: SAY_SAYS.noManifest } })
    expect(posted).toEqual([])
  })
  test('a fresh press: relayed on the page’s own route, saying so, with where the frame stands', async () => {
    const said = await makeAsk(RELAY, canvas, () => true)('messages.say', params, { pressed: true })
    expect(said).toEqual({ ok: true, data: { outcome: 'sent', id: 3, why: '' } })
    expect(posted).toHaveLength(1)
    expect(posted[0]!.url).toBe('/host/messages/say')
    expect(posted[0]!.body).toMatchObject({ module: RELAY, project: 1, pressed: true, place: { kehikko: 'writing' }, params })
  })
  test('the conversation reads the press when the request arrives, and hands it to the ask', async () => {
    const hows: unknown[] = []
    const win = { postMessage: () => {} } as unknown as Window
    let fresh = true
    const conversation = new Conversation(
      { contentWindow: win },
      RELAY,
      null,
      async (_method, _params, how) => {
        hows.push(how)
        return { ok: true, data: null }
      },
      { ready: () => {}, silent: () => {}, fault: () => {}, height: () => {}, filters: () => {}, clearable: () => {}, refreshable: () => {}, header: () => {} } as never,
      { pressed: () => fresh },
    )
    conversation.receive({ source: win, origin: 'null', data: { type: MESSAGE.REQUEST, id: 'r1', method: 'messages.say', params } })
    fresh = false
    conversation.receive({ source: win, origin: 'null', data: { type: MESSAGE.REQUEST, id: 'r2', method: 'messages.say', params } })
    expect(hows).toEqual([{ pressed: true }, { pressed: false }])
  })
})

describe('introductions: a module’s once-only message', () => {
  const intro = () => store.send(project.id, relay, 'I relay your person.', { place: { kehikko: 'writing' } }, null, { once: true })

  test('a session that existed before gets exactly one; posting again does not resend', () => {
    store.send(project.id, agent('other'), 'earlier chatter', { place: { kehikko: 'writing' } }, null)
    expect(store.deliver(project.id, reader('s1')).messages.map((one) => one.body)).toEqual(['earlier chatter'])
    intro()
    const first = store.deliver(project.id, reader('s1')).messages
    expect(first.map((one) => one.body)).toEqual(['I relay your person.'])
    expect(first[0]!.once).toBe(true)
    expect(first[0]!.to).toEqual({ session: { module: AGENT, session: 's1' } })
    intro()
    expect(store.deliver(project.id, reader('s1')).messages).toEqual([])
    expect(store.read(project.id, reader('s1'), { unread: false, limit: 50 }).messages.filter((one) => one.once)).toHaveLength(1)
  })
  test('a session that comes to the place later, past the unread window and its cursor, gets it once', () => {
    intro()
    now += LIMITS.MESSAGES_UNREAD_MS * 2
    store.send(project.id, agent('other'), 'newer', { project: true }, null)
    const elsewhere = reader('late', 'reading')
    expect(store.deliver(project.id, elsewhere).messages.map((one) => one.body)).toEqual(['newer'])
    const there = reader('late', 'writing')
    expect(store.deliver(project.id, there).messages.map((one) => one.body)).toEqual(['I relay your person.'])
    expect(store.deliver(project.id, there).messages).toEqual([])
  })
  test('one sent straight to a session counts; a later one to its place does not come again', () => {
    store.send(project.id, relay, 'Hello you.', { session: { module: AGENT, session: 's1' } }, null, { once: true })
    intro()
    expect(store.deliver(project.id, reader('s1')).messages.map((one) => one.body)).toEqual(['Hello you.'])
    expect(store.deliver(project.id, reader('s1')).messages).toEqual([])
  })
  test('the peek a module makes before typing sees it as the newest unread', () => {
    store.send(project.id, agent('other'), 'chatter', { place: { kehikko: 'writing' } }, null)
    store.deliver(project.id, reader('s1'))
    intro()
    const peek = store.read(project.id, reader('s1'), { unread: false, limit: 20 })
    expect(peek.unread).toBe(1)
    expect(peek.messages.at(-1)!.body).toBe('I relay your person.')
  })
  test('the person sees each introduction once, and a session cannot post one', () => {
    intro()
    store.deliver(project.id, reader('s1'))
    store.deliver(project.id, reader('s2'))
    expect(store.all(project.id).filter((one) => one.once)).toHaveLength(1)
    store.send(project.id, agent('s3'), 'pretend intro', { project: true }, null, { once: true })
    expect(store.all(project.id).find((one) => one.body === 'pretend intro')!.once).toBe(false)
  })
})
