import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_DELIVERY, NOT_PLACED_HEAD, PLACE_TOKEN_ARG, type ServiceProvider } from 'kehikot-module-protocol'

import { AgentMessages } from '../server/agentMessages.ts'
import { createCanvas, open, type Canvas } from '../server/canvases.ts'
import { doorToken, openSession, PLACE_PARAM } from '../server/doorPlaces.ts'
import { deliveryKnocker, DOOR_MESSAGE_SAYS } from '../server/doorMessages.ts'
import { createEpic } from '../server/holdings.ts'
import { Inbox } from '../server/inbox.ts'
import { mcp, TOOL_NAMES, type Door } from '../server/mcp.ts'
import { messageDesk } from '../server/messageRoutes.ts'
import { placeDesk } from '../server/placeRoutes.ts'
import { addProject, projectById, type Project } from '../server/projects.ts'

/**
 * Messages on the host's own door (protocol 2.95.0): `send_message` and `read_messages` for every
 * agent conversation, known by the place token its module issued — on the URL for one the module
 * launched, passed once as `placeToken` and bound to the connection for one placed afterwards.
 */

const HOST = 'http://127.0.0.1:4180'
const A = 'stand.alpha'
const LAUNCHED = 'llllllllllllllllllllllllllllllll'
const ADOPTED = 'dddddddddddddddddddddddddddddddd'
const DELIVERY: ServiceProvider = {
  module: A,
  name: 'Alpha',
  descriptor: { name: 'Alpha', program: 'Alpha CLI', deliver: '/api/deliver', adopt: 'Type /alpha-here in it.' },
  placed: null,
}

let db: Database
let folder: string
let project: Project
let writing: Canvas
let records: Record<string, { conversation: string; epic: string | null; parts: string[]; kehikko: string | null } | undefined>
let places: ReturnType<typeof placeDesk>
let desk: ReturnType<typeof messageDesk>
let store: AgentMessages

const net = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init)
  const url = new URL(request.url)
  if (url.origin === HOST) return (await places.route(request, url)) ?? new Response('{}', { status: 404 })
  if (url.pathname === '/api/kehikot/place') return Response.json({ ok: true, place: records[url.searchParams.get(PLACE_PARAM) ?? ''] ?? null })
  return new Response('{}', { status: 404 })
}) as unknown as typeof fetch

beforeEach(() => {
  db = open(':memory:')
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'door-messages-')))
  const added = addProject(db, folder, 'thesis')
  if (!added.ok) throw new Error(added.why)
  project = projectById(db, added.project.id)!
  createEpic(folder, { title: 'Methods', slug: 'methods' })
  writing = createCanvas(db, 'writing', project.id)
  store = new AgentMessages(db, () => Date.parse('2026-11-13T12:00:00Z'))
  records = {
    [LAUNCHED]: { conversation: 'conv-launched', epic: 'methods', parts: [], kehikko: writing.key },
    [ADOPTED]: { conversation: 'conv-adopted', epic: 'methods', parts: [], kehikko: writing.key },
  }
  places = placeDesk({
    db,
    inbox: new Inbox(db),
    hostUrl: () => `${HOST}/mcp`,
    doors: async () => [],
    known: () => new Map(),
    open: () => null,
    changed: () => {},
    originOf: async () => 'http://127.0.0.1:4701',
    messagesFor: (here, token) => desk.forNotes(here, token),
    fetch: net,
  })
  desk = messageDesk({ db, messages: store, resolve: (token) => places.resolve(token, null), nameOf: () => 'Alpha', changed: () => {} })
})
afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

async function issue(token: string): Promise<void> {
  await net(`${HOST}/host/place`, { method: 'POST', body: JSON.stringify({ module: A, token, project: folder, kehikko: writing.key }) })
}

/** One call at the door the way `server.ts` makes it: the key from the URL, the argument or the connection's binding. */
async function call(name: string, args: Record<string, unknown>, at: { url?: string | null; session?: string | null } = {}): Promise<{ text: string; isError: boolean }> {
  const token = doorToken(db, at.url ?? null, at.session ?? null, args)
  const { here } = await places.resolve(token, at.session ?? null)
  const door = {
    db,
    here,
    session: at.session ?? null,
    messaging: { serverAnswer: (module: string, method: 'messages.send' | 'messages.read', params: Record<string, unknown>) => desk.serverAnswer(module, method, params), deliverers: () => [DELIVERY] },
  } as unknown as Door
  const said = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } as never, door, { name: 'host', version: '0' })
  const result = (said.body as { result: { content: { text: string }[]; isError?: boolean } }).result
  return { text: result.content.map((one) => one.text).join('\n'), isError: result.isError === true }
}

describe('messaging on the kehikko door', () => {
  test('is listed to every caller', async () => {
    expect(TOOL_NAMES).toContain('send_message')
    expect(TOOL_NAMES).toContain('read_messages')
    const listed = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as never, { db } as unknown as Door, { name: 'host', version: '0' })
    const tools = (listed.body as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } }).result.tools
    const send = tools.find((one) => one.name === 'send_message')!
    expect(send.inputSchema.properties[PLACE_TOKEN_ARG]).toBeDefined()
    expect(tools.some((one) => one.name === 'read_messages')).toBe(true)
  })

  test('a launched conversation messages with the token on its URL, as before', async () => {
    await issue(LAUNCHED)
    const sent = await call('send_message', { body: 'from the launched one' }, { url: LAUNCHED })
    expect(sent).toEqual({ text: 'Sent (message #1).', isError: false })
    expect(store.read(project.id, { module: A, session: 'other', epic: 'methods', kehikko: writing.key, parts: [], space: null }, { unread: false, limit: 20 }).messages[0]!.from.session).toBe('conv-launched')
  })

  test('an adopted conversation messages after passing its key once; the connection keeps it', async () => {
    await issue(ADOPTED)
    const session = openSession(db, 'Some CLI')
    const first = await call('send_message', { body: 'hello', [PLACE_TOKEN_ARG]: ADOPTED }, { session })
    expect(first.isError).toBe(false)
    const again = await call('read_messages', {}, { session })
    expect(again.isError).toBe(false)
    expect(again.text).toContain('conv-adopted')
  })

  test('no key: listed, and refused in words with each delivering module’s way to place a conversation', async () => {
    const said = await call('send_message', { body: 'hi' }, { session: openSession(db, 'Some CLI') })
    expect(said.isError).toBe(true)
    expect(said.text.startsWith(NOT_PLACED_HEAD)).toBe(true)
    expect(said.text).toContain('In Alpha CLI: Type /alpha-here in it.')
  })

  test('a made-up key, or a conversation id given as one, is refused and binds nothing', async () => {
    await issue(ADOPTED)
    const session = openSession(db, 'Some CLI')
    const guessed = await call('send_message', { body: 'hi', [PLACE_TOKEN_ARG]: 'gggggggggggggggggggggggggggggggg' }, { session })
    expect(guessed.isError).toBe(true)
    expect(guessed.text).toContain(DOOR_MESSAGE_SAYS.badKey)
    const byId = await call('send_message', { body: 'hi', [PLACE_TOKEN_ARG]: 'conv-adopted' }, { session })
    expect(byId.isError).toBe(true)
    expect(doorToken(db, null, session, {})).toBeNull()
  })

  test('a disconnected conversation is refused once its module’s record stops placing it (asked again after a moment)', async () => {
    await issue(ADOPTED)
    const session = openSession(db, 'Some CLI')
    expect((await call('send_message', { body: 'one', [PLACE_TOKEN_ARG]: ADOPTED }, { session })).isError).toBe(false)
    records[ADOPTED] = undefined
    /* A desk whose moment has passed: what the module said is not kept. */
    places = placeDesk({ db, inbox: new Inbox(db), hostUrl: () => `${HOST}/mcp`, doors: async () => [], known: () => new Map(), open: () => null, changed: () => {}, originOf: async () => 'http://127.0.0.1:4701', fetch: net })
    expect((await call('send_message', { body: 'two' }, { session })).isError).toBe(true)
  })
})

describe('the delivery knock', () => {
  test('knocks on each delivering module that issued tokens in the project, at most once a second', async () => {
    const knocked: unknown[] = []
    const timers: { run: () => void; ms: number }[] = []
    let now = 10_000
    const knocker = deliveryKnocker({
      deliverers: () => [DELIVERY, { ...DELIVERY, module: 'stand.other' }],
      issuersIn: () => [A],
      pathOf: () => folder,
      originOf: async () => 'http://127.0.0.1:4701',
      now: () => now,
      setTimer: (run, ms) => timers.push({ run, ms }),
      fetch: (async (url: URL, init: RequestInit) => {
        knocked.push([String(url), JSON.parse(String(init.body))])
        return Response.json({ outcome: 'delivered', delivered: 1, why: '' })
      }) as unknown as typeof fetch,
    })
    expect(await knocker.send(project.id)).toBe(1)
    expect(knocked).toEqual([['http://127.0.0.1:4701/api/deliver', { project: folder }]])
    knocker.knock(project.id)
    knocker.knock(project.id)
    expect(timers).toHaveLength(1)
    now += 1000
    timers[0]!.run()
    await new Promise((done) => setTimeout(done, 5))
    expect(knocked).toHaveLength(2)
    expect(AGENT_DELIVERY).toBe('agent.delivery')
  })
})
