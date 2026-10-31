import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { doorAt, doorKept, ensureKnown, forgetDoor, forgetUnregistered, known, knownDoors, remember, rememberDoor, rememberedMcp } from '../server/known.ts'

/**
 * Remembering what a module is called.
 *
 * The behaviour under test is narrow on purpose: a name, a summary and tags,
 * for a module that cannot currently give them, and nothing else. The tests that matter are the
 * ones about the edges of that — a rename, an id nobody registers any more, and
 * the refusal to store an empty name — because those are where a memory starts
 * saying something that is no longer true.
 */

function fresh() {
  const db = new Database(':memory:')
  ensureKnown(db)
  return db
}

describe('what a module is called', () => {
  test('a name given once is given back', () => {
    const db = fresh()
    remember(db, 'kehikot.paper', 'Paper')
    expect(known(db).get('kehikot.paper')?.name).toBe('Paper')
  })

  test('a rename replaces the old name rather than keeping the first', () => {
    /* The memory follows the module. Pinning the first answer would mean a
       module renamed months ago still showing its old name whenever it slept. */
    const db = fresh()
    remember(db, 'kehikot.paper', 'Paper')
    remember(db, 'kehikot.paper', 'Reader')
    expect(known(db).get('kehikot.paper')?.name).toBe('Reader')
    expect(known(db).size).toBe(1)
  })

  test('an empty name is not a name', () => {
    /* A module that answered with nothing must not overwrite what it said when
       it could speak — otherwise one bad sweep erases the memory. */
    const db = fresh()
    remember(db, 'kehikot.paper', 'Paper')
    remember(db, 'kehikot.paper', '')
    expect(known(db).get('kehikot.paper')?.name).toBe('Paper')
  })

  test('an id with no name is not stored at all', () => {
    const db = fresh()
    remember(db, 'kehikot.ghost', '')
    expect(known(db).size).toBe(0)
  })

  test('a module nobody registers any more is forgotten', () => {
    /* A table that only grows eventually holds the name of every experiment
       anybody ever registered, and the one place that surfaces is a list of
       things which no longer exist. */
    const db = fresh()
    remember(db, 'kehikot.paper', 'Paper')
    remember(db, 'kehikot.atlas', 'Atlas')
    forgetUnregistered(db, ['kehikot.paper'])
    expect([...known(db).keys()]).toEqual(['kehikot.paper'])
  })

  test('forgetting nothing when everything is still registered', () => {
    const db = fresh()
    remember(db, 'kehikot.paper', 'Paper')
    remember(db, 'kehikot.notes', 'Notes')
    forgetUnregistered(db, ['kehikot.paper', 'kehikot.notes'])
    expect(known(db).size).toBe(2)
  })

  test('the summary and the tags are kept with the name, and follow it', () => {
    const db = fresh()
    remember(db, 'kehikot.paper', 'Paper', { summary: 'The paper, as prose.', tags: ['writing', 'reading'] })
    expect(known(db).get('kehikot.paper')).toEqual({ name: 'Paper', summary: 'The paper, as prose.', tags: ['writing', 'reading'], icon: null, reacts: null })
    remember(db, 'kehikot.paper', 'Paper', { summary: 'Read as prose.', tags: [] })
    expect(known(db).get('kehikot.paper')).toEqual({ name: 'Paper', summary: 'Read as prose.', tags: [], icon: null, reacts: null })
  })

  test('a table from before the summary and the tags gains them, empty, and keeps its names', () => {
    const db = new Database(':memory:')
    db.exec('create table known_modules (id text primary key, name text not null, seen integer not null)')
    db.query('insert into known_modules (id, name, seen) values (?, ?, ?)').run('kehikot.paper', 'Paper', 1)
    ensureKnown(db)
    expect(known(db).get('kehikot.paper')).toEqual({ name: 'Paper', summary: '', tags: [], icon: null, reacts: null })
  })

  test('the icon a module declared is kept with its name (protocol 2.14.0), and follows it', () => {
    const db = fresh()
    remember(db, 'kehikot.paper', 'Paper', { icon: 'brand:latex' })
    expect(known(db).get('kehikot.paper')?.icon).toBe('brand:latex')
    remember(db, 'kehikot.paper', 'Paper', { icon: null })
    expect(known(db).get('kehikot.paper')?.icon).toBeNull()
  })

  test('what a module reacts to is kept with its name, and a sweep that did not see it does not wipe it', () => {
    const db = fresh()
    remember(db, 'kehikot.browser', 'Browser', { reacts: ['selection', 'address'] })
    expect(known(db).get('kehikot.browser')?.reacts).toEqual(['selection', 'address'])
    remember(db, 'kehikot.browser', 'Browser')
    expect(known(db).get('kehikot.browser')?.reacts).toEqual(['selection', 'address'])
    remember(db, 'kehikot.browser', 'Browser', { reacts: [] })
    expect(known(db).get('kehikot.browser')?.reacts).toEqual([])
  })

  test('a table from before reacts gains the column, empty', () => {
    const db = new Database(':memory:')
    db.exec('create table known_modules (id text primary key, name text not null, seen integer not null)')
    ensureKnown(db)
    remember(db, 'kehikot.browser', 'Browser')
    expect(known(db).get('kehikot.browser')?.reacts).toBeNull()
  })

  test('the table can be made twice without complaint', () => {
    /* It is made on every start, and a host restarts often. */
    const db = fresh()
    remember(db, 'kehikot.paper', 'Paper')
    ensureKnown(db)
    expect(known(db).get('kehikot.paper')?.name).toBe('Paper')
  })
})

describe('where a module’s door was', () => {
  test('kept as a path, and given back at the registration’s origin as it is now', () => {
    const db = fresh()
    const kept = doorKept({ url: 'http://127.0.0.1:7861/mcp?x=1', transport: 'http', as: 'kehikko-claude' })!
    expect(kept).toEqual({ path: '/mcp?x=1', transport: 'http', as: 'kehikko-claude' })
    rememberDoor(db, 'kehikot.claude', kept)
    expect(rememberedMcp(knownDoors(db).get('kehikot.claude'), 'http://127.0.0.1:7999')).toEqual({
      url: 'http://127.0.0.1:7999/mcp?x=1',
      transport: 'http',
      as: 'kehikko-claude',
    })
  })

  test('nothing remembered, no origin, or a path that leaves the origin, is no door', () => {
    expect(rememberedMcp(undefined, 'http://127.0.0.1:7999')).toBeNull()
    expect(rememberedMcp({ path: '/mcp', transport: 'http', as: null }, undefined)).toBeNull()
    expect(doorAt('http://127.0.0.1:7999', { path: '//example.org/mcp', transport: 'http', as: null })).toBeNull()
    expect(rememberedMcp({ path: '/mcp', transport: 'http', as: null }, 'http://127.0.0.1:7999')).toEqual({ url: 'http://127.0.0.1:7999/mcp', transport: 'http' })
  })

  test('replaced by the next reading, forgotten on its own and with the registration', () => {
    const db = fresh()
    rememberDoor(db, 'kehikot.notes', { path: '/mcp', transport: 'http', as: null })
    rememberDoor(db, 'kehikot.notes', { path: '/door', transport: 'sse', as: 'notes2' })
    rememberDoor(db, 'kehikot.paper', { path: '/mcp', transport: 'http', as: null })
    expect(knownDoors(db).get('kehikot.notes')).toEqual({ path: '/door', transport: 'sse', as: 'notes2' })
    forgetUnregistered(db, ['kehikot.notes'])
    expect([...knownDoors(db).keys()]).toEqual(['kehikot.notes'])
    forgetDoor(db, 'kehikot.notes')
    expect(knownDoors(db).size).toBe(0)
  })
})

describe('a module installed from a repository, never awake', () => {
  test('is named by the lists, not by its id', async () => {
    const { namedByLists } = await import('../server/known.ts')
    const mine = [{ id: 'kehikot.antigravity', name: 'Antigravity', summary: 'A terminal.', tags: ['agents'] }]
    const official = [{ id: 'kehikot.codex', name: 'Codex' }]
    expect(namedByLists('kehikot.antigravity', [official, mine])).toEqual({ name: 'Antigravity', summary: 'A terminal.', tags: ['agents'] })
    expect(namedByLists('kehikot.codex', [official, mine])?.name).toBe('Codex')
    expect(namedByLists('kehikot.unlisted', [official, mine])).toBeNull()
  })
})
