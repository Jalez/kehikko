import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { settingsRoute } from '../server/agentSettings.ts'
import { PAGE_ONLY } from '../server/guard.ts'
import { ensurePickerOrder, readSorts, readVisits, recordVisit, visitsRoute } from '../server/pickerOrder.ts'
import { DEFAULT_SORTS, epicVisitKey, kehikkoVisitKey, ordered, projectVisitKey, sortsFrom, sortsPatched, visitFor, type Here } from '../src/host/pickerOrder.ts'

/*
 * How the project, epic and kehikko pickers are ordered, and when a place counts
 * as visited. The rules are pure (`src/host/pickerOrder.ts`); the host keeps the
 * choice and the visit times in `frame.sqlite`.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Item = { name: string; at?: number }
const name = (item: Item) => item.name
const at = (item: Item) => item.at
const names = (items: Item[]) => items.map(name)

describe('the two orders', () => {
  const items: Item[] = [{ name: 'beta', at: 10 }, { name: 'Alpha' }, { name: 'gamma', at: 30 }, { name: 'delta' }, { name: 'a10' }, { name: 'a9' }]

  test('A–Z reads names the way a person does: case ignored, numbers by value', () => {
    expect(names(ordered(items, 'az', name, at))).toEqual(['a9', 'a10', 'Alpha', 'beta', 'delta', 'gamma'])
  })

  test('Recent puts the latest visit first, and what was never visited after it, A–Z among itself', () => {
    expect(names(ordered(items, 'recent', name, at))).toEqual(['gamma', 'beta', 'a9', 'a10', 'Alpha', 'delta'])
  })

  test('visits at the same moment fall back to the name; nothing visited at all is A–Z', () => {
    expect(names(ordered([{ name: 'b', at: 5 }, { name: 'a', at: 5 }], 'recent', name, at))).toEqual(['a', 'b'])
    expect(names(ordered([{ name: 'b' }, { name: 'a' }], 'recent', name, at))).toEqual(['a', 'b'])
  })

  test('the list given is not reordered in place', () => {
    const given = [{ name: 'b' }, { name: 'a' }]
    ordered(given, 'az', name, at)
    expect(names(given)).toEqual(['b', 'a'])
  })
})

describe('what is a visit: the place the page shows, however it was reached', () => {
  const at = (project: number | null, epic: string | null, kehikko: string | null): Here => ({ project, epic, kehikko })
  const home = at(1, 'one', 'main')
  const homeLeft = { project: 1, epic: 'one', kehikko: 'main' }

  test('the picker: a different epic, kehikko or project is a visit to it, and the place left is stamped too', () => {
    expect(visitFor(home, at(1, 'two', 'main'))).toEqual({ project: 1, epic: 'two', kehikko: 'main', left: homeLeft })
    expect(visitFor(home, at(1, 'one', 'wide'))).toEqual({ project: 1, epic: 'one', kehikko: 'wide', left: homeLeft })
    expect(visitFor(home, at(2, null, 'main'))).toEqual({ project: 2, kehikko: 'main', left: homeLeft })
  })

  test('a pinned place and Inbox Open: the same arrival, in another project', () => {
    expect(visitFor(home, at(3, 'auth', 'review'))).toEqual({ project: 3, epic: 'auth', kehikko: 'review', left: homeLeft })
  })

  test('an agent’s jump, and Go back after it: each arrival is a visit, the way back too', () => {
    const jumped = at(1, 'two', 'wide')
    expect(visitFor(home, jumped)).toEqual({ project: 1, epic: 'two', kehikko: 'wide', left: homeLeft })
    expect(visitFor(jumped, home)).toEqual({ ...homeLeft, left: { project: 1, epic: 'two', kehikko: 'wide' } })
  })

  test('a jump into another project, and back', () => {
    expect(visitFor(home, at(4, 'x', 'k'))?.project).toBe(4)
    expect(visitFor(at(4, 'x', 'k'), home)?.project).toBe(1)
  })

  test('"All epics" visits the project and kehikko and no epic', () => {
    expect(visitFor(home, at(1, null, 'main'))).toEqual({ project: 1, kehikko: 'main', left: homeLeft })
  })

  test('starting up is not a switch (the place is stamped when first left); standing still, or no project, is nothing', () => {
    expect(visitFor(null, home)).toBeNull()
    expect(visitFor(home, { ...home })).toBeNull()
    expect(visitFor(home, at(null, null, null))).toBeNull()
    expect(visitFor(home, null)).toBeNull()
    expect(visitFor(at(null, null, null), home)).toEqual(homeLeft)
  })
})

describe('the choices', () => {
  test('epics keep today’s A–Z, and projects and kehikot — listed in the order made — start on Recent', () => {
    expect(DEFAULT_SORTS).toEqual({ projects: 'recent', epics: 'az', kehikot: 'recent' })
  })

  test('a stored value that is not one of the two is the default, one picker at a time', () => {
    expect(sortsFrom({ projects: 'az', epics: 'sideways' })).toEqual({ projects: 'az', epics: 'az', kehikot: 'recent' })
    expect(sortsFrom('nonsense')).toEqual(DEFAULT_SORTS)
  })

  test('a change names any subset of the three, each one of the two — or is refused whole', () => {
    expect(sortsPatched(DEFAULT_SORTS, { epics: 'recent' })).toEqual({ projects: 'recent', epics: 'recent', kehikot: 'recent' })
    expect(sortsPatched(DEFAULT_SORTS, { epics: 'sideways' })).toBeNull()
    expect(sortsPatched(DEFAULT_SORTS, { epics: 'az', parts: 'az' })).toBeNull()
    expect(sortsPatched(DEFAULT_SORTS, {})).toBeNull()
    expect(sortsPatched(DEFAULT_SORTS, 'az')).toBeNull()
  })
})

describe('the host keeps them in frame.sqlite', () => {
  const post = (route: (r: Request, u: URL) => Promise<Response | null>, path: string, body: unknown) => {
    const url = new URL(`http://127.0.0.1${path}`)
    return route(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), url)
  }
  const settings = (db: Database) => settingsRoute({ db, status: () => ({}) as never, changed: () => undefined, skillsAt: () => '/nowhere' })

  test('visits are stamped per project, per epic in its project and per kehikko, and the latest wins', () => {
    const db = new Database(':memory:')
    recordVisit(db, { project: 1, epic: 'one', kehikko: 'main' }, 100)
    recordVisit(db, { project: 2, epic: 'one' }, 200)
    recordVisit(db, { project: 1, kehikko: 'main' }, 300)
    const visits = readVisits(db)
    expect(visits.projects).toEqual({ [projectVisitKey(1)]: 300, [projectVisitKey(2)]: 200 })
    expect(visits.epics).toEqual({ [epicVisitKey(1, 'one')]: 100, [epicVisitKey(2, 'one')]: 200 })
    expect(visits.kehikot).toEqual({ [kehikkoVisitKey(1, 'main')]: 300 })
  })

  test('a visit stamps the place left a moment before the one arrived at, so it ranks next', async () => {
    const db = new Database(':memory:')
    const route = visitsRoute({ db, now: () => 1000 })
    const answer = await post(route, '/host/visits', { project: 2, kehikko: 'b', left: { project: 1, epic: 'e', kehikko: 'a' } })
    expect(answer!.status).toBe(200)
    const visits = readVisits(db)
    expect(visits.projects).toEqual({ [projectVisitKey(1)]: 999, [projectVisitKey(2)]: 1000 })
    expect(visits.epics).toEqual({ [epicVisitKey(1, 'e')]: 999 })
    expect(visits.kehikot).toEqual({ [kehikkoVisitKey(1, 'a')]: 999, [kehikkoVisitKey(2, 'b')]: 1000 })
    expect((await post(route, '/host/visits', { project: 2, left: { project: 1, left: { project: 3 } } }))!.status).toBe(400)
  })

  test('the settings answer carries the visits, so the page needs no request of its own at start-up', async () => {
    const db = new Database(':memory:')
    recordVisit(db, { project: 1, epic: 'e' }, 50)
    const url = new URL('http://127.0.0.1/host/settings')
    const read = await (await settings(db)(new Request(url), url))!.json()
    expect(read.visits.epics[epicVisitKey(1, 'e')]).toBe(50)
  })

  test('the choice and the visits are still there after a restart, and the same through a second connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'picker-order-'))
    dirs.push(dir)
    const file = join(dir, 'frame.sqlite')
    const first = new Database(file)
    ensurePickerOrder(first)
    const answer = await post(settings(first), '/host/settings', { picker: { epics: 'recent' } })
    expect((await answer!.json()).picker).toEqual({ projects: 'recent', epics: 'recent', kehikot: 'recent' })
    await post(visitsRoute({ db: first, now: () => 777 }), '/host/visits', { project: 5, epic: 'e', kehikko: 'k' })
    first.close()

    const second = new Database(file)
    expect(readSorts(second).epics).toBe('recent')
    const read = await (await settings(second)(new Request('http://127.0.0.1/host/settings'), new URL('http://127.0.0.1/host/settings')))!.json()
    expect(read.picker.epics).toBe('recent')
    expect(readVisits(second).projects[projectVisitKey(5)]).toBe(777)
    expect(readVisits(second).kehikot[kehikkoVisitKey(5, 'k')]).toBe(777)
    second.close()
  })

  test('a refused change changes nothing, and a bad visit is refused', async () => {
    const db = new Database(':memory:')
    const refused = await post(settings(db), '/host/settings', { picker: { epics: 'sideways' } })
    expect(refused!.status).toBe(400)
    expect(readSorts(db)).toEqual(DEFAULT_SORTS)
    const route = visitsRoute({ db })
    for (const body of [{}, { project: 'x' }, { project: 1.5 }, { project: 1, epic: 3 }, { project: 1, kehikko: '' }, []]) {
      expect((await post(route, '/host/visits', body))!.status).toBe(400)
    }
    expect(readVisits(db).projects).toEqual({})
  })

  test('only the page writes: a visit and a change of order are PAGE_ONLY', () => {
    expect(PAGE_ONLY).toContain('/host/visits')
    expect(PAGE_ONLY).toContain('/host/settings')
  })
})
