import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextSchema, ignoresProjectFile, PROJECT_ID, projectFile, type ActivityItem } from 'kehikot-module-protocol'

import { createCanvas, listCanvases, open } from '../server/canvases.ts'
import { Inbox } from '../server/inbox.ts'
import { call, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { readProjectId, setIdentityLog } from '../server/projectIdentity.ts'
import {
  addProject,
  adopt,
  formerPaths,
  identifyAll,
  listProjects,
  locateProject,
  NOT_THIS_PROJECT,
  projectById,
  relinkProject,
} from '../server/projects.ts'
import { Wakes } from '../server/wake.ts'
import { byProject } from '../src/canvas/useInbox.ts'
import { toWireContext } from '../src/host/context.ts'
import { pickedFrom, projectSchema } from '../src/host/projects.ts'

/*
 * A project's permanent id (protocol 2.1.0): `.kehikot/project.json`, kept in
 * `projects.uid`, and what makes a renamed or moved folder the same project.
 * Every folder here is a scratch directory; the home folder is a scratch HOME.
 */

let root: string
let db: Database
let lines: string[]
const HOME = process.env.HOME

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-identity-')))
  db = open(':memory:')
  lines = []
  setIdentityLog((line) => lines.push(line))
})
afterEach(() => {
  db.close()
  if (HOME === undefined) delete process.env.HOME
  else process.env.HOME = HOME
  chmodAll(root)
  rmSync(root, { recursive: true, force: true })
})

function chmodAll(dir: string): void {
  try {
    chmodSync(dir, 0o755)
  } catch {
    /* Already gone. */
  }
}

function folder(name: string, git = false): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (git) mkdirSync(join(dir, '.git'))
  return dir
}

function added(dir: string) {
  const out = addProject(db, dir)
  if (!out.ok) throw new Error(out.why)
  return out
}

const fileOf = (dir: string) => JSON.parse(readFileSync(projectFile(dir)!, 'utf8')) as { id: string; createdAt: string }

describe('a project is given an id', () => {
  test('minted and written to .kehikot/project.json, and kept out of git', () => {
    const dir = folder('fresh', true)
    const { project } = added(dir)
    expect(project.uid).toMatch(PROJECT_ID)
    expect(fileOf(dir).id).toBe(project.uid!)
    expect(typeof fileOf(dir).createdAt).toBe('string')
    expect(ignoresProjectFile(readFileSync(join(dir, '.gitignore'), 'utf8'))).toBe(true)
    /* Nothing else at the top of `.kehikot/`. */
    expect(existsSync(join(dir, '.kehikot', 'project.json.tmp'))).toBe(false)
  })

  test('a folder with no git gets the file and no .gitignore', () => {
    const dir = folder('plain')
    const { project } = added(dir)
    expect(readProjectId(dir)).toBe(project.uid!)
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)
  })

  test('adopted from a project.json already there, which is never rewritten', () => {
    const dir = folder('carried')
    mkdirSync(join(dir, '.kehikot'))
    const text = `${JSON.stringify({ id: 'kept-from-before-1234', createdAt: '2026-01-01T00:00:00.000Z' })}\n`
    writeFileSync(projectFile(dir)!, text)
    const { project } = added(dir)
    expect(project.uid).toBe('kept-from-before-1234')
    expect(readFileSync(projectFile(dir)!, 'utf8')).toBe(text)
    identifyAll(db)
    expect(readFileSync(projectFile(dir)!, 'utf8')).toBe(text)
  })

  test('a project.json that does not parse is replaced by a minted id', () => {
    const dir = folder('broken')
    mkdirSync(join(dir, '.kehikot'))
    writeFileSync(projectFile(dir)!, '{ not json')
    const { project } = added(dir)
    expect(project.uid).toMatch(PROJECT_ID)
    expect(readProjectId(dir)).toBe(project.uid!)
  })

  test('a read-only folder keeps its id in the database only', () => {
    const dir = folder('locked')
    chmodSync(dir, 0o555)
    try {
      const { project } = added(dir)
      expect(project.uid).toMatch(PROJECT_ID)
      expect(existsSync(join(dir, '.kehikot'))).toBe(false)
      /* And the same id on the next start: the database is where it lives. */
      identifyAll(db)
      expect(projectById(db, project.id)?.uid).toBe(project.uid)
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  test('the home folder is never written into, and keeps its id in the database', () => {
    const home = folder('home', true)
    process.env.HOME = home
    const { project } = added(home)
    expect(project.uid).toMatch(PROJECT_ID)
    identifyAll(db)
    expect(projectById(db, project.id)?.uid).toBe(project.uid)
    expect(existsSync(join(home, '.kehikot'))).toBe(false)
    expect(existsSync(join(home, '.gitignore'))).toBe(false)
  })

  test('a project already in the database gets its id on the next start', () => {
    const dir = folder('older')
    db.query("insert into projects (name, path, rank) values ('older', ?, 1)").run(dir)
    expect(listProjects(db)[0]?.uid).toBeNull()
    adopt(db, {})
    const uid = listProjects(db)[0]?.uid
    expect(uid).toMatch(PROJECT_ID)
    expect(readProjectId(dir)).toBe(uid!)
  })
})

describe('two folders carrying one id', () => {
  test('a copy added beside the original is a project of its own with a fresh id', () => {
    const original = folder('original')
    const first = added(original).project
    const copy = join(root, 'copy')
    cpSync(original, copy, { recursive: true })

    const second = added(copy)
    expect(second.relinked).toBeUndefined()
    expect(second.project.id).not.toBe(first.id)
    expect(second.project.uid).not.toBe(first.uid)
    expect(readProjectId(copy)).toBe(second.project.uid!)
    /* The older keeps its id, in the database and on disk. */
    expect(projectById(db, first.id)?.uid).toBe(first.uid)
    expect(readProjectId(original)).toBe(first.uid!)
    expect(lines.some((line) => line.includes('a copy of it'))).toBe(true)
  })

  test('on start, the older row keeps the id and the newer folder is given a fresh one', () => {
    const a = folder('a')
    const b = folder('b')
    const one = added(a).project
    const two = added(b).project
    /* Somebody copied a's project.json over b's. */
    writeFileSync(projectFile(b)!, readFileSync(projectFile(a)!, 'utf8'))
    identifyAll(db)
    expect(projectById(db, one.id)?.uid).toBe(one.uid)
    const now = projectById(db, two.id)?.uid
    expect(now).toMatch(PROJECT_ID)
    expect(now).not.toBe(one.uid)
    expect(readProjectId(b)).toBe(now!)
    expect(lines.length).toBeGreaterThan(0)
  })

  test('says once when git tracks the file', () => {
    const a = folder('tracked-a')
    const one = added(a).project
    const b = join(root, 'tracked-b')
    cpSync(a, b, { recursive: true })
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', b, ...args], { stdout: 'ignore', stderr: 'ignore' })
    git('init', '-q')
    git('add', '-f', '.kehikot/project.json')
    const two = added(b).project
    expect(two.uid).not.toBe(one.uid)
    const said = lines.filter((line) => line.includes('git tracks'))
    expect(said).toHaveLength(1)
    identifyAll(db)
    expect(lines.filter((line) => line.includes('git tracks'))).toHaveLength(1)
  })
})

describe('a moved folder is the same project', () => {
  test('adding the renamed folder relinks the row: same id, kehikot, Inbox and former path', () => {
    const before = folder('thesis')
    const { project } = added(before)
    createCanvas(db, 'writing', project.id)
    const inbox = new Inbox(db, () => 1_000_000)
    inbox.report(project.id, 'kehikot.claude', 'Claude', [{ id: 's', state: 'working', label: 'Writing' } as ActivityItem])
    const canvases = listCanvases(db).filter((c) => c.project === project.id).map((c) => c.id)

    const after = join(root, 'thesis-final')
    renameSync(before, after)
    expect(listProjects(db)[0]?.missing).toBe(true)
    /* No ghost: nothing made the old folder again. */
    expect(existsSync(before)).toBe(false)

    const found = added(after)
    expect(found.relinked).toBe(true)
    expect(found.project.id).toBe(project.id)
    expect(found.project.uid).toBe(project.uid)
    expect(found.project.path).toBe(after)
    expect(found.project.missing).toBe(false)
    expect(listProjects(db)).toHaveLength(1)
    expect(listCanvases(db).filter((c) => c.project === project.id).map((c) => c.id)).toEqual(canvases)
    expect(inbox.open(project.id).map((e) => e.id)).toEqual(['s'])
    expect(formerPaths(db, project.id).map((p) => p.path)).toEqual([before])
    expect(existsSync(before)).toBe(false)
  })

  test('a relink is refused when another project is already that folder', () => {
    const a = added(folder('one')).project
    const other = folder('two')
    added(other)
    const said = relinkProject(db, a.id, other)
    expect(said.ok).toBe(false)
    if (!said.ok) expect(said.status).toBe(409)
    expect(projectById(db, a.id)?.path).toBe(join(root, 'one'))
    expect(formerPaths(db, a.id)).toEqual([])
  })
})

describe('Locate…', () => {
  test('accepts the folder carrying the project’s id, and records where it was', () => {
    const before = folder('notes')
    const { project } = added(before)
    const after = join(root, 'moved', 'notes')
    mkdirSync(join(root, 'moved'))
    renameSync(before, after)

    const found = locateProject(db, project.id, after)
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.project.id).toBe(project.id)
    expect(found.project.uid).toBe(project.uid)
    expect(found.project.missing).toBe(false)
    expect(formerPaths(db, project.id)).toHaveLength(1)
    expect(formerPaths(db, project.id)[0]?.path).toBe(before)
    expect(Number.isNaN(Date.parse(formerPaths(db, project.id)[0]!.until))).toBe(false)
  })

  test('refuses a folder with no id, and one with a different id, in a sentence', () => {
    const before = folder('paper')
    const { project } = added(before)
    renameSync(before, join(root, 'paper-gone'))

    const empty = folder('empty')
    const none = locateProject(db, project.id, empty)
    expect(none.ok).toBe(false)
    if (!none.ok) {
      expect(none.why.startsWith(NOT_THIS_PROJECT)).toBe(true)
      expect(none.anyway).toBeUndefined()
    }

    const stranger = folder('stranger')
    mkdirSync(join(stranger, '.kehikot'))
    writeFileSync(projectFile(stranger)!, JSON.stringify({ id: 'somebody-else-5678', createdAt: null }))
    const different = locateProject(db, project.id, stranger)
    expect(different.ok).toBe(false)
    if (!different.ok) expect(different.why.startsWith(NOT_THIS_PROJECT)).toBe(true)

    /* And it says "anyway" is not on offer, even when asked. */
    expect(locateProject(db, project.id, stranger, true).ok).toBe(false)
    expect(projectById(db, project.id)?.missing).toBe(true)
    expect(formerPaths(db, project.id)).toEqual([])
  })

  test('refuses a folder that is another project here', () => {
    const before = folder('mine')
    const { project } = added(before)
    renameSync(before, join(root, 'mine-gone'))
    const theirs = folder('theirs')
    added(theirs)
    const said = locateProject(db, project.id, theirs)
    expect(said.ok).toBe(false)
  })

  test('a project that never had an id takes the folder only on the second step', () => {
    const gone = join(root, 'never')
    db.query("insert into projects (name, path, rank) values ('never', ?, 1)").run(gone)
    const id = listProjects(db)[0]!.id
    identifyAll(db)
    expect(projectById(db, id)?.uid).toBeNull()

    const there = folder('found')
    const first = locateProject(db, id, there)
    expect(first.ok).toBe(false)
    if (!first.ok) {
      expect(first.anyway).toBe(true)
      expect(first.why.startsWith(NOT_THIS_PROJECT)).toBe(true)
    }
    expect(projectById(db, id)?.path).toBe(gone)

    const second = locateProject(db, id, there, true)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.project.path).toBe(there)
    expect(second.project.uid).toMatch(PROJECT_ID)
    expect(readProjectId(there)).toBe(second.project.uid!)
    expect(formerPaths(db, id).map((p) => p.path)).toEqual([gone])
  })
})

describe('the id, handed out', () => {
  test('context.projectId, and unchanged across a relink', () => {
    const before = folder('ctx')
    const { project } = added(before)
    const told = toWireContext({ epic: null, project }, 'light')
    expect(contextSchema.parse(told).projectId).toBe(project.uid)
    renameSync(before, join(root, 'ctx-2'))
    const found = locateProject(db, project.id, join(root, 'ctx-2'))
    if (!found.ok) throw new Error(found.why)
    expect(toWireContext({ epic: null, project: found.project }, 'light').projectId).toBe(project.uid)
    expect(toWireContext({ epic: null, project: null }, 'light').projectId).toBeNull()
  })

  test('projects.pick carries the id', () => {
    const { project } = added(folder('picked'))
    const page = projectSchema.parse(JSON.parse(JSON.stringify(project)))
    expect(pickedFrom(page)).toEqual({ path: project.path, name: project.name, id: project.uid! })
    expect(pickedFrom({ ...page, uid: null })).toEqual({ path: project.path, name: project.name })
  })

  test('an activity item is filed by projectId first, then by its folder', () => {
    const projects = [
      { id: 1, name: 'one', path: '/now/one', uid: 'project-one-id' },
      { id: 2, name: 'two', path: '/now/two', uid: 'project-two-id' },
    ]
    const item = (id: string, more: Partial<ActivityItem>): ActivityItem => ({ id, state: 'working', label: id, ...more })
    const { lists, unknown } = byProject(
      [
        /* Named by where project two USED to be, and by its id: filed under two. */
        item('a', { project: '/was/two', projectId: 'project-two-id' }),
        item('b', { project: '/now/one' }),
        item('c', { project: '/nowhere', projectId: 'nobody-knows-this' }),
      ],
      null,
      projects,
    )
    expect(lists.get(2)?.map((i) => i.id)).toEqual(['a'])
    expect(lists.get(1)?.map((i) => i.id)).toEqual(['b'])
    expect(unknown).toBe(1)
    expect(lists.get(2)?.[0]).not.toHaveProperty('projectId')
  })

  test('read_canvas says the project id', async () => {
    const { project } = added(folder('door'))
    const canvas = createCanvas(db, 'k', project.id)
    const openness = new Openness()
    const wakes = new Wakes()
    const door: Door = {
      db,
      which: () => openness.open(),
      wake: (kehikko) => wakes.woke(kehikko),
      epicsChanged: (project) => wakes.epicsChanged(project),
      dispositionsChanged: (project) => wakes.dispositionsChanged(project),
      seen: async () => [],
    }
    const said = await call('read_canvas', { kehikko: canvas.id }, door)
    expect(said.text).toContain(`project id ${project.uid}`)
  })
})
