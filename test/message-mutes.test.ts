import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headerItemsSchema } from 'kehikot-module-protocol'

import { AgentMessages } from '../server/agentMessages.ts'
import { createCanvas, editCanvas, open, type Canvas, type Placement } from '../server/canvases.ts'
import { PLACE_PARAM } from '../server/doorPlaces.ts'
import { PAGE_ONLY } from '../server/guard.ts'
import { createEpic } from '../server/holdings.ts'
import { Inbox } from '../server/inbox.ts'
import { call, MESSAGES_MUTED_MARK, type Door, type Sighting } from '../server/mcp.ts'
import { MessageMutes, MUTED_SAYS } from '../server/messageMutes.ts'
import { messageDesk } from '../server/messageRoutes.ts'
import { Openness } from '../server/open.ts'
import { placeDesk } from '../server/placeRoutes.ts'
import { addProject, projectById, type Project } from '../server/projects.ts'
import { FRAME_ENTRIES, layoutOf, modeFor, pinsFor, placesOf } from '../src/host/headerOffer.ts'
import { MESSAGES_USE, muteWords, offersMessagesUse } from '../src/host/messagesUse.ts'

/*
 * "Messages to agents": the person's switch, per module and per project, for whether a module's OWN
 * messages reach the agent sessions (`server/messageMutes.ts`). Off, the host declines them with
 * MUTED_SAYS and keeps nothing; the person's own messages through a module and a session's messages
 * to other sessions are never touched.
 */

const HOST = 'http://127.0.0.1:4180'
const SESSIONS = 'stand.sessions'
const RUNNER = 'stand.runner'
const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ORIGIN: Record<string, string> = { [SESSIONS]: 'http://127.0.0.1:4701', [RUNNER]: 'http://127.0.0.1:4702' }

let db: Database
let folders: string[]
let project: Project
let other: Project
let writing: Canvas
let store: AgentMessages
let changed: number[]
let places: ReturnType<typeof placeDesk>
let desk: ReturnType<typeof messageDesk>

const net = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init)
  const url = new URL(request.url)
  if (url.origin === HOST) return (await places.route(request, url)) ?? (await desk.route(request, url)) ?? new Response('{}', { status: 404 })
  if (url.pathname === '/api/kehikot/place') {
    const token = url.searchParams.get(PLACE_PARAM) ?? ''
    return Response.json({ ok: true, place: token === TOKEN ? { conversation: 'conv-a', epic: 'methods', parts: [], kehikko: writing.key } : null })
  }
  return new Response('{}', { status: 404 })
}) as unknown as typeof fetch

beforeEach(() => {
  db = open(':memory:')
  folders = [realpathSync(mkdtempSync(join(tmpdir(), 'message-mutes-a-'))), realpathSync(mkdtempSync(join(tmpdir(), 'message-mutes-b-')))]
  const a = addProject(db, folders[0]!, 'thesis')
  const b = addProject(db, folders[1]!, 'other')
  if (!a.ok || !b.ok) throw new Error('no project')
  project = projectById(db, a.project.id)!
  other = projectById(db, b.project.id)!
  createEpic(folders[0]!, { title: 'Methods', slug: 'methods' })
  writing = createCanvas(db, 'writing', project.id)
  store = new AgentMessages(db)
  changed = []
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
    nameOf: (id) => ({ [SESSIONS]: 'Sessions', [RUNNER]: 'Runner' })[id] ?? null,
    changed: (id) => changed.push(id),
    hasProject: (id) => projectById(db, id) !== null,
    known: (id) => id in ORIGIN,
    may: () => true,
    granted: () => true,
    projectIdAt: (root) => (root === folders[0] ? project.id : root === folders[1] ? other.id : null),
    setTimer: () => null,
  })
})
afterEach(() => {
  db.close()
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

/** The session module saying it issued the token, so a notice can find its session. */
async function issue(): Promise<void> {
  await net(`${HOST}/host/place`, { method: 'POST', body: JSON.stringify({ module: SESSIONS, token: TOKEN, project: folders[0], kehikko: writing.key }) })
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await net(`${HOST}${path}`, { method: 'POST', body: JSON.stringify(body) })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const mute = (muted: boolean, module = RUNNER, at = project.id) => post('/host/messages/mute', { project: at, module, muted })

describe('the store', () => {
  test('on by default; off is per project and module; back on removes it; the same press twice changes nothing', () => {
    const mutes = new MessageMutes(db)
    expect(mutes.muted(project.id)).toEqual([])
    expect(mutes.set(project.id, RUNNER, true)).toEqual({ changed: true })
    expect(mutes.set(project.id, RUNNER, true)).toEqual({ changed: false })
    expect(mutes.has(project.id, RUNNER)).toBe(true)
    expect(mutes.has(other.id, RUNNER)).toBe(false)
    expect(mutes.has(project.id, SESSIONS)).toBe(false)
    expect(new MessageMutes(db).muted(project.id)).toEqual([RUNNER])
    expect(mutes.set(project.id, RUNNER, false)).toEqual({ changed: true })
    expect(mutes.muted(project.id)).toEqual([])
  })
})

describe('the route', () => {
  test('is the page’s alone, takes a project, a module and a boolean, and wakes the project’s pages', async () => {
    expect(PAGE_ONLY).toContain('/host/messages/mute')
    expect((await post('/host/messages/mute', { project: project.id, muted: true })).status).toBe(400)
    expect((await post('/host/messages/mute', { project: project.id, module: RUNNER, muted: 'yes' })).status).toBe(400)
    expect((await post('/host/messages/mute', { project: 9999, module: RUNNER, muted: true })).status).toBe(400)
    expect((await mute(true)).body).toEqual({ ok: true, changed: true, muted: [RUNNER] })
    expect(changed).toEqual([project.id])
    expect((await mute(true)).body).toEqual({ ok: true, changed: false, muted: [RUNNER] })
    expect(changed).toEqual([project.id])
    const read = (await (await net(`${HOST}/host/messages?project=${project.id}&limit=0`)).json()) as { muted: string[] }
    expect(read.muted).toEqual([RUNNER])
    const elsewhere = (await (await net(`${HOST}/host/messages?project=${other.id}&limit=0`)).json()) as { muted: string[] }
    expect(elsewhere.muted).toEqual([])
  })
})

describe('a muted module’s own messages', () => {
  test('its notice to a session is declined with the reason, kept nowhere and wakes nothing; unmuted, it is delivered', async () => {
    await issue()
    await mute(true)
    changed = []
    const said = await desk.serverAnswer(RUNNER, 'messages.notify', { token: TOKEN, body: 'Run passed.', kind: 'report' })
    expect(said).toEqual({ ok: true, data: { outcome: 'declined', id: null, why: MUTED_SAYS } })
    expect(store.count(project.id)).toBe(0)
    expect(changed).toEqual([])
    await mute(false)
    changed = []
    expect(await desk.serverAnswer(RUNNER, 'messages.notify', { token: TOKEN, body: 'Run passed.' })).toMatchObject({ data: { outcome: 'sent' } })
    expect(store.count(project.id)).toBe(1)
    expect(changed).toEqual([project.id])
  })

  test('its news to every session at a place is declined the same way; unmuted, it is kept', async () => {
    await mute(true)
    changed = []
    const tell = () => desk.serverAnswer(RUNNER, 'messages.tell', { to: { place: { epic: 'methods' } }, body: 'CI failed', kind: 'report' }, folders[0]!)
    expect(await tell()).toEqual({ ok: true, data: { outcome: 'declined', id: null, why: MUTED_SAYS } })
    expect(store.count(project.id)).toBe(0)
    expect(changed).toEqual([])
    await mute(false)
    expect(await tell()).toMatchObject({ ok: true, data: { outcome: 'sent' } })
    expect(store.count(project.id)).toBe(1)
  })

  test('its page’s post is declined the same way; unmuted, it is kept', async () => {
    await mute(true)
    changed = []
    expect(desk.pageAnswer(RUNNER, 'messages.post', { body: 'Hello', to: { module: SESSIONS } }, project.id)).toEqual({ ok: true, data: { outcome: 'declined', id: null, why: MUTED_SAYS } })
    expect(store.count(project.id)).toBe(0)
    expect(changed).toEqual([])
    await mute(false)
    expect(desk.pageAnswer(RUNNER, 'messages.post', { body: 'Hello', to: { module: SESSIONS } }, project.id)).toMatchObject({ data: { outcome: 'sent' } })
    expect(store.count(project.id)).toBe(1)
  })

  test('muted in one project, it still sends in another', async () => {
    await mute(true)
    expect(desk.pageAnswer(RUNNER, 'messages.post', { body: 'Here', to: { module: SESSIONS } }, other.id)).toMatchObject({ data: { outcome: 'sent' } })
    expect(desk.pageAnswer(RUNNER, 'messages.post', { body: 'There', to: { module: SESSIONS } }, project.id)).toMatchObject({ data: { outcome: 'declined', why: MUTED_SAYS } })
    expect(store.count(other.id)).toBe(1)
    expect(store.count(project.id)).toBe(0)
  })

  test('another module, not muted, is not touched', async () => {
    await mute(true)
    expect(desk.pageAnswer(SESSIONS, 'messages.post', { body: 'Mine', to: { module: RUNNER } }, project.id)).toMatchObject({ data: { outcome: 'sent' } })
  })
})

describe('what the switch never touches', () => {
  test('the person’s own message through a muted module is sent', async () => {
    await mute(true)
    const said = await post('/host/messages/say', { module: RUNNER, project: project.id, pressed: true, params: { body: 'From me', to: { module: SESSIONS } } })
    expect(said.body).toMatchObject({ ok: true, data: { outcome: 'sent' } })
    expect(store.all(project.id)[0]!.from.person).toBe(true)
  })

  test('a session’s message to other sessions, through a muted module, is sent', async () => {
    await issue()
    await mute(true, SESSIONS)
    const said = await desk.serverAnswer(SESSIONS, 'messages.send', { token: TOKEN, body: 'To the others', to: { module: SESSIONS } })
    expect(said).toMatchObject({ ok: true, data: { outcome: 'sent' } })
    expect(store.all(project.id)[0]!.from.session).toBe('conv-a')
  })
})

describe('where the person finds it, and what an agent reads', () => {
  test('a Container menu row after "Use inbox", reachable exactly once at every width and fold', () => {
    expect(FRAME_ENTRIES.indexOf('messages')).toBe(FRAME_ENTRIES.indexOf('inbox') + 1)
    const items = headerItemsSchema.parse([{ kind: 'run', id: 'go', label: 'Go' }])
    for (const width of [null, 380, 280, 220, 200, 160]) {
      for (const fold of [0, 1, 2] as const) {
        const keys = placesOf(layoutOf({ items, frame: [...FRAME_ENTRIES] }, modeFor(width), pinsFor(width), fold)).map((one) => one.key)
        expect(keys.filter((one) => one === 'frame:messages'), `${width} ${fold}`).toHaveLength(1)
      }
    }
    expect(MESSAGES_USE).toBe('Messages to agents')
    expect(muteWords('Runner')).toBe('Mute messages from Runner')
  })

  test('the row is offered to a module that may send messages, or one muted now', () => {
    expect(offersMessagesUse({ declares: { uses: ['agents:message'] } }, false)).toBe(true)
    expect(offersMessagesUse({ declares: { uses: ['epics:read'] } }, false)).toBe(false)
    expect(offersMessagesUse({ declares: { uses: [] } }, true)).toBe(true)
    expect(offersMessagesUse(undefined, false)).toBe(false)
  })

  test('read_canvas says a module is muted, in its project only; no tool sets it', async () => {
    const openness = new Openness()
    editCanvas(db, writing.id, { placements: [{ i: RUNNER, x: 0, y: 0, w: 6, h: 10, wish: 10 }, { i: SESSIONS, x: 6, y: 0, w: 6, h: 10, wish: 10 }] as Placement[] })
    const elsewhere = createCanvas(db, 'elsewhere', other.id)
    editCanvas(db, elsewhere.id, { placements: [{ i: RUNNER, x: 0, y: 0, w: 6, h: 10, wish: 10 }] as Placement[] })
    const seen: Sighting[] = [
      { id: RUNNER, name: 'Runner', condition: 'ready' },
      { id: SESSIONS, name: 'Sessions', condition: 'ready' },
    ]
    const door: Door = {
      db,
      which: () => openness.open(),
      watched: () => openness.every(),
      wake: () => {},
      epicsChanged: () => {},
      dispositionsChanged: () => {},
      inbox: new Inbox(db),
      seen: async () => seen,
    }
    await mute(true)
    const text = (await call('read_canvas', { kehikko: writing.id }, door)).text
    expect(text.split('\n').find((line) => line.trim().startsWith(RUNNER))).toContain(MESSAGES_MUTED_MARK)
    expect(text.split('\n').find((line) => line.trim().startsWith(SESSIONS))).not.toContain(MESSAGES_MUTED_MARK)
    const there = (await call('read_canvas', { kehikko: elsewhere.id }, door)).text
    expect(there).not.toContain(MESSAGES_MUTED_MARK)
  })
})
