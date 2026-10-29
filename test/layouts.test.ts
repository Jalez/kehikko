import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { createCanvas, editCanvas, listCanvases, open as openDb, type Placement } from '../server/canvases.ts'
import { layoutsDir } from '../server/machineDirs.ts'
import { projectLayoutsDir, readShelves, saveLayout } from '../server/layouts.ts'
import { readOnboarding, writeOnboarding, ensureOnboarding } from '../server/onboarding.ts'
import { addProject } from '../server/projects.ts'
import { OFFICIAL } from '../server/official.ts'
import {
  availability,
  availabilitySaid,
  BUILT_IN_LAYOUTS,
  layoutFileSchema,
  placementsFor,
  slugFor,
  toInstall,
  type Layout,
} from '../src/host/layouts.ts'
import { continuable, edited, INTRO_VERSION, introDue, NOT_STARTED, underway } from '../src/host/onboarding.ts'
import { COLUMNS } from '../src/host/canvases.ts'
import { CANVAS_ROWS } from '../src/host/fit.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-layouts-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let made = 0
function folder(): string {
  const dir = join(root, `p${(made += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}


describe('the built-in layouts', () => {
  test('the five ways of working first, then the rest; every module is on the official list or optional', () => {
    expect(BUILT_IN_LAYOUTS.map((one) => one.name)).toEqual([
      'Design',
      'Research',
      'Development',
      'Review',
      'Learning',
      'Write a paper',
      'Plan an epic',
      'Start simple',
    ])
    /* "Build software" became "Development": one layout, not two names for it. */
    expect(BUILT_IN_LAYOUTS.some((one) => one.name === 'Build software')).toBe(false)
    const modulesOf = (id: string) => BUILT_IN_LAYOUTS.find((one) => one.id === id)!.containers.map((c) => c.module.replace('kehikot.', ''))
    expect(modulesOf('design')).toEqual(['browser', 'flows', 'claude', 'notes', 'references'])
    expect(modulesOf('research')).toEqual(['paper', 'browser', 'notes', 'citations', 'references', 'claude'])
    expect(modulesOf('development')).toEqual(['journeys', 'references', 'checklist', 'claude', 'review', 'factory'])
    expect(modulesOf('review')).toEqual(['references', 'checklist', 'diff', 'review', 'browser', 'claude'])
    expect(modulesOf('learning')).toEqual(['paper', 'learning', 'notes', 'slides', 'claude'])
    for (const layout of BUILT_IN_LAYOUTS) expect(layout.summary.length).toBeGreaterThan(20)
    const listed = new Set(OFFICIAL.map((one) => one.id))
    for (const layout of BUILT_IN_LAYOUTS) {
      for (const c of layout.containers) expect(listed.has(c.module) || c.optional === true).toBe(true)
    }
    /* Flows is not on the list: it is used when it is here and left out without a word when not. */
    const plan = BUILT_IN_LAYOUTS.find((one) => one.id === 'plan-an-epic')!
    expect(plan.containers.find((c) => c.module === 'kehikot.flows')?.optional).toBe(true)
  })

  test('each fits the grid — twelve columns, the canvas’s rows — and no two containers overlap', () => {
    for (const layout of BUILT_IN_LAYOUTS) {
      for (const c of layout.containers) {
        expect(c.x + c.w).toBeLessThanOrEqual(COLUMNS)
        expect(c.y + c.h).toBeLessThanOrEqual(CANVAS_ROWS)
        expect(layoutFileSchema.shape.containers.element.safeParse(c).success).toBe(true)
      }
      const cells = new Set<string>()
      for (const c of layout.containers) {
        for (let x = c.x; x < c.x + c.w; x++) {
          for (let y = c.y; y < c.y + c.h; y++) {
            const cell = `${x},${y}`
            expect(cells.has(cell)).toBe(false)
            cells.add(cell)
          }
        }
      }
    }
  })
})

describe('what a layout needs on this computer', () => {
  const layout: Layout = {
    id: 't',
    from: 'project',
    name: 'T',
    summary: '',
    containers: [
      { module: 'kehikot.claude', x: 0, y: 0, w: 6, h: 10 },
      { module: 'kehikot.review', x: 6, y: 0, w: 6, h: 10 },
      { module: 'kehikot.factory', x: 0, y: 10, w: 6, h: 10 },
      { module: 'acme.private', x: 6, y: 10, w: 6, h: 10 },
      { module: 'kehikot.flows', x: 0, y: 20, w: 12, h: 8, optional: true },
    ],
  }
  const registered = new Map([['kehikot.claude', 'Claude']])
  const list = [
    { id: 'kehikot.claude', name: 'Claude', installed: true },
    { id: 'kehikot.review', name: 'Review', installed: false },
    { id: 'kehikot.factory', name: 'Factory', installed: false, newer: { protocol: '9.0.0', has: '2.0.0' } },
  ]

  test('here, installable, needing a newer app, and not available', () => {
    const got = availability(layout, registered, list)
    expect(got.map((one) => [one.module, one.state])).toEqual([
      ['kehikot.claude', 'here'],
      ['kehikot.review', 'install'],
      ['kehikot.factory', 'newer'],
      ['acme.private', 'missing'],
      ['kehikot.flows', 'missing'],
    ])
    expect(availabilitySaid(got)).toBe('will install Review · needs a newer Kehikot: Factory · not available: acme.private')
    expect(toInstall(got).map((one) => one.module)).toEqual(['kehikot.review'])
  })

  test('installed but not yet registered counts as here; nothing listed offers nothing to install', () => {
    const got = availability(layout, new Map(), [{ id: 'kehikot.review', name: 'Review', installed: true }])
    expect(got.find((one) => one.module === 'kehikot.review')?.state).toBe('here')
    expect(toInstall(availability(layout, new Map(), []))).toEqual([])
  })

  test('the new kehikko gets what is here, and what is being installed only when the press named it', () => {
    const got = availability(layout, registered, list)
    expect(placementsFor(layout, got).map((p) => p.i)).toEqual(['kehikot.claude'])
    expect(placementsFor(layout, got, new Set(['kehikot.review'])).map((p) => p.i)).toEqual(['kehikot.claude', 'kehikot.review'])
    const [claude] = placementsFor(layout, got)
    expect(claude).toMatchObject({ x: 0, y: 0, w: 6, h: 10, wish: 10, collapsed: false, selected: false, filters: {}, version: null })
  })
})

describe('the project’s layouts and the person’s own', () => {
  function kehikko(dir: string) {
    const store = openDb(':memory:')
    const added = addProject(store, dir, undefined, false)
    if (!added.ok) throw new Error(added.why)
    const canvas = createCanvas(store, 'writing', added.project.id)
    const notes: Placement = {
      i: 'kehikot.notes', x: 0, y: 0, w: 6, h: 1, grow: false, pinned: true, prompt: '', promptFor: null,
      collapsed: true, wish: 12, selected: true, filters: { a: 'b' }, refreshEvery: null, version: 'v1.0.0', scope: null,
    }
    editCanvas(store, canvas.id, { placements: [notes, { ...notes, i: 'kehikot.paper', x: 6, h: 14, wish: 14, collapsed: false, selected: false, filters: {} }] })
    return listCanvases(store)[0]!
  }

  test('saved for the project, it is a file in .kehikot/host/layouts/ that reads back — rectangles only, folds undone', () => {
    const dir = folder()
    const saved = saveLayout(kehikko(dir), dir, { name: 'Writing week', summary: 'for the draft', where: 'project' })
    expect(saved.ok).toBe(true)
    const file = join(projectLayoutsDir(dir)!, 'writing-week.json')
    expect(existsSync(file)).toBe(true)
    const text = readFileSync(file, 'utf8')
    /* One container per line. */
    expect(text).toContain('\n    {"module":"kehikot.notes","x":0,"y":0,"w":6,"h":12}')
    const containers = text.slice(text.indexOf('"containers"'))
    for (const personal of ['collapsed', 'selected', 'filters', 'version', 'pinned']) expect(containers).not.toContain(personal)
    const shelves = readShelves(dir)
    expect(shelves.project.map((one) => [one.id, one.name, one.summary])).toEqual([['writing-week', 'Writing week', 'for the draft']])
    expect(shelves.builtIn).toHaveLength(BUILT_IN_LAYOUTS.length)
  })

  test('saved for me, it is in the machine directory and offered in every project', () => {
    const one = folder()
    const saved = saveLayout(kehikko(one), one, { name: 'My desk', where: 'mine' })
    expect(saved.ok && saved.file.startsWith(layoutsDir())).toBe(true)
    expect(readShelves(folder()).mine.some((layout) => layout.id === 'my-desk')).toBe(true)
    expect(readShelves(null).mine.some((layout) => layout.id === 'my-desk')).toBe(true)
  })

  test('a name already taken is refused, not replaced; nameless, nowhere and empty are refused', () => {
    const dir = folder()
    const canvas = kehikko(dir)
    expect(saveLayout(canvas, dir, { name: 'Twice', where: 'project' }).ok).toBe(true)
    const again = saveLayout(canvas, dir, { name: 'twice', where: 'project' })
    expect(again).toMatchObject({ ok: false, status: 409 })
    expect(saveLayout(canvas, dir, { name: '  ', where: 'project' })).toMatchObject({ ok: false, status: 400 })
    expect(saveLayout(canvas, dir, { name: 'x', where: 'somewhere' })).toMatchObject({ ok: false, status: 400 })
    expect(saveLayout({ ...canvas, placements: [] }, dir, { name: 'empty', where: 'project' })).toMatchObject({ ok: false, status: 400 })
  })

  test('a layout file that will not read is a sentence, and the others still read', () => {
    const dir = folder()
    mkdirSync(projectLayoutsDir(dir)!, { recursive: true })
    writeFileSync(join(projectLayoutsDir(dir)!, 'broken.json'), '{ nope')
    writeFileSync(join(projectLayoutsDir(dir)!, 'fine.json'), JSON.stringify({ version: 1, name: 'Fine', containers: [{ module: 'kehikot.notes', x: 0, y: 0, w: 4, h: 4 }] }))
    const shelves = readShelves(dir)
    expect(shelves.project.map((one) => one.id)).toEqual(['fine'])
    expect(shelves.trouble.join(' ')).toContain('broken.json')
  })

  test('a slug is lowercase words and dashes', () => {
    expect(slugFor('Write a Paper — fast!')).toBe('write-a-paper-fast')
    expect(slugFor('Ääkköset')).toBe('aakkoset')
    expect(slugFor('---')).toBeNull()
  })
})

describe('the introduction is shown once', () => {
  test('due until seen, and a newer introduction is due again', () => {
    expect(introDue(NOT_STARTED)).toBe(true)
    expect(introDue(null)).toBe(false)
    const seen = edited(NOT_STARTED, { intro: 'seen' })
    expect(seen.intro).toBe(INTRO_VERSION)
    expect(introDue(seen)).toBe(false)
    expect(introDue({ ...seen, intro: INTRO_VERSION - 1 })).toBe(true)
  })

  test('kept in frame.sqlite: seen stays seen, the tour is resumed where it was left', () => {
    const store = openDb(':memory:')
    ensureOnboarding(store)
    expect(readOnboarding(store, {})).toEqual(NOT_STARTED)
    writeOnboarding(store, { intro: 'seen' }, {})
    writeOnboarding(store, { tour: { step: 'epic' } }, {})
    expect(readOnboarding(store, {})).toEqual({ intro: INTRO_VERSION, tour: { step: 'epic', paused: false, finished: false } })
    /* Paused: the step is kept, for Continue tour. */
    writeOnboarding(store, { tour: { step: 'epic', paused: true } }, {})
    expect(readOnboarding(store, {}).tour).toEqual({ step: 'epic', paused: true, finished: false })
    expect(continuable(readOnboarding(store, {}))).toBe(true)
    expect(underway(readOnboarding(store, {}))).toBe(false)
    /* Moving on is not paused. */
    writeOnboarding(store, { tour: { step: 'parts' } }, {})
    expect(underway(readOnboarding(store, {}))).toBe(true)
    writeOnboarding(store, { tour: { step: null, finished: true } }, {})
    expect(readOnboarding(store, {})).toEqual({ intro: INTRO_VERSION, tour: { step: null, paused: false, finished: true } })
    expect(continuable(readOnboarding(store, {}))).toBe(false)
  })

  test('a row from the first tour (numbered stops) reads as not started; a newer introduction is due again', () => {
    const store = openDb(':memory:')
    ensureOnboarding(store)
    store.query("insert into settings (key, value) values ('onboarding', ?)").run(JSON.stringify({ intro: 1, tour: { at: 3, finished: false } }))
    const read = readOnboarding(store, {})
    expect(read.tour).toEqual({ step: null, paused: false, finished: false })
    expect(introDue(read)).toBe(true)
  })

  test('KEHIKOT_ONBOARDING=off answers as if both were done', () => {
    const store = openDb(':memory:')
    ensureOnboarding(store)
    expect(introDue(readOnboarding(store, { KEHIKOT_ONBOARDING: 'off' }))).toBe(false)
  })
})

