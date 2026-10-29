import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, editCanvas, listCanvases, open, readSubject, setSubject, type Placement } from '../server/canvases.ts'
import { headersDesk, type Came } from '../server/headers.ts'
import { epicsDir } from '../server/hostData.ts'
import { call, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject, type Project } from '../server/projects.ts'
import { Wakes, type JumpOrder, type News } from '../server/wake.ts'
import { makeAsk, type CanvasControls } from '../src/host/ask.ts'
import { jumpOrderIn } from '../src/host/canvases.ts'
import { NOT_GREETED } from '../src/host/conversation.ts'
import type { Walked } from '../src/host/presses.ts'
import {
  JUMP_MIN_INTERVAL_MS,
  jumpMarkText,
  markAfter,
  markStands,
  paceRefusal,
  planJump,
  toldIn,
  walkAll,
  walkersOf,
  walkSoon,
  type JumpFacts,
  type Place,
} from '../src/host/jump.ts'

/*
 * `jump`: an agent jumping the person's view (#208, widened by the person:
 * "I want to enable Claude to jump me to another epic/part/project/kehikko").
 * Partial args stay where the person is; unknown targets are refused with what
 * exists; it acts on the page on screen only; it is marked with Go back, which
 * restores everything; it is paced, and a jump to where the person is is
 * ignored. The step-only jump walks the containers that follow `kehikot.goto`.
 */

/* ------------------------------------------------------------ the plan */

const facts: JumpFacts = {
  projects: [
    { id: 1, name: 'Kehikko' },
    { id: 2, name: 'Paper' },
    { id: 3, name: 'Gone', missing: true },
  ],
  kehikotOf: (project) =>
    project === 1
      ? [{ key: 'main', name: 'Main' }, { key: 'wide', name: 'Wide' }]
      : project === 2
        ? [{ key: 'draft', name: 'Draft' }]
        : [],
  subjectOf: (project) => (project === 2 ? { epic: 'thesis', parts: ['ch1'] } : { epic: null, scope: 'project', parts: [] }),
}
const here: Place = { project: 1, kehikko: 'main', epic: 'share', parts: ['auth'], step: 2 }

describe('where a jump lands: what is named moves, the rest stays', () => {
  test('a step alone: the same place, that step', () => {
    expect(planJump({ step: 7 }, here, facts)).toEqual({ kind: 'go', target: { ...here, step: 7 } })
  })
  test('parts alone: picked in the epic that is open', () => {
    expect(planJump({ parts: ['ui'] }, here, facts)).toEqual({ kind: 'go', target: { ...here, parts: ['ui'] } })
  })
  test('an epic: its whole, no parts, no step', () => {
    expect(planJump({ epic: 'other' }, here, facts)).toEqual({ kind: 'go', target: { ...here, epic: 'other', parts: [], step: null } })
  })
  test('a kehikko: the same epic and parts there, the step not carried', () => {
    expect(planJump({ kehikko: 'wide' }, here, facts)).toEqual({ kind: 'go', target: { ...here, kehikko: 'wide', step: null } })
  })
  test('another project: where that project is, its own kehikko', () => {
    expect(planJump({ project: 2 }, here, facts)).toEqual({ kind: 'go', target: { project: 2, kehikko: null, epic: 'thesis', parts: ['ch1'], step: null } })
    expect(planJump({ project: 2, kehikko: 'draft', epic: 'thesis', parts: [], step: 3 }, here, facts)).toEqual({
      kind: 'go',
      target: { project: 2, kehikko: 'draft', epic: 'thesis', parts: [], step: 3 },
    })
  })
  test('into a project on all epics without an epic named: all epics there', () => {
    const fromPaper: Place = { project: 2, kehikko: 'draft', epic: 'thesis', parts: [], step: null }
    expect(planJump({ project: 1 }, fromPaper, facts)).toEqual({ kind: 'go', target: { project: 1, kehikko: null, epic: null, scope: 'project', parts: [], step: null } })
  })
  test('refused: a project not held, a gone folder, a kehikko not there, parts or a step with no epic', () => {
    expect(planJump({ project: 9 }, here, facts).kind).toBe('refused')
    expect(planJump({ project: 3 }, here, facts)).toEqual({ kind: 'refused', why: expect.stringContaining('folder of Gone is gone') })
    expect(planJump({ kehikko: 'nope' }, here, facts).kind).toBe('refused')
    expect(planJump({ project: 1, step: 2 }, { ...here, project: 2 }, facts)).toEqual({ kind: 'refused', why: expect.stringContaining('name the epic') })
  })
  test('a jump to where the person already is is ignored, a repeat of the same step too', () => {
    expect(planJump({ epic: 'share', parts: ['auth'] }, here, facts).kind).toBe('ignored')
    expect(planJump({ step: 2 }, here, facts).kind).toBe('ignored')
    expect(planJump({ kehikko: 'main' }, here, facts).kind).toBe('ignored')
    expect(planJump({ step: 3 }, here, facts).kind).toBe('go')
  })
})

describe('the mark and Go back', () => {
  const there: Place = { project: 2, kehikko: 'draft', epic: 'thesis', parts: ['ch1'], step: null }
  test('signed, and Go back is exactly where the person was: project, kehikko, epic, parts and step', () => {
    const mark = markAfter(null, here, there)
    expect(jumpMarkText(mark)).toBe('Jumped here by an agent.')
    expect(mark.back).toEqual(here)
  })
  test('a step-only jump says so, with the step’s title', () => {
    const mark = markAfter(null, here, { ...here, step: 7 }, 'Cap the rate')
    expect(jumpMarkText(mark)).toBe('Moved to step 7 (Cap the rate) by an agent.')
  })
  test('a second jump while the mark stands keeps the PERSON’s place to go back to', () => {
    const first = markAfter(null, here, there)
    const second = markAfter(first, there, { ...there, step: 4 })
    expect(second.back).toEqual(here)
    expect(jumpMarkText(second)).toBe('Jumped here by an agent, at step 4.')
  })
  test('once the person is somewhere else, the mark is gone — and the next jump goes back to there', () => {
    const mark = markAfter(null, here, there)
    expect(markStands(mark, there)).toBe(mark)
    expect(markStands(mark, { ...there, step: 9 })).toBe(mark)
    const moved: Place = { ...there, parts: [] }
    expect(markStands(mark, moved)).toBeNull()
    expect(markAfter(mark, moved, here).back).toEqual(moved)
  })
})

describe('pace', () => {
  test('jumps are at least the interval apart', () => {
    expect(paceRefusal(undefined, 1000)).toBeNull()
    expect(paceRefusal(1000, 1000 + JUMP_MIN_INTERVAL_MS - 1)).toContain('Nothing moved')
    expect(paceRefusal(1000, 1000 + JUMP_MIN_INTERVAL_MS)).toBeNull()
  })
})

/* ------------------------------------------------------------ the walk */

describe('the walk to a step: delivered to the containers that follow it', () => {
  test('every container whose frame is standing, but the one that asked', () => {
    const standing = new Set(['a.flows', 'a.journeys', 'a.paper'])
    expect(walkersOf(['a.flows', 'a.journeys', 'a.paper', 'a.gone'], (id) => standing.has(id), 'a.flows')).toEqual(['a.journeys', 'a.paper'])
  })
  test('only frames that are there are walked; found follows, not found says why', async () => {
    const walked: string[] = []
    const answers: Record<string, Walked> = { 'a.journeys': { found: true, why: '' }, 'a.notes': { found: false, why: 'nothing here to walk to' } }
    const presses = {
      walk: (id: string, target: { epic?: string; step?: number }) => {
        if (!(id in answers)) return null
        walked.push(`${id}:${target.epic}#${target.step}`)
        return Promise.resolve(answers[id]!)
      },
    }
    expect(await walkAll(presses, ['a.journeys', 'a.notes', 'a.unframed'], { epic: 'share', step: 7 })).toEqual([
      { module: 'a.journeys', found: true, why: '' },
      { module: 'a.notes', found: false, why: 'nothing here to walk to' },
    ])
    expect(walked).toEqual(['a.journeys:share#7', 'a.notes:share#7'])
  })
  test('after a switch, a frame still coming up is asked again; one never ready is said', async () => {
    let round = 0
    const presses = {
      walk: (id: string) => {
        if (id === 'a.late') return round < 2 ? null : Promise.resolve({ found: true, why: '' })
        if (id === 'a.greeting') return Promise.resolve(round < 1 ? { found: false, why: NOT_GREETED } : { found: true, why: '' })
        return null
      },
    }
    const told = await walkSoon(presses, () => ['a.late', 'a.greeting', 'a.never'], { epic: 'share', step: 1 }, {
      tries: 4,
      wait: async () => void round++,
    })
    expect(told).toContainEqual({ module: 'a.late', found: true, why: '' })
    expect(told).toContainEqual({ module: 'a.greeting', found: true, why: '' })
    expect(told).toContainEqual({ module: 'a.never', found: false, why: 'it was not ready in time' })
  })
  test('a walk stops once the person is somewhere else', async () => {
    const told = await walkSoon({ walk: () => null }, () => null, { epic: 'share', step: 1 }, { wait: async () => {} })
    expect(told).toEqual([])
  })
})

describe('a module’s view.goto { epic, step }: a person’s press on a step in Flows', () => {
  const controls = () => {
    const walked: { target: { epic: string; step: number }; from: string }[] = []
    const c = {
      showEpic: () => {},
      goto: () => ({ outcome: 'declined', epic: null, why: '' }),
      walkStep: (target: { epic: string; step: number }, from: string) => void walked.push({ target, from }),
    } as unknown as CanvasControls
    return { c, walked }
  }
  test('walks the other containers to that step, named by who asked', async () => {
    const { c, walked } = controls()
    expect((await makeAsk('kehikot.flows', c)('view.goto', { epic: 'share', step: 3 })).ok).toBe(true)
    expect(walked).toEqual([{ target: { epic: 'share', step: 3 }, from: 'kehikot.flows' }])
  })
  test('an epic alone walks nobody', async () => {
    const { c, walked } = controls()
    await makeAsk('kehikot.journeys', c)('view.goto', { epic: 'share' })
    expect(walked).toEqual([])
  })
})

describe('the road from the door to the page on screen and back', () => {
  test('the order goes down that page’s streams only, and the answer carries who was told', async () => {
    const wakes = new Wakes()
    const heard: Record<string, News[]> = { mine: [], other: [] }
    wakes.listen((news) => void heard.mine!.push(news), 'mine')
    wakes.listen((news) => void heard.other!.push(news), 'other')
    const desk = headersDesk({ hears: (page) => wakes.hears(page), send: () => true, sendJump: (order) => wakes.jump(order) })
    desk.held.posted('mine', 5, 1, {})
    const jumping = desk.door.jump(5, { epic: 'share', step: 4, title: 'Cap the rate' })
    const order = (heard.mine![0] as { jump: JumpOrder }).jump
    expect(order).toMatchObject({ page: 'mine', epic: 'share', step: 4, title: 'Cap the rate' })
    expect(heard.other).toEqual([])
    const answer = new Request('http://localhost/host/pressed', {
      method: 'POST',
      body: JSON.stringify({ page: 'mine', id: order.id, ok: true, why: '', told: [{ module: 'a.journeys', found: true, why: '' }] }),
    })
    await desk.route(answer, new URL(answer.url))
    expect(await jumping).toEqual({ ok: true, why: '', told: [{ module: 'a.journeys', found: true, why: '' }] })
  })
  test('no listening page: null, nothing sent', async () => {
    const desk = headersDesk({ hears: () => false, send: () => true, sendJump: () => true })
    expect(await desk.door.jump(5, { step: 4 })).toBeNull()
  })
  test('an order to another page, or malformed, is no order; a told list is bounded', () => {
    expect(jumpOrderIn({ id: 'x', page: 'p1', project: 2, kehikko: 'draft', epic: 'share', parts: ['a', 'a'], step: 2 }, 'p1')).toEqual({
      id: 'x',
      project: 2,
      kehikko: 'draft',
      epic: 'share',
      parts: ['a'],
      step: 2,
    })
    expect(jumpOrderIn({ id: 'x', page: 'p2', step: 2 }, 'p1')).toBeNull()
    expect(jumpOrderIn({ id: 'x', page: 'p1', epic: 'Share!' }, 'p1')).toBeNull()
    expect(jumpOrderIn({ id: 'x', page: 'p1', step: 0 }, 'p1')).toBeNull()
    expect(toldIn([{ module: 'a.one', found: 'yes' }])).toBeNull()
  })
})

/* ------------------------------------------------------------ the tool */

let db: Database
let openness: Openness
let folders: string[]
let project: Project
let other: Project
let kehikko: number
let asked: { kehikko: number; ask: Record<string, unknown> }[]
let answer: Came | null
let jumps: Map<number, number>
let clock: number
let logged: string[]

const STEPS = [{ id: 'one', title: 'Sign in' }, { id: 'two', title: 'Share a link' }, { id: 'three', title: 'Cap the rate' }]

function aProject(name: string, epics: Record<string, unknown>): Project {
  const outer = mkdtempSync(join(tmpdir(), 'kehikko-jump-'))
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
    share: { slug: 'share', title: 'Share links', steps: STEPS, parts: [{ id: 'auth', name: 'Sign-in' }, { id: 'ui', name: 'The page' }] },
    other: { slug: 'other', title: 'Other', steps: [] },
  })
  other = aProject('Paper', { thesis: { slug: 'thesis', title: 'Thesis', steps: [] } })
  kehikko = createCanvas(db, 'Main', project.id).id
  createCanvas(db, 'Wide', project.id)
  createCanvas(db, 'Draft', other.id)
  editCanvas(db, kehikko, { placements: [{ i: 'a.journeys', x: 0, y: 0, w: 6, h: 20 }, { i: 'a.flows', x: 6, y: 0, w: 6, h: 20 }] as Placement[] })
  setSubject(db, project.id, { epic: 'share' })
  openness.reported('page-1', kehikko)
  asked = []
  answer = { ok: true, why: '', told: [{ module: 'a.journeys', found: true, why: '' }, { module: 'a.flows', found: false, why: 'nothing here to walk to' }] }
  jumps = new Map()
  clock = 100_000
  logged = []
})
afterEach(() => {
  db.close()
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

const door = (): Door => ({
  db,
  which: () => openness.open(),
  watched: () => openness.every(),
  wake: () => {},
  epicsChanged: () => {},
  dispositionsChanged: () => {},
  seen: async () => [
    { id: 'a.journeys', name: 'Journeys', condition: 'ready' },
    { id: 'a.flows', name: 'Flows', condition: 'ready' },
  ],
  headers: {
    on: () => new Map(),
    press: async () => null,
    jump: async (k, ask) => {
      asked.push({ kehikko: k, ask })
      return answer
    },
  },
  jumps,
  now: () => clock,
  log: (line) => void logged.push(line),
})

const keyOf = (name: string) => listCanvases(db).find((c) => c.name === name)!.key!

describe('jump, the tool', () => {
  test('a step alone: sent to the page on screen with its title, and who followed is said', async () => {
    const done = await call('jump', { step: 3 }, door())
    expect(done.failed).toBe(false)
    expect(asked).toEqual([{ kehikko, ask: { step: 3, title: 'Cap the rate' } }])
    expect(done.text).toContain('Followed the step: Journeys (a.journeys)')
    expect(done.text).toContain('Told and did not follow: Flows (a.flows) — nothing here to walk to')
    expect(done.text).toContain('Moved to step 3 by an agent')
    expect(done.text).toContain('Go back')
    expect(logged).toEqual(['jump: an agent jumped the view to step 3 (Cap the rate)'])
  })

  test('each kind, by name: another project, its kehikko, an epic by title, parts by heading', async () => {
    await call('jump', { project: 'Paper', kehikko: 'Draft' }, door())
    expect(asked.at(-1)!.ask).toEqual({ project: other.id, kehikko: keyOf('Draft') })
    clock += JUMP_MIN_INTERVAL_MS
    await call('jump', { kehikko: 'wide' }, door())
    expect(asked.at(-1)!.ask).toEqual({ kehikko: keyOf('Wide') })
    clock += JUMP_MIN_INTERVAL_MS
    await call('jump', { epic: 'Other' }, door())
    expect(asked.at(-1)!.ask).toEqual({ epic: 'other' })
    clock += JUMP_MIN_INTERVAL_MS
    await call('jump', { parts: ['The page', 'auth'] }, door())
    expect(asked.at(-1)!.ask).toEqual({ parts: ['ui', 'auth'] })
    clock += JUMP_MIN_INTERVAL_MS
    await call('jump', { project: other.path }, door())
    expect(asked.at(-1)!.ask).toEqual({ project: other.id })
  })

  test('the door writes nothing: no subject, kehikko or arrangement changes on the server', async () => {
    const before = { subject: readSubject(db, project.id), canvases: listCanvases(db), open: openness.open() }
    await call('jump', { project: 'Paper' }, door())
    expect(readSubject(db, project.id)).toEqual(before.subject)
    expect(listCanvases(db)).toEqual(before.canvases)
    expect(openness.open()).toEqual(before.open)
  })

  test('unknown targets are refused with what exists, and nothing is sent', async () => {
    expect((await call('jump', { project: 'Nope' }, door())).text).toContain('Its projects: Kehikko')
    expect((await call('jump', { kehikko: 'Nope' }, door())).text).toContain('Main (key ')
    expect((await call('jump', { epic: 'nope' }, door())).text).toContain('Its epics: ')
    expect((await call('jump', { parts: ['nope'] }, door())).text).toContain('Its parts: Sign-in (auth), The page (ui)')
    const step = await call('jump', { step: 9 }, door())
    expect(step.text).toContain('share has 3 steps, so there is no step 9')
    expect(step.text).toContain('3 Cap the rate')
    expect((await call('jump', {}, door())).text).toContain('needs somewhere to go')
    expect((await call('jump', { project: 'Paper', step: 1 }, door())).text).toContain('name the epic')
    expect(asked).toEqual([])
  })

  test('acts on the page on screen only: none open, nothing moves', async () => {
    openness.reported('page-1', null)
    const done = await call('jump', { step: 2 }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('Nothing moved.')
    answer = null
    openness.reported('page-1', kehikko)
    expect((await call('jump', { step: 2 }, door())).text).toContain('not listening')
  })

  test('paced: a second jump within the interval is refused before any page hears it', async () => {
    await call('jump', { step: 2 }, door())
    clock += JUMP_MIN_INTERVAL_MS - 1
    const again = await call('jump', { step: 3 }, door())
    expect(again.failed).toBe(true)
    expect(again.text).toContain('jumped a moment ago')
    expect(asked).toHaveLength(1)
    clock += 1
    expect((await call('jump', { step: 3 }, door())).failed).toBe(false)
  })

  test('a jump the page ignored is said as ignored and is not counted against the pace', async () => {
    answer = { ok: true, why: 'The person is already there, so nothing moved.', ignored: true }
    const done = await call('jump', { epic: 'share' }, door())
    expect(done.text).toStartWith('Ignored: ')
    expect(jumps.size).toBe(0)
  })

  test('the page’s own refusal is passed on', async () => {
    answer = { ok: false, why: 'This page does not hold that project, so nothing moved.' }
    expect((await call('jump', { project: 'Paper' }, door())).text).toContain('Nothing moved: This page does not hold')
  })
})
