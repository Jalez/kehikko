import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, editCanvas, open, setSubject, type Canvas } from '../server/canvases.ts'
import { ASK_MS, openSession, PLACE_PARAM, projectByUid, sessionOf } from '../server/doorPlaces.ts'
import { createEpic, editParts } from '../server/holdings.ts'
import { Inbox } from '../server/inbox.ts'
import { call, mcp, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { ASK_PREFIX, doorsFor, nameFor, placeDesk, withToken } from '../server/placeRoutes.ts'
import { addProject, projectById, relinkProject, type Project } from '../server/projects.ts'
import { askChoices, isPlaceAsk } from '../src/host/placeAsk.ts'

/**
 * Each conversation knows its OWN place (protocol 2.4.0): what a record says,
 * never what the person has on screen. Two records, each with one owner — a
 * module's record of the conversations it started (asked by token), and the
 * host's record of an MCP session tied by an explicit act — and a door that
 * says which it answered from, or that it fell back to the person's view.
 */

const TOKEN_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const PAGE = 'page-1'

let db: Database
let openness: Openness
let inbox: Inbox
let folder: string
let project: Project
let canvas: Canvas
let other: Canvas
/** What the module that issued the tokens records, by token: the stand-in for Claude's places.json. */
let records: Record<string, { conversation: string; epic: string | null; parts: string[]; kehikko: string | null }>
let changed: number[]
let desk: ReturnType<typeof placeDesk>

const module = (async (url: string) => {
  const token = new URL(url).searchParams.get(PLACE_PARAM) ?? ''
  return new Response(JSON.stringify({ ok: true, place: records[token] ?? null }), { status: 200 })
}) as unknown as typeof fetch

beforeEach(() => {
  db = open(':memory:')
  openness = new Openness()
  inbox = new Inbox(db)
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'frame-place-')))
  const added = addProject(db, folder, 'thesis')
  if (!added.ok) throw new Error(added.why)
  project = projectById(db, added.project.id)!
  createEpic(folder, { title: 'Methods', slug: 'methods' })
  createEpic(folder, { title: 'Results', slug: 'results' })
  editParts(folder, 'methods', { add: { name: 'Data' } })
  canvas = createCanvas(db, 'writing', project.id)
  editCanvas(db, canvas.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
  other = createCanvas(db, 'review', project.id)
  /* The person is looking at RESULTS, on the review kehikko. */
  setSubject(db, project.id, { epic: 'results', parts: [] })
  openness.reported(PAGE, other.id)
  records = {
    [TOKEN_A]: { conversation: '11111111-1111-4111-8111-111111111111', epic: 'methods', parts: ['data'], kehikko: canvas.key },
    [TOKEN_B]: { conversation: '22222222-2222-4222-8222-222222222222', epic: 'results', parts: [], kehikko: other.key },
  }
  changed = []
  desk = placeDesk({
    db,
    inbox,
    hostUrl: () => 'http://127.0.0.1:4180/mcp',
    doors: async () => [
      { module: 'a.one', declared: null, url: 'http://127.0.0.1:4601/mcp', transport: 'http' },
      { module: 'a.two', declared: null, url: 'http://127.0.0.1:4602/mcp', transport: 'http' },
    ],
    known: () => new Map<string, unknown>([['my-one', { type: 'http', url: 'http://127.0.0.1:4601/mcp' }]]),
    open: () => {
      const open = openness.open()
      return open.ok ? open.id : null
    },
    changed: (id) => changed.push(id),
    originOf: async (id) => (id === 'kehikot.claude' ? 'http://127.0.0.1:4590' : null),
    fetch: module,
  })
})
afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

const issue = (token: string, kehikko: string | null) =>
  desk.route(new Request('http://127.0.0.1:4180/host/place', { method: 'POST', body: JSON.stringify({ module: 'kehikot.claude', token, project: folder, kehikko }) }), new URL('http://127.0.0.1:4180/host/place'))

/** A door as the server hands it, for a call with this token and this MCP session. */
async function doorFor(token: string | null, session: string | null = null): Promise<Door> {
  const { here, unrecorded } = await desk.resolve(token, session)
  return {
    db,
    which: () => openness.open(),
    watched: () => openness.every(),
    wake: () => {},
    epicsChanged: () => {},
    dispositionsChanged: () => {},
    seen: async () => [{ id: 'a.one', name: 'One', condition: 'ready' }],
    here,
    unrecorded,
    session,
    places: desk.places,
    inbox,
  }
}

const text = async (name: Parameters<typeof call>[0], door: Door, args: Record<string, unknown> = {}) => {
  const reply = await mcp({ id: 1, method: 'tools/call', params: { name, arguments: args } }, door, { name: 'kehikko', version: 't' })
  return (reply.body as { result: { content: { text: string }[]; isError?: boolean } }).result
}

describe('a module that starts conversations issues a token, and gets the doors with it on', () => {
  test('the host’s door and the doors of the modules on that kehikko, under the names the person’s config uses', async () => {
    const reply = await issue(TOKEN_A, canvas.key)
    expect(reply!.status).toBe(200)
    const body = (await reply!.json()) as { ok: boolean; token: string; doors: { module: string; name: string; url: string; transport: string }[] }
    expect(body.token).toBe(TOKEN_A)
    expect(body.doors).toEqual([
      { module: 'kehikko', name: 'kehikko', url: `http://127.0.0.1:4180/mcp?${PLACE_PARAM}=${TOKEN_A}`, transport: 'http' },
      /* The person connected a.one as "my-one": the session's entry replaces theirs by that name. */
      { module: 'a.one', name: 'my-one', url: `http://127.0.0.1:4601/mcp?${PLACE_PARAM}=${TOKEN_A}`, transport: 'http' },
    ])
  })

  test('a token that is not spelled as one, or a folder the host does not hold, is refused', async () => {
    expect((await desk.route(new Request('http://x/host/place', { method: 'POST', body: JSON.stringify({ module: 'kehikot.claude', token: 'short', project: folder }) }), new URL('http://x/host/place')))!.status).toBe(400)
    expect((await desk.route(new Request('http://x/host/place', { method: 'POST', body: JSON.stringify({ module: 'kehikot.claude', token: TOKEN_A, project: '/nowhere' }) }), new URL('http://x/host/place')))!.status).toBe(404)
  })

  test('names: the person’s own name for a door, else the name the plug would give', () => {
    expect(nameFor({ module: 'a.two', declared: null, url: 'http://127.0.0.1:4602/mcp', transport: 'http' }, new Map())).toBe('two')
    expect(nameFor({ module: 'a.two', declared: 'second', url: 'http://127.0.0.1:4602/mcp', transport: 'http' }, new Map())).toBe('second')
    expect(withToken('http://127.0.0.1:4602/mcp', TOKEN_A)).toBe(`http://127.0.0.1:4602/mcp?${PLACE_PARAM}=${TOKEN_A}`)
    expect(doorsFor({ token: TOKEN_A, canvas: null }, 'http://127.0.0.1:4180/mcp', [], new Map()).map((one) => one.name)).toEqual(['kehikko'])
  })
})

describe('two conversations on two epics, and the person switching', () => {
  test('each my_place and read_canvas answers about its own epic, and says what the person is on', async () => {
    await issue(TOKEN_A, canvas.key)
    await issue(TOKEN_B, other.key)
    const a = await text('my_place', await doorFor(TOKEN_A))
    expect(a.content[0]!.text).toContain(`This conversation belongs to ${project.name} (${folder}), epic methods (parts data) on kehikko "writing" — as kehikot.claude records it.`)
    expect(a.content[0]!.text).toContain('The person is looking at something else now (epic results on kehikko "review")')
    const b = await text('my_place', await doorFor(TOKEN_B))
    expect(b.content[0]!.text).toContain('epic results on kehikko "review"')
    expect(b.content[0]!.text).toContain('The person is looking at this place now.')

    const canvasA = (await text('read_canvas', await doorFor(TOKEN_A))).content[0]!.text
    expect(canvasA).toContain(`kehikko ${canvas.id}: writing — this conversation’s own kehikko — not the one on screen now`)
    expect(canvasA).toContain('epic: methods — this conversation\'s epic.')
    expect(canvasA).toContain('parts this conversation is about: data')

    /* The person switches to methods on the writing kehikko: A is now on screen, B is not. */
    setSubject(db, project.id, { epic: 'methods', parts: ['data'] })
    openness.reported(PAGE, canvas.id)
    expect((await text('my_place', await doorFor(TOKEN_A))).content[0]!.text).toContain('The person is looking at this place now.')
    const later = (await text('read_canvas', await doorFor(TOKEN_B))).content[0]!.text
    expect(later).toContain('epic: results — this conversation\'s epic.')
    expect(later).toContain('The person is looking at something else now (epic methods (parts data) on kehikko "writing")')
  })

  test('set_parts and read_tracker default to the conversation’s epic, not the one on screen', async () => {
    await issue(TOKEN_A, canvas.key)
    const done = await text('set_parts', await doorFor(TOKEN_A), { add: { name: 'Analysis' } })
    expect(done.isError).toBeUndefined()
    expect(done.content[0]!.text).toContain('The parts of methods')
  })

  test('the record is read as it is NOW: a conversation moved to another place is answered there', async () => {
    await issue(TOKEN_A, canvas.key)
    records[TOKEN_A] = { ...records[TOKEN_A]!, epic: 'results', parts: [] }
    await new Promise((done) => setTimeout(done, 2100))
    expect((await text('my_place', await doorFor(TOKEN_A))).content[0]!.text).toContain('epic results')
  })

  test('a token whose module has no record is said, never guessed past', async () => {
    await issue(TOKEN_A, canvas.key)
    delete records[TOKEN_A]
    const door = await doorFor(TOKEN_A)
    expect(door.here).toBeNull()
    expect((await text('my_place', door)).content[0]!.text).toContain('carries a place from kehikot.claude, but kehikot.claude has no record for it')
  })

  test('GET /host/place answers a module’s door with the place and what the person is looking at', async () => {
    await issue(TOKEN_A, canvas.key)
    const url = new URL(`http://127.0.0.1:4180/host/place?${PLACE_PARAM}=${TOKEN_A}`)
    const body = (await (await desk.route(new Request(url), url))!.json()) as { place: Record<string, unknown> }
    expect(body.place).toMatchObject({
      token: TOKEN_A,
      conversation: '11111111-1111-4111-8111-111111111111',
      projectId: project.uid,
      project: folder,
      epic: 'methods',
      parts: ['data'],
      kehikko: { key: canvas.key, name: 'writing' },
      looking: { epic: 'results', kehikko: { key: other.key, name: 'review' } },
    })
    const unknown = new URL(`http://127.0.0.1:4180/host/place?${PLACE_PARAM}=${'z'.repeat(32)}`)
    expect(await (await desk.route(new Request(unknown), unknown))!.json()).toEqual({ ok: true, place: null })
  })

  test('a renamed project folder is followed: the token keeps the project’s id', async () => {
    await issue(TOKEN_A, canvas.key)
    const moved = `${folder}-renamed`
    renameSync(folder, moved)
    relinkProject(db, project.id, moved)
    expect(projectByUid(db, project.uid!)?.path).toBe(moved)
    expect((await text('my_place', await doorFor(TOKEN_A))).content[0]!.text).toContain(`(${moved})`)
    renameSync(moved, folder)
  })
})

describe('a conversation nobody started from a place', () => {
  test('initialize hands it an MCP session; my_place says it is not recorded and asks the person in the Inbox, once', async () => {
    const init = await mcp({ id: 0, method: 'initialize', params: { clientInfo: { name: 'claude-code', title: 'Claude Code' } } as never }, await doorFor(null), { name: 'kehikko', version: 't' })
    const session = init.headers?.['mcp-session-id']
    expect(session).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    const said = (await text('my_place', await doorFor(null, session!))).content[0]!.text
    expect(said).toContain('This conversation isn’t recorded under any place.')
    expect(said).toContain('For information only, NOT this conversation’s place: The person is looking at')
    expect(said).not.toContain('This conversation belongs')
    const asks = inbox.open(project.id).filter((one) => isPlaceAsk(one))
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ module: 'kehikko', id: `${ASK_PREFIX}${session}`, state: 'attention', label: 'A Claude Code session asks which epic it is for' })
    await text('my_place', await doorFor(null, session!))
    expect(inbox.open(project.id).filter((one) => isPlaceAsk(one))).toHaveLength(1)
    expect(ASK_MS).toBeGreaterThan(0)
  })

  test('the person’s press records it; the ask closes and later calls answer about that epic', async () => {
    const session = openSession(db, 'Claude Code')
    await text('my_place', await doorFor(null, session))
    const url = new URL('http://127.0.0.1:4180/host/place/answer')
    const reply = await desk.route(new Request(url, { method: 'POST', body: JSON.stringify({ project: project.id, session: `${ASK_PREFIX}${session}`, epic: 'methods', kehikko: canvas.id }) }), url)
    expect(reply!.status).toBe(200)
    expect(inbox.open(project.id).filter((one) => isPlaceAsk(one))).toHaveLength(0)
    expect(sessionOf(db, session)?.place).toMatchObject({ epic: 'methods', kehikko: canvas.key })
    const after = (await text('my_place', await doorFor(null, session))).content[0]!.text
    expect(after).toContain('epic methods on kehikko "writing" — as recorded for this connection.')
    expect(after).toContain('If the agent restarts or reconnects, it is a new connection with no record')
  })

  test('set_my_place records what the person said, only for an epic the project has', async () => {
    const session = openSession(db, 'Claude Code')
    const refused = await text('set_my_place', await doorFor(null, session), { epic: 'nonsense', kehikko: canvas.id })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toContain('Nothing was recorded.')
    const done = await text('set_my_place', await doorFor(null, session), { epic: 'methods', parts: ['data'], kehikko: canvas.id })
    expect(done.content[0]!.text).toContain('Recorded. This conversation belongs to')
    expect((await doorFor(null, session)).here?.epic).toBe('methods')
  })

  test('a conversation with a token cannot be re-recorded by set_my_place: the module’s record stays', async () => {
    await issue(TOKEN_A, canvas.key)
    const refused = await text('set_my_place', await doorFor(TOKEN_A, openSession(db, 'x')), { epic: 'results' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toContain('That record is kehikot.claude')
  })

  test('a tool that fell back to the person’s view says so', async () => {
    const reply = await text('read_inbox', await doorFor(null, null))
    expect(reply.content[0]!.text).toContain('This conversation is not recorded under any place, so this answer is about what the person has open NOW')
  })

  test('the page’s quick answers: the epic on screen first, the others, then none', () => {
    expect(askChoices('results', [{ slug: 'methods', title: 'Methods' }, { slug: 'results', title: 'Results' }])).toEqual([
      { epic: 'results', label: 'Results (on screen)' },
      { epic: 'methods', label: 'Methods' },
      { epic: null, label: 'Not about an epic' },
    ])
  })
})
