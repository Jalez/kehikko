import { describe, expect, test } from 'bun:test'
import type { ActivityItem } from 'kehikot-module-protocol'

import { readOf } from '../src/host/inboxDoor.ts'
import { countLook, needingCount } from '../src/host/inboxBar.ts'
import { byProject, projectsHolding } from '../src/canvas/useInbox.ts'
import type { Entry } from '../src/host/inbox.ts'

/** Switching project silences nothing: other projects' items are filed, shown and counted. */

const THESIS = { id: 2, name: 'thesis_latex', path: '/Users/me/CS-DEGREE' }
const PORTAL = { id: 3, name: 'Community portal', path: '/Users/me/hippos-portal' }
const item = (id: string, more: Partial<ActivityItem> = {}): ActivityItem => ({ id, state: 'attention', label: id, ...more })

describe('a tagged list, filed by project', () => {
  test('each item under the project its folder names, without the field; untagged under the open one', () => {
    const { lists, unknown } = byProject(
      [item('a', { project: THESIS.path }), item('b', { project: `${PORTAL.path}/` }), item('c')],
      THESIS.id,
      [THESIS, PORTAL],
    )
    expect(unknown).toBe(0)
    expect(lists.get(THESIS.id)).toEqual([item('a'), item('c')])
    expect(lists.get(PORTAL.id)).toEqual([item('b')])
  })

  test('complete across projects: a project reported to before and named by nothing now is told []', () => {
    const { lists } = byProject([item('a', { project: THESIS.path })], THESIS.id, [THESIS, PORTAL], [PORTAL.id])
    expect(lists.get(PORTAL.id)).toEqual([])
  })

  test('after a reload: a project holding open items of the module is told [] though this page never reported to it', () => {
    const open = (module: string, closed: number | null = null): Entry => ({
      module, name: module, id: 'w', state: 'working', label: 'w', priority: 'normal', refs: [],
      entered: 1, opened: 1, closed, how: null, seen: null, dismissed: null, origin: 'activity',
    })
    const snaps = {
      [THESIS.id]: { rev: 1, earlier: 0, open: [open('kehikot.claude', 5)] },
      [PORTAL.id]: { rev: 1, earlier: 0, open: [open('kehikot.claude'), open('kehikot.other')] },
      4: { rev: 1, earlier: 0, open: [open('kehikot.other')] },
    }
    const holding = projectsHolding(snaps, 'kehikot.claude')
    expect(holding).toEqual([PORTAL.id])
    const { lists } = byProject([item('a', { project: THESIS.path })], THESIS.id, [THESIS, PORTAL], holding)
    expect(lists.get(PORTAL.id)).toEqual([])
    expect([...lists.keys()].sort()).toEqual([THESIS.id, PORTAL.id])
  })

  test('a folder no project is in is kept nowhere, and counted', () => {
    const { lists, unknown } = byProject([item('a', { project: '/elsewhere/entirely' })], THESIS.id, [THESIS, PORTAL])
    expect(unknown).toBe(1)
    expect(lists.size).toBe(0)
  })

  test('with no project open, a tagged item still has somewhere to go and an untagged one does not', () => {
    const { lists, unknown } = byProject([item('a', { project: PORTAL.path }), item('b')], null, [THESIS, PORTAL])
    expect(lists.get(PORTAL.id)).toEqual([item('a')])
    expect(unknown).toBe(1)
  })
})

describe('other projects in the Inbox', () => {
  const entry = (id: string, state: Entry['state'], more: Partial<Entry> = {}): Entry => ({
    module: 'kehikot.claude',
    name: 'Claude',
    id,
    state,
    label: id,
    priority: 'normal',
    refs: [],
    entered: Date.now() - 60_000,
    opened: Date.now() - 60_000,
    closed: null,
    how: null,
    seen: null,
    dismissed: null,
    origin: 'activity',
    ...more,
  })
  test('the Inbox a module reads holds each other project under its name, its place in words', () => {
    const read = readOf({
      entries: () => [],
      elsewhere: () => [{ project: PORTAL, entries: [entry('w', 'working', { label: 'Building the reel' }), entry('q', 'attention', { label: 'Kiosk reel', place: { epic: 'kiosk-info-reel' } })] }],
      muted: () => [],
      earlier: () => 0,
      rev: () => 1,
      next: () => null,
      at: () => ({ epic: 'thesis', kehikko: 'k1' }),
      names: () => ({ epic: () => null, part: () => null, kehikko: () => null }),
      projectName: () => 'Thesis',
      log: async () => null,
      act: () => {},
      answer: async () => ({ ok: true }),
      open: () => {},
      use: () => {},
      hasProject: () => true,
    })
    expect(read.elsewhere[0]?.project).toEqual(PORTAL)
    expect(read.elsewhere[0]?.items.map((one) => one.label)).toEqual(['Building the reel', 'Kiosk reel'])
    expect(read.elsewhere[0]?.items[1]?.where).toBe('kiosk-info-reel')
    expect(read.elsewhere[0]?.items.every((one) => !one.here)).toBe(true)
  })

  test('the bar’s count counts what needs the person in other projects too', () => {
    expect(needingCount([], [{ entries: [entry('q', 'attention'), entry('d', 'done')] }])).toBe(1)
    expect(countLook(1, true).label).toContain('1 needs you')
  })
})
