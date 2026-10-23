import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addressOpenResult, type SharedAddress } from 'kehikot-module-protocol'

import { createCanvas, editCanvas, open, type Placement } from '../server/canvases.ts'
import { own, refusal } from '../server/guard.ts'
import { headersDesk } from '../server/headers.ts'
import { call, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import { Wakes, type News } from '../server/wake.ts'
import {
  NO_ADDRESSES,
  accepted,
  addressOn,
  addressWords,
  freshAt,
  handed,
  offerWords,
  opensOutside,
  readersOn,
  type Addresses,
  type Handing,
} from '@/host/address.ts'
import { makeAsk, type CanvasControls } from '@/host/ask.ts'
import { addressOrderIn } from '@/host/canvases.ts'
import { toWireContext, type Subject } from '@/host/context.ts'
import { ANSWERED_BY_THE_VIEW } from '@/host/division.ts'
import { hold } from '@/host/grants.ts'

/*
 * A web address handed to a kehikko (protocol 2.16.0): into a container that
 * shows pages when there is one, stamped with who asked and when; an offer to
 * the person when a module asked and there is none, with nothing opened; and
 * for an agent, the Browser or nothing.
 */

const AT = '2026-10-23T10:00:00.000Z'
const URL_ = 'https://example.com/design'

const handing = (over: Partial<Handing> = {}): Handing => ({
  kehikko: 1,
  url: URL_,
  asker: { by: 'kehikot.flows' },
  at: AT,
  readers: ['kehikot.browser'],
  ...over,
})

describe('handed: a module asks', () => {
  test('with a container that shows pages, it goes into the context, stamped by and at, and is shown', () => {
    const out = handed(NO_ADDRESSES, handing({ title: 'Design' }))
    expect(out.answer).toEqual({ outcome: 'shown', why: '' })
    expect(out.offer).toBeNull()
    expect(out.next[1]).toEqual({ url: URL_, title: 'Design', intent: 'show', by: 'kehikot.flows', at: AT })
    expect(addressOpenResult.safeParse(out.answer).success).toBe(true)
  })

  test('with none, nothing is opened and nothing goes into the context: the person is offered it', () => {
    const was: Addresses = NO_ADDRESSES
    const out = handed(was, handing({ readers: [], title: 'Design' }))
    expect(out.answer.outcome).toBe('offered')
    expect(out.next).toBe(was)
    expect(out.offer).toEqual({ kehikko: 1, url: URL_, title: 'Design', by: 'kehikot.flows', at: AT })
  })

  test('an address the protocol refuses is declined with its sentence, and nothing is offered', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'http://example.com', 'https://u:p@example.com']) {
      const out = handed(NO_ADDRESSES, handing({ url }))
      expect(out.answer.outcome).toBe('declined')
      expect(out.answer.why.length).toBeGreaterThan(0)
      expect(out.offer).toBeNull()
      expect(out.next).toBe(NO_ADDRESSES)
    }
  })

  test('the same address twice is two requests: each gets its own at, even within one millisecond', () => {
    const first = handed(NO_ADDRESSES, handing())
    const second = handed(first.next, handing())
    expect(second.next[1]!.url).toBe(first.next[1]!.url)
    expect(second.next[1]!.at).not.toBe(first.next[1]!.at)
    expect(Date.parse(second.next[1]!.at!)).toBe(Date.parse(AT) + 1)
    const later = handed(second.next, handing({ at: '2026-10-23T11:00:00.000Z' }))
    expect(later.next[1]!.at).toBe('2026-10-23T11:00:00.000Z')
  })

  test('freshAt keeps a later time and moves an equal or earlier one past the last', () => {
    expect(freshAt(AT, undefined)).toBe(AT)
    expect(freshAt('2026-10-23T10:00:01.000Z', AT)).toBe('2026-10-23T10:00:01.000Z')
    expect(freshAt(AT, AT)).toBe('2026-10-23T10:00:00.001Z')
    expect(freshAt('2026-10-23T09:00:00.000Z', AT)).toBe('2026-10-23T10:00:00.001Z')
  })

  test('one kehikko’s address is its own', () => {
    const one = handed(NO_ADDRESSES, handing())
    const two = handed(one.next, handing({ kehikko: 2, url: 'https://example.org' }))
    expect(addressOn(two.next, 1)?.url).toBe(URL_)
    expect(addressOn(two.next, 2)?.url).toBe('https://example.org')
    expect(addressOn(two.next, 3)).toBeNull()
    expect(addressOn(two.next, null)).toBeNull()
  })
})

describe('handed: an agent asks', () => {
  test('only into a container that shows pages, marked as an agent’s', () => {
    const out = handed(NO_ADDRESSES, handing({ asker: { agent: true } }))
    expect(out.answer.outcome).toBe('shown')
    expect(out.next[1]).toMatchObject({ url: URL_, agent: true })
    expect(out.next[1]!.by).toBeUndefined()
  })

  test('with none, declined: no offer to the person and nothing out into their browser', () => {
    const out = handed(NO_ADDRESSES, handing({ asker: { agent: true }, readers: [] }))
    expect(out.answer.outcome).toBe('declined')
    expect(out.answer.why).toContain('place_modules')
    expect(out.offer).toBeNull()
    expect(out.next).toBe(NO_ADDRESSES)
  })
})

describe('the offer', () => {
  const offer = { kehikko: 1, url: URL_, by: 'kehikot.flows', at: AT }

  test('"Add Browser" puts the address into the context, signed by the module that asked', () => {
    const next = accepted(NO_ADDRESSES, offer, '2026-10-23T10:01:00.000Z')
    expect(next[1]).toEqual({ url: URL_, intent: 'show', by: 'kehikot.flows', at: '2026-10-23T10:01:00.000Z' })
  })

  test('"Open in your browser" only for https:, never for an address on this machine', () => {
    expect(opensOutside(URL_)).toBe(true)
    expect(opensOutside('http://localhost:5173/')).toBe(false)
    expect(offerWords(offer, 'Flows', []).outside).toBe(true)
    expect(offerWords({ ...offer, url: 'http://localhost:5173/' }, 'Flows', []).outside).toBe(false)
    expect(offerWords({ ...offer, url: 'http://localhost:5173/' }, 'Flows', []).lede).toContain('not opened in your browser')
  })

  test('the words name the asker and what could be added, and say nothing was opened', () => {
    const words = offerWords({ ...offer, title: 'Design' }, 'Flows', [{ id: 'kehikot.browser', name: 'Browser' }])
    expect(words.title).toBe('Flows wants to show a page')
    expect(words.lede).toContain('Nothing on this kehikko shows pages')
    expect(words.lede).toContain('Add Browser here')
    expect(words.label).toBe('Design')
  })
})

describe('readers', () => {
  test('a container is a reader when its module says it reacts to address', () => {
    const reacts: Record<string, string[]> = { 'kehikot.browser': ['selection', 'address'], 'kehikot.notes': ['parts'] }
    expect(readersOn(['kehikot.notes', 'kehikot.browser', 'kehikot.unknown'], (id) => reacts[id])).toEqual(['kehikot.browser'])
    expect(readersOn(['kehikot.notes'], (id) => reacts[id])).toEqual([])
  })
})

describe('the context', () => {
  const subject: Subject = { epic: null, project: null, scope: 'epic' } as unknown as Subject
  const shared: SharedAddress = { url: URL_, intent: 'show', by: 'kehikot.flows', at: AT }

  test('carries the address on the kehikko, and none by default', () => {
    const args = [subject, 'light', [], null, null, [], [], { at: null, refreshing: false }, [], [], null] as const
    expect(toWireContext(...args).address).toBeNull()
    expect(toWireContext(...args, shared).address).toEqual(shared)
  })

  test('an address that would not parse is none, and the rest of the context stands', () => {
    const bad = { ...shared, url: 'javascript:alert(1)' } as SharedAddress
    const context = toWireContext(subject, 'dark', [], null, null, [], [], { at: null, refreshing: false }, [], [], null, bad)
    expect(context.address).toBeNull()
    expect(context.theme).toBe('dark')
  })
})

describe('the method', () => {
  function canvas() {
    const calls: unknown[][] = []
    const controls: CanvasControls = {
      showEpic: () => {},
      goto: () => ({ outcome: 'declined', epic: null, why: '' }),
      select: () => {},
      point: () => {},
      locate: () => ({ outcome: 'declined', why: '' }),
      openAddress: (...args) => (calls.push(args), { outcome: 'offered', why: 'asked the person' }),
      show: () => {},
      emit: () => ({ ok: true, delivered: 0 }),
      project: () => null,
      filter: () => ({ ok: true as const, filters: {} }),
      pickProject: () => Promise.resolve({ outcome: 'declined' as const, project: null, why: '' }),
      fold: () => ({ outcome: 'declined' as const, folded: [], unfolded: [], why: '' }),
    }
    return { controls, calls }
  }

  test('answered by the view, under address:open', () => {
    expect([...ANSWERED_BY_THE_VIEW]).toContain('address.open')
    expect(hold('address.open', () => false)).toMatchObject({ held: true, capability: 'address:open' })
  })

  test('reaches the canvas with the registration’s id, the schema’s url, title and intent', async () => {
    const { controls, calls } = canvas()
    const out = await makeAsk('kehikot.flows', controls, (c) => c === 'address:open')('address.open', { url: URL_, title: ' Design ' })
    expect(out).toEqual({ ok: true, data: { outcome: 'offered', why: 'asked the person' } })
    expect(calls).toEqual([['kehikot.flows', URL_, 'Design', undefined]])
  })

  test('a bad address never reaches the canvas', async () => {
    const { controls, calls } = canvas()
    const ask = makeAsk('kehikot.flows', controls, () => true)
    for (const url of ['javascript:alert(1)', 'file:///x', 'https://a:b@example.com']) {
      const out = await ask('address.open', { url })
      expect(out.ok).toBe(false)
    }
    expect(calls).toEqual([])
  })

  test('a module that did not declare address:open is not answered', async () => {
    const { controls, calls } = canvas()
    const out = await makeAsk('kehikot.flows', controls, () => false)('address.open', { url: URL_ })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('address:open')
    expect(calls).toEqual([])
  })
})

describe('read_canvas’s line', () => {
  test('says the address, its title and who handed it over, on one line', () => {
    expect(addressWords(null)).toContain('address: none')
    const line = addressWords({ url: URL_, title: 'Design\ndoc', intent: 'show', by: 'kehikot.flows', at: AT })
    expect(line).toContain(URL_)
    expect(line).toContain('"Design doc"')
    expect(line).toContain('kehikot.flows')
    expect(line).not.toContain('\n')
    expect(addressWords({ url: URL_, intent: 'show', agent: true })).toContain('by an agent')
  })
})

describe('the order on the page’s side', () => {
  test('one addressed to this page is read; another page’s, or a bad address, is not an order', () => {
    const order = { id: 'o1', page: 'page-a', kehikko: 3, url: URL_, title: 'Design' }
    expect(addressOrderIn(order, 'page-a')).toEqual({ id: 'o1', kehikko: 3, url: URL_, title: 'Design' })
    expect(addressOrderIn(order, 'page-b')).toBeNull()
    expect(addressOrderIn({ ...order, url: 'javascript:alert(1)' }, 'page-a')).toBeNull()
    expect(addressOrderIn({ ...order, kehikko: 0 }, 'page-a')).toBeNull()
    expect(addressOrderIn(null, 'page-a')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * The agent's door: open_address, through the page
 * ------------------------------------------------------------------ */

const PAGE = 'http://127.0.0.1:4181'
const ORIGINS = [PAGE, 'http://localhost:4181']

let db: Database
let openness: Openness
let wakes: Wakes
let folder: string
let desk: ReturnType<typeof headersDesk>

const door = (): Door => ({
  db,
  which: () => openness.open(),
  watched: () => openness.every(),
  wake: () => {},
  epicsChanged: () => {},
  dispositionsChanged: () => {},
  headers: desk.door,
  seen: async () => [{ id: 'kehikot.browser', name: 'Browser', condition: 'ready' }],
})

beforeEach(() => {
  db = open(':memory:')
  openness = new Openness()
  wakes = new Wakes()
  folder = mkdtempSync(join(tmpdir(), 'kehikko-address-'))
  desk = headersDesk({ hears: (page) => wakes.hears(page), send: (order) => wakes.press(order), sendAddress: (order) => wakes.address(order), waitMs: 60 })
})
afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

function aCanvas(): number {
  const added = addProject(db, folder, 'a project')
  if (!added.ok) throw new Error(added.why)
  const made = createCanvas(db, 'the wire', added.project.id)
  editCanvas(db, made.id, { placements: [{ i: 'kehikot.browser', x: 0, y: 0, w: 6, h: 10, wish: 10 }] as Placement[] })
  return made.id
}

const post = async (path: string, body: unknown) => {
  const headers = { origin: PAGE, 'content-type': 'application/json' }
  const request = new Request(`http://127.0.0.1:4180${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const refused = refusal({ method: 'POST', pathname: path, headers: request.headers }, own({}, 4180, ORIGINS))
  if (refused) return new Response(JSON.stringify({ ok: false, why: refused.why }), { status: refused.status })
  return desk.route(request, new URL(request.url))
}

/** A page with the kehikko open, answering an address order with `answer` — as `addressedRef` in App does. */
async function aPage(kehikko: number, name: string, answer: { ok: boolean; why: string }, address: SharedAddress | null = null) {
  const heard: News[] = []
  const stop = wakes.listen((news) => {
    heard.push(news)
    const order = addressOrderIn((news as { address?: unknown }).address, name)
    if (order) void post('/host/pressed', { page: name, id: order.id, ...answer })
  }, name)
  openness.reported(name, kehikko)
  const posted = await post('/host/headers', { page: name, kehikko, at: Date.now(), headers: {}, address })
  expect(posted!.status).toBe(200)
  return { heard, stop }
}

describe('open_address', () => {
  test('goes to the page that has the kehikko open, and says what it showed', async () => {
    const id = aCanvas()
    const page = await aPage(id, 'page-a', { ok: true, why: '' })
    const other = await aPage(aCanvas(), 'page-b', { ok: true, why: '' })
    const done = await call('open_address', { kehikko: id, url: URL_, title: 'Design' }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain(`Showed ${URL_} on kehikko ${id}`)
    const orders = page.heard.filter((news) => 'address' in news)
    expect(orders).toHaveLength(1)
    expect((orders[0] as { address: { url: string; title?: string } }).address).toMatchObject({ url: URL_, title: 'Design', kehikko: id })
    /* Only that page's streams: the other page hears nothing of it. */
    expect(other.heard.filter((news) => 'address' in news)).toHaveLength(0)
    expect(desk.held.waiting).toBe(0)
  })

  test('the page’s refusal comes back — nothing on the kehikko shows pages, so nothing was opened', async () => {
    const id = aCanvas()
    await aPage(id, 'page-a', { ok: false, why: 'Nothing on this kehikko shows pages, so the address was not opened anywhere.' })
    const done = await call('open_address', { kehikko: id, url: URL_ }, door())
    expect(done).toEqual({ text: 'Not opened: Nothing on this kehikko shows pages, so the address was not opened anywhere.', failed: true })
  })

  test('a bad address is refused before anything is sent', async () => {
    const id = aCanvas()
    const page = await aPage(id, 'page-a', { ok: true, why: '' })
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com', 'https://user:pw@example.com', 42]) {
      const done = await call('open_address', { kehikko: id, url }, door())
      expect(done.failed).toBe(true)
      expect(done.text).toContain('Nothing was opened.')
    }
    const titled = await call('open_address', { kehikko: id, url: URL_, title: '' }, door())
    expect(titled.failed).toBe(true)
    expect(page.heard.filter((news) => 'address' in news)).toHaveLength(0)
  })

  test('no page has the kehikko open: refused, and nothing is queued', async () => {
    const id = aCanvas()
    const done = await call('open_address', { kehikko: id, url: URL_ }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('is not open on a page of this host that is listening')
    expect(desk.held.waiting).toBe(0)
  })

  test('read_canvas says the last address the page holds', async () => {
    const id = aCanvas()
    await aPage(id, 'page-a', { ok: true, why: '' }, { url: URL_, title: 'Design', intent: 'show', by: 'kehikot.flows', at: AT })
    const read = await call('read_canvas', { kehikko: id }, door())
    expect(read.text).toContain(`address: ${URL_} "Design", handed over by kehikot.flows`)
  })

  test('a posted address that would not parse is none', async () => {
    const id = aCanvas()
    await aPage(id, 'page-a', { ok: true, why: '' }, { url: 'javascript:alert(1)', intent: 'show' } as SharedAddress)
    expect(desk.door.address(id)).toBeNull()
  })
})
