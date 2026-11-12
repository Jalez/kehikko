import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createCanvas, editCanvas, listCanvases, open, type Placement } from '../server/canvases.ts'
import { call, mcp, type Door, type Sighting } from '../server/mcp.ts'
import type { Here } from '../server/doorPlaces.ts'
import { Openness } from '../server/open.ts'
import { addProject, listProjects, type Project } from '../server/projects.ts'
import { spaceTree } from '../server/spaces.ts'

/*
 * Every tool at the kehikko door reaches any project the host knows, whichever one is on screen and with
 * no page open at all: pass `project` (its folder, name or id). An agent asked to make a space in another
 * project used to find the door reached only the open one, and wrote `.kehikot/host/spaces.json` by hand.
 */

let root: string
let db: Database
let openness: Openness
let shown: Project
let other: Project
let changed: number[]
let woken: number[]

const seen: Sighting[] = [
  { id: 'a.one', name: 'One', condition: 'ready' },
  { id: 'a.two', name: 'Two', condition: 'ready' },
]

const folder = (name: string, inside: string[] = []): string => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const one of inside) mkdirSync(join(dir, one), { recursive: true })
  return dir
}

const hereIn = (project: Project, canvas: number | null): Here => {
  const on = canvas === null ? null : (listCanvases(db).find((c) => c.id === canvas) ?? null)
  return { token: null, via: 'session', module: null, conversation: 'c-1', project, epic: null, parts: [], key: on?.key ?? null, canvas: on }
}

const door = (more: Partial<Door> = {}): Door => ({
  db,
  which: () => openness.open(),
  watched: () => openness.every(),
  wake: (kehikko) => void woken.push(kehikko),
  epicsChanged: (project) => void changed.push(project),
  epicWritten: () => {},
  dispositionsChanged: () => {},
  seen: async () => seen,
  session: 'session-any-project-0',
  arranges: new Map(),
  now: () => 1_000_000,
  ...more,
})

const placements = (): Placement[] =>
  [
    { i: 'a.one', x: 0, y: 0, w: 12, h: 28, wish: 28 },
    { i: 'a.two', x: 12, y: 0, w: 12, h: 28, wish: 28 },
  ] as Placement[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-any-project-')))
  db = open(':memory:')
  openness = new Openness()
  changed = []
  woken = []
  const a = addProject(db, folder('shown', ['.git']))
  const b = addProject(db, folder('kollekti-like', ['.git']), undefined, false)
  if (!a.ok || !b.ok) throw new Error('no project')
  shown = a.project
  other = b.project
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the space tools, in a project no page shows', () => {
  test('edit_space with project and no page open at all creates the space through the one writer', async () => {
    expect(listCanvases(db).filter((c) => c.project === other.id)).toHaveLength(0)
    const top = await call('edit_space', { project: other.path, create: { parent: [], name: 'Collections' } }, door())
    expect(top.failed).toBe(false)
    const deep = await call('edit_space', { project: other.path, create: { parent: ['collections'], name: 'Sharing' } }, door())
    expect(deep.failed).toBe(false)
    expect(spaceTree(other.path).map((one) => [one.id, one.children.map((child) => child.id)])).toEqual([['collections', ['sharing']]])
    expect(spaceTree(shown.path)).toEqual([])
    expect(changed).toEqual([other.id, other.id])
    expect(deep.text).toContain(`The spaces of ${other.name} now`)
  })

  test('the project is named by its folder, its name or its id; read_canvas lists its spaces', async () => {
    await call('edit_space', { project: other.name, create: { parent: [], name: 'Collections' } }, door())
    const byId = await call('read_canvas', { project: other.uid! }, door())
    expect(byId.failed).toBe(false)
    expect(byId.text).toContain(`project: ${other.name} at ${other.path}`)
    expect(byId.text).toContain('- Collections [collections]')
    const made = await call('create_epic', { project: `${other.path}/`, title: 'Billing' }, door())
    expect(made.failed).toBe(false)
    const parts = await call('set_parts', { project: other.path, epic: 'billing', add: { name: 'Invoices' } }, door())
    expect(parts.failed).toBe(false)
    expect(spaceTree(other.path).map((one) => one.id)).toContain('billing')
  })

  test('a kehikko of another project named with project is refused', async () => {
    const there = createCanvas(db, 'elsewhere', shown.id)
    const done = await call('edit_space', { project: other.path, kehikko: there.id, create: { parent: [], name: 'X' } }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain(`is not in ${other.name}`)
    expect(spaceTree(other.path)).toEqual([])
  })
})

describe('what project may name', () => {
  test('a path with no folder is refused, and nothing is added', async () => {
    const before = listProjects(db).length
    const done = await call('edit_space', { project: join(root, 'nowhere'), create: { parent: [], name: 'X' } }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('There is no folder at')
    expect(listProjects(db)).toHaveLength(before)
  })

  test('a folder with no .git or .kehikot of its own is refused; an unknown name is refused with the list', async () => {
    const plain = await call('read_canvas', { project: folder('plain') }, door())
    expect(plain.failed).toBe(true)
    expect(plain.text).toContain('holds no .git or .kehikot')
    const name = await call('read_canvas', { project: 'no-such-project' }, door())
    expect(name.failed).toBe(true)
    expect(name.text).toContain('This host has no project no-such-project')
    expect(name.text).toContain(other.path)
  })

  test('a git worktree is not added as a project', async () => {
    const dir = folder('a-worktree')
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/else\n')
    const done = await call('read_canvas', { project: dir }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('git worktree')
    expect(listProjects(db).some((one) => one.path === dir)).toBe(false)
  })

  test('a repository the host does not know is added as Add a project adds one, and the answer says so', async () => {
    const dir = folder('new-repo', ['.git'])
    const done = await call('edit_space', { project: dir, create: { parent: [], name: 'First' } }, door())
    expect(done.failed).toBe(false)
    expect(listProjects(db).some((one) => one.path === dir)).toBe(true)
    const read = await call('read_canvas', { project: dir }, door())
    expect(read.text).toContain('- First [first]')
    const added = await call('read_canvas', { project: folder('another-repo', ['.kehikot']) }, door())
    expect(added.text).toContain('to this host’s projects, as Add a project does')
  })
})

describe('refusals name project', () => {
  test('no page open and no place: the refusal says to pass project', async () => {
    createCanvas(db, 'k', shown.id)
    const done = await call('edit_space', { create: { parent: [], name: 'X' } }, door({ here: null }))
    expect(done.failed).toBe(true)
    expect(done.text).toContain('pass project')
  })

  test('a fold on a kehikko no page shows says how to get there', async () => {
    const k = createCanvas(db, 'k', other.id)
    editCanvas(db, k.id, { placements: placements() })
    const done = await call('fold_modules', { project: other.path, fold: ['a.one'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain(`open ${other.name}`)
    expect(done.text).toContain('jump with project')
  })
})

describe('the other kinds of tool', () => {
  test('select_modules keeps the selection in the project’s stored arrangement, with no page', async () => {
    const k = createCanvas(db, 'k', other.id)
    editCanvas(db, k.id, { placements: placements() })
    const done = await call('select_modules', { project: other.path, modules: ['a.two'] }, door())
    expect(done.failed).toBe(false)
    expect(listCanvases(db).find((c) => c.id === k.id)!.placements.find((p) => p.i === 'a.two')!.selected).toBe(true)
  })

  test('kehikko_skills and set_my_place reach another project than the conversation’s', async () => {
    const mine = createCanvas(db, 'mine', shown.id)
    createCanvas(db, 'theirs', other.id)
    const skills = await call('kehikko_skills', { project: other.name }, door({ here: hereIn(shown, mine.id) }))
    expect(skills.failed).toBe(false)
    await call('edit_space', { project: other.path, create: { parent: [], name: 'Collections' } }, door())
    let bound: { project: Project; place: { epic: string | null } } | null = null
    const placed = await call(
      'set_my_place',
      { project: other.path, space: 'collections' },
      door({
        places: {
          open: () => 's',
          bind: (_s, project, place) => {
            bound = { project, place }
            return { ...hereIn(project, null), epic: place.epic }
          },
        },
      }),
    )
    expect(placed.failed).toBe(false)
    expect(bound!.project.id).toBe(other.id)
    expect(bound!.place.epic).toBe('collections')
  })

  test('arrange_modules with project arranges the kehikko a page shows there, not only the conversation’s own', async () => {
    const mine = createCanvas(db, 'mine', shown.id)
    const k = createCanvas(db, 'theirs', other.id)
    editCanvas(db, k.id, { placements: placements() })
    openness.reported('page-1', k.id)
    const done = await call('arrange_modules', { project: other.path, containers: [{ module: 'a.one', rows: 40 }] }, door({ here: hereIn(shown, mine.id) }))
    expect(done.failed).toBe(false)
    expect(woken).toContain(k.id)
    /* By its number alone, another kehikko is still refused. */
    const byNumber = await call('arrange_modules', { kehikko: k.id, containers: [{ module: 'a.one', rows: 30 }] }, door({ here: hereIn(shown, mine.id) }))
    expect(byNumber.failed).toBe(true)
  })

  test('without project, a tool still answers about the conversation’s place', async () => {
    const mine = createCanvas(db, 'mine', shown.id)
    createCanvas(db, 'theirs', other.id)
    const read = await call('read_canvas', {}, door({ here: hereIn(shown, mine.id) }))
    expect(read.text).toContain(`project: ${shown.name} at ${shown.path}`)
  })
})

describe('what agents read at the door', () => {
  test('the instructions say every tool reaches any project with project, and forbid hand-written host files', async () => {
    const about = { name: 'kehikko', version: '0' }
    const hello = await mcp({ id: 1, method: 'initialize' }, door(), about)
    const instructions = (hello.body as { result: { instructions: string } }).result.instructions
    expect(instructions).toContain('Every tool can act on any project the host knows')
    expect(instructions).toContain('pass project')
    expect(instructions).toContain('Never write a project’s .kehikot/host/ files by hand')
    const listed = await mcp({ id: 2, method: 'tools/list' }, door(), about)
    const tools = (listed.body as { result: { tools: { name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }[] } }).result.tools
    const edit = tools.find((one) => one.name === 'edit_space')!
    expect(edit.description).toContain('Pass project')
    expect(edit.description).toContain('never write .kehikot/host/spaces.json')
    for (const tool of tools) {
      if (['my_place', 'storage'].includes(tool.name)) continue
      expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).toContain('project')
    }
  })
})
