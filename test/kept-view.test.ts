import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextSchema, type ModuleContext } from 'kehikot-module-protocol'

import { answer } from '../server/answers.ts'
import { createCanvas, editCanvas, keepFor, keepState, open, readKept, readState } from '../server/canvases.ts'
import { keptAt } from '../src/host/ask.ts'
import { whileFrozen } from '../src/host/context.ts'
import { keptFor, keptWritten } from '../src/host/kept.ts'

/**
 * A module's view, kept per CONTAINER (protocol 2.51.0): the module on one
 * kehikko keeps its own string, the host hands each frame its container's, and
 * all of it survives the app restarting. The host never reads the string.
 */

const MODULE = 'kehikot.example'
const placed = { i: MODULE, x: 0, y: 0, w: 6, h: 10 }

describe('the store', () => {
  test('the same module on two kehikot keeps two views, and both survive a restart', () => {
    const file = join(tmpdir(), `kept-view-${process.pid}-${Date.now()}.sqlite`)
    const before = open(file)
    const one = createCanvas(before, 'one')
    const two = createCanvas(before, 'two')
    editCanvas(before, one.id, { placements: [placed] })
    editCanvas(before, two.id, { placements: [placed] })
    expect(keepFor(before, one.id, MODULE, '{"view":"board"}')).toBe(true)
    expect(keepFor(before, two.id, MODULE, '{"view":"list","sort":"date"}')).toBe(true)
    /* A page saving the arrangement rewrites the placements; the views stay. */
    editCanvas(before, one.id, { placements: [{ ...placed, w: 8 }] })
    before.close()

    const after = open(file)
    expect(readKept(after, MODULE)).toEqual({ [one.id]: '{"view":"board"}', [two.id]: '{"view":"list","sort":"date"}' })
    /* And the page hands each kehikko its own, as the greeting and the context say it. */
    const presence = { state: null, kept: readKept(after, MODULE) }
    expect(keptFor(presence, MODULE, one.id, new Map())).toBe('{"view":"board"}')
    expect(keptFor(presence, MODULE, two.id, new Map())).toBe('{"view":"list","sort":"date"}')
    after.close()
    rmSync(file, { force: true })
  })

  test('a module keeps only for a kehikko it is on; the module-wide string is untouched', () => {
    const db = open(':memory:')
    const here = createCanvas(db, 'here')
    const elsewhere = createCanvas(db, 'elsewhere')
    editCanvas(db, here.id, { placements: [placed] })
    keepState(db, MODULE, 'module-wide')
    expect(keepFor(db, elsewhere.id, MODULE, 'x')).toBe(false)
    expect(keepFor(db, 9999, MODULE, 'x')).toBe(false)
    expect(readKept(db, MODULE)).toEqual({})
    expect(readState(db, MODULE)).toBe('module-wide')
    expect(keepFor(db, here.id, MODULE, 'x'.repeat(10_000))).toBe(true)
    expect(readKept(db, MODULE)[here.id]?.length).toBe(4 * 1024)
  })

  test('removing a kehikko takes its views with it', () => {
    const db = open(':memory:')
    const gone = createCanvas(db, 'gone')
    createCanvas(db, 'stays')
    editCanvas(db, gone.id, { placements: [placed] })
    keepFor(db, gone.id, MODULE, 'v')
    db.query('delete from canvases where id = ?').run(gone.id)
    expect(readKept(db, MODULE)).toEqual({})
  })
})

describe('state.set', () => {
  const known = (id: string) => id === MODULE

  test('passes on the kehikko the module named, and says when it was not kept', () => {
    const seen: [string, string, number | null][] = []
    const keep = (module: string, state: string, kehikko: number | null) => {
      seen.push([module, state, kehikko])
      return kehikko !== 2
    }
    expect(answer(MODULE, 'state.set', { state: 'a', kehikko: 1 }, known, keep)).toEqual({ ok: true, data: { kept: true } })
    expect(answer(MODULE, 'state.set', { state: 'b' }, known, keep)).toEqual({ ok: true, data: { kept: true } })
    expect(answer(MODULE, 'state.set', { state: 'c', kehikko: 2 }, known, keep)).toEqual({ ok: true, data: { kept: false } })
    expect(seen).toEqual([
      [MODULE, 'a', 1],
      [MODULE, 'b', null],
      [MODULE, 'c', 2],
    ])
  })

  test('the page files a write under the kehikko named, else the frame\'s; a malformed one under none', () => {
    expect(keptAt({ state: 's', kehikko: 4 }, 9)).toEqual({ kehikko: 4, state: 's' })
    expect(keptAt({ state: 's' }, 9)).toEqual({ kehikko: 9, state: 's' })
    expect(keptAt({ state: 's' }, null)).toEqual({ kehikko: null, state: 's' })
    expect(keptAt({ state: 7 }, 9)).toBeNull()
    expect(keptAt({ state: 's', kehikko: 'x' }, 9)).toBeNull()
    expect(keptAt(null, 9)).toBeNull()
  })
})

describe('which string a frame is handed', () => {
  test('what was written here first, then what the server keeps for the container, then the module-wide string', () => {
    const presence = { state: 'module-wide', kept: { 1: 'stored-one' } }
    let here: ReadonlyMap<string, string> = new Map()
    expect(keptFor(presence, MODULE, 1, here)).toBe('stored-one')
    expect(keptFor(presence, MODULE, 2, here)).toBe('module-wide')
    expect(keptFor(presence, MODULE, null, here)).toBe('module-wide')
    here = keptWritten(here, MODULE, 1, 'written-one')
    expect(keptFor(presence, MODULE, 1, here)).toBe('written-one')
    expect(keptFor({ state: 'other-wide' }, 'kehikot.other', 1, here)).toBe('other-wide')
    expect(keptWritten(here, MODULE, 1, 'written-one')).toBe(here)
    expect(keptFor(undefined, MODULE, 1, new Map())).toBeNull()
  })

  test('a pinned container moved to another kehikko is told which, with that one\'s view', () => {
    const at = (id: number, kept: string | null): ModuleContext => ({ ...contextSchema.parse({ epic: 'held-epic', theme: 'light' }), kehikko: { id, name: `K${id}` }, kept })
    const held = at(1, 'one')
    expect(whileFrozen(held, at(1, 'one'))).toBeNull()
    const moved = whileFrozen(held, { ...at(2, 'two'), epic: 'other-epic' })
    expect(moved?.kehikko?.id).toBe(2)
    expect(moved?.kept).toBe('two')
    expect(moved?.epic).toBe('held-epic')
  })
})
