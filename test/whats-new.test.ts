import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { editWhatsNew, ensureWhatsNew, installedModule, positionOf, readWhatsNew } from '../server/whatsNew.ts'
import {
  ackFor,
  acknowledged,
  afterRead,
  appRange,
  baselined,
  editSchema,
  headerSaid,
  mergeItems,
  moved,
  newsItems,
  noticeSaid,
  rangeFor,
  rangeSaid,
  tidied,
  type InstalledModule,
  type Position,
  type WhatsNewAnswer,
  type WhatsNewRecord,
} from '../src/host/whatsNew.ts'

/*
 * "What's new" after an update: the rules (what is news, what acknowledging
 * records, what a read in the Updates menu counts for) and the record kept in
 * `frame.sqlite`. The notice and the dialog are `whats-new-dom.test.tsx`.
 */

const at = (release: string | null, commit: string | null = null): Position => ({ release, commit })
const record = (over: Partial<WhatsNewRecord> = {}): WhatsNewRecord => ({ app: '0.1.41', modules: {}, show: true, ...over })
const module = (id: string, name: string, position: Position, range: string[] = [], over: Partial<InstalledModule> = {}): InstalledModule => ({
  id,
  name,
  repo: `Jalez/kehikko-${name.toLowerCase()}`,
  follows: position.release ? 'release' : 'main',
  position,
  range,
  works: {},
  ...over,
})

describe('what counts as new', () => {
  test('the first run records what is here and shows nothing', () => {
    const first = baselined(null, '0.1.43', { 'kehikot.journeys': at('v1.6.0') })
    expect(first).toEqual({ app: '0.1.43', modules: { 'kehikot.journeys': at('v1.6.0') }, show: true, told: ['auto-updates'] })
    const answer: WhatsNewAnswer = { record: null, modules: [module('kehikot.journeys', 'Journeys', at('v1.6.0'))], updating: [] }
    expect(newsItems({ answer, app: '0.1.43', appTags: null })).toEqual([])
  })

  test('a baseline fills in only what the record does not know: a module installed since, the app first seen', () => {
    const was = record({ app: null, modules: { a: at('v1.0.0') } })
    expect(baselined(was, '0.1.43', { a: at('v2.0.0'), b: at('v0.3.0') })).toEqual(record({ app: '0.1.43', modules: { a: at('v1.0.0'), b: at('v0.3.0') } }))
  })

  test('an app update is news, with the range from the acknowledged version', () => {
    const answer: WhatsNewAnswer = { record: record({ app: '0.1.41' }), modules: [], updating: [] }
    const items = newsItems({ answer, app: '0.1.43', appTags: ['v0.1.43', 'v0.1.42'] })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'kehikot', from: '0.1.41', to: '0.1.43', tags: ['v0.1.43', 'v0.1.42'], news: true })
    expect(headerSaid(items)).toBe('0.1.41 → 0.1.43')
    expect(newsItems({ answer: { ...answer, record: record({ app: '0.1.43' }) }, app: '0.1.43', appTags: null })).toEqual([])
  })

  test('the app range is read from its release list; offline it is the running version alone', () => {
    expect(appRange(['v0.1.44', 'v0.1.43', 'v0.1.42', 'v0.1.41', 'v0.1.40'], '0.1.41', '0.1.43')).toEqual(['v0.1.43', 'v0.1.42'])
    expect(appRange(null, '0.1.41', '0.1.43')).toBeNull()
    const answer: WhatsNewAnswer = { record: record({ app: '0.1.41' }), modules: [], updating: [] }
    expect(newsItems({ answer, app: '0.1.43', appTags: null })[0]!.tags).toEqual(['v0.1.43'])
  })

  test('a module on a newer release is news, with every release since the acknowledged one', () => {
    expect(rangeFor(at('v1.5.0'), at('v1.6.0'), ['v1.4.0', 'v1.5.0', 'v1.5.1', 'v1.6.0', 'v1.7.0'])).toEqual(['v1.6.0', 'v1.5.1'])
    expect(rangeFor(at('v1.6.0'), at('v1.6.0'), ['v1.6.0'])).toEqual([])
    expect(rangeFor(undefined, at('v1.6.0'), ['v1.6.0'])).toEqual([])
    expect(rangeFor(at(null, 'abc1234'), at('v1.0.0'), ['v1.0.0'])).toEqual(['v1.0.0'])
    const answer: WhatsNewAnswer = {
      record: record({ app: '0.1.43', modules: { j: at('v1.5.0'), n: at('v2.0.0') } }),
      modules: [module('j', 'Journeys', at('v1.6.0'), ['v1.6.0', 'v1.5.1']), module('n', 'Notes', at('v2.0.0'))],
      updating: [],
    }
    const items = newsItems({ answer, app: '0.1.43', appTags: null })
    expect(items.map((one) => one.id)).toEqual(['j'])
    expect(rangeSaid(items[0]!)).toBe('1.5.0 → 1.6.0')
    expect(items[0]!.tags).toEqual(['v1.6.0', 'v1.5.1'])
    expect(headerSaid(items)).toBe('1 module updated')
  })

  test('a module following main is news when its commit moved, and has no notes', () => {
    expect(moved(at(null, 'aaa1111'), at(null, 'bbb2222'))).toBe(true)
    expect(moved(at(null, 'aaa1111'), at(null, 'aaa1111'))).toBe(false)
    const answer: WhatsNewAnswer = {
      record: record({ modules: { b: at(null, 'aaa1111') } }),
      modules: [module('b', 'Board', at(null, 'bbb2222'))],
      updating: [],
    }
    const [item] = newsItems({ answer, app: null, appTags: null })
    expect(item).toMatchObject({ follows: 'main', from: 'aaa1111', to: 'bbb2222', tags: [] })
  })

  test('a module still updating is news already, as a "Preparing…" row with no notes; one whose update failed is not', () => {
    const answer: WhatsNewAnswer = {
      record: record({ modules: { a: at('v1.0.0'), b: at('v1.0.0') } }),
      modules: [module('a', 'A', at('v1.1.0'), ['v1.1.0']), module('b', 'B', at('v1.1.0'), ['v1.1.0'])],
      updating: ['a'],
    }
    const items = newsItems({ answer, app: null, appTags: null, failed: new Set(['b']) })
    expect(items.map((one) => [one.id, one.news, one.preparing, one.tags])).toEqual([['a', true, true, []]])
    expect(headerSaid(items)).toBe('1 preparing')
    /* Never acknowledged while its copy is still moving. */
    expect(ackFor(items)).toEqual({})
  })

  test('the notice: Kehikot\'s version, or how many modules; nothing when nothing is news', () => {
    const none = newsItems({ answer: { record: record({ app: '0.1.61', modules: { a: at('v1.1.0') } }), modules: [module('a', 'A', at('v1.1.0'))], updating: [] }, app: '0.1.61', appTags: null })
    expect(noticeSaid(none)).toBeNull()
    /* On demand everything installed is a row, and still nothing is news. */
    expect(noticeSaid(newsItems({ answer: { record: record({ app: '0.1.61', modules: { a: at('v1.1.0') } }), modules: [module('a', 'A', at('v1.1.0'))], updating: [] }, app: '0.1.61', appTags: null, all: true }))).toBeNull()
    const both = newsItems({
      answer: { record: record({ app: '0.1.41', modules: { a: at('v1.0.0'), b: at('v1.0.0') } }), modules: [module('a', 'A', at('v1.1.0'), ['v1.1.0']), module('b', 'B', at('v1.0.0'))], updating: ['b'] },
      app: '0.1.61',
      appTags: null,
    })
    expect(noticeSaid(both)).toEqual({ text: 'What’s new in 0.1.61', label: 'What’s new: Kehikot 0.1.61 and 2 modules, 1 still preparing — press to read' })
    const one = newsItems({ answer: { record: record({ app: '0.1.61', modules: { a: at('v1.0.0') } }), modules: [module('a', 'A', at('v1.1.0'), ['v1.1.0'])], updating: [] }, app: '0.1.61', appTags: null })
    expect(noticeSaid(one)).toEqual({ text: 'What’s new · 1 module', label: 'What’s new: 1 module — press to read' })
    expect(noticeSaid([])).toBeNull()
  })

  test('on demand, everything installed is listed, news first', () => {
    const answer: WhatsNewAnswer = {
      record: record({ app: '0.1.43', modules: { a: at('v1.0.0'), z: at('v1.0.0') } }),
      modules: [module('a', 'Alpha', at('v1.0.0')), module('z', 'Zed', at('v1.1.0'), ['v1.1.0'])],
      updating: [],
    }
    const items = newsItems({ answer, app: '0.1.43', appTags: null, all: true })
    expect(items.map((one) => [one.id, one.news])).toEqual([
      ['kehikot', false],
      ['z', true],
      ['a', false],
    ])
    expect(items[2]!.tags).toEqual(['v1.0.0'])
  })
})

describe('acknowledging', () => {
  test('"Got it" records every row shown, and never moves a module back', () => {
    const answer: WhatsNewAnswer = {
      record: record({ app: '0.1.41', modules: { j: at('v1.5.0') } }),
      modules: [module('j', 'Journeys', at('v1.6.0'), ['v1.6.0'])],
      updating: [],
    }
    const items = newsItems({ answer, app: '0.1.43', appTags: null })
    const after = acknowledged(answer.record!, ackFor(items))
    expect(after.app).toBe('0.1.43')
    expect(after.modules.j).toEqual(at('v1.6.0'))
    expect(newsItems({ answer: { ...answer, record: after }, app: '0.1.43', appTags: null })).toEqual([])
    expect(acknowledged(after, { modules: { j: at('v1.2.0') }, app: '0.1.40' })).toEqual(after)
  })

  test('notes read in the Updates menu count, when they cover everything since the acknowledged release', () => {
    const was = record({ modules: { j: at('v1.5.0') } })
    /* Read 1.5.0 → 1.6.0 before pressing Update: after the update it is not news. */
    const read = afterRead(was, 'j', 'v1.5.0', 'v1.6.0')
    expect(read.modules.j!.release).toBe('v1.6.0')
    expect(moved(read.modules.j, at('v1.6.0'))).toBe(false)
    /* A gap — 1.5.0 → 1.6.0 not acknowledged, then 1.6.0 → 1.7.0 read — leaves it as it is. */
    expect(afterRead(was, 'j', 'v1.6.0', 'v1.7.0')).toEqual(was)
    expect(afterRead(was, 'unknown', 'v1.5.0', 'v1.6.0')).toEqual(was)
    expect(afterRead(was, 'j', 'v1.5.0', 'main')).toEqual(was)
  })

  test('an update landing while the dialog stands adds a row, and a later release of a row widens it', () => {
    const answer = (modules: InstalledModule[]): WhatsNewAnswer => ({ record: record({ modules: { a: at('v1.0.0'), b: at('v1.0.0') } }), modules, updating: [] })
    const first = newsItems({ answer: answer([module('a', 'A', at('v1.1.0'), ['v1.1.0'])]), app: null, appTags: null })
    const next = newsItems({ answer: answer([module('a', 'A', at('v1.2.0'), ['v1.2.0', 'v1.1.0']), module('b', 'B', at('v1.1.0'), ['v1.1.0'])]), app: null, appTags: null })
    const merged = mergeItems(first, next)
    expect(merged.map((one) => [one.id, rangeSaid(one), one.tags])).toEqual([
      ['a', '1.0.0 → 1.2.0', ['v1.2.0', 'v1.1.0']],
      ['b', '1.0.0 → 1.1.0', ['v1.1.0']],
    ])
  })

  test('a "Preparing…" row fills in once done, and goes when its update came to nothing', () => {
    const answer = (updating: string[], b: Position): WhatsNewAnswer => ({
      record: record({ modules: { a: at('v1.0.0'), b: at('v1.0.0') } }),
      modules: [module('a', 'A', at('v1.0.0')), module('b', 'B', b, b.release === 'v1.1.0' ? ['v1.1.0'] : [])],
      updating,
    })
    const first = newsItems({ answer: answer(['a', 'b'], at('v1.0.0')), app: null, appTags: null })
    expect(first.map((one) => [one.id, one.preparing])).toEqual([['a', true], ['b', true]])
    /* B landed on 1.1.0; A's update changed nothing. */
    const next = newsItems({ answer: answer([], at('v1.1.0')), app: null, appTags: null })
    expect(mergeItems(first, next).map((one) => [one.id, one.preparing, rangeSaid(one), one.tags])).toEqual([['b', false, '1.0.0 → 1.1.0', ['v1.1.0']]])
  })

  test('a change is one of four shapes, nothing else', () => {
    expect(editSchema.safeParse({ show: false }).success).toBe(true)
    expect(editSchema.safeParse({ baseline: { app: null } }).success).toBe(true)
    expect(editSchema.safeParse({ acknowledge: { app: '0.1.43', modules: { a: at('v1.0.0') } } }).success).toBe(true)
    expect(editSchema.safeParse({ read: { module: 'a', from: null, to: 'v1.0.0' } }).success).toBe(true)
    expect(editSchema.safeParse({ show: false, app: '1' }).success).toBe(false)
    expect(editSchema.safeParse({ acknowledge: { app: '0.1.43', extra: 1 } }).success).toBe(false)
  })
})

describe('one entry per module', () => {
  /* Monitor was a "My module" while its repository was private, then was listed; the host's answer, the dialog's
     rows and the record must each name it once. */
  const mine = module('kehikot.monitor', 'Monitor', at('v0.3.0'), ['v0.3.0'], { repo: 'Jalez/kehikko-monitor' })
  const listed = module('kehikot.monitor', 'Monitor', at('v0.2.0'), [], { repo: 'Jalez/kehikko-monitor' })

  test('a module in the answer twice is one item, at the installed (later) position', () => {
    const answer: WhatsNewAnswer = { record: record({ app: '0.1.43', modules: { 'kehikot.monitor': at('v0.1.0') } }), modules: [listed, mine], updating: [] }
    const items = newsItems({ answer, app: '0.1.43', appTags: null })
    expect(items.map((one) => one.id)).toEqual(['kehikot.monitor'])
    expect(items[0]!.to).toBe('0.3.0')
    expect(noticeSaid(items)!.text).toBe('What’s new · 1 module')
    expect(newsItems({ answer, app: '0.1.43', appTags: null, all: true }).filter((one) => one.id === 'kehikot.monitor')).toHaveLength(1)
    expect(Object.keys(ackFor(items).modules!)).toEqual(['kehikot.monitor'])
  })

  test('a record holding both spellings of an id is one row, and tidying it again changes nothing', () => {
    const both = record({ app: '0.1.43', modules: { 'roadmap.monitor': at('v0.1.0'), 'kehikot.monitor': at('v0.2.0') } })
    const once = tidied(both)
    expect(once.modules).toEqual({ 'kehikot.monitor': at('v0.2.0') })
    expect(tidied(once)).toBe(once)
    const answer: WhatsNewAnswer = { record: both, modules: [mine], updating: [] }
    const items = newsItems({ answer, app: '0.1.43', appTags: null })
    expect(items.map((one) => one.id)).toEqual(['kehikot.monitor'])
    expect(items[0]!.from).toBe('0.2.0')
  })

  test('the stored record is tidied on read, once', () => {
    const db = new Database(':memory:')
    ensureWhatsNew(db)
    db.query('insert into settings (key, value) values (?, ?)').run('whats-new', JSON.stringify(record({ modules: { 'roadmap.monitor': at('v0.1.0'), 'kehikot.monitor': at('v0.2.0') } })))
    expect(readWhatsNew(db)!.modules).toEqual({ 'kehikot.monitor': at('v0.2.0') })
    const stored = db.query<{ value: string }, []>("select value from settings where key = 'whats-new'").get()!.value
    expect(JSON.parse(stored).modules).toEqual({ 'kehikot.monitor': at('v0.2.0') })
    expect(readWhatsNew(db)!.modules).toEqual({ 'kehikot.monitor': at('v0.2.0') })
  })

  test('rows merged into a dialog never repeat an id', () => {
    const row = newsItems({ answer: { record: record({ app: '0.1.43', modules: { 'kehikot.monitor': at('v0.1.0') } }), modules: [mine], updating: [] }, app: '0.1.43', appTags: null })[0]!
    expect(mergeItems([row, row], [row]).map((one) => one.id)).toEqual(['kehikot.monitor'])
  })
})

describe('the record in frame.sqlite', () => {
  const fresh = () => {
    const db = new Database(':memory:')
    ensureWhatsNew(db)
    return db
  }
  const here = async () => ({ 'kehikot.journeys': at('v1.6.0') })

  test('nothing until the first baseline; then the baseline is what is here', async () => {
    const db = fresh()
    expect(readWhatsNew(db)).toBeNull()
    await editWhatsNew(db, { baseline: { app: '0.1.43' } }, here)
    expect(readWhatsNew(db)).toEqual({ app: '0.1.43', modules: { 'kehikot.journeys': at('v1.6.0') }, show: true, told: ['auto-updates'] })
  })

  test('the setting is kept, and turning it back on keeps what was acknowledged', async () => {
    const db = fresh()
    await editWhatsNew(db, { baseline: { app: '0.1.41' } }, here)
    await editWhatsNew(db, { show: false }, here)
    expect(readWhatsNew(db)!.show).toBe(false)
    await editWhatsNew(db, { acknowledge: { app: '0.1.43' } }, here)
    await editWhatsNew(db, { show: true }, here)
    expect(readWhatsNew(db)).toMatchObject({ app: '0.1.43', show: true })
  })

  test('a row that does not read is the first run again, not a failure', () => {
    const db = fresh()
    db.query("insert into settings (key, value) values ('whats-new', 'not json')").run()
    expect(readWhatsNew(db)).toBeNull()
  })

  test('an installed module: its position, the range since the acknowledged release, and which Kehikot each works with', async () => {
    const one = await installedModule({
      id: 'kehikot.journeys',
      name: 'Journeys',
      release: { follows: 'release', installed: 'v1.6.0', newest: 'v1.6.0', target: null, notes: ['v1.6.0'], needsNewer: null, repo: 'Jalez/kehikko-journeys', error: null },
      commit: 'abc1234',
      record: record({ modules: { 'kehikot.journeys': at('v1.5.0') } }),
      local: async () => ['v1.6.0', 'v1.5.1', 'v1.5.0'],
      works: async (tags) => Object.fromEntries(tags.map((tag) => [tag, { kind: 'from' as const, need: '2.6.0', from: '0.1.39', until: null }])),
    })
    expect(one).toMatchObject({ position: at('v1.6.0'), range: ['v1.6.0', 'v1.5.1'], repo: 'Jalez/kehikko-journeys' })
    expect(one.works['v1.5.1']).toBe('Works with Kehikot 0.1.39 and later')
    expect(positionOf(undefined, 'abc1234')).toEqual(at(null, 'abc1234'))
  })
})
