import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { keepingOf, keepRunningChange, keepRunningProjects, readKeepRunning, writeKeepRunning, ensureKeepRunning } from '../server/keepRunning.ts'
import { GRACE_MS, toStop, wanted, type Standing } from '../server/lifecycle.ts'

/**
 * "Keep this project's modules running" is each project's own: stored by
 * project id, honoured by `wanted` (and so by the idle stop), and started from
 * the old machine-wide value once.
 */

const k = (id: number, project: number | null, ...modules: string[]) => ({ id, project, placements: modules.map((i) => ({ i })) })

/* Project 10 has kehikot 1 and 2, project 20 has 3 and 4. A module `shared` is on one of each. */
const canvases = [k(1, 10, 'a'), k(2, 10, 'b', 'shared'), k(3, 20, 'c'), k(4, 20, 'd', 'shared')]

describe('the processes', () => {
  test('a project that keeps has its other kehikot warm; one that does not, has none', () => {
    const open = new Set([1, 3])
    const got = wanted(canvases, open, (project) => project === 10)
    expect([...got.warm.keys()].sort()).toEqual(['b', 'shared'])
    expect([...got.needed].sort()).toEqual(['a', 'c'])
    const other = wanted(canvases, open, (project) => project === 20)
    expect([...other.warm.keys()].sort()).toEqual(['d', 'shared'])
    expect(wanted(canvases, open, () => false).warm.size).toBe(0)
    /* A plain boolean is every project's. */
    expect(wanted(canvases, open, true).warm.size).toBe(3)
    expect(wanted(canvases, open, false).warm.size).toBe(0)
  })

  test('a module shared by two projects stays running if either keeps, and goes when neither does', () => {
    const open = new Set([1, 3])
    expect(wanted(canvases, open, (project) => project === 10).warm.has('shared')).toBe(true)
    expect(wanted(canvases, open, (project) => project === 20).warm.has('shared')).toBe(true)
    expect(wanted(canvases, open, () => false).warm.has('shared')).toBe(false)
  })

  test('the idle stop honours it: only the module no project keeps is stopped after the grace period', () => {
    const open = new Set([1, 3])
    const asked = (keep: (project: number) => boolean) => wanted(canvases, open, keep)
    const standings = (w: ReturnType<typeof wanted>): Standing[] =>
      ['a', 'b', 'c', 'd', 'shared'].map((id) => ({
        id,
        needed: w.needed.has(id),
        warm: w.warm.get(id) ?? null,
        answering: true,
        startable: true,
        ours: true,
        keep: false,
        idleSince: 0,
        starting: false,
      }))
    /* Project 10 keeps, project 20 does not: b and shared stay, d (project 20's alone) goes. */
    expect(toStop(standings(asked((project) => project === 10)), GRACE_MS).sort()).toEqual(['d'])
    /* Neither keeps: everything off the open kehikot goes. */
    expect(toStop(standings(asked(() => false)), GRACE_MS).sort()).toEqual(['b', 'd', 'shared'])
  })
})

describe('the store', () => {
  const projects = (db: Database, ...ids: number[]) => {
    db.exec('create table projects (id integer primary key, name text)')
    for (const id of ids) db.query('insert into projects (id, name) values (?, ?)').run(id, `p${id}`)
  }

  test('on by default, set per project, and read back per project', () => {
    const db = new Database(':memory:')
    expect(readKeepRunning(db, 1)).toBe(true)
    writeKeepRunning(db, 1, false)
    expect(readKeepRunning(db, 1)).toBe(false)
    expect(readKeepRunning(db, 2)).toBe(true)
    expect(keepRunningProjects(db)).toEqual({ 1: false })
    const keeps = keepingOf(db)
    expect([keeps(1), keeps(2)]).toEqual([false, true])
    writeKeepRunning(db, 1, true)
    expect(readKeepRunning(db, 1)).toBe(true)
  })

  test('the change the route takes names a project', () => {
    expect(keepRunningChange({ project: 3, keep: false })).toEqual({ project: 3, keep: false })
    expect(keepRunningChange({ keep: false })).toBeNull()
    expect(keepRunningChange({ project: '3', keep: false })).toBeNull()
    expect(keepRunningChange({ project: 3 })).toBeNull()
    expect(keepRunningChange(null)).toBeNull()
  })

  test('migration: the old machine-wide value becomes each known project’s own, once', () => {
    const db = new Database(':memory:')
    db.exec('create table settings (key text primary key, value text not null)')
    db.query('insert into settings (key, value) values (?, ?)').run('keep-project-modules', JSON.stringify({ keep: false }))
    projects(db, 1, 2)
    ensureKeepRunning(db)
    expect(keepRunningProjects(db)).toEqual({ 1: false, 2: false })
    expect(db.query('select * from settings where key = ?').get('keep-project-modules')).toBeNull()
    /* A project made afterwards starts from the default, and a project's own change sticks. */
    db.query('insert into projects (id, name) values (3, ?)').run('p3')
    writeKeepRunning(db, 1, true)
    expect(readKeepRunning(db, 3)).toBe(true)
    expect(readKeepRunning(db, 1)).toBe(true)
    expect(readKeepRunning(db, 2)).toBe(false)
  })

  test('migration: an old “on” stays on, an unreadable one is the default, and no old row changes nothing', () => {
    const on = new Database(':memory:')
    on.exec('create table settings (key text primary key, value text not null)')
    on.query('insert into settings (key, value) values (?, ?)').run('keep-project-modules', JSON.stringify({ keep: true }))
    projects(on, 1)
    expect(keepRunningProjects(on)).toEqual({ 1: true })

    const bad = new Database(':memory:')
    bad.exec('create table settings (key text primary key, value text not null)')
    bad.query('insert into settings (key, value) values (?, ?)').run('keep-project-modules', 'not json')
    projects(bad, 1)
    expect(keepRunningProjects(bad)).toEqual({ 1: true })

    const none = new Database(':memory:')
    projects(none, 1)
    expect(keepRunningProjects(none)).toEqual({})
  })

  test('migration waits for the projects table instead of losing the old value', () => {
    const db = new Database(':memory:')
    db.exec('create table settings (key text primary key, value text not null)')
    db.query('insert into settings (key, value) values (?, ?)').run('keep-project-modules', JSON.stringify({ keep: false }))
    expect(readKeepRunning(db, 1)).toBe(true)
    projects(db, 1)
    expect(readKeepRunning(db, 1)).toBe(false)
  })
})
