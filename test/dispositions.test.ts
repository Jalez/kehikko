import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LIMITS } from 'kehikot-module-protocol'

import { answer } from '../server/answers.ts'
import { createCanvas, open } from '../server/canvases.ts'
import { dispositionsFile, marksOf, readDispositions, setDisposition } from '../server/dispositions.ts'
import { call, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import { Wakes, type News } from '../server/wake.ts'
import { toWireContext } from '../src/host/context.ts'

/**
 * #18: why a closed ref closed, kept per project, in the project.
 *
 * Real folders throughout, because everything here is one file in somebody's
 * project and every interesting case is a fact about that file.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-dispositions-')))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const AT = new Date('2026-10-05T12:00:00.000Z')

describe('the file', () => {
  test('lives under the project’s .kehikot/kehikko/, beside kehikot.json', () => {
    expect(dispositionsFile(folder)).toBe(join(folder, '.kehikot', 'kehikko', 'dispositions.json'))
    expect(dispositionsFile(null)).toBeNull()
  })

  test('no file is no marks', () => {
    expect(readDispositions(folder)).toEqual({ ok: true, marks: [] })
  })

  test('a mark is written with who and when, and read back', () => {
    const done = setDisposition(folder, { ref: '#2274', value: 'done' }, 'Journeys', AT)
    expect(done.ok && done.changed).toBe(true)
    expect(marksOf(folder)).toEqual([
      { ref: '#2274', value: 'done', target: null, note: '', by: 'Journeys', at: AT.toISOString() },
    ])
  })

  test('one mark per ref: a new verdict replaces the old one in place', () => {
    setDisposition(folder, { ref: '#1', value: 'done' }, 'you', AT)
    setDisposition(folder, { ref: '#2', value: 'done' }, 'you', AT)
    setDisposition(folder, { ref: '#1', value: 'duplicate', target: '#2', note: 'same bug' }, 'you', AT)
    expect(marksOf(folder).map((m) => [m.ref, m.value, m.target, m.note])).toEqual([
      ['#1', 'duplicate', '#2', 'same bug'],
      ['#2', 'done', null, ''],
    ])
  })

  test('saying the same thing again writes nothing, not even a new time', () => {
    setDisposition(folder, { ref: '#1', value: 'done' }, 'you', AT)
    const again = setDisposition(folder, { ref: '#1', value: 'done' }, 'someone else', new Date())
    expect(again.ok && again.changed).toBe(false)
    expect(marksOf(folder)[0]?.by).toBe('you')
  })

  test('null takes the mark back, and taking back nothing changes nothing', () => {
    setDisposition(folder, { ref: '#1', value: 'wont-do' }, 'you', AT)
    const gone = setDisposition(folder, { ref: '#1', value: null }, 'you', AT)
    expect(gone.ok && gone.changed).toBe(true)
    expect(marksOf(folder)).toEqual([])
    const nothing = setDisposition(folder, { ref: '#1', value: null }, 'you', AT)
    expect(nothing.ok && nothing.changed).toBe(false)
  })

  /* A hand-edit gone wrong is somebody's verdicts. Writing over it would
     throw them away with nothing to say so. */
  test('a file that will not read is not written over', () => {
    const file = dispositionsFile(folder)!
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ not json')
    const done = setDisposition(folder, { ref: '#1', value: 'done' }, 'you', AT)
    expect(done.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
    /* And what modules are told is no marks, rather than nothing at all. */
    expect(marksOf(folder)).toEqual([])
  })

  test('no project is nowhere to keep one', () => {
    expect(setDisposition(null, { ref: '#1', value: 'done' }, 'you').ok).toBe(false)
  })

  test('no more marks than a context can carry', () => {
    for (let n = 0; n < LIMITS.DISPOSITIONS; n += 1) {
      setDisposition(folder, { ref: `#${n}`, value: 'done' }, 'you', AT)
    }
    expect(setDisposition(folder, { ref: '#over', value: 'done' }, 'you', AT).ok).toBe(false)
    /* Changing one that is already there is still fine. */
    expect(setDisposition(folder, { ref: '#0', value: 'wont-do' }, 'you', AT).ok).toBe(true)
  })
})

describe('disposition.set from a framed module', () => {
  const ME = 'kehikot.journeys'
  const registered = (id: string) => id === ME
  const mark = (module: string, root: string | null, marking: Parameters<typeof setDisposition>[1]) =>
    setDisposition(root, marking, module === ME ? 'Journeys' : module, AT)

  test('is answered by the server, written into the project, and signed with the module', () => {
    const given = answer(ME, 'disposition.set', { ref: '#2274', value: 'wont-do' }, registered, undefined, folder, mark)
    expect(given.ok).toBe(true)
    expect(marksOf(folder)[0]).toMatchObject({ ref: '#2274', value: 'wont-do', by: 'Journeys' })
  })

  test('a target on a mark that names no relation is refused by the protocol’s own schema', () => {
    const given = answer(
      ME,
      'disposition.set',
      { ref: '#1', value: 'done', target: '#2' },
      registered,
      undefined,
      folder,
      mark,
    )
    expect(given.ok).toBe(false)
    expect(existsSync(dispositionsFile(folder)!)).toBe(false)
  })

  test('a call with no project is refused in a sentence rather than kept nowhere', () => {
    const given = answer(ME, 'disposition.set', { ref: '#1', value: 'done' }, registered, undefined, null, mark)
    expect(given.ok).toBe(false)
  })

  test('a host that was given nowhere to keep it says so', () => {
    const given = answer(ME, 'disposition.set', { ref: '#1', value: 'done' }, registered)
    expect(given.ok).toBe(false)
  })
})

describe('mark_disposition at the host’s door', () => {
  let db: Database
  let news: News[]
  let door: Door
  beforeEach(() => {
    db = open(':memory:')
    news = []
    const wakes = new Wakes()
    wakes.listen((one) => news.push(one))
    const openness = new Openness()
    door = {
      db,
      which: () => openness.open(),
      wake: (kehikko) => wakes.woke(kehikko),
      epicsChanged: (project) => wakes.epicsChanged(project),
      dispositionsChanged: (project) => wakes.dispositionsChanged(project),
      seen: async () => [],
    }
  })
  afterEach(() => db.close())

  function kehikko(): { id: number; project: number } {
    const added = addProject(db, folder, undefined, false)
    if (!added.ok) throw new Error(added.why)
    return { id: createCanvas(db, 'one', added.project.id).id, project: added.project.id }
  }

  test('an agent marks #2274 done, signed as the agent, and every page in the project is told', async () => {
    const { id, project } = kehikko()
    const done = await call('mark_disposition', { kehikko: id, ref: '#2274', value: 'done' }, door)
    expect(done.failed).toBe(false)
    expect(done.text).toContain('#2274 is marked done')
    expect(marksOf(folder)[0]).toMatchObject({ ref: '#2274', value: 'done', by: 'agent (MCP)' })
    expect(news).toEqual([{ dispositions: project }])
  })

  test('saying it again writes nothing and wakes nobody', async () => {
    const { id } = kehikko()
    await call('mark_disposition', { kehikko: id, ref: '#1', value: 'done' }, door)
    news.length = 0
    const again = await call('mark_disposition', { kehikko: id, ref: '#1', value: 'done' }, door)
    expect(again.text).toContain('nothing was written')
    expect(news).toEqual([])
  })

  test('null takes it back', async () => {
    const { id } = kehikko()
    await call('mark_disposition', { kehikko: id, ref: '#1', value: 'superseded', target: '#9' }, door)
    const back = await call('mark_disposition', { kehikko: id, ref: '#1', value: null }, door)
    expect(back.failed).toBe(false)
    expect(marksOf(folder)).toEqual([])
  })

  test('an unknown value, or none, is refused with the four it could be', async () => {
    const { id } = kehikko()
    expect((await call('mark_disposition', { kehikko: id, ref: '#1', value: 'fixed' }, door)).failed).toBe(true)
    const none = await call('mark_disposition', { kehikko: id, ref: '#1' }, door)
    expect(none.failed).toBe(true)
    expect(none.text).toContain('wont-do')
  })
})

describe('the marks are in every module’s context', () => {
  test('carried whole, and empty when nobody has said anything', () => {
    const subject = { epic: null, project: null }
    expect(toWireContext(subject, 'light').dispositions).toEqual([])
    setDisposition(folder, { ref: '#1', value: 'done' }, 'you', AT)
    const context = toWireContext(subject, 'light', [], null, null, [], marksOf(folder))
    expect(context.dispositions.map((d) => d.ref)).toEqual(['#1'])
  })
})
