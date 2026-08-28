import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canvasesHolding,
  createCanvas,
  databaseFile,
  deleteCanvas,
  editCanvas,
  ensureCanvases,
  keepState,
  readState,
  listCanvases,
  open,
} from '../server/canvases.ts'

/**
 * The canvases survive everything: a reload, a restart, a cleared browser.
 *
 * That is the whole reason there is a database, and most of what is below is
 * about the second half of that sentence — the arrangement used to live in
 * `localStorage`, where clearing a browser destroyed work somebody named.
 */

let db: Database
beforeEach(() => {
  db = open(':memory:')
})
afterEach(() => {
  db.close()
})

describe('a canvas is a name and an arrangement', () => {
  test('what is written comes back', () => {
    const made = createCanvas(db, 'the wire')
    editCanvas(db, made.id, {
      epic: 'modes-are-modules',
      placements: [
        { i: 'roadmap.atlas', x: 0, y: 0, w: 5, h: 12, grow: false, pinned: false },
        { i: 'roadmap.references', x: 5, y: 0, w: 7, h: 20, grow: false, pinned: false },
      ],
    })

    const [canvas] = listCanvases(db)
    expect(canvas?.name).toBe('the wire')
    expect(canvas?.epic).toBe('modes-are-modules')
    expect(canvas?.placements).toEqual([
      { i: 'roadmap.atlas', x: 0, y: 0, w: 5, h: 12, grow: false, pinned: false },
      { i: 'roadmap.references', x: 5, y: 0, w: 7, h: 20, grow: false, pinned: false },
    ])
  })

  test('a rearrangement replaces the arrangement rather than adding to it', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    editCanvas(db, made.id, { placements: [{ i: 'a.two', x: 0, y: 0, w: 6, h: 10 }] })

    expect(listCanvases(db)[0]?.placements.map((p) => p.i)).toEqual(['a.two'])
  })

  test('an edit that names nothing changes nothing', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 1, y: 2, w: 6, h: 10 }] })
    editCanvas(db, made.id, {})

    const [canvas] = listCanvases(db)
    expect(canvas?.name).toBe('one')
    expect(canvas?.placements).toHaveLength(1)
  })

  test('the subject can be cleared, which is different from not mentioning it', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { epic: 'modes-are-modules' })
    editCanvas(db, made.id, { epic: null })
    expect(listCanvases(db)[0]?.epic).toBeNull()
  })

  test('editing a canvas that is not there says so instead of making one', () => {
    expect(editCanvas(db, 999, { name: 'ghost' })).toBeNull()
    expect(listCanvases(db)).toHaveLength(0)
  })
})

describe('a name that is only spaces is a slip of the hand, not a rename', () => {
  test('the previous name is kept', () => {
    const made = createCanvas(db, 'the wire')
    editCanvas(db, made.id, { name: '   ' })
    expect(listCanvases(db)[0]?.name).toBe('the wire')
  })

  test('a new canvas with no name given still has one', () => {
    expect(createCanvas(db).name).toBe('canvas')
    expect(createCanvas(db, '  ').name).toBe('canvas')
  })

  test('a name is trimmed and bounded, because it is shown in a switcher', () => {
    const made = createCanvas(db, `  ${'x'.repeat(200)}  `)
    expect(made.name.length).toBe(60)
  })
})

describe('what arrives over HTTP is not what is written', () => {
  test('a placement naming something that is not a module id is dropped', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [
        { i: 'Not An Id', x: 0, y: 0, w: 6, h: 10 },
        { i: 'a.fine', x: 0, y: 0, w: 6, h: 10 },
      ],
    })
    expect(listCanvases(db)[0]?.placements.map((p) => p.i)).toEqual(['a.fine'])
  })

  test('the same module twice is once, because a canvas cannot show two of it', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [
        { i: 'a.one', x: 0, y: 0, w: 6, h: 10 },
        { i: 'a.one', x: 6, y: 0, w: 6, h: 10 },
      ],
    })
    expect(listCanvases(db)[0]?.placements).toHaveLength(1)
  })

  test('a rectangle no host could lay out is brought back into range', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [{ i: 'a.one', x: -5, y: 0, w: 0, h: 1e9 } as never],
    })
    expect(listCanvases(db)[0]?.placements[0]).toEqual({ i: 'a.one', x: 0, y: 0, w: 1, h: 400, grow: false, pinned: false })
  })

  test('a number that is not one does not become NaN in the database', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [{ i: 'a.one', x: 'over there', y: null, w: undefined, h: 5 } as never],
    })
    expect(listCanvases(db)[0]?.placements[0]).toEqual({ i: 'a.one', x: 0, y: 0, w: 1, h: 5, grow: false, pinned: false })
  })
})

describe('following the module’s height is a property of one pane', () => {
  test('it is off unless it was asked for', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    expect(listCanvases(db)[0]?.placements[0]?.grow).toBe(false)
  })

  test('it is written and read back', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10, grow: true }] })
    expect(listCanvases(db)[0]?.placements[0]?.grow).toBe(true)

    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10, grow: false, pinned: false }] })
    expect(listCanvases(db)[0]?.placements[0]?.grow).toBe(false)
  })

  test('anything that is not exactly true is off', () => {
    /* It arrives over HTTP. A string, a number or a missing field must not
       switch on something that resizes somebody's pane. */
    const made = createCanvas(db, 'one')
    for (const grow of ['true', 1, {}, [], 'yes']) {
      editCanvas(db, made.id, {
        placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10, grow } as never],
      })
      expect(listCanvases(db)[0]?.placements[0]?.grow).toBe(false)
    }
  })

  test('the same module can follow on one canvas and hold its size on another', () => {
    const one = createCanvas(db, 'one')
    const two = createCanvas(db, 'two')
    editCanvas(db, one.id, { placements: [{ i: 'a.shared', x: 0, y: 0, w: 6, h: 10, grow: true }] })
    editCanvas(db, two.id, { placements: [{ i: 'a.shared', x: 0, y: 0, w: 6, h: 10, grow: false, pinned: false }] })

    const canvases = listCanvases(db)
    expect(canvases[0]?.placements[0]?.grow).toBe(true)
    expect(canvases[1]?.placements[0]?.grow).toBe(false)
  })
})

describe('pinning a pane is a fact about the pane, not about the module', () => {
  test('it is off unless asked for, and is written and read back', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    expect(listCanvases(db)[0]?.placements[0]?.pinned).toBe(false)

    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10, pinned: true }] })
    expect(listCanvases(db)[0]?.placements[0]?.pinned).toBe(true)
  })

  test('anything that is not exactly true is off', () => {
    /* It arrives over HTTP, and this one decides whether a module stops hearing
       about the canvas — not a behaviour to switch on because a string came. */
    const made = createCanvas(db, 'one')
    for (const pinned of ['true', 1, {}, [], 'yes']) {
      editCanvas(db, made.id, {
        placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10, pinned } as never],
      })
      expect(listCanvases(db)[0]?.placements[0]?.pinned).toBe(false)
    }
  })

  test('the same module can be pinned on one canvas and following on another', () => {
    /* The entire use: two panes on two epics, side by side, to compare. It is
       per placement for exactly this, where a module's kept state is not. */
    const one = createCanvas(db, 'one')
    const two = createCanvas(db, 'two')
    editCanvas(db, one.id, { placements: [{ i: 'a.shared', x: 0, y: 0, w: 6, h: 10, pinned: true }] })
    editCanvas(db, two.id, { placements: [{ i: 'a.shared', x: 0, y: 0, w: 6, h: 10, pinned: false }] })

    const canvases = listCanvases(db)
    expect(canvases[0]?.placements[0]?.pinned).toBe(true)
    expect(canvases[1]?.placements[0]?.pinned).toBe(false)
  })

  test('pinning and following-the-height are independent', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10, grow: true, pinned: false }],
    })
    const [canvas] = listCanvases(db)
    expect(canvas?.placements[0]?.grow).toBe(true)
    expect(canvas?.placements[0]?.pinned).toBe(false)
  })
})

describe('a database written before a column existed still opens', () => {
  test('the column is added and what was already stored keeps its meaning', () => {
    /* Canvases live on somebody's own disk. A schema that moved is not a reason
       to lose them, and `create table if not exists` does nothing at all to a
       table that is already there with fewer columns — so the migration is the
       thing under test here, not the table definition. */
    const file = join(tmpdir(), `kehikko-migration-${process.pid}.sqlite`)
    rmSync(file, { force: true })

    const before = new Database(file, { create: true })
    before.exec(`
      create table canvases (
        id integer primary key autoincrement, name text not null,
        rank integer not null, epic text, project text
      );
      create table placements (
        canvas integer not null references canvases(id) on delete cascade,
        module text not null, x integer not null, y integer not null,
        w integer not null, h integer not null,
        primary key (canvas, module)
      );
    `)
    before.query('insert into canvases (id, name, rank) values (1, ?, 1)').run('from before')
    before.query('insert into placements (canvas, module, x, y, w, h) values (1, ?, 0, 0, 6, 10)').run(
      'a.old',
    )
    before.close()

    const after = open(file)
    const [canvas] = listCanvases(after)
    expect(canvas?.name).toBe('from before')
    expect(canvas?.placements[0]).toEqual({ i: 'a.old', x: 0, y: 0, w: 6, h: 10, grow: false, pinned: false })

    /* And opening it a second time is not an error. */
    after.close()
    const again = open(file)
    expect(listCanvases(again)[0]?.placements[0]?.grow).toBe(false)
    again.close()
    rmSync(file, { force: true })
    rmSync(`${file}-wal`, { force: true })
    rmSync(`${file}-shm`, { force: true })
  })
})

describe('a selection is what somebody picked out, and the host holds it without reading it', () => {
  test('what is set comes back', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { selection: ['gh#131', 'gh#105'] })
    expect(listCanvases(db)[0]?.selection).toEqual(['gh#131', 'gh#105'])
  })

  test('nothing selected is a state, and an empty list is how it is reached', () => {
    const made = createCanvas(db, 'one')
    expect(listCanvases(db)[0]?.selection).toEqual([])
    editCanvas(db, made.id, { selection: ['gh#131'] })
    editCanvas(db, made.id, { selection: [] })
    expect(listCanvases(db)[0]?.selection).toEqual([])
  })

  test('the same ref twice is once — a duplicate is the same pick, not a second one', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { selection: ['gh#1', 'gh#1', 'gh#2'] })
    expect(listCanvases(db)[0]?.selection).toEqual(['gh#1', 'gh#2'])
  })

  test('anything that is not a usable ref is dropped rather than stored', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      selection: ['gh#1', '', '   ', 42, null, 'x'.repeat(500)] as never,
    })
    expect(listCanvases(db)[0]?.selection).toEqual(['gh#1'])
  })

  test('a canvas stored before selections existed reads as nothing selected', () => {
    const made = createCanvas(db, 'one')
    db.query('update canvases set selection = null where id = ?').run(made.id)
    expect(listCanvases(db)[0]?.selection).toEqual([])
  })

  test('a column somebody edited by hand does not take the canvas down with it', () => {
    const made = createCanvas(db, 'one')
    for (const junk of ['{ not json', '"a string"', '{"refs":[]}', '17']) {
      db.query('update canvases set selection = ? where id = ?').run(junk, made.id)
      expect(listCanvases(db)[0]?.selection).toEqual([])
    }
  })
})

describe("a module's own kept state, which the host does not read", () => {
  test('what is kept comes back verbatim', () => {
    keepState(db, 'roadmap.references', '{"kind":"change","state":"merged"}')
    expect(readState(db, 'roadmap.references')).toBe('{"kind":"change","state":"merged"}')
  })

  test('nothing kept is null, which is not the same as an empty string', () => {
    expect(readState(db, 'roadmap.never-wrote')).toBeNull()
    keepState(db, 'roadmap.wrote-nothing', '')
    expect(readState(db, 'roadmap.wrote-nothing')).toBe('')
  })

  test('keeping again replaces, because there is one state and not a history', () => {
    keepState(db, 'a.module', 'first')
    keepState(db, 'a.module', 'second')
    expect(readState(db, 'a.module')).toBe('second')
  })

  test('one module cannot read another by keeping something', () => {
    keepState(db, 'a.one', 'mine')
    expect(readState(db, 'a.two')).toBeNull()
  })

  test('it is per module and not per canvas, so switching canvases changes nothing', () => {
    /* A module's page is loaded once and shown wherever it is placed, so one
       module is one document with one set of preferences. */
    const one = createCanvas(db, 'one')
    const two = createCanvas(db, 'two')
    keepState(db, 'a.module', 'kept')
    editCanvas(db, one.id, { placements: [{ i: 'a.module', x: 0, y: 0, w: 6, h: 10 }] })
    editCanvas(db, two.id, { placements: [{ i: 'a.module', x: 0, y: 0, w: 6, h: 10 }] })
    expect(readState(db, 'a.module')).toBe('kept')
  })

  test('more than the bound is clipped rather than refused', () => {
    /* The opposite of what happens to a ref, and deliberately: a clipped ref is
       a DIFFERENT ref, while a clipped blob is a module's own business and it
       is the one that will notice. */
    keepState(db, 'a.module', 'x'.repeat(10_000))
    expect(readState(db, 'a.module')?.length).toBe(4 * 1024)
  })
})

describe('removing a canvas', () => {
  test('its placements go with it, so nothing is left keyed to a canvas that is gone', () => {
    const one = createCanvas(db, 'one')
    const two = createCanvas(db, 'two')
    editCanvas(db, one.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    editCanvas(db, two.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })

    expect(deleteCanvas(db, one.id)).toBe('deleted')
    expect(canvasesHolding(db, 'a.one')).toEqual([two.id])
  })

  test('the only canvas is refused, because this host with no canvas has no state to be in', () => {
    const only = createCanvas(db, 'one')
    expect(deleteCanvas(db, only.id)).toBe('the-last-one')
    expect(listCanvases(db)).toHaveLength(1)
  })

  test('a canvas that is not there is said so rather than reported as removed', () => {
    createCanvas(db, 'one')
    createCanvas(db, 'two')
    expect(deleteCanvas(db, 999)).toBe('no-such-canvas')
  })
})

describe('a first run has a canvas without anybody making one', () => {
  test('an empty database gets exactly one', () => {
    expect(ensureCanvases(db)).toHaveLength(1)
    /* And asking twice does not make a second. */
    expect(ensureCanvases(db)).toHaveLength(1)
  })

  test('a database with canvases in it is left exactly as it is', () => {
    createCanvas(db, 'mine')
    expect(ensureCanvases(db).map((canvas) => canvas.name)).toEqual(['mine'])
  })
})

describe('which canvases hold a module, which is why placements are rows', () => {
  test('a module on two canvases is reported on both', () => {
    const one = createCanvas(db, 'one')
    const two = createCanvas(db, 'two')
    editCanvas(db, one.id, { placements: [{ i: 'a.shared', x: 0, y: 0, w: 6, h: 10 }] })
    editCanvas(db, two.id, { placements: [{ i: 'a.shared', x: 0, y: 0, w: 6, h: 10 }] })

    expect(canvasesHolding(db, 'a.shared')).toEqual([one.id, two.id])
    expect(canvasesHolding(db, 'a.elsewhere')).toEqual([])
  })
})

describe('canvases are shown in the order they were made', () => {
  test('a new one goes last, where a person looks for a thing they just made', () => {
    createCanvas(db, 'one')
    createCanvas(db, 'two')
    createCanvas(db, 'three')
    expect(listCanvases(db).map((canvas) => canvas.name)).toEqual(['one', 'two', 'three'])
  })
})

describe('where the file is', () => {
  test('the environment can move it, which is what makes this testable', () => {
    expect(databaseFile({ ROADMAP_FRAME_DB: '/tmp/somewhere.sqlite' })).toBe('/tmp/somewhere.sqlite')
    expect(databaseFile({})).toMatch(/\.roadmap\/frame\.sqlite$/)
  })
})
