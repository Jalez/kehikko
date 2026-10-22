import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { open } from '../server/canvases.ts'
import { keep, syncProject } from '../server/kehikot.ts'
import { scratchHost } from '../server/machineDirs.ts'
import { addProject, adopt, knowFolders, listProjects } from '../server/projects.ts'
import { isReadOnlyRoot, makeUnderRoot, resetMissingSaid, setMissingLog } from '../server/projectRoot.ts'
import { createEpic, editParts } from '../server/holdings.ts'
import { editTrackers } from '../server/trackers/edit.ts'
import { shareKehikot } from '../server/projects.ts'
import { toWireContext, NO_SUBJECT } from '../src/host/context.ts'
import { firstUndone, NO_FACTS, projectPicked, TOUR_STEPS } from '../src/host/tour.ts'

/*
 * A folder nobody picked is read, never written.
 *
 * A fresh host with no project opens the home folder so there is a canvas.
 * Twice, a scratch host started that way wrote `~/.kehikot/host/` into a real
 * home. These tests run it on a SCRATCH home only, and assert on its file tree.
 */

let db: Database
let home: string
let realHome: string
let lines: string[]
const saved = process.env.HOME

/** Every path under a folder, relative, sorted: the "file tree" assertions read. */
function tree(root: string, at = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, at)).sort()) {
    const rel = at ? `${at}/${name}` : name
    out.push(rel)
    if (statSync(join(root, rel)).isDirectory()) out.push(...tree(root, rel))
  }
  return out
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kehikko-home-'))
  realHome = realpathSync(home)
  mkdirSync(join(home, '.git')) // a git home: the .gitignore edits are in play
  process.env.HOME = home
  db = open(':memory:')
  knowFolders(db)
  lines = []
  resetMissingSaid()
  setMissingLog((line) => lines.push(line))
})
afterEach(() => {
  process.env.HOME = saved
  db.close()
  rmSync(home, { recursive: true, force: true })
  setMissingLog((line) => console.warn(line))
})

/** Everything the host writes on a project, tried in turn. */
function writeEverything(id: number, path: string): void {
  syncProject(db, { id, path })
  keep(db, id)
  createEpic(path, { title: 'An epic' } as never)
  editParts(path, 'an-epic', { op: 'add', title: 'x' } as never)
  editTrackers(path, { remote: 'github.com/a/b' } as never, [])
  shareKehikot(db, id, false)
  makeUnderRoot(path, join(path, '.kehikot', 'kehikot.notes'))
}

describe('the home fallback is read-only', () => {
  test('adopt opens home, flagged, and writes nothing under it', () => {
    const before = tree(home)
    const settled = adopt(db, { HOME: home })
    expect(settled.seeded?.path).toBe(realHome)
    expect(settled.seeded?.home).toBe(true)
    expect(isReadOnlyRoot(realHome)).toBe(true)

    const project = listProjects(db)[0]!
    writeEverything(project.id, project.path)
    expect(createEpic(project.path, { title: 'An epic' })).toMatchObject({ ok: false, status: 409 })
    expect(tree(home)).toEqual(before)
    expect(lines.some((line) => line.includes('nothing is written under it'))).toBe(true)
  })

  test('a module is told of no project while it is the fallback', () => {
    adopt(db, { HOME: home })
    const project = listProjects(db)[0]!
    const wire = toWireContext({ ...NO_SUBJECT, project }, undefined as never, null as never)
    expect(wire.projectPath).toBeNull()
    expect(wire.project).toBeNull()
  })

  test('a real project beside it is written as ever', () => {
    adopt(db, { HOME: home })
    const other = join(home, 'work')
    mkdirSync(other)
    const added = addProject(db, other)
    if (!added.ok) throw new Error('not added')
    syncProject(db, { id: added.project.id, path: added.project.path })
    expect(tree(home).some((path) => path.startsWith('work/.kehikot'))).toBe(true)
    expect(tree(home).filter((path) => path.startsWith('.kehikot'))).toEqual([])
  })
})

describe('picking home on purpose allows writes', () => {
  test('the picker clears the flag and the host writes under it', () => {
    adopt(db, { HOME: home })
    expect(listProjects(db)[0]?.home).toBe(true)
    const picked = addProject(db, home)
    if (!picked.ok) throw new Error('not added')
    expect(picked.already).toBe(true)
    expect(picked.project.home).toBeUndefined()
    expect(isReadOnlyRoot(realHome)).toBe(false)

    expect(makeUnderRoot(realHome, join(realHome, '.kehikot', 'host'))).toBe(true)
    syncProject(db, { id: picked.project.id, path: picked.project.path })
    expect(tree(home)).toContain('.kehikot/host')
  })

  test('a named seed is a pick', () => {
    const seed = join(home, 'seed')
    mkdirSync(seed)
    expect(adopt(db, { KEHIKOT_SEED_PROJECT: seed }).seeded?.home).toBeUndefined()
    expect(isReadOnlyRoot(seed)).toBe(false)
  })
})

describe('a scratch host never falls back to a real folder', () => {
  const warned: string[] = []
  const warn = console.warn
  beforeEach(() => {
    warned.length = 0
    console.warn = (line: string) => void warned.push(String(line))
  })
  afterEach(() => {
    console.warn = warn
  })

  test('which environments are scratch', () => {
    expect(scratchHost({})).toBe(false)
    expect(scratchHost({ KEHIKOT_SCRATCH: '1' })).toBe(true)
    expect(scratchHost({ KEHIKOT_FRAME_DB: join(tmpdir(), 'x', 'frame.sqlite') })).toBe(true)
    expect(scratchHost({ KEHIKOT_MODULES_DIR: '/tmp/modules' })).toBe(true)
    expect(scratchHost({ KEHIKOT_LOGS_DIR: '/Users/someone/Library/Logs/Kehikot' })).toBe(false)
  })

  test('no seed: no project, one line, nothing written', () => {
    const before = tree(home)
    const settled = adopt(db, { HOME: home, KEHIKOT_MODULES_DIR: join(tmpdir(), 'scratch-modules') })
    expect(settled.seeded).toBeNull()
    expect(listProjects(db)).toEqual([])
    expect(warned.filter((line) => line.includes('scratch host'))).toHaveLength(1)
    expect(tree(home)).toEqual(before)
  })

  test('with a seed it opens that one', () => {
    const seed = join(home, 'seed')
    mkdirSync(seed)
    const settled = adopt(db, { KEHIKOT_SCRATCH: '1', KEHIKOT_SEED_PROJECT: seed })
    expect(settled.seeded?.path).toBe(realpathSync(seed))
  })
})

describe('the tour waits for a pick', () => {
  const step = TOUR_STEPS.find((one) => one.id === 'project')!

  test('the fallback is no project; a pick is', () => {
    expect(projectPicked(null, null)).toBe(false)
    expect(projectPicked(1, { home: true })).toBe(false)
    expect(projectPicked(1, {})).toBe(true)
  })

  test('the project step waits on the fallback and is done after a pick', () => {
    adopt(db, { HOME: home })
    const fallback = listProjects(db)[0]!
    const waiting = { ...NO_FACTS, project: projectPicked(fallback.id, fallback) }
    expect(step.done?.(waiting)).toBe(false)
    expect(firstUndone(waiting)).toBe(0)

    const picked = addProject(db, home)
    if (!picked.ok) throw new Error('not added')
    const facts = { ...NO_FACTS, project: projectPicked(picked.project.id, picked.project) }
    expect(step.done?.(facts)).toBe(true)
    expect(firstUndone(facts)).toBeGreaterThan(0)
  })
})
