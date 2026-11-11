import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVER_PASS_PATH } from 'kehikot-module-protocol'
import { askHost, forgetMessageHosts, serverPassReply } from 'kehikot-module-protocol/serve'

import { answer } from '../server/answers.ts'
import { createCanvas, open, type Canvas } from '../server/canvases.ts'
import { PLACE_PARAM } from '../server/doorPlaces.ts'
import { createEpic } from '../server/holdings.ts'
import { Inbox } from '../server/inbox.ts'
import { placeDesk } from '../server/placeRoutes.ts'
import { addProject } from '../server/projects.ts'
import { serverAskDesk } from '../server/serverAsk.ts'

/**
 * Protocol 2.85.0. `sessions.placeOf { session }`: a module's server asks which place an agent session
 * is filed under in a project, by the session's own id. The host answers from the records its door
 * already reads — the module that issued each place token in that project — and reads no module's folder.
 */

const HOST = 'http://127.0.0.1:4180'
const SESSIONS = 'stand.sessions'
const WORKER = 'stand.worker'
const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ORIGIN: Record<string, string> = { [SESSIONS]: 'http://127.0.0.1:4701', [WORKER]: 'http://127.0.0.1:4702' }

let db: Database
let folder: string
let writing: Canvas
let records: Record<string, { conversation: string; epic: string | null; parts: string[]; kehikko: string | null }>
let places: ReturnType<typeof placeDesk>
let ask: ReturnType<typeof serverAskDesk>
let capabilities: string[]

const net = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init)
  const url = new URL(request.url)
  if (url.origin === HOST) return (await ask.route(request, url)) ?? (await places.route(request, url)) ?? new Response('{}', { status: 404 })
  if (url.pathname === '/api/kehikot/place') {

    return Response.json({ ok: true, place: records[url.searchParams.get(PLACE_PARAM) ?? ''] ?? null })
  }
  if (url.pathname === SERVER_PASS_PATH) {
    const said = serverPassReply('GET', url.pathname, url.searchParams)!
    return Response.json(said.body, { status: said.status })
  }
  return new Response('{}', { status: 404 })
}) as unknown as typeof fetch

beforeEach(() => {
  db = open(':memory:')
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'place-of-')))
  const added = addProject(db, folder, 'thesis')
  if (!added.ok) throw new Error(added.why)
  createEpic(folder, { title: 'Methods', slug: 'methods' })
  writing = createCanvas(db, 'writing', added.project.id)
  records = {
    [TOKEN]: { conversation: 'conv-alpha-0001', epic: 'methods', parts: ['p1'], kehikko: writing.key },
    [OTHER]: { conversation: 'conv-beta-0002', epic: null, parts: [], kehikko: null },
  }
  capabilities = ['sessions:place']
  places = placeDesk({
    db,
    inbox: new Inbox(db),
    hostUrl: () => `${HOST}/mcp`,
    doors: async () => [],
    known: () => new Map(),
    open: () => null,
    changed: () => {},
    originOf: async (id) => ORIGIN[id] ?? null,
    fetch: net,
  })
  ask = serverAskDesk({
    known: (id) => id in ORIGIN,
    originOf: async (id) => ORIGIN[id] ?? null,
    may: (_id, capability) => capabilities.includes(capability),
    projectAt: (at) => (at === folder ? folder : null),
    answer: () => ({ ok: false, reason: 'failed', error: 'not here' }),
    placeOf: (root, session) => places.placeOfSession(root, session),
    fetch: net,
  })
  forgetMessageHosts()
})
afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

/** A session's prompt: the module that runs it asks for its notes with its token, and the host keeps who issued it. */
async function prompt(token: string): Promise<void> {
  await net(`${HOST}/host/place`, { method: 'POST', body: JSON.stringify({ module: SESSIONS, token, project: folder, kehikko: writing.key }) })
}
const placeOf = (session: string, project = folder) => askHost('sessions.placeOf', { session }, { module: WORKER, project, env: { KEHIKOT_ORIGINS: HOST }, fetch: net })

describe('sessions.placeOf', () => {
  test('answers the place the record of that session says, now', async () => {
    await prompt(TOKEN)
    await prompt(OTHER)
    expect(await placeOf('conv-alpha-0001')).toEqual({ ok: true, data: { place: { epic: 'methods', parts: ['p1'], kehikko: writing.key } } })
    expect(await placeOf('conv-beta-0002')).toEqual({ ok: true, data: { place: { epic: null, parts: [], kehikko: null } } })
  })

  test('a session no record names, or a project with no tokens, has no place', async () => {
    expect(await placeOf('conv-alpha-0001')).toEqual({ ok: true, data: { place: null } })
    await prompt(TOKEN)
    expect(await placeOf('conv-nobody')).toEqual({ ok: true, data: { place: null } })
  })

  test('held to sessions:place, and to a project this host holds', async () => {
    await prompt(TOKEN)
    capabilities = []
    expect((await placeOf('conv-alpha-0001')).ok).toBe(false)
    capabilities = ['sessions:place']
    expect((await placeOf('conv-alpha-0001', '/no/such/folder')).ok).toBe(false)
  })

  test('a page is not answered', () => {
    expect(answer(WORKER, 'sessions.placeOf', { session: 'conv-alpha-0001' }, () => true)).toMatchObject({ ok: false })
  })
})
