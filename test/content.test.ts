import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTENT_HOST, LIMITS, contentSignalSchema, contentStamp, kehikotDir } from 'kehikot-module-protocol'

import { answer } from '../server/answers.ts'
import { Contents, ContentWatch, folderSource, stepsAreKeptBy } from '../server/content.ts'
import { epicsDir, stateDir } from '../server/hostData.ts'
import { Wakes, type News } from '../server/wake.ts'
import { toWireContext, whileFrozen } from '../src/host/context.ts'

/**
 * What tells a container that the material it shows has changed.
 *
 * The case all of this is for: a person watching a canvas while an agent adds
 * a ref to a journey step. The step is written by the module's own server
 * process, into a file in the project, and before this nothing told anybody.
 */

describe('what the host keeps about what changed', () => {
  test('the last change per source and epic, told whole each time', () => {
    const told: unknown[] = []
    const contents = new Contents({ told: (root, changes) => told.push([root, changes.length]) })
    contents.announce('/p', CONTENT_HOST, 'x')
    contents.announce('/p', 'kehikot.journeys', 'x')
    contents.announce('/p', CONTENT_HOST, 'x')
    expect(contents.of('/p').map((one) => `${one.source} ${one.epic}`)).toEqual(['kehikot.journeys x', 'host x'])
    expect(told).toEqual([['/p', 1], ['/p', 2], ['/p', 2]])
    expect(contents.of('/elsewhere')).toEqual([])
  })

  test('two changes inside one millisecond are still two', () => {
    const contents = new Contents({ now: () => new Date('2026-10-06T10:00:00.000Z') })
    const about = { sources: [CONTENT_HOST], epic: 'x' }
    const first = contentStamp(contents.announce('/p', CONTENT_HOST, 'x'), about)
    const second = contentStamp(contents.announce('/p', CONTENT_HOST, 'x'), about)
    expect(second).not.toBe(first)
  })

  test('it stays inside what the protocol will carry, newest kept', () => {
    const contents = new Contents()
    for (let i = 0; i <= LIMITS.CONTENT; i += 1) contents.announce('/p', CONTENT_HOST, `e-${i}`)
    const kept = contents.of('/p')
    expect(contentSignalSchema.safeParse(kept).success).toBe(true)
    expect(kept.some((one) => one.epic === 'e-0')).toBe(false)
    expect(kept.at(-1)?.epic).toBe(`e-${LIMITS.CONTENT}`)
  })
})

/**
 * This host answers an epic's steps out of the Journeys module's file. So a
 * step saved there changes what `steps.list` and `epic.get` say, with nothing
 * of the host's own written — and a module listening only for the host's
 * epics would go on showing the steps from before.
 */
describe('a change to the journeys is a change to the steps this host answers with', () => {
  const hostOnly = { sources: [CONTENT_HOST], epic: 'x' }

  test('a module listening for the host’s epics re-asks when Journeys saves a step', () => {
    const contents = new Contents()
    const before = contentStamp(contents.of('/p'), hostOnly)
    const after = contentStamp(contents.announce('/p', 'kehikot.journeys', 'x'), hostOnly)
    expect(after).not.toBe(before)
    /* Under both names: it is the module's change, and it is the host's answer that moved. */
    expect(contents.of('/p').map((one) => `${one.source} ${one.epic}`).sort()).toEqual(['host x', 'kehikot.journeys x'])
  })

  test('and when the file moved without anybody saying which journey, for whichever epic is open', () => {
    const contents = new Contents()
    const after = contentStamp(contents.announce('/p', 'kehikot.journeys', null), hostOnly)
    expect(after).toContain(`${CONTENT_HOST} *`)
    expect(contentStamp(contents.of('/p'), { sources: [CONTENT_HOST], epic: 'another-epic' })).toBe(after)
  })

  test('it is one telling, not two', () => {
    const told: number[] = []
    const contents = new Contents({ told: (_root, changes) => void told.push(changes.length) })
    contents.announce('/p', 'kehikot.journeys', 'x')
    expect(told).toEqual([2])
  })

  test('a step saved for one epic does not move a module showing another', () => {
    const contents = new Contents()
    const other = { sources: [CONTENT_HOST], epic: 'y' }
    const before = contentStamp(contents.of('/p'), other)
    expect(contentStamp(contents.announce('/p', 'kehikot.journeys', 'x'), other)).toBe(before)
  })

  test('every save moves it again, even two in one millisecond', () => {
    const contents = new Contents({ now: () => new Date('2026-10-07T10:00:00.000Z') })
    const first = contentStamp(contents.announce('/p', 'kehikot.journeys', 'x'), hostOnly)
    const second = contentStamp(contents.announce('/p', 'kehikot.journeys', 'x'), hostOnly)
    expect(second).not.toBe(first)
  })

  test('a Journeys registered from before the rename is the same module', () => {
    expect(stepsAreKeptBy('kehikot.journeys')).toBe(true)
    expect(stepsAreKeptBy('roadmap.journeys')).toBe(true)
    const contents = new Contents()
    contents.announce('/p', 'roadmap.journeys', 'x')
    expect(contents.of('/p').some((one) => one.source === CONTENT_HOST && one.epic === 'x')).toBe(true)
  })

  test('no other module’s change is the host’s', () => {
    for (const source of ['kehikot.notes', 'kehikot.checklist', 'kehikot.journeys-extra', CONTENT_HOST]) {
      expect(stepsAreKeptBy(source)).toBe(false)
    }
    const contents = new Contents()
    contents.announce('/p', 'kehikot.notes', 'x')
    expect(contents.of('/p').map((one) => one.source)).toEqual(['kehikot.notes'])
  })

  test('it stays inside what the protocol will carry', () => {
    const contents = new Contents()
    for (let i = 0; i <= LIMITS.CONTENT; i += 1) contents.announce('/p', 'kehikot.journeys', `e-${i}`)
    expect(contentSignalSchema.safeParse(contents.of('/p')).success).toBe(true)
    expect(contents.of('/p').at(-1)).toMatchObject({ source: CONTENT_HOST, epic: `e-${LIMITS.CONTENT}` })
  })
})

describe('a module reporting its own write', () => {
  const known = (id: string) => id === 'kehikot.journeys'

  test('is announced under the name of the module that asked', () => {
    const reports: unknown[] = []
    const report = (module: string, root: string, epic: string | null) => void reports.push([module, root, epic])
    const said = answer('kehikot.journeys', 'content.changed', { epic: 'x' }, known, undefined, '/p', undefined, null, report)
    expect(said.ok).toBe(true)
    answer('kehikot.journeys', 'content.changed', {}, known, undefined, '/p', undefined, null, report)
    expect(reports).toEqual([['kehikot.journeys', '/p', 'x'], ['kehikot.journeys', '/p', null]])
  })

  test('a source it names for itself is not taken', () => {
    const reports: unknown[] = []
    answer('kehikot.journeys', 'content.changed', { epic: 'x', source: 'host' }, known, undefined, '/p', undefined, null, (module) => void reports.push(module))
    expect(reports).toEqual(['kehikot.journeys'])
  })

  test('standing in no project, it is refused rather than told to nobody', () => {
    const said = answer('kehikot.journeys', 'content.changed', {}, known, undefined, null, undefined, null, () => {})
    expect(said.ok).toBe(false)
  })

  test('and a host given nobody to tell says so', () => {
    expect(answer('kehikot.journeys', 'content.changed', {}, known, undefined, '/p').ok).toBe(false)
  })
})

describe('the news on the stream', () => {
  test('carries the project and the list, and nothing of the material', () => {
    const wakes = new Wakes()
    const heard: News[] = []
    wakes.listen((news) => heard.push(news))
    const changes = new Contents().announce('/p', 'kehikot.journeys', 'x')
    wakes.contentChanged(3, changes)
    expect(heard).toEqual([{ content: 3, changes }])
  })
})

describe('the context a container is sent', () => {
  const project = { id: 1, name: 'P', path: '/p' }
  const subject = { epic: 'x', project } as unknown as Parameters<typeof toWireContext>[0]
  const wire = (content: Parameters<typeof toWireContext>[8]) =>
    toWireContext(subject, 'light', [], null, null, [], [], { at: null, refreshing: false }, content)

  test('says what changed', () => {
    const changes = new Contents().announce('/p', CONTENT_HOST, 'x')
    expect(wire(changes).content).toEqual(changes)
    expect(wire([]).content).toEqual([])
  })

  test('a pinned container still hears that its epic was rewritten', () => {
    const contents = new Contents()
    const held = wire([])
    expect(whileFrozen(held, wire([]))).toBeNull()
    const told = wire(contents.announce('/p', CONTENT_HOST, 'x'))
    expect(whileFrozen(held, told)?.content).toEqual(told.content)
  })
})

describe('a project’s .kehikot, watched', () => {
  const made: string[] = []
  const watches: ContentWatch[] = []
  afterEach(() => {
    for (const watch of watches.splice(0)) watch.close()
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const QUIET = 40
  const settle = () => new Promise((done) => setTimeout(done, QUIET * 8))

  /* A watcher takes a moment to arm; a write in the same tick as `watching` is
     a write from before anybody was looking. */
  async function project() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-content-')))
    made.push(root)
    const journeys = join(kehikotDir(root)!, 'journeys')
    mkdirSync(journeys, { recursive: true })
    mkdirSync(epicsDir(root), { recursive: true })
    mkdirSync(stateDir(root), { recursive: true })
    writeFileSync(join(epicsDir(root), 'x.json'), '{"title":"X"}\n')
    const heard: string[] = []
    let states = 0
    const watch = new ContentWatch({
      changed: (_root, source, epic) => void heard.push(`${source} ${epic ?? '*'}`),
      stateChanged: () => void (states += 1),
      quietMs: QUIET,
      reportedMs: QUIET * 20,
    })
    watches.push(watch)
    watch.watching([root])
    await settle()
    return { root, journeys, heard, watch, states: () => states }
  }

  test('a module’s file written by its own server is announced as that module’s', async () => {
    const one = await project()
    writeFileSync(join(one.journeys, 'journeys.json'), '{"steps":[1]}\n')
    await settle()
    expect(one.heard).toEqual(['kehikot.journeys *'])
  })

  test('a burst is one announcement', async () => {
    const one = await project()
    for (let i = 0; i < 5; i += 1) writeFileSync(join(one.journeys, 'journeys.json'), `{"steps":[${i}]}\n`)
    writeFileSync(join(one.journeys, 'journeys.json.tmp'), 'half')
    await settle()
    expect(one.heard).toEqual(['kehikot.journeys *'])
  })

  test('an epic edited from outside is announced as the host’s, for that epic', async () => {
    const one = await project()
    writeFileSync(join(epicsDir(one.root), 'x.json'), '{"title":"X, rewritten"}\n')
    await settle()
    expect(one.heard).toEqual(['host x'])
  })

  test('an epic rewritten with what it already held says nothing', async () => {
    const one = await project()
    writeFileSync(join(epicsDir(one.root), 'x.json'), '{"title":"X"}\n')
    await settle()
    expect(one.heard).toEqual([])
  })

  test('the host does not hear its own write', async () => {
    const one = await project()
    const file = join(epicsDir(one.root), 'x.json')
    writeFileSync(file, '{"title":"Retitled by the host"}\n')
    one.watch.noted(one.root, file)
    await settle()
    expect(one.heard).toEqual([])
  })

  test('a write a module already reported is not announced a second time', async () => {
    const one = await project()
    writeFileSync(join(one.journeys, 'journeys.json'), '{"steps":[2]}\n')
    one.watch.reported(one.root, 'kehikot.journeys')
    await settle()
    expect(one.heard).toEqual([])
  })

  test('state rewritten from outside is the tracker’s news, not content', async () => {
    const one = await project()
    writeFileSync(join(stateDir(one.root), 'x.json'), '{"issues":{}}\n')
    await settle()
    expect(one.states()).toBe(1)
    expect(one.heard).toEqual([])
  })

  test('the host’s own bookkeeping beside its epics is nobody’s content', async () => {
    const one = await project()
    writeFileSync(join(kehikotDir(one.root)!, 'kehikko', 'tracker-reading.json'), '{}\n')
    writeFileSync(join(kehikotDir(one.root)!, 'kehikko', 'dispositions.json'), '[]\n')
    await settle()
    expect(one.heard).toEqual([])
    expect(one.states()).toBe(0)
  })

  test('a project nobody has open any more is not watched', async () => {
    const one = await project()
    one.watch.watching([])
    expect(one.watch.roots).toEqual([])
    writeFileSync(join(one.journeys, 'journeys.json'), '{"steps":[3]}\n')
    await settle()
    expect(one.heard).toEqual([])
  })

  test('a folder is its module’s, named the way a module is', () => {
    expect(folderSource('journeys')).toBe('kehikot.journeys')
    expect(folderSource('Not A Folder')).toBeNull()
  })
})
