import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createCanvas, editCanvas, listCanvases, open, type Canvas, type Placement } from '../server/canvases.ts'
import { copiedSaid, copyKehikko, elsewhere } from '../server/fromProject.ts'
import { PAGE_ONLY } from '../server/guard.ts'
import { editKehikkoSettings, readKehikkoSettings } from '../server/kehikkoSettings.ts'
import { listKehikkoSkills, saveKehikkoSkill } from '../server/kehikkoSkills.ts'
import { call, type Door, type Sighting } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { recordVisit } from '../server/pickerOrder.ts'
import { addProject, type Project } from '../server/projects.ts'
import { byRecent, copiedPlacements, findProjects, notInstalled, takeIn, TAKE_DEFAULT } from '../src/host/fromProject.ts'

/*
 * A kehikko started from one in another project: the arrangement whole, the kehikko's own settings
 * the person ticks, and nothing of the other project's — `src/host/fromProject.ts`.
 */

let root: string
let db: Database
let here: Project
let there: Project
let source: Canvas
let woken: number[]

const seen: Sighting[] = [
  { id: 'a.one', name: 'One', condition: 'ready' },
  { id: 'a.agent', name: 'Agent', condition: 'ready' },
]

const folder = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

const door = (more: Partial<Door> = {}): Door => {
  const openness = new Openness()
  return {
    db,
    which: () => openness.open(),
    watched: () => openness.every(),
    wake: (kehikko) => void woken.push(kehikko),
    epicsChanged: () => {},
    epicWritten: () => {},
    dispositionsChanged: () => {},
    seen: async () => seen,
    session: 'session-from-project-0',
    arranges: new Map(),
    now: () => 1_000_000,
    ...more,
  }
}

const placed = (more: Partial<Placement> & { i: string }): Placement => ({
  x: 0,
  y: 0,
  w: 12,
  h: 28,
  wish: 28,
  grow: false,
  pinned: false,
  prompt: '',
  promptFor: null,
  collapsed: false,
  selected: false,
  filters: {},
  refreshEvery: null,
  version: null,
  scope: null,
  ...more,
})

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-from-project-')))
  db = open(':memory:')
  woken = []
  const a = addProject(db, folder('here'))
  const b = addProject(db, folder('there'), undefined, false)
  if (!a.ok || !b.ok) throw new Error('no project')
  here = a.project
  there = b.project
  const made = createCanvas(db, 'Review desk', there.id)
  source = editCanvas(db, made.id, {
    placements: [
      placed({ i: 'a.one', x: 0, w: 8, grow: true, prompt: 'Look at the tests first', promptFor: 'a.agent', refreshEvery: 15, scope: 'epic', selected: true, pinned: true, filters: { doc: 'thesis.md' }, version: 'v1.2.0' }),
      placed({ i: 'a.agent', x: 8, w: 8, h: 1, wish: 30, collapsed: true }),
      placed({ i: 'b.absent', x: 16, w: 8, tiled: true }),
    ],
    connections: { off: [{ kind: 'passage', from: 'a.one', to: 'a.agent' }], only: [] },
  })!
  saveKehikkoSkill(there.path, source.key, { name: 'review-first', description: 'Read the diff before anything', body: 'Read it.' })
  editKehikkoSettings(db, there.id, source.key, { primary: 'a.agent' }, ['a.agent'])
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('what is copied and what is not', () => {
  test('the arrangement whole — rectangles, wishes, folds, tiles, grow, scope, prompt, refresh — and none of the other project’s particulars', () => {
    const copied = copiedPlacements(source.placements).sort((a, b) => a.x - b.x)
    expect(copied.map((p) => [p.i, p.x, p.w, p.wish, p.collapsed, p.tiled === true, p.grow])).toEqual([
      ['a.one', 0, 8, 28, false, false, true],
      ['a.agent', 8, 8, 30, true, false, false],
      ['b.absent', 16, 8, 28, false, true, false],
    ])
    const one = copied.find((p) => p.i === 'a.one')!
    expect([one.prompt, one.promptFor, one.refreshEvery, one.scope]).toEqual(['Look at the tests first', 'a.agent', 15, 'epic'])
    /* Picked out, pinned, filtered and version-pinned are the other project's. */
    for (const p of copied) {
      expect(p.selected).toBe(false)
      expect(p.pinned).toBe(false)
      expect(p.filters).toEqual({})
      expect(p.version).toBeNull()
    }
  })

  test('copyKehikko makes the kehikko here with its connection choices, its skills and its primary agent', () => {
    const copied = copyKehikko(db, { from: source.id, into: here.id, name: 'My review', take: TAKE_DEFAULT })
    if (!copied.ok) throw new Error(copied.why)
    const made = listCanvases(db).find((c) => c.id === copied.canvas.id)!
    expect(made.project).toBe(here.id)
    expect(made.name).toBe('My review')
    expect(made.key).not.toBe('')
    expect(made.placements.map((p) => p.i).sort()).toEqual(['a.agent', 'a.one', 'b.absent'])
    expect(made.placements.find((p) => p.i === 'a.agent')?.collapsed).toBe(true)
    expect(made.placements.find((p) => p.i === 'b.absent')?.tiled).toBe(true)
    expect(made.placements.some((p) => p.selected || p.pinned || p.version !== null || Object.keys(p.filters).length)).toBe(false)
    expect(made.connections.off).toEqual([{ kind: 'passage', from: 'a.one', to: 'a.agent' }])
    expect(listKehikkoSkills(here.path, made.key).map((one) => [one.name, one.description, one.body])).toEqual([['review-first', 'Read the diff before anything', 'Read it.']])
    expect(readKehikkoSettings(db, here.id, made.key).primary).toBe('a.agent')
    expect(copied.took).toEqual({ general: true, skills: true, agents: true })
    expect(copiedSaid(copied, ['Absent'], new Map([['a.agent', 'Agent']]))).toBe(
      'Made My review from Review desk in there: 3 containers where they were, its connection choices, its skill review-first, Agent as its primary agent. '
        + 'Not installed here: Absent. Their containers are on it, waiting to be installed from Kehikko modules.',
    )
  })

  test('each settings group stays behind when unticked, and the arrangement still comes', () => {
    const copied = copyKehikko(db, { from: source.id, into: here.id, name: '', take: { general: false, skills: false, agents: false } })
    if (!copied.ok) throw new Error(copied.why)
    const made = copied.canvas
    /* No name given: the source's. */
    expect(made.name).toBe('Review desk')
    expect(made.placements).toHaveLength(3)
    expect(made.connections).toEqual({ off: [], only: [] })
    expect(listKehikkoSkills(here.path, made.key)).toEqual([])
    expect(existsSync(join(here.path, '.kehikot', 'host', 'skills', made.key))).toBe(false)
    expect(readKehikkoSettings(db, here.id, made.key).primary).toBeNull()
  })

  test('nothing is written into the other project, and its kehikko is left as it was', () => {
    const before = readdirSync(join(there.path, '.kehikot', 'host'), { recursive: true }).map(String).filter((one) => !one.endsWith('kehikot.json')).sort()
    copyKehikko(db, { from: source.id, into: here.id, name: 'Copy', take: TAKE_DEFAULT })
    const after = readdirSync(join(there.path, '.kehikot', 'host'), { recursive: true }).map(String).filter((one) => !one.endsWith('kehikot.json')).sort()
    expect(after).toEqual(before)
    const still = listCanvases(db).find((c) => c.id === source.id)!
    expect(still.placements.find((p) => p.i === 'a.one')?.selected).toBe(true)
    expect(still.placements.find((p) => p.i === 'a.one')?.filters).toEqual({ doc: 'thesis.md' })
  })

  test('a primary agent that is not in the arrangement is not carried', () => {
    editKehikkoSettings(db, there.id, source.key, { primary: 'a.gone' }, ['a.gone'])
    const copied = copyKehikko(db, { from: source.id, into: here.id, name: 'X', take: TAKE_DEFAULT })
    if (!copied.ok) throw new Error(copied.why)
    expect(copied.primary).toBeNull()
    expect(readKehikkoSettings(db, here.id, copied.canvas.key).primary).toBeNull()
  })

  test('refused in words for a kehikko or a project that is not there; nothing is made', () => {
    const count = listCanvases(db).length
    expect(copyKehikko(db, { from: 9999, into: here.id })).toMatchObject({ ok: false, status: 404 })
    expect(copyKehikko(db, { from: source.id, into: 9999 })).toMatchObject({ ok: false, status: 404 })
    expect(listCanvases(db)).toHaveLength(count)
  })

  test('takeIn reads literal booleans and defaults every other value to on', () => {
    expect(TAKE_DEFAULT).toEqual({ general: true, skills: true, agents: true })
    expect(takeIn(undefined)).toEqual(TAKE_DEFAULT)
    expect(takeIn({ skills: false, agents: 'no' })).toEqual({ general: true, skills: false, agents: true })
  })

  test('the copy is the page’s alone: its POST is in PAGE_ONLY', () => {
    expect(PAGE_ONLY).toContain('/host/kehikot/copy')
  })
})

describe('modules that are not installed here', () => {
  test('their containers are kept, never dropped, and the card names them as not installed', () => {
    const copied = copyKehikko(db, { from: source.id, into: here.id, name: 'Copy', take: TAKE_DEFAULT })
    if (!copied.ok) throw new Error(copied.why)
    expect(copied.canvas.placements.find((p) => p.i === 'b.absent')).toMatchObject({ x: 16, w: 8 })
    const listed = elsewhere(db, here.id).find((one) => one.id === there.id)!.kehikot[0]!
    expect(notInstalled(listed.containers, new Map([['a.one', 'One'], ['a.agent', 'Agent']]), [])).toEqual(['b.absent'])
    /* A module the official list names is said by its name there. */
    expect(notInstalled(listed.containers, new Map([['a.one', 'One'], ['a.agent', 'Agent']]), [{ id: 'b.absent', name: 'Absent', installed: false }])).toEqual(['Absent'])
  })
})

describe('the projects the dialog lists', () => {
  test('every other project, recent first, with its kehikot, skill names, primary agent and connection choices', () => {
    const third = addProject(db, folder('third'), undefined, false)
    if (!third.ok) throw new Error('no project')
    recordVisit(db, { project: there.id }, 100)
    recordVisit(db, { project: third.project.id }, 200)
    const listed = elsewhere(db, here.id)
    expect(listed.map((one) => one.name)).toEqual(['third', 'there'])
    const desk = listed[1]!.kehikot.find((one) => one.id === source.id)!
    expect(desk).toMatchObject({ name: 'Review desk', key: source.key, skills: ['review-first'], primary: 'a.agent', connections: true, folded: 2 })
    /* The picture is the arrangement, unfolded. */
    expect(desk.containers.find((c) => c.module === 'a.agent')?.h).toBe(30)
  })

  test('the search matches every word in the name or the folder, accents and case aside', () => {
    const projects = [
      { name: 'Kollekti', path: '/p/kollekti', visited: 1 },
      { name: 'Thesis', path: '/home/väitös', visited: 3 },
      { name: 'Alpha', path: '/p/alpha', visited: null },
    ]
    expect(findProjects(projects, 'VAITOS').map((one) => one.name)).toEqual(['Thesis'])
    expect(findProjects(projects, 'p kol').map((one) => one.name)).toEqual(['Kollekti'])
    expect(findProjects(projects, '  ')).toHaveLength(3)
    expect(byRecent(projects).map((one) => one.name)).toEqual(['Thesis', 'Kollekti', 'Alpha'])
  })
})

describe('the door: create_kehikko', () => {
  test('with from { project, kehikko } it copies another project’s kehikko into the named project, and says what is not installed', async () => {
    const got = await call('create_kehikko', { project: here.path, name: 'Agent review', from: { project: there.path, kehikko: source.key } }, door())
    expect(got.failed).toBe(false)
    const made = listCanvases(db).find((c) => c.project === here.id && c.name === 'Agent review')!
    expect(made.placements.map((p) => p.i).sort()).toEqual(['a.agent', 'a.one', 'b.absent'])
    expect(got.text).toContain('Not installed here: b.absent.')
    expect(got.text).toContain(`key ${made.key}`)
    expect(got.text).toContain('view did not move')
    expect(woken).toContain(made.id)
    expect(listKehikkoSkills(here.path, made.key).map((one) => one.name)).toEqual(['review-first'])
  })

  test('the kehikko is named by its key, its exact name or its id; take leaves settings behind', async () => {
    const byName = await call('create_kehikko', { project: here.path, from: { project: there.name, kehikko: 'review desk' }, take: { skills: false } }, door())
    expect(byName.failed).toBe(false)
    const made = listCanvases(db).filter((c) => c.project === here.id && c.name === 'Review desk')
    expect(made).toHaveLength(1)
    expect(listKehikkoSkills(here.path, made[0]!.key)).toEqual([])
    const byId = await call('create_kehikko', { project: here.path, name: 'Third', from: { project: there.path, kehikko: source.id } }, door())
    expect(byId.failed).toBe(false)
  })

  test('refused in words, with the project’s kehikot, when the kehikko is not there; nothing is made', async () => {
    const before = listCanvases(db).length
    const got = await call('create_kehikko', { project: here.path, from: { project: there.path, kehikko: 'nope' } }, door())
    expect(got.failed).toBe(true)
    expect(got.text).toContain('has no kehikko "nope"')
    expect(got.text).toContain('Review desk')
    expect(listCanvases(db).length).toBe(before)
    const bad = await call('create_kehikko', { project: here.path, from: 'Review desk' }, door())
    expect(bad.failed).toBe(true)
  })

  test('without from it makes an empty kehikko in the named project, with no page open', async () => {
    const got = await call('create_kehikko', { project: there.path, name: 'Scratch' }, door())
    expect(got.failed).toBe(false)
    const made = listCanvases(db).find((c) => c.project === there.id && c.name === 'Scratch')!
    expect(made.placements).toEqual([])
    expect(woken).toContain(made.id)
  })
})
