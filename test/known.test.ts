import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'

import { ensureKnown, forgetUnregistered, known, remember } from '../server/known.ts'

/**
 * Remembering what a module is called.
 *
 * The behaviour under test is narrow on purpose: a name, for a module that
 * cannot currently give one, and nothing else. The tests that matter are the
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
    remember(db, 'roadmap.paper', 'Paper')
    expect(known(db).get('roadmap.paper')).toBe('Paper')
  })

  test('a rename replaces the old name rather than keeping the first', () => {
    /* The memory follows the module. Pinning the first answer would mean a
       module renamed months ago still showing its old name whenever it slept. */
    const db = fresh()
    remember(db, 'roadmap.paper', 'Paper')
    remember(db, 'roadmap.paper', 'Reader')
    expect(known(db).get('roadmap.paper')).toBe('Reader')
    expect(known(db).size).toBe(1)
  })

  test('an empty name is not a name', () => {
    /* A module that answered with nothing must not overwrite what it said when
       it could speak — otherwise one bad sweep erases the memory. */
    const db = fresh()
    remember(db, 'roadmap.paper', 'Paper')
    remember(db, 'roadmap.paper', '')
    expect(known(db).get('roadmap.paper')).toBe('Paper')
  })

  test('an id with no name is not stored at all', () => {
    const db = fresh()
    remember(db, 'roadmap.ghost', '')
    expect(known(db).size).toBe(0)
  })

  test('a module nobody registers any more is forgotten', () => {
    /* A table that only grows eventually holds the name of every experiment
       anybody ever registered, and the one place that surfaces is a list of
       things which no longer exist. */
    const db = fresh()
    remember(db, 'roadmap.paper', 'Paper')
    remember(db, 'roadmap.atlas', 'Atlas')
    forgetUnregistered(db, ['roadmap.paper'])
    expect([...known(db).keys()]).toEqual(['roadmap.paper'])
  })

  test('forgetting nothing when everything is still registered', () => {
    const db = fresh()
    remember(db, 'roadmap.paper', 'Paper')
    remember(db, 'roadmap.notes', 'Notes')
    forgetUnregistered(db, ['roadmap.paper', 'roadmap.notes'])
    expect(known(db).size).toBe(2)
  })

  test('the table can be made twice without complaint', () => {
    /* It is made on every start, and a host restarts often. */
    const db = fresh()
    remember(db, 'roadmap.paper', 'Paper')
    ensureKnown(db)
    expect(known(db).get('roadmap.paper')).toBe('Paper')
  })
})
