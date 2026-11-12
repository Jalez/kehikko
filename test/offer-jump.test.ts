import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inboxItemSchema, inboxReadResult } from 'kehikot-module-protocol'

import { createCanvas, listCanvases, open, readSubject, setSubject } from '../server/canvases.ts'
import type { Here } from '../server/doorPlaces.ts'
import { PAGE_ONLY } from '../server/guard.ts'
import { epicsDir } from '../server/hostData.ts'
import { Inbox } from '../server/inbox.ts'
import { inboxDesk } from '../server/inboxRoutes.ts'
import { call, TOOL_NAMES, type Door } from '../server/mcp.ts'
import { MessageMutes } from '../server/messageMutes.ts'
import { Openness } from '../server/open.ts'
import { addProject, type Project } from '../server/projects.ts'
import { applyList, closedWords, isLive, isOffer, type Entry } from '../src/host/inbox.ts'
import { answerInbox, itemOf, readOf, type InboxDoor } from '../src/host/inboxDoor.ts'
import { jumpMarkText, markAfter, offerAsk, planJump, type JumpFacts, type Place } from '../src/host/jump.ts'

/*
 * `offer_jump`: an agent OFFERS to take the person somewhere instead of jumping them unasked. It
 * files one Inbox item from the calling session, by the session's agent module, with a "Take me
 * there" (`go`, protocol 2.87.0); the person decides. It never moves the view; one open offer per
 * session; the person's mutes hold; taking it (`inbox.open`, page-only, fresh press) goes as the
 * jump would with Go back, and closes it. No MCP tool takes or dismisses one.
 */

let db: Database
let openness: Openness
let folders: string[]
let project: Project
let other: Project
let kehikko: number
let inbox: Inbox
let jumped: unknown[]
let changed: { project: number; rev: number }[]
let clock: number

const STEPS = [{ title: 'Read the code' }, { title: 'Fix the test' }, { title: 'Cap the rate' }]

function aProject(name: string, epics: Record<string, unknown>): Project {
  const outer = mkdtempSync(join(tmpdir(), 'kehikko-offer-'))
  folders.push(outer)
  const folder = join(outer, name)
  mkdirSync(epicsDir(folder), { recursive: true })
  for (const [slug, epic] of Object.entries(epics)) writeFileSync(join(epicsDir(folder), `${slug}.json`), JSON.stringify(epic))
  const added = addProject(db, folder, name)
  if (!added.ok) throw new Error(added.why)
  return added.project
}

beforeEach(() => {
  db = open(':memory:')
  openness = new Openness()
  folders = []
  project = aProject('Kehikko', {
    auth: { slug: 'auth', title: 'Sign-in', steps: STEPS, parts: [{ id: 'p1', name: 'Tokens' }, { id: 'p3', name: 'Tests' }] },
    other: { slug: 'other', title: 'Other', steps: [] },
  })
  other = aProject('Paper', { thesis: { slug: 'thesis', title: 'Thesis', steps: [] } })
  kehikko = createCanvas(db, 'Main', project.id).id
  createCanvas(db, 'Draft', other.id)
  setSubject(db, project.id, { epic: 'other' })
  openness.reported('page-1', kehikko)
  clock = 50_000
  inbox = new Inbox(db, () => clock)
  jumped = []
  changed = []
})
afterEach(() => {
  db.close()
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

const hereOf = (conversation: string, module = 'a.agent', at: Project = project): Here => ({
  token: `tok-${conversation}`,
  via: 'token',
  module,
  conversation,
  project: at,
  epic: 'auth',
  parts: [],
  key: null,
  canvas: null,
})

const door = (here: Here | null = hereOf('c1')): Door => ({
  db,
  which: () => openness.open(),
  watched: () => openness.every(),
  wake: () => {},
  epicsChanged: () => {},
  dispositionsChanged: () => {},
  seen: async () => [{ id: 'a.agent', name: 'Agent', condition: 'ready' }],
  headers: {
    on: () => new Map(),
    press: async () => null,
    jump: async (k, ask) => {
      jumped.push({ k, ask })
      return { ok: true, why: '' }
    },
  },
  now: () => clock,
  log: () => {},
  inbox,
  inboxChanged: (one, rev) => void changed.push({ project: one, rev }),
  here,
})

const offers = (at: Project = project) => inbox.open(at.id).filter(isOffer)

describe('offer_jump files one Inbox item and never moves the view', () => {
  test('one item, by the session’s agent module, saying why, carrying the place; nothing moves', async () => {
    const before = { subject: readSubject(db, project.id), canvases: listCanvases(db), open: openness.open() }
    const done = await call('offer_jump', { epic: 'auth', parts: ['Tests'], step: 2, why: 'The failing test is in the auth epic, part 3.' }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toStartWith('Offered; the person can go there from the Inbox.')
    expect(jumped).toEqual([])
    expect(readSubject(db, project.id)).toEqual(before.subject)
    expect(listCanvases(db)).toEqual(before.canvases)
    expect(openness.open()).toEqual(before.open)
    const [one, ...rest] = offers()
    expect(rest).toEqual([])
    expect(one).toMatchObject({
      module: 'a.agent',
      name: 'Agent',
      state: 'done',
      priority: 'normal',
      label: 'The failing test is in the auth epic, part 3.',
      place: { epic: 'auth', parts: ['p3'] },
      go: { step: 2, title: 'Fix the test' },
      origin: 'offer',
    })
    expect(changed.map((c) => c.project)).toEqual([project.id])
  })

  test('why is plain text, clipped to the label’s limit', async () => {
    await call('offer_jump', { epic: 'auth', why: `Look  here\n${'x'.repeat(300)}` }, door())
    const [one] = offers()
    expect(one!.label.length).toBe(120)
    expect(one!.label).toStartWith('Look here x')
    expect(one!.label.endsWith('…')).toBe(true)
  })

  test('the target is resolved as strictly as jump’s, and a project left out is the conversation’s', async () => {
    expect((await call('offer_jump', { epic: 'nope', why: 'x' }, door())).text).toContain('Its epics: ')
    expect((await call('offer_jump', { why: 'x' }, door())).text).toContain('offer_jump needs somewhere to go')
    expect((await call('offer_jump', { epic: 'auth' }, door())).text).toContain('why is what you want to show')
    expect(offers()).toEqual([])
    await call('offer_jump', { kehikko: 'Draft', why: 'The draft' }, door(hereOf('c1', 'a.agent', other)))
    expect(offers(other)).toHaveLength(1)
  })

  test('refused for a call no agent module’s session made', async () => {
    const done = await call('offer_jump', { epic: 'auth', why: 'x' }, door(null))
    expect(done.failed).toBe(true)
    expect(done.text).toContain('Nothing was offered.')
    expect(offers()).toEqual([])
  })
})

describe('one open offer per session', () => {
  test('a second offer replaces the first; another session’s stands', async () => {
    await call('offer_jump', { epic: 'auth', why: 'First' }, door())
    clock += 1000
    const again = await call('offer_jump', { epic: 'auth', step: 3, why: 'Second' }, door())
    expect(again.text).toContain('replaced your earlier open offer')
    expect(offers().map((one) => one.label)).toEqual(['Second'])
    await call('offer_jump', { epic: 'other', why: 'Another session' }, door(hereOf('c2')))
    expect(offers().map((one) => one.label).sort()).toEqual(['Another session', 'Second'])
  })

  test('an offer into another project closes the session’s open one here as replaced', async () => {
    await call('offer_jump', { epic: 'auth', why: 'Here' }, door())
    await call('offer_jump', { project: 'Paper', why: 'There' }, door())
    expect(offers()).toEqual([])
    expect(offers(other).map((one) => one.label)).toEqual(['There'])
    const closed = inbox.all(project.id).find(isOffer)!
    expect(closed.how).toBe('replaced')
    expect(changed.map((c) => c.project)).toEqual([project.id, other.id, project.id])
  })

  test('a replaced offer that was dismissed comes back as the new one', async () => {
    await call('offer_jump', { epic: 'auth', why: 'First' }, door())
    inbox.dismiss(project.id, offers())
    expect(offers().filter(isLive)).toEqual([])
    clock += 1000
    await call('offer_jump', { epic: 'auth', why: 'Second' }, door())
    expect(offers().filter(isLive).map((one) => one.label)).toEqual(['Second'])
  })
})

describe('the person’s mutes hold', () => {
  test('"Use inbox" off for the module: nothing is filed', async () => {
    inbox.use('a.agent', false)
    const done = await call('offer_jump', { epic: 'auth', why: 'x' }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('"Use inbox"')
    expect(offers()).toEqual([])
  })
  test('its messages muted in the project: nothing is filed', async () => {
    new MessageMutes(db).set(project.id, 'a.agent', true)
    const done = await call('offer_jump', { epic: 'auth', why: 'x' }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('muted Agent’s messages')
    expect(offers()).toEqual([])
    /* Muted in another project only: the offer here is filed. */
    new MessageMutes(db).set(project.id, 'a.agent', false)
    new MessageMutes(db).set(other.id, 'a.agent', true)
    expect((await call('offer_jump', { epic: 'auth', why: 'x' }, door())).failed).toBe(false)
  })
})

describe('the module’s own list never closes or overwrites an offer', () => {
  test('a report without it, or with its id, leaves the offer as it is', async () => {
    await call('offer_jump', { epic: 'auth', why: 'Offer' }, door())
    const [offer] = offers()
    inbox.report(project.id, 'a.agent', 'Agent', [{ id: 'run', state: 'working', label: 'Running' }])
    inbox.report(project.id, 'a.agent', 'Agent', [{ id: offer!.id, state: 'attention', label: 'Hijack' }])
    inbox.report(project.id, 'a.agent', 'Agent', [], { silent: true })
    expect(offers()).toEqual([offer!])
    /* The pure rule, as the page runs it too. */
    const applied = applyList([offer!], 'a.agent', 'Agent', [], { now: clock })
    expect(applied.puts).toEqual([])
  })
})

describe('taking an offer', () => {
  test('took marks it seen and closes it as taken; only offers, only open ones', async () => {
    await call('offer_jump', { epic: 'auth', why: 'Offer' }, door())
    inbox.report(project.id, 'a.agent', 'Agent', [{ id: 'run', state: 'done', label: 'Ran' }])
    const [offer] = offers()
    expect(inbox.took(project.id, [offer!, { module: 'a.agent', id: 'run' }]).changed).toBe(1)
    const closed = inbox.entry(project.id, offer!.module, offer!.id)!
    expect(closed).toMatchObject({ how: 'taken', seen: closed.entered })
    expect(closed.closed).not.toBeNull()
    expect(closedWords(closed)).toBe('offer taken: you went there')
    expect(inbox.entry(project.id, 'a.agent', 'run')!.closed).toBeNull()
    expect(inbox.took(project.id, [offer!]).changed).toBe(0)
  })

  test('the page’s route takes it, and is the page’s alone', async () => {
    await call('offer_jump', { epic: 'auth', why: 'Offer' }, door())
    const [offer] = offers()
    const routes = inboxDesk({ inbox, pathOf: () => project.path, changed: () => {} })
    const url = new URL('http://127.0.0.1/host/inbox/act')
    const got = await routes.route(
      new Request(url, { method: 'POST', body: JSON.stringify({ project: project.id, do: 'took', keys: [{ module: offer!.module, id: offer!.id }] }) }),
      url,
    )
    expect(((await got!.json()) as { changed: number }).changed).toBe(1)
    expect(offers()).toEqual([])
    expect(PAGE_ONLY).toContain('/host/inbox/act')
  })

  test('it goes as the jump would: what the agent named, the rest where the person is; marked with Go back', () => {
    const offer = { place: { epic: 'auth', parts: ['p3'] }, go: { step: 2, title: 'Fix the test' } }
    const facts: JumpFacts = {
      projects: [{ id: 1, name: 'Kehikko' }, { id: 2, name: 'Paper' }],
      kehikotOf: () => [{ key: 'main', name: 'Main' }],
      subjectOf: () => ({ epic: 'thesis', parts: [] }),
    }
    const now: Place = { project: 1, kehikko: 'main', epic: 'other', parts: [], step: null }
    expect(offerAsk(offer, 1, 1)).toEqual({ epic: 'auth', parts: ['p3'], step: 2, title: 'Fix the test' })
    expect(offerAsk({}, 2, 1)).toEqual({ project: 2 })
    const plan = planJump(offerAsk(offer, 1, 1), now, facts)
    expect(plan).toEqual({ kind: 'go', target: { project: 1, kehikko: 'main', epic: 'auth', parts: ['p3'], step: 2 } })
    if (plan.kind !== 'go') throw new Error('no plan')
    const mark = { ...markAfter(null, now, plan.target, 'Fix the test', 'Agent'), offer: true }
    expect(mark.back).toEqual(now)
    expect(jumpMarkText(mark)).toBe('Went here on Agent’s offer, at step 2 (Fix the test).')
  })
})

describe('the Inbox module sees it as an item to go to, and only the person takes it', () => {
  const offerEntry = (): Entry => ({
    module: 'a.agent',
    name: 'Agent',
    id: 'offer:abc',
    state: 'done',
    label: 'The failing test is in part 3',
    place: { epic: 'auth', parts: ['p3'] },
    priority: 'normal',
    refs: [],
    go: { step: 2 },
    entered: 1,
    opened: 1,
    closed: null,
    how: null,
    seen: null,
    dismissed: null,
    origin: 'offer',
  })
  const pageDoor = (entries: Entry[], opened: Entry[], acts: string[]): InboxDoor => ({
    entries: () => entries,
    elsewhere: () => [],
    muted: () => [],
    earlier: () => 0,
    rev: () => 1,
    next: () => null,
    at: () => ({ epic: 'auth', kehikko: 'main' }),
    names: () => ({ epic: () => null, part: () => null, kehikko: () => null }),
    projectName: () => 'Kehikko',
    log: async () => null,
    act: (what) => void acts.push(what),
    answer: async () => ({ ok: true }),
    open: (entry) => void opened.push(entry),
    use: () => {},
    hasProject: () => true,
  })

  test('an offer carries go; an ordinary item does not', () => {
    const names = { epic: () => null, part: () => null, kehikko: () => null }
    const item = itemOf(offerEntry(), names, { epic: 'auth', kehikko: 'main' }, 'Kehikko')
    expect(inboxItemSchema.parse(item).go).toEqual({})
    expect(itemOf({ ...offerEntry(), origin: 'activity', go: undefined }, names, { epic: null, kehikko: null }, null).go).toBeUndefined()
    const read = inboxReadResult.parse(readOf(pageDoor([offerEntry()], [], [])))
    expect(read.items[0]!.go).toEqual({})
  })

  test('inbox.open takes it on a fresh press only; never by a module’s server', async () => {
    const opened: Entry[] = []
    const d = pageDoor([offerEntry()], opened, [])
    const without = await answerInbox('inbox.open', { module: 'a.agent', id: 'offer:abc' }, false, d)
    expect(without).toMatchObject({ ok: true, data: { outcome: 'declined' } })
    expect(opened).toEqual([])
    const pressed = await answerInbox('inbox.open', { module: 'a.agent', id: 'offer:abc' }, true, d)
    expect(pressed).toMatchObject({ ok: true, data: { outcome: 'opened' } })
    expect(opened.map((one) => one.id)).toEqual(['offer:abc'])
  })

  test('dismiss works as for any item', async () => {
    await call('offer_jump', { epic: 'auth', why: 'Offer' }, door())
    inbox.dismiss(project.id, offers())
    expect(offers().filter(isLive)).toEqual([])
  })

  test('no MCP tool takes, sees, dismisses or forgets an offer', async () => {
    expect(TOOL_NAMES.filter((one) => /inbox|seen|dismiss|forget|answer|took|take/.test(one))).toEqual(['read_inbox'])
    await call('offer_jump', { epic: 'auth', why: 'Offer' }, door())
    const [offer] = offers()
    /* Pressing an Inbox item is not a header item; press_item reaches only what a module declared. */
    const pressed = await call('press_item', { module: 'a.agent', item: offer!.id }, door())
    expect(pressed.failed).toBe(true)
    expect(offers()).toEqual([offer!])
  })
})
