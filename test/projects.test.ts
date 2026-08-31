import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, deleteCanvas, editCanvas, listCanvases, open } from '../server/canvases.ts'
import { addProject, adopt, holdsEpics, listProjects, projectById, within } from '../server/projects.ts'
import { epicsIn, listEpics } from '../server/holdings.ts'
import { answer } from '../server/answers.ts'

/**
 * A project is a folder, and a kehikko is inside one.
 *
 * The model this replaces had it the other way round: `canvases` carried a
 * `project text` column holding a name somebody was supposed to type, and it
 * was NULL on every canvas that had ever been written. Most of what is below is
 * about the two consequences — that a kehikko now belongs somewhere, and that
 * what it can show depends on what that somewhere holds.
 */

let db: Database
let scratch: string
beforeEach(() => {
  db = open(':memory:')
  scratch = mkdtempSync(join(tmpdir(), 'kehikko-projects-'))
})
afterEach(() => {
  db.close()
  rmSync(scratch, { recursive: true, force: true })
})

/** A folder with `data/epics` under it, holding the named epics. */
function withEpics(name: string, epics: Record<string, unknown>[] = []): string {
  const root = join(scratch, name)
  mkdirSync(join(root, 'data', 'epics'), { recursive: true })
  for (const epic of epics) {
    writeFileSync(join(root, 'data', 'epics', `${String(epic.slug)}.json`), JSON.stringify(epic))
  }
  return root
}

/** A folder with work in it and no epics anywhere — the thesis case. */
function withoutEpics(name: string): string {
  const root = join(scratch, name)
  mkdirSync(join(root, 'chapters'), { recursive: true })
  writeFileSync(join(root, 'main.tex'), '\\documentclass{book}\n')
  writeFileSync(join(root, 'references.bib'), '\n')
  return root
}

describe('a project is a name and a folder', () => {
  test('adding one keeps the folder, names it after the folder, and gives it a kehikko', () => {
    const root = withEpics('roadmap')
    const added = addProject(db, root)
    expect(added.ok).toBe(true)
    if (!added.ok) return

    expect(added.project.name).toBe('roadmap')
    expect(added.project.path).toBe(require('node:fs').realpathSync(root))
    expect(added.project.epics).toBe(true)

    /* A project with no kehikot has nothing to open. Somebody who pressed "add
       a project" has already said what they want. */
    const kehikot = listCanvases(db).filter((canvas) => canvas.project === added.project.id)
    expect(kehikot).toHaveLength(1)
    expect(kehikot[0]?.placements).toEqual([])
  })

  test('a project with no data/epics is a project, and says so', () => {
    /* The user's thesis: main.tex, chapters/, references.bib, and no epics
       anywhere. Refusing it would be this host insisting that work it cannot
       index is not work. */
    const added = addProject(db, withoutEpics('thesis_latex'))
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.project.name).toBe('thesis_latex')
    expect(added.project.epics).toBe(false)
  })

  test('the same folder twice is one project, not two names for it', () => {
    const root = withEpics('roadmap')
    const first = addProject(db, root)
    const second = addProject(db, root)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.already).toBe(true)
    expect(second.project.id).toBe(first.project.id)
    expect(listProjects(db)).toHaveLength(1)
  })

  test('two folders may share a name, because a name is not the identity', () => {
    mkdirSync(join(scratch, 'a', 'roadmap'), { recursive: true })
    mkdirSync(join(scratch, 'b', 'roadmap'), { recursive: true })
    expect(addProject(db, join(scratch, 'a', 'roadmap')).ok).toBe(true)
    expect(addProject(db, join(scratch, 'b', 'roadmap')).ok).toBe(true)
    expect(listProjects(db)).toHaveLength(2)
  })

  test('a path that is not a folder, or not there, or not absolute, is refused', () => {
    writeFileSync(join(scratch, 'notes.txt'), 'hello')
    for (const bad of [join(scratch, 'notes.txt'), join(scratch, 'nowhere'), 'Projects/roadmap', '']) {
      const tried = addProject(db, bad)
      expect(tried.ok).toBe(false)
      if (tried.ok) continue
      /* A sentence, because the person who pressed add is owed the reason. */
      expect(tried.why.length).toBeGreaterThan(10)
    }
    expect(listProjects(db)).toHaveLength(0)
  })

  test('epics are read per project, and the wrong project does not leak into the right one', () => {
    const roadmap = withEpics('roadmap', [
      { slug: 'modes-are-modules', title: 'Modes are modules', steps: [1, 2] },
      { slug: 'tables-declare-themselves', title: 'Tables declare themselves' },
    ])
    const thesis = withoutEpics('thesis_latex')

    expect(holdsEpics(roadmap)).toBe(true)
    expect(holdsEpics(thesis)).toBe(false)

    expect(listEpics(roadmap).map((epic) => epic.slug)).toEqual([
      'modes-are-modules',
      'tables-declare-themselves',
    ])
    /* Not an empty list from the thesis — no list at all, because there is no
       directory to have read. `epicsIn` is what tells those two apart. */
    expect(epicsIn(thesis)).toBeNull()
    expect(epicsIn(roadmap)).toBe(roadmap)
  })

  test('a call answers out of the project it names and not one a variable named at startup', () => {
    const roadmap = withEpics('roadmap', [{ slug: 'modes-are-modules', title: 'Modes are modules' }])
    const thesis = withoutEpics('thesis_latex')
    const known = (id: string) => id === 'example.notes'

    const here = answer('example.notes', 'epics.list', {}, known, () => {}, roadmap)
    expect(here).toEqual({ ok: true, data: { epics: [{ slug: 'modes-are-modules', title: 'Modes are modules' }] } })

    /* The same call, from a kehikko in a project that has none. An empty list
       is the honest answer and it is a different answer from the one above —
       the point being that it depends on the project and not on the process. */
    const there = answer('example.notes', 'epics.list', {}, known, () => {}, thesis)
    expect(there).toEqual({ ok: true, data: { epics: [] } })

    /* And with no project at all, which is the state this host started in. */
    const nowhere = answer('example.notes', 'epics.list', {}, known, () => {}, null)
    expect(nowhere).toEqual({ ok: true, data: { epics: [] } })
  })

  test('an epic is read out of its own project, and not out of another', () => {
    const roadmap = withEpics('roadmap', [{ slug: 'modes-are-modules', title: 'Modes are modules' }])
    const thesis = withoutEpics('thesis_latex')
    const known = (id: string) => id === 'example.notes'

    const found = answer('example.notes', 'epic.get', { epic: 'modes-are-modules' }, known, () => {}, roadmap)
    expect(found.ok).toBe(true)

    /* The same slug, asked from the thesis. Refused rather than answered out of
       the roadmap, which is the failure this whole change is about: a host that
       showed one project and answered about another, correctly, with nothing to
       indicate it. */
    const missing = answer('example.notes', 'epic.get', { epic: 'modes-are-modules' }, known, () => {}, thesis)
    expect(missing.ok).toBe(false)
  })
})

describe('the kehikot that were written before projects existed', () => {
  test('a database from before this opens, and nothing in it is lost', () => {
    /* The three on this machine, written by a version whose `canvases` table
       had a `project text` column and an `epic`. Built here by hand, the way
       the old code would have left them. */
    const old = new Database(':memory:', { create: true })
    old.exec(`
      create table canvases (
        id integer primary key autoincrement,
        name text not null,
        rank integer not null,
        epic text,
        project text
      );
      create table placements (
        canvas integer not null, module text not null,
        x integer not null, y integer not null, w integer not null, h integer not null,
        primary key (canvas, module)
      );
      insert into canvases (id, name, rank, epic, project) values
        (1, 'Kehikko 1', 1, 'tables-declare-themselves', null),
        (2, 'Kehikko 2 -reviews', 2, 'modes-are-modules', null),
        (10, 'writing', 3, 'workbench-reads-like-the-thesis', null);
      insert into placements (canvas, module, x, y, w, h) values (1, 'roadmap.atlas', 0, 0, 6, 10);
    `)
    const file = join(scratch, 'frame.sqlite')
    old.exec(`vacuum into '${file}'`)
    old.close()

    /* Opened by the new code. The additive migration has to run over a table
       that already exists with fewer columns; `create table if not exists` does
       nothing for one of those, which is why `add` exists. */
    const now = open(file)
    const before = listCanvases(now)
    expect(before.map((canvas) => canvas.name)).toEqual(['Kehikko 1', 'Kehikko 2 -reviews', 'writing'])
    expect(before.map((canvas) => canvas.epic)).toEqual([
      'tables-declare-themselves',
      'modes-are-modules',
      'workbench-reads-like-the-thesis',
    ])
    expect(before.every((canvas) => canvas.project === null)).toBe(true)
    expect(before[0]?.placements).toHaveLength(1)

    /* And the dead text column is gone, so nobody can write a query against a
       `project` that is a name and get NULL back from every row. */
    const columns = now.query<{ name: string }, []>('pragma table_info(canvases)').all().map((c) => c.name)
    expect(columns).toContain('project_id')
    expect(columns).not.toContain('project')

    /* The migration proper: they belong to `~/Projects/roadmap`, which is where
       the epics they show come from, so filing them there loses nothing and
       writes down something that was already true. */
    const roadmap = withEpics('roadmap')
    const settled = adopt(now, { KEHIKKO_ROADMAP_DIR: roadmap })
    expect(settled.adopted).toBe(3)
    expect(settled.seeded?.name).toBe('roadmap')

    const after = listCanvases(now)
    expect(after.every((canvas) => canvas.project === settled.seeded?.id)).toBe(true)
    expect(after.map((canvas) => canvas.epic)).toEqual([
      'tables-declare-themselves',
      'modes-are-modules',
      'workbench-reads-like-the-thesis',
    ])
    /* The arrangement survives, which is the whole reason there is a database. */
    expect(after[0]?.placements).toHaveLength(1)

    /* Twice is not an error, because a host is started more than once. */
    expect(adopt(now, { KEHIKKO_ROADMAP_DIR: roadmap }).adopted).toBe(0)
    expect(listProjects(now)).toHaveLength(1)
    now.close()
    rmSync(file, { force: true })
  })

  test('KEHIKKO_ROADMAP_DIR still seeds the first project, so an existing setup starts', () => {
    const roadmap = withEpics('roadmap')
    const settled = adopt(db, { KEHIKKO_ROADMAP_DIR: roadmap })
    expect(settled.seeded?.path).toBe(require('node:fs').realpathSync(roadmap))
    expect(settled.seeded?.epics).toBe(true)
  })

  test('with nowhere named, the seed is home — visible, and never nothing', () => {
    /* A guess, deliberately a visible one: home certainly exists, it holds no
       data/epics, so the header says there are none — which is true — and "add
       a project" is one press away. The alternative was leaving kehikot in no
       project, and a kehikko no dropdown lists is work nobody can reach. */
    const settled = adopt(db, {})
    expect(settled.seeded?.path).toBe(require('node:fs').realpathSync(homedir()))
  })
})

describe('a kehikko belongs to a project', () => {
  test('it is made in one, and the store keeps the key', () => {
    const added = addProject(db, withEpics('roadmap'))
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const made = createCanvas(db, 'writing', added.project.id)
    expect(made.project).toBe(added.project.id)
    expect(listCanvases(db).find((canvas) => canvas.id === made.id)?.project).toBe(added.project.id)
  })

  test('moving one between projects is an edit, and a project that does not exist is not one', () => {
    const one = addProject(db, withEpics('roadmap'))
    const two = addProject(db, withoutEpics('thesis_latex'))
    if (!one.ok || !two.ok) throw new Error('the projects were not added')

    const made = createCanvas(db, 'writing', one.project.id)
    expect(editCanvas(db, made.id, { project: two.project.id })?.project).toBe(two.project.id)

    /* The foreign key is the check, which is the point of having turned a name
       into a key: there is nothing to write here that could be wrong and go
       unnoticed. */
    expect(() => editCanvas(db, made.id, { project: 9999 })).toThrow()
  })

  test('the last kehikko in a project cannot be removed, even when other projects have some', () => {
    const one = addProject(db, withEpics('roadmap'))
    const two = addProject(db, withoutEpics('thesis_latex'))
    if (!one.ok || !two.ok) throw new Error('the projects were not added')

    /* Each project came with one. Removing the thesis's only kehikko would
       leave its header with nothing to open — the same nothing-to-be-in state
       the old global rule protected, one level down. */
    const theirs = listCanvases(db).filter((canvas) => canvas.project === two.project.id)
    expect(theirs).toHaveLength(1)
    expect(deleteCanvas(db, theirs[0]!.id)).toBe('the-last-one')

    /* With a second one there, it can go. */
    const spare = createCanvas(db, 'another', two.project.id)
    expect(deleteCanvas(db, theirs[0]!.id)).toBe('deleted')
    expect(listCanvases(db).filter((canvas) => canvas.project === two.project.id)).toHaveLength(1)
    expect(spare.project).toBe(two.project.id)
  })

  test('removing a project takes its kehikot with it, and leaves the others alone', () => {
    const one = addProject(db, withEpics('roadmap'))
    const two = addProject(db, withoutEpics('thesis_latex'))
    if (!one.ok || !two.ok) throw new Error('the projects were not added')

    db.query('delete from projects where id = ?').run(two.project.id)
    /* A kehikko in a project that is gone is a layout of containers over a folder
       that is not there. `on delete cascade` is what says so. */
    expect(listCanvases(db).some((canvas) => canvas.project === two.project.id)).toBe(false)
    expect(listCanvases(db).some((canvas) => canvas.project === one.project.id)).toBe(true)
    expect(projectById(db, two.project.id)).toBeNull()
  })
})

describe('containment is compared with a separator', () => {
  test('a sibling whose name starts the same way is not inside', () => {
    /* `/Users/x/Projects-old` starts with `/Users/x/Projects` and is not inside
       it. The off-by-one that turns a prefix check into a way out. */
    expect(within('/Users/x/Projects-old/thing', ['/Users/x/Projects'])).toBe(false)
    expect(within('/Users/x/Projects/thing', ['/Users/x/Projects'])).toBe(true)
    expect(within('/Users/x/Projects', ['/Users/x/Projects'])).toBe(true)
    expect(within('/etc', ['/Users/x/Projects'])).toBe(false)
  })
})
