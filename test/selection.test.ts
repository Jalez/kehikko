import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, editCanvas, listCanvases, open } from '../server/canvases.ts'

/**
 * Which containers on a kehikko have been picked out as targets.
 *
 * The third axis — not the refs in `canvas.selection`, which are what somebody
 * picked out of a tracker, and not a passage, which is a place inside a
 * document. This is a fact about the arrangement, so it is stored with the
 * arrangement, and these are the properties that decision has to keep.
 */

let db: Database
beforeEach(() => {
  db = open(':memory:')
})
afterEach(() => {
  db.close()
})

const at = (i: string, x = 0) => ({ i, x, y: 0, w: 6, h: 10 })

describe('a container is picked out on one kehikko', () => {
  test('nothing is selected until somebody says so', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [at('a.one'), at('a.two', 6)] })
    expect(listCanvases(db)[0]?.placements.map((p) => p.selected)).toEqual([false, false])
  })

  test('what is picked out comes back after a restart', () => {
    const file = join(tmpdir(), `frame-selection-${Date.now()}.sqlite`)
    try {
      const first = open(file)
      const made = createCanvas(first, 'one')
      editCanvas(first, made.id, {
        placements: [{ ...at('a.one'), selected: true }, at('a.two', 6)],
      })
      first.close()

      /* The point of storing it at all: a person who ticks two containers,
         closes the tab and comes back has not stopped meaning those two. */
      const again = open(file)
      const placements = listCanvases(again)[0]?.placements ?? []
      expect(placements.find((p) => p.i === 'a.one')?.selected).toBe(true)
      expect(placements.find((p) => p.i === 'a.two')?.selected).toBe(false)
      again.close()
    } finally {
      rmSync(file, { force: true })
      rmSync(`${file}-wal`, { force: true })
      rmSync(`${file}-shm`, { force: true })
    }
  })

  test('a database written before selection existed opens, with nothing selected', () => {
    const file = join(tmpdir(), `frame-selection-old-${Date.now()}.sqlite`)
    try {
      /* The shape of an older host's table: no `selected` column at all. */
      const before = new Database(file, { create: true })
      before.exec(`
        create table canvases (id integer primary key autoincrement, name text not null, rank integer not null, epic text, project text);
        create table placements (
          canvas integer not null, module text not null,
          x integer not null, y integer not null, w integer not null, h integer not null,
          primary key (canvas, module)
        );
        insert into canvases (name, rank) values ('from before', 1);
        insert into placements (canvas, module, x, y, w, h) values (1, 'a.old', 0, 0, 6, 10);
      `)
      before.close()

      const after = open(file)
      expect(listCanvases(after)[0]?.placements[0]?.selected).toBe(false)
      after.close()
    } finally {
      rmSync(file, { force: true })
      rmSync(`${file}-wal`, { force: true })
      rmSync(`${file}-shm`, { force: true })
    }
  })

  test('anything but a literal true is not selected', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [{ ...at('a.one'), selected: 'true' } as never, { ...at('a.two', 6), selected: 1 } as never],
    })
    /* A flag that switched on because the string "false" arrived would aim an
       agent at a container nobody picked. */
    expect(listCanvases(db)[0]?.placements.map((p) => p.selected)).toEqual([false, false])
  })

  test('it is per kehikko: the same module is a target on one and a bystander on the other', () => {
    const here = createCanvas(db, 'here')
    const there = createCanvas(db, 'there')
    editCanvas(db, here.id, { placements: [{ ...at('a.one'), selected: true }] })
    editCanvas(db, there.id, { placements: [at('a.one')] })

    const canvases = listCanvases(db)
    expect(canvases.find((c) => c.id === here.id)?.placements[0]?.selected).toBe(true)
    expect(canvases.find((c) => c.id === there.id)?.placements[0]?.selected).toBe(false)
  })

  test('a container taken off the kehikko takes its selection with it', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ ...at('a.one'), selected: true }, at('a.two', 6)] })
    editCanvas(db, made.id, { placements: [at('a.two', 6)] })
    /* The reason this is a field on the row rather than a list beside it: there
       is no second place left holding the name of a container that is not
       there, so a selection cannot outlive what it names. */
    expect(listCanvases(db)[0]?.placements.map((p) => p.i)).toEqual(['a.two'])
    editCanvas(db, made.id, { placements: [at('a.one'), at('a.two', 6)] })
    expect(listCanvases(db)[0]?.placements.map((p) => p.selected)).toEqual([false, false])
  })

  test('picking one out does not disturb what else the container is', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [{ ...at('a.one'), pinned: true, collapsed: true, wish: 14, prompt: 'read this' }],
    })
    const was = listCanvases(db)[0]?.placements[0]
    editCanvas(db, made.id, { placements: [{ ...was!, selected: true }] })
    const now = listCanvases(db)[0]?.placements[0]
    expect(now).toEqual({ ...was!, selected: true })
  })

  test('the refs picked out of a tracker are a different axis and do not move', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { selection: ['gh#105'], placements: [at('a.one')] })
    editCanvas(db, made.id, { placements: [{ ...at('a.one'), selected: true }] })
    const canvas = listCanvases(db)[0]
    expect(canvas?.selection).toEqual(['gh#105'])
    expect(canvas?.placements[0]?.selected).toBe(true)
  })
})
