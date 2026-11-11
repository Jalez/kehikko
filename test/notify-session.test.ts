import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS, SERVER_PASS_PATH, WORK_QUEUE, providerOf } from 'kehikot-module-protocol'
import { askHost, forgetMessageHosts, serverPassReply } from 'kehikot-module-protocol/serve'

import { AgentMessages } from '../server/agentMessages.ts'
import { answer } from '../server/answers.ts'
import { createCanvas, open, type Canvas } from '../server/canvases.ts'
import { PLACE_PARAM } from '../server/doorPlaces.ts'
import { createEpic } from '../server/holdings.ts'
import { Inbox } from '../server/inbox.ts'
import { MessageMutes, MUTED_SAYS } from '../server/messageMutes.ts'
import { messageDesk, MESSAGE_ROUTE_SAYS } from '../server/messageRoutes.ts'
import { placeDesk } from '../server/placeRoutes.ts'
import { addProject, projectById, type Project } from '../server/projects.ts'
import { serverAskDesk } from '../server/serverAsk.ts'
import { providersOf } from '../server/services.ts'

/**
 * Protocol 2.81.0. `messages.notifySession`: a module that watches this computer tells one agent session,
 * named by its own id, about work it started; the host finds the session among those it has seen through
 * their tokens. And `services.find`: who provides a service here, read off the last sweep's manifests.
 */

const HOST = 'http://127.0.0.1:4180'
const SESSIONS = 'stand.sessions'
const WATCHER = 'stand.watcher'
const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CONVERSATION = 'conv-alpha-0001'
const ORIGIN: Record<string, string> = { [SESSIONS]: 'http://127.0.0.1:4701', [WATCHER]: 'http://127.0.0.1:4702' }

let db: Database
let folder: string
let project: Project
let writing: Canvas
let now: number
let store: AgentMessages
let records: Record<string, { conversation: string; epic: string | null; parts: string[]; kehikko: string | null }>
let places: ReturnType<typeof placeDesk>
let desk: ReturnType<typeof messageDesk>
let ask: ReturnType<typeof serverAskDesk>
let capabilities: string[]

const net = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init)
  const url = new URL(request.url)
  if (url.origin === HOST) return (await ask.route(request, url)) ?? (await places.route(request, url)) ?? (await desk.route(request, url)) ?? new Response('{}', { status: 404 })
  if (url.pathname === '/api/kehikot/place') return Response.json({ ok: true, place: records[url.searchParams.get(PLACE_PARAM) ?? ''] ?? null })
  if (url.pathname === SERVER_PASS_PATH) {
    const said = serverPassReply('GET', url.pathname, url.searchParams)!
    return Response.json(said.body, { status: said.status })
  }
  return new Response('{}', { status: 404 })
}) as unknown as typeof fetch

beforeEach(() => {
  now = Date.parse('2026-11-11T12:00:00Z')
  db = open(':memory:')
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'notify-session-')))
  const added = addProject(db, folder, 'thesis')
  if (!added.ok) throw new Error(added.why)
  project = projectById(db, added.project.id)!
  createEpic(folder, { title: 'Methods', slug: 'methods' })
  writing = createCanvas(db, 'writing', project.id)
  store = new AgentMessages(db, () => now)
  records = { [TOKEN]: { conversation: CONVERSATION, epic: 'methods', parts: [], kehikko: writing.key } }
  capabilities = ['sessions:observe', 'agents:message']
  places = placeDesk({
    db,
    inbox: new Inbox(db),
    hostUrl: () => `${HOST}/mcp`,
    doors: async () => [],
    known: () => new Map(),
    open: () => null,
    changed: () => {},
    originOf: async (id) => ORIGIN[id] ?? null,
    messagesFor: (here, token) => desk.forNotes(here, token),
    fetch: net,
  })
  desk = messageDesk({
    db,
    messages: store,
    resolve: (token) => places.resolve(token, null),
    nameOf: (id) => ({ [SESSIONS]: 'Sessions', [WATCHER]: 'Watcher' })[id] ?? null,
    changed: () => {},
    may: (_id, capability) => capabilities.includes(capability),
  })
  ask = serverAskDesk({
    known: (id) => id in ORIGIN,
    originOf: async (id) => ORIGIN[id] ?? null,
    may: (_id, capability) => capabilities.includes(capability),
    projectAt: (asked) => (asked === folder ? folder : null),
    answer: () => ({ ok: false, reason: 'failed', error: 'not here' }),
    messages: (module, method, params, root) => desk.serverAnswer(module, method, params, root ?? null),
    fetch: net,
  })
  forgetMessageHosts()
})
afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

/** The session's prompt: its module asks for its notes with its token, and the host sees it. */
async function prompt(): Promise<void> {
  await net(`${HOST}/host/place`, { method: 'POST', body: JSON.stringify({ module: SESSIONS, token: TOKEN, project: folder, kehikko: writing.key, messages: true }) })
}
const notice = (body = 'vitest is running outside Turns (95% CPU).') => desk.serverAnswer(WATCHER, 'messages.notifySession', { session: CONVERSATION, body, kind: 'report' })

describe('messages.notifySession', () => {
  test('reaches the one session by its id, in its project, stamped as the module with that session’s place', async () => {
    await prompt()
    expect(await notice()).toMatchObject({ ok: true, data: { outcome: 'sent' } })
    const [kept] = store.all(project.id)
    expect(kept!.from).toEqual({ module: WATCHER, name: 'Watcher', session: null, place: { epic: 'methods', parts: [], kehikko: writing.key }, person: false })
    expect(kept!.to).toEqual({ session: { module: SESSIONS, session: CONVERSATION } })
    expect(store.deliver(project.id, { module: SESSIONS, session: CONVERSATION, epic: 'methods', kehikko: writing.key }).messages.map((one) => one.body)).toEqual(['vitest is running outside Turns (95% CPU).'])
  })

  test('through /host/server-ask on the module’s pass, held to sessions:observe', async () => {
    await prompt()
    expect(await askHost('messages.notifySession', { session: CONVERSATION, body: 'x' }, { module: WATCHER, env: { KEHIKOT_ORIGINS: HOST }, fetch: net })).toMatchObject({ ok: true, data: { outcome: 'sent' } })
    capabilities = ['agents:message']
    expect((await askHost('messages.notifySession', { session: CONVERSATION, body: 'x' }, { module: WATCHER, env: { KEHIKOT_ORIGINS: HOST }, fetch: net })).ok).toBe(false)
  })

  test('a module that does not ask for agents:message is declined', async () => {
    await prompt()
    capabilities = ['sessions:observe']
    expect(await notice()).toEqual({ ok: true, data: { outcome: 'declined', id: null, why: MESSAGE_ROUTE_SAYS.notAsked('agents:message') } })
  })

  test('a session the host has not seen, or whose record no longer names that id, is declined and nothing is kept', async () => {
    expect(await notice()).toMatchObject({ data: { outcome: 'declined', why: MESSAGE_ROUTE_SAYS.unknownSession } })
    await prompt()
    /* Carried on under a new id: the old one names no session now. */
    records[TOKEN] = { ...records[TOKEN]!, conversation: 'conv-other-0002' }
    await prompt()
    expect(await notice()).toMatchObject({ data: { outcome: 'declined', why: MESSAGE_ROUTE_SAYS.unknownSession } })
    expect(store.count(project.id)).toBe(0)
  })

  test('muted in that project, declined and kept nowhere', async () => {
    await prompt()
    new MessageMutes(db).set(project.id, WATCHER, true)
    expect(await notice()).toMatchObject({ data: { outcome: 'declined', why: MUTED_SAYS } })
    expect(store.count(project.id)).toBe(0)
  })

  test('bounded to OBSERVED_PER_HOUR per module and session', async () => {
    await prompt()
    for (let i = 0; i < LIMITS.OBSERVED_PER_HOUR; i++) {
      now += 61_000
      expect(await notice(`n${i}`)).toMatchObject({ data: { outcome: 'sent' } })
    }
    now += 61_000
    expect(await notice('more')).toMatchObject({ data: { outcome: 'declined' } })
    now += 3_600_000
    expect(await notice('later')).toMatchObject({ data: { outcome: 'sent' } })
  })

  test('a page has no server to send from', () => {
    expect(answer(WATCHER, 'messages.notifySession', { session: CONVERSATION, body: 'x' }, () => true)).toMatchObject({ ok: true, data: { outcome: 'declined' } })
  })
})

const QUEUE = { name: 'Turns', run: { test: "'/x/runner' run -- {command}" }, tool: 'run_tool' }

describe('services.find', () => {
  test('the modules whose manifests provide it, placed first, each with its descriptor', () => {
    const modules = [
      { id: 'stand.b', name: 'B', services: { [WORK_QUEUE]: QUEUE } },
      { id: 'stand.a', name: 'A', services: { [WORK_QUEUE]: QUEUE, 'other.thing': {} } },
      { id: 'stand.c', name: 'C' },
    ]
    expect(providersOf(WORK_QUEUE, modules, null).map((one) => [one.module, one.placed])).toEqual([['stand.a', null], ['stand.b', null]])
    expect(providersOf(WORK_QUEUE, modules, (id) => id === 'stand.b').map((one) => [one.module, one.placed])).toEqual([['stand.b', true], ['stand.a', false]])
    expect(providersOf('nobody.here', modules, null)).toEqual([])
    expect(providerOf(WORK_QUEUE, providersOf(WORK_QUEUE, modules, null))?.descriptor.name).toBe('Turns')
  })

  test('answered with what the server was given, under services:read, and empty without it', () => {
    const grants = { may: (_id: string, capability: string) => capability === 'services:read', undeclared: () => {} }
    const said = answer(WATCHER, 'services.find', { service: WORK_QUEUE, kehikko: writing.key }, () => true, () => {}, folder, undefined, null, null, null, grants, null, null, (service, root, kehikko) =>
      providersOf(service, [{ id: 'stand.b', name: 'B', services: { [service]: QUEUE } }], root === folder && kehikko === writing.key ? () => true : null),
    )
    expect(said).toEqual({ ok: true, data: { providers: [{ module: 'stand.b', name: 'B', descriptor: QUEUE, placed: true }] } })
    expect(answer(WATCHER, 'services.find', { service: WORK_QUEUE }, () => true, () => {}, null, undefined, null, null, null, grants)).toEqual({ ok: true, data: { providers: [] } })
    expect(answer(WATCHER, 'services.find', { service: WORK_QUEUE }, () => true, () => {}, null, undefined, null, null, null, { may: () => false, undeclared: () => {} }).ok).toBe(false)
  })
})
