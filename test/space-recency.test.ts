import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import type { SpaceNode } from 'kehikot-module-protocol'

import { readVisits, recordVisit, visitOf } from '../server/pickerOrder.ts'
import { NO_VISITS, epicVisitKey, spaceVisitKey, visitFor, type Visits } from '../src/host/pickerOrder.ts'
import { treeRows } from '../src/host/spaces.ts'
import {
  agoWords,
  bucketOf,
  directMarks,
  headings,
  lifeWords,
  matchedTree,
  sortedTree,
  spaceLives,
  spacesOfPlace,
  worstElsewhere,
  type SpaceActivity,
} from '../src/host/spaceRecency.ts'

/*
 * The space picker's life of each space: the dot, when it was last interacted with (the person's
 * visit or anyone's activity, whichever is later, over the subtree), the Recent order and its time
 * headings. Times are built in local time, so the headings hold in any time zone.
 */

const TREE: SpaceNode[] = [
  {
    id: 'auth',
    name: 'Auth',
    children: [
      { id: 'login', name: 'Login', children: [{ id: 'errors', name: 'Errors', children: [] }] },
      { id: 'signup', name: 'Sign-up', children: [] },
    ],
  },
  { id: 'billing', name: 'Billing', children: [{ id: 'invoices', name: 'Invoices', children: [] }] },
  { id: 'search', name: 'Search', children: [] },
]

/* Thursday 12 November 2026, 15:00 local. */
const NOW = new Date(2026, 10, 12, 15, 0, 0).getTime()
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
const HOUR = 3_600_000
const item = (state: SpaceActivity['state'], place: SpaceActivity['place'], entered: number, live = true): SpaceActivity => ({ state, place, entered, live })
const visits = (epics: Record<string, number> = {}, spaces: Record<string, number> = {}): Visits => ({ ...NO_VISITS, epics, spaces })

describe('the places an item names', () => {
  test('an epic is its top-level space; one part its child; several parts each child; a space its path', () => {
    expect(spacesOfPlace({ epic: 'auth' })).toEqual([['auth']])
    expect(spacesOfPlace({ epic: 'auth', parts: ['login'] })).toEqual([['auth', 'login']])
    expect(spacesOfPlace({ epic: 'auth', parts: ['login', 'signup'] })).toEqual([
      ['auth', 'login'],
      ['auth', 'signup'],
    ])
    expect(spacesOfPlace({ epic: 'auth', parts: ['login'], space: ['auth', 'login', 'errors'] })).toEqual([['auth', 'login', 'errors']])
    expect(spacesOfPlace({ kehikko: 'k' })).toEqual([])
    expect(spacesOfPlace(undefined)).toEqual([])
  })
})

describe('the dot', () => {
  test('the worst live state named in each space itself; a put-away item marks nothing', () => {
    const marks = directMarks([
      item('working', { epic: 'auth', parts: ['login'] }, 1),
      item('attention', { epic: 'auth', parts: ['login'] }, 2),
      item('done', { epic: 'billing' }, 3),
      item('attention', { epic: 'search' }, 4, false),
    ])
    expect(Object.fromEntries(marks)).toEqual({ 'auth/login': 'attention', billing: 'done' })
  })

  test('aggregated up the tree: a parent holds the worst of its subtree, beside its own', () => {
    const lives = spaceLives(TREE, 1, NO_VISITS, [item('attention', { epic: 'auth', space: ['auth', 'login', 'errors'] }, 1), item('working', { epic: 'auth' }, 2)], NOW)
    expect(lives.get('auth/login/errors')).toMatchObject({ mark: 'attention', markBelow: 'attention' })
    expect(lives.get('auth/login')).toMatchObject({ mark: null, markBelow: 'attention' })
    expect(lives.get('auth')).toMatchObject({ mark: 'working', markBelow: 'attention' })
    expect(lives.get('billing')).toMatchObject({ mark: null, markBelow: null })
  })

  test('the closed control: the worst outside the space stood in, and the items above it', () => {
    const lives = spaceLives(TREE, 1, NO_VISITS, [item('attention', { epic: 'auth', parts: ['login'] }, 1), item('working', { epic: 'billing' }, 1)], NOW)
    expect(worstElsewhere(lives, TREE, ['auth', 'login'])).toBe('working')
    expect(worstElsewhere(lives, TREE, ['billing'])).toBe('attention')
    expect(worstElsewhere(lives, TREE, ['search'])).toBe('attention')
  })
})

describe('last interaction', () => {
  test('epic visits kept before spaces are their top-level spaces’ visits; deeper visits are the spaces’', () => {
    const lives = spaceLives(TREE, 1, visits({ [epicVisitKey(1, 'billing')]: 500, [epicVisitKey(2, 'auth')]: 900 }, { [spaceVisitKey(1, ['auth', 'login'])]: 700 }), [], NOW)
    expect(lives.get('billing')!.visited).toBe(500)
    /* Another project's visit to a space of the same name is not this one's. */
    expect(lives.get('auth/login')!.visited).toBe(700)
    expect(lives.get('auth')!.visited).toBe(700)
    expect(lives.get('search')!.visited).toBeUndefined()
  })

  test('the later of the person’s visit and anyone’s activity, over the subtree', () => {
    const lives = spaceLives(
      TREE,
      1,
      visits({ [epicVisitKey(1, 'auth')]: NOW - 7 * 24 * HOUR }),
      [item('done', { epic: 'auth', parts: ['signup'] }, NOW - HOUR / 2, false)],
      NOW,
    )
    /* An agent worked in it half an hour ago although the person has not opened it for a week. */
    expect(lives.get('auth')!.last).toBe(NOW - HOUR / 2)
    expect(lives.get('auth')!.visited).toBe(NOW - 7 * 24 * HOUR)
    expect(lifeWords(lives.get('auth'), NOW)).toBe('Activity 30 min ago · you visited 7 d ago')
    expect(bucketOf(lives.get('auth')!.last, NOW)).toBe('hour')
  })

  test('a visit alone, when nothing happened there since', () => {
    const lives = spaceLives(TREE, 1, visits({ [epicVisitKey(1, 'search')]: NOW - 3 * HOUR }), [item('done', { epic: 'search' }, NOW - 30 * 24 * HOUR, false)], NOW)
    expect(lives.get('search')!.last).toBe(NOW - 3 * HOUR)
    expect(lifeWords(lives.get('search'), NOW)).toBe('Activity 4 wk ago · you visited 3 h ago')
  })

  test('an item working now is activity now', () => {
    const lives = spaceLives(TREE, 1, NO_VISITS, [item('working', { epic: 'billing' }, NOW - 5 * HOUR)], NOW)
    expect(lives.get('billing')!.active).toBe(NOW)
  })
})

describe('the order', () => {
  const names = (nodes: readonly SpaceNode[]) => nodes.map((one) => one.id)

  test('A to Z within each level, the tree kept', () => {
    const sorted = sortedTree([...TREE].reverse(), 'az', new Map())
    expect(names(sorted)).toEqual(['auth', 'billing', 'search'])
    expect(names(sorted[0]!.children)).toEqual(['login', 'signup'])
  })

  test('Recent: latest first by visit or subtree activity, never-touched after A to Z, and within each level', () => {
    const lives = spaceLives(
      TREE,
      1,
      visits({ [epicVisitKey(1, 'billing')]: NOW - 2 * HOUR }),
      [item('done', { epic: 'auth', parts: ['signup'] }, NOW - HOUR, false)],
      NOW,
    )
    const sorted = sortedTree(TREE, 'recent', lives)
    expect(names(sorted)).toEqual(['auth', 'billing', 'search'])
    expect(names(sorted[0]!.children)).toEqual(['signup', 'login'])
    const later = spaceLives(TREE, 1, visits({ [epicVisitKey(1, 'billing')]: NOW - 2 * HOUR, [epicVisitKey(1, 'search')]: NOW - 60_000 }), [], NOW)
    expect(names(sortedTree(TREE, 'recent', later))).toEqual(['search', 'billing', 'auth'])
  })

  test('while filtering: by match, a name starting with the word first', () => {
    const tree: SpaceNode[] = [
      { id: 'a', name: 'Old logs', children: [] },
      { id: 'b', name: 'Login', children: [] },
      { id: 'c', name: 'Billing', children: [{ id: 'd', name: 'Log rotation', children: [] }] },
    ]
    expect(names(matchedTree(tree, 'log'))).toEqual(['b', 'a', 'c'])
  })
})

describe('the time headings, in local time', () => {
  test('each bucket, with a fixed clock', () => {
    expect(bucketOf(NOW - 10 * 60_000, NOW)).toBe('hour')
    expect(bucketOf(at(12, 9), NOW)).toBe('today')
    expect(bucketOf(at(12, 0, 1), NOW)).toBe('today')
    expect(bucketOf(at(11, 23, 59), NOW)).toBe('yesterday')
    expect(bucketOf(at(11, 0, 0), NOW)).toBe('yesterday')
    /* The week starts on Monday, 9 November. */
    expect(bucketOf(at(10, 22), NOW)).toBe('week')
    expect(bucketOf(at(9, 0, 0), NOW)).toBe('week')
    expect(bucketOf(at(8, 23), NOW)).toBe('lastWeek')
    expect(bucketOf(at(2, 0, 0), NOW)).toBe('lastWeek')
    expect(bucketOf(at(1, 23), NOW)).toBe('month')
    expect(bucketOf(new Date(2026, 9, 31, 23).getTime(), NOW)).toBe('older')
    expect(bucketOf(undefined, NOW)).toBe('never')
  })

  test('on a Monday, yesterday is yesterday and not this week', () => {
    const monday = new Date(2026, 10, 9, 10).getTime()
    expect(bucketOf(new Date(2026, 10, 8, 10).getTime(), monday)).toBe('yesterday')
    expect(bucketOf(new Date(2026, 10, 7, 10).getTime(), monday)).toBe('lastWeek')
  })

  test('how long ago, short', () => {
    expect(agoWords(NOW - 10_000, NOW)).toBe('just now')
    expect(agoWords(NOW - 90 * 60_000, NOW)).toBe('1 h ago')
    expect(agoWords(NOW - 3 * 24 * HOUR, NOW)).toBe('3 d ago')
    expect(agoWords(NOW - 21 * 24 * HOUR, NOW)).toBe('3 wk ago')
    expect(lifeWords(undefined, NOW)).toBe('')
  })

  test('the top level headed at every change; an opened level only when its children differ; empty groups never drawn', () => {
    const lives = spaceLives(
      TREE,
      1,
      visits({ [epicVisitKey(1, 'auth')]: NOW - 10 * 60_000, [epicVisitKey(1, 'billing')]: at(12, 9) }, { [spaceVisitKey(1, ['auth', 'login'])]: NOW - 10 * 60_000 }),
      [],
      NOW,
    )
    const rows = treeRows(sortedTree(TREE, 'recent', lives), new Set(['auth', 'billing']))
    const bucketAt = (ids: readonly string[]) => bucketOf(lives.get(ids.join('/'))?.last, NOW)
    const said = [...headings(rows, bucketAt)].map(([index, bucket]) => [rows[index]!.ids.join('/'), bucket])
    expect(said).toEqual([
      ['auth', 'hour'],
      /* Login was visited, Sign-up never: two groups inside Auth. */
      ['auth/login', 'hour'],
      ['auth/signup', 'never'],
      ['billing', 'today'],
      ['search', 'never'],
    ])
    /* Billing's only child is in one group: no heading inside it. */
    expect(said.some(([key]) => key === 'billing/invoices')).toBe(false)
  })
})

describe('visits to spaces', () => {
  test('arriving in a space deeper than its epic records its path, and moving within the epic is a visit', () => {
    const was = { project: 1, epic: 'auth', kehikko: 'k', space: ['auth'] }
    expect(visitFor(was, { ...was, space: ['auth', 'login'] })).toEqual({ project: 1, epic: 'auth', space: ['auth', 'login'], kehikko: 'k', left: { project: 1, epic: 'auth', kehikko: 'k' } })
    expect(visitFor({ ...was, space: ['auth', 'login'] }, { ...was, space: ['auth', 'login'] })).toBeNull()
    /* A host without spaces says no space: the same as before. */
    expect(visitFor({ project: 1, epic: 'a', kehikko: null }, { project: 1, epic: 'b', kehikko: null })).toEqual({ project: 1, epic: 'b', left: { project: 1, epic: 'a' } })
  })

  test('the host keeps them beside the epic’s, and refuses a path not under the epic', () => {
    const db = new Database(':memory:')
    const visit = visitOf({ project: 3, epic: 'auth', space: ['auth', 'login', 'errors'] })!
    recordVisit(db, visit, 1234)
    const read = readVisits(db)
    expect(read.epics[epicVisitKey(3, 'auth')]).toBe(1234)
    expect(read.spaces![spaceVisitKey(3, ['auth', 'login', 'errors'])]).toBe(1234)
    expect(visitOf({ project: 3, epic: 'auth', space: ['billing', 'x'] })).toBeNull()
    expect(visitOf({ project: 3, epic: 'auth', space: ['auth'] })).toBeNull()
    expect(visitOf({ project: 3, epic: 'auth', space: 'auth/login' })).toBeNull()
    expect(visitOf({ project: 3, epic: 'auth', space: ['auth', '../x'] })).toBeNull()
  })
})
