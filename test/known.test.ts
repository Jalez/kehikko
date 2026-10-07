import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { ensureKnown, forgetUnregistered, known, remember } from '../server/known.ts'

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
    expect(known(db).get('kehikot.paper')).toEqual({ name: 'Paper', summary: 'The paper, as prose.', tags: ['writing', 'reading'] })
    remember(db, 'kehikot.paper', 'Paper', { summary: 'Read as prose.', tags: [] })
    expect(known(db).get('kehikot.paper')).toEqual({ name: 'Paper', summary: 'Read as prose.', tags: [] })
  })

  test('a table from before the summary and the tags gains them, empty, and keeps its names', () => {
    const db = new Database(':memory:')
    db.exec('create table known_modules (id text primary key, name text not null, seen integer not null)')
    db.query('insert into known_modules (id, name, seen) values (?, ?, ?)').run('kehikot.paper', 'Paper', 1)
    ensureKnown(db)
    expect(known(db).get('kehikot.paper')).toEqual({ name: 'Paper', summary: '', tags: [] })
  })

  test('the table can be made twice without complaint', () => {
    /* It is made on every start, and a host restarts often. */
    const db = fresh()
    remember(db, 'kehikot.paper', 'Paper')
    ensureKnown(db)
    expect(known(db).get('kehikot.paper')?.name).toBe('Paper')
  })
})
