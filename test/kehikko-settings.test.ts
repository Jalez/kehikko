import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentMessages, type Reader } from '../server/agentMessages.ts'
import { createCanvas, open, type Canvas } from '../server/canvases.ts'
import { PAGE_ONLY, refusal, type Own } from '../server/guard.ts'
import { editKehikkoSettings, readKehikkoSettings, takesNewsAt } from '../server/kehikkoSettings.ts'
import { messageDesk } from '../server/messageRoutes.ts'
import { addProject } from '../server/projects.ts'
import { choiceDue, kehikkoLinkOf, NO_SETTINGS, PRIMARY_SAID, routingPrimary, shownPrimary, takesPlaceNews } from '../src/host/kehikkoSettings.ts'

/**
 * Which agent module is a kehikko's primary one, and what that changes: news to a place (a module's
 * `messages.tell`, the host's tracker news) goes only to the primary's sessions on that kehikko;
 * a message to one session is handed as ever.
 */

const A = 'stand.alpha'
const B = 'stand.beta'
const OTHER = 'stand.notes'

describe('the rule', () => {
  test('one agent module is primary by itself, and nothing is asked', () => {
    expect(shownPrimary([A], NO_SETTINGS)).toBe(A)
    expect(routingPrimary([A], NO_SETTINGS)).toBeNull()
    expect(choiceDue([A], NO_SETTINGS)).toBe(false)
    expect(takesPlaceNews(A, [A], NO_SETTINGS)).toBe(true)
  })

  test('two with none chosen: asked, and everyone gets the news', () => {
    expect(choiceDue([A, B], NO_SETTINGS)).toBe(true)
    expect(takesPlaceNews(A, [A, B], NO_SETTINGS)).toBe(true)
    expect(takesPlaceNews(B, [A, B], NO_SETTINGS)).toBe(true)
  })

  test('two with one chosen: only it gets the news, and nothing is asked', () => {
    const chosen = { primary: B, later: [] }
    expect(choiceDue([A, B], chosen)).toBe(false)
    expect(takesPlaceNews(B, [A, B], chosen)).toBe(true)
    expect(takesPlaceNews(A, [A, B], chosen)).toBe(false)
  })

  test('the primary removed with two left: asked again, and everyone gets the news meanwhile', () => {
    const chosen = { primary: B, later: [] }
    expect(choiceDue([A, OTHER], chosen)).toBe(true)
    expect(takesPlaceNews(A, [A, OTHER], chosen)).toBe(true)
  })

  test('Later puts it off for the same agents, and a new agent module asks again', () => {
    const later = { primary: null, later: [A, B] }
    expect(choiceDue([A, B], later)).toBe(false)
    expect(choiceDue([A, B, OTHER], later)).toBe(true)
    expect(takesPlaceNews(A, [A, B], later)).toBe(true)
  })

  test('the words say what is routed', () => {
    expect(PRIMARY_SAID.implications).toContain('tracker news')
    expect(PRIMARY_SAID.implications).toContain('messages meant for them directly')
  })

  test('a link names a section, a control and a kehikko, or nothing it does not understand', () => {
    expect(kehikkoLinkOf({ section: 'agents', target: 'primary-agent', kehikko: 3 })).toEqual({ section: 'agents', target: 'primary-agent', kehikko: 3 })
    expect(kehikkoLinkOf({ section: 'nope', target: '<b>', kehikko: -1 })).toEqual({ section: null, target: null, kehikko: null })
    expect(kehikkoLinkOf(null)).toEqual({ section: null, target: null, kehikko: null })
  })
})

describe('the store and the routing', () => {
  let db: Database
  let folder: string
  let project: number
  let writing: Canvas
  let store: AgentMessages
  let agents: string[]
  let now: number

  const reader = (module: string, session: string, kehikko: string | null = writing.key): Reader => ({ module, session, epic: 'auth', kehikko })
  const bodies = (who: Reader) => store.deliver(project, who).messages.map((one) => one.body)

  beforeEach(() => {
    now = Date.parse('2026-11-12T12:00:00Z')
    db = open(':memory:')
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-settings-')))
    const added = addProject(db, folder, 'thesis')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    writing = createCanvas(db, 'writing', project)
    agents = [A, B]
    store = new AgentMessages(db, () => now, (id, who) => takesNewsAt(db, id, who.kehikko, who.module, () => agents))
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  test('kept per project and kehikko key; choosing clears Later', () => {
    expect(readKehikkoSettings(db, project, writing.key)).toEqual({ primary: null, later: [] })
    expect(editKehikkoSettings(db, project, writing.key, { later: agents }, agents)).toMatchObject({ ok: true })
    expect(readKehikkoSettings(db, project, writing.key)).toEqual({ primary: null, later: [A, B] })
    expect(editKehikkoSettings(db, project, writing.key, { primary: B }, agents)).toMatchObject({ ok: true })
    expect(readKehikkoSettings(db, project, writing.key)).toEqual({ primary: B, later: [] })
  })

  test('a module that is not an agent on the kehikko cannot be primary', () => {
    expect(editKehikkoSettings(db, project, writing.key, { primary: OTHER }, agents)).toMatchObject({ ok: false, status: 400 })
    expect(readKehikkoSettings(db, project, writing.key).primary).toBeNull()
  })

  test('two agent modules plus a primary: one copy, to the primary', () => {
    editKehikkoSettings(db, project, writing.key, { primary: A }, agents)
    expect(store.tell(project, { module: OTHER, name: 'Notes' }, { kehikko: writing.key }, 'CI failed')).toMatchObject({ ok: true })
    expect(bodies(reader(A, 'a1'))).toEqual(['CI failed'])
    expect(bodies(reader(B, 'b1'))).toEqual([])
  })

  test('tracker news to an epic with no kehikko: the primary on this kehikko, everyone at another or at none', () => {
    editKehikkoSettings(db, project, writing.key, { primary: A }, agents)
    const desk = messageDesk({ db, messages: store, resolve: async () => ({ here: null }), nameOf: () => null, changed: () => {}, setTimer: () => null })
    expect(desk.hostTell(project, { epic: 'auth' }, 'CI failed on !4606')).toMatchObject({ ok: true })
    const review = createCanvas(db, 'review', project)
    expect(bodies(reader(A, 'a1'))).toEqual(['CI failed on !4606'])
    expect(bodies(reader(B, 'b1'))).toEqual([])
    expect(bodies(reader(B, 'b2', review.key))).toEqual(['CI failed on !4606'])
    expect(bodies(reader(B, 'b3', null))).toEqual(['CI failed on !4606'])
  })

  test('no primary: every agent gets the news, as before', () => {
    store.tell(project, { module: OTHER, name: 'Notes' }, { epic: 'auth' }, 'news')
    expect(bodies(reader(A, 'a1'))).toEqual(['news'])
    expect(bodies(reader(B, 'b1'))).toEqual(['news'])
  })

  test('one agent module: it gets the news', () => {
    agents = [B]
    editKehikkoSettings(db, project, writing.key, { primary: B }, [A, B])
    store.tell(project, { module: OTHER, name: 'Notes' }, { epic: 'auth' }, 'news')
    expect(bodies(reader(B, 'b1'))).toEqual(['news'])
  })

  test('the primary removed: everyone gets the news again', () => {
    editKehikkoSettings(db, project, writing.key, { primary: A }, agents)
    agents = [B, 'stand.gamma']
    store.tell(project, { module: OTHER, name: 'Notes' }, { epic: 'auth' }, 'news')
    expect(bodies(reader(B, 'b1'))).toEqual(['news'])
    expect(bodies(reader('stand.gamma', 'g1'))).toEqual(['news'])
  })

  test('direct messages are unaffected', () => {
    editKehikkoSettings(db, project, writing.key, { primary: A }, agents)
    const from = { module: OTHER, session: '', name: 'Notes', epic: 'auth', parts: [], kehikko: writing.key }
    expect(store.send(project, from, 'just for b1', { session: { module: B, session: 'b1' } }, null, { notice: true })).toMatchObject({ ok: true })
    expect(store.send(project, { ...from, session: 'n1' }, 'to every beta', { module: B }, null)).toMatchObject({ ok: true })
    expect(bodies(reader(B, 'b1'))).toEqual(['just for b1', 'to every beta'])
  })

  test('the route is the page’s alone', () => {
    expect(PAGE_ONLY).toContain('/host/kehikko-settings')
    const self: Own = { origins: ['http://127.0.0.1:4181'], hosts: new Set(['127.0.0.1:4180']) }
    const asked = (headers: Record<string, string>) =>
      refusal({ method: 'POST', pathname: '/host/kehikko-settings', headers: new Headers({ host: '127.0.0.1:4180', 'content-type': 'application/json', 'content-length': '2', ...headers }) }, self)
    expect(asked({})?.status).toBe(403)
    expect(asked({ origin: 'http://127.0.0.1:4181' })).toBeNull()
  })
})
