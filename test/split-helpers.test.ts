import { describe, expect, mock, test } from 'bun:test'
import type { TrackerRow } from 'kehikot-module-protocol'

import { heardWake } from '../src/host/canvases.ts'
import {
  activityLines,
  containerMarks,
  elsewhereLine,
  legendLines,
  MESSAGES_MUTED_MARK,
  pickedPartsLines,
  projectLine,
  sizeText,
} from '../server/mcp/canvasText.ts'
import {
  ARRANGE_PER_MINUTE,
  arrangeAskOf,
  arrangeAsksOf,
  arrangedSaid,
  backSaid,
  notOwnSaid,
  pacedSaid,
  unfitSaid,
  whereSaid,
} from '../server/mcp/tools/arrangeModules.ts'
import { epicNamed, kehikkoNamed, partsNamed, projectNamed, stepNamed, targetArgsOf } from '../server/mcp/tools/jump.ts'
import { goneOf, stillChecking, withUnread } from '../server/trackers/readSources.ts'
import type { Source } from '../server/trackers/sources.ts'

/*
 * The pure pieces taken out of the host's longest functions — `canvasText`,
 * `arrangeOn`, `resolveTarget`, `readSource` and the watch stream's `heard` —
 * each on its own. The functions they came from are tested whole in
 * `mcp.test.ts`, `arrange.test.ts`, `jump.test.ts`, the `tracker-*` tests and
 * `watching.test.ts`.
 */

describe('canvasText, in parts', () => {
  test('the project line: id, a missing folder, or none', () => {
    expect(projectLine(null)).toContain('project: none.')
    const line = projectLine({ name: 'Thesis', path: '/p/thesis', uid: 'u1', missing: false })
    expect(line).toBe('project: Thesis at /p/thesis (project id u1, which stays the same when its folder is renamed or moved)')
    expect(projectLine({ name: 'Thesis', path: '/p/thesis', uid: null, missing: true } as never)).toContain('Nothing is read from it or written to it until it is found again.')
  })

  test('sub-spaces with the picks marked, what they narrow to, and picks that name nothing', () => {
    const parts = [{ id: 'a', heading: 'Auth' }, { id: 'b', heading: 'Billing' }]
    const lines = pickedPartsLines('epic', parts, ['a', 'gone'], false)
    expect(lines[0]).toBe('direct sub-spaces of epic (older name: parts; id — name): a — "Auth" [picked]; b — "Billing".')
    expect(lines[1]).toContain('sub-spaces picked out: a — every module here is pointed at those only;')
    expect(lines[2]).toBe('picked, and no longer a sub-space of epic (narrows nothing): gone.')
    expect(pickedPartsLines('epic', parts, ['b'], true)[1]).toBe('sub-spaces this conversation is about: b — the rest of epic is still there.')
    expect(pickedPartsLines('epic', [], [], false)).toEqual(['direct sub-spaces of epic: none. edit_space adds one.'])
  })

  test('a container\'s marks, in order, and what is said of a module that is not running', () => {
    const p = { selected: true, pinned: false, version: 'v1', collapsed: true, tiled: false, scope: null } as never
    expect(containerMarks(p, { id: 'm', name: 'M', condition: 'ready' }, undefined, true)).toEqual([
      'SELECTED',
      'runs version v1, not latest',
      'folded to its header',
      MESSAGES_MUTED_MARK,
    ])
    const plain = { selected: false, pinned: false, version: null, collapsed: false, tiled: false, scope: null } as never
    expect(containerMarks(plain, undefined, undefined, false)[0]).toContain('no registration on this computer')
    expect(containerMarks(plain, { id: 'm', name: 'M', condition: 'silent' }, undefined, false)).toEqual(['not answering (silent)'])
    expect(containerMarks(plain, { id: 'm', name: 'M', condition: 'incompatible', fit: 'needs newer' }, undefined, false)[0]).toContain('does not fit this Kehikot')
  })

  test('where a container is, and the rows it asks for when it is open', () => {
    expect(sizeText({ x: 1, y: 2, w: 3, h: 4, wish: 6, collapsed: false, tiled: false })).toMatch(/^at column 1, row 2; 3 wide and 4 tall \(asks for 6 rows\), of \d+ columns and \d+ rows$/)
    expect(sizeText({ x: 1, y: 2, w: 3, h: 4, wish: 6, collapsed: true, tiled: false })).not.toContain('asks for')
  })

  test('each legend once, only for what appears', () => {
    const placements = [{ i: 'a' }]
    expect(legendLines(placements, new Map(), undefined, undefined)).toEqual([])
    expect(legendLines(placements, new Map(), null, undefined)[1]).toContain('Header items are not listed')
    const declared = new Map([['a', [{} as never]]])
    expect(legendLines(placements, new Map([['a', { modes: [] }]]), declared, declared).filter((line) => line).length).toBe(3)
  })

  test('activity: not listed, listed with what is not here, or only the log', () => {
    expect(activityLines([], null, undefined)[1]).toContain('Activity is not listed')
    expect(activityLines([], undefined, ['earlier'])).toEqual(['', 'earlier'])
    expect(activityLines([], [], undefined)).toEqual([])
    const row = { module: 'gone', name: 'Gone', label: 'x', state: 'working' } as never
    const lines = activityLines([{ i: 'here' }], [row], ['log'])
    expect(lines.some((line) => line.startsWith('activity of gone, which is not on this kehikko:'))).toBe(true)
    expect(lines.at(-1)).toBe('log')
  })

  test('what place_modules can add', () => {
    expect(elsewhereLine([{ id: 'a', name: 'A' }, { id: 'b', name: 'b' }], [{ i: 'c' }])).toBe('registered on this computer and not on this kehikko (what place_modules can add): a (A), b')
    expect(elsewhereLine([{ id: 'a', name: null }], [{ i: 'a' }])).toBe('every module registered on this computer is already on this kehikko.')
  })
})

describe('arrange_modules, in parts', () => {
  test('one entry: bounded, one of size or columns, and something to become', () => {
    expect(arrangeAskOf({ module: ' kehikot.a ', columns: 4, row: 0 })).toEqual({ i: 'kehikot.a', w: 4, y: 0 })
    expect(arrangeAskOf('x')).toContain('every entry in containers is an object')
    expect(arrangeAskOf({ module: '' })).toContain('names module')
    expect(arrangeAskOf({ module: 'a', size: 'wide', columns: 3 })).toBe('a: give size or columns, not both.')
    expect(arrangeAskOf({ module: 'a', size: 'enormous' })).toContain('a: size is one of')
    expect(arrangeAskOf({ module: 'a', columns: 0 })).toContain('a: columns is a whole number')
    expect(arrangeAskOf({ module: 'a', rows: 1.5 })).toContain('to fold a container, use fold_modules')
    expect(arrangeAskOf({ module: 'a' })).toBe('a: say what it is to become — size or columns, rows, column or row.')
  })

  test('the whole ask: containers, show, or why not', () => {
    expect(arrangeAsksOf({})).toEqual({ ok: false, why: 'arrange_modules needs containers (what each is to become) or show (what to bring into view), or both.' })
    expect(arrangeAsksOf({ containers: 'x' })).toMatchObject({ ok: false })
    expect(arrangeAsksOf({ containers: [{ module: 'a', column: 1 }], show: ['b', 'b'] })).toEqual({ ok: true, asks: [{ i: 'a', x: 1 }], show: ['b'] })
  })

  test('only the conversation\'s own kehikko, unless a project was named', () => {
    const canvas = { id: 3, name: 'Wide' }
    expect(notOwnSaid(null, canvas, true)).toBeNull()
    expect(notOwnSaid(null, canvas, false)).toContain('this conversation has none recorded.')
    const here = { canvas: { id: 4, name: 'Other' }, project: { name: 'P' } } as never
    expect(notOwnSaid(here, canvas, false)).toContain('is not this conversation’s own: that is kehikko 4 (Other)')
    expect(notOwnSaid({ canvas: { id: 3, name: 'Wide' }, project: { name: 'P' } } as never, canvas, false)).toBeNull()
  })

  test('what is not on the kehikko, and a tile resized without being shown', () => {
    const canvas = { id: 3, name: 'Wide', placements: [{ i: 'a', tiled: true }, { i: 'b', tiled: false }] } as never
    expect(unfitSaid(canvas, [], [], ['z'])).toContain('z is not a container on kehikko 3 (Wide)')
    expect(unfitSaid(canvas, [{ i: 'a', w: 4 }], [], ['a'])).toContain('a is a tile')
    expect(unfitSaid(canvas, [{ i: 'a', w: 4 }], ['a'], ['a'])).toBeNull()
  })

  test('the pace, and what each container came to', () => {
    expect(pacedSaid(Array.from({ length: ARRANGE_PER_MINUTE }, () => 1_000), 31_000)).toContain('Ask again in 30 s')
    const got = { i: 'a', x: 2, y: 0, w: 4, h: 5, wish: 5, collapsed: false, tiled: false } as never
    expect(whereSaid(got)).toBe('column 2, row 0, 4 wide and 5 tall')
    const was = new Map([['a', { i: 'a', x: 0, y: 3, w: 3, h: 5, wish: 6, collapsed: false, tiled: false }], ['b', { i: 'b', x: 0, y: 0, w: 3, h: 2, wish: 2, collapsed: true, tiled: false }]]) as never
    const after = [got, { i: 'b', x: 6, y: 0, w: 3, h: 4, wish: 4, collapsed: false, tiled: false }] as never
    expect(arrangedSaid([{ i: 'a', w: 5, y: 1 }], ['b'], after, was)).toEqual([
      'a is at column 2, row 0, 4 wide and 5 tall (5 wide asked, 4 is what fits from column 2; row 1 asked, the grid compacts it to row 0).',
      'b is shown, at column 6, row 0, 3 wide and 4 tall.',
    ])
    expect(backSaid(after, new Set(['a']), was)).toEqual(['{ module: "a", columns: 3, rows: 6, column: 0, row: 3 }'])
  })
})

describe('jump\'s target, in parts', () => {
  test('the arguments, bounded before anything is looked up', () => {
    expect(targetArgsOf({}, 'jump')).toEqual({ why: 'jump needs somewhere to go: a project, kehikko, space or step — any of them, and what is left out stays.' })
    expect(targetArgsOf({ project: '' }, 'jump')).toMatchObject({ why: expect.stringContaining('project, when given') })
    expect(targetArgsOf({ step: 0 }, 'jump')).toMatchObject({ why: expect.stringContaining('step, when given') })
    expect(targetArgsOf({ parts: [' a ', 'a'], step: 2 }, 'jump')).toMatchObject({ askedParts: ['a'], step: 2, askedProject: undefined })
  })

  test('names strictly: an id, the folder or the one exact name', () => {
    const projects = [
      { id: 1, uid: 'u1', name: 'Thesis', path: '/p/thesis', missing: false },
      { id: 2, uid: 'u2', name: 'Twin', path: '/p/twin-a', missing: false },
      { id: 3, uid: 'u3', name: 'Twin', path: '/p/twin-b', missing: false },
    ] as never[]
    expect(projectNamed(projects, 'u1')).toMatchObject({ id: 1 })
    expect(projectNamed(projects, 'thesis')).toMatchObject({ id: 1 })
    expect(projectNamed(projects, '/p/twin-b')).toMatchObject({ id: 3 })
    expect(projectNamed(projects, 'Twin')).toMatchObject({ why: expect.stringContaining('More than one project is called Twin') })
    expect(projectNamed(projects, 'The')).toMatchObject({ why: expect.stringContaining('This host has no project The') })
    const kehikot = [{ id: 7, key: 'k7', name: 'Wide' }] as never[]
    expect(kehikkoNamed(kehikot, { name: 'Thesis' }, '7')).toMatchObject({ id: 7 })
    expect(kehikkoNamed(kehikot, { name: 'Thesis' }, 'narrow')).toMatchObject({ why: expect.stringContaining('Thesis has no kehikko narrow') })
    expect(epicNamed([{ slug: 'share', title: 'Share links' }], { name: 'Thesis' }, 'share links')).toBe('share')
    expect(epicNamed([{ slug: 'share' }], { name: 'Thesis' }, 'nope')).toMatchObject({ why: expect.stringContaining('no top-level space nope') })
  })

  test('sub-spaces and steps', () => {
    expect(partsNamed([{ id: 'a', heading: 'Auth' }], 'epic', ['auth'])).toEqual(['a'])
    expect(partsNamed([{ id: 'a', heading: 'Auth' }], 'epic', ['a', 'x'])).toMatchObject({ why: expect.stringContaining('epic has no sub-space x') })
    expect(stepNamed(null, 'epic', 3)).toEqual({ title: undefined, unchecked: true })
    expect(stepNamed([], 'epic', 1)).toMatchObject({ why: expect.stringContaining('Nobody has written steps') })
    expect(stepNamed([{ title: 'One' }], 'epic', 2)).toMatchObject({ why: expect.stringContaining('epic has 1 step, so there is no step 2') })
    expect(stepNamed([{ title: '  Login  ' }], 'epic', 1)).toEqual({ title: 'Login', unchecked: false })
  })
})

describe('readSource, in parts', () => {
  const source = { tracker: 'gitlab', host: 'gitlab.com', repo: 'g/r' } as Source
  const row = (number: number, over: Partial<TrackerRow> = {}): TrackerRow =>
    ({ tracker: 'gitlab', host: 'gitlab.com', repo: 'g/r', kind: 'change', number, state: 'open', pipeline: 'running', ref: `!${number}`, ...over }) as TrackerRow
  const id = (n: number) => `gitlab|gitlab.com|g/r|change|${n}`

  test('held changes still checking are asked again, unless already read or asked', () => {
    const held = new Map([
      [id(1), row(1)],
      [id(2), row(2, { pipeline: 'success' } as never)],
      [id(3), row(3)],
      [id(4), row(4)],
    ])
    expect(stillChecking(held, source, new Set([id(3)]), new Map([[id(4), {}]]))).toEqual([{ number: 1, kind: 'change', refs: ['!1'], id: id(1) }])
  })

  test('unread refs of two reads as one, and what is gone', () => {
    const a = { why: 'first', refs: [{ number: 1, kind: null }] }
    const b = { why: 'second', refs: [{ number: 2, kind: null }] }
    expect(withUnread(undefined, b)).toBe(b)
    expect(withUnread(a, undefined)).toBe(a)
    expect(withUnread(a, b)).toEqual({ why: 'first', refs: [...a.refs, ...b.refs] })
    const wanted = new Map([[id(1), {}], [id(2), {}], [id(3), {}], [id(4), {}]])
    expect(goneOf(wanted, new Set([id(1), id(2), id(3)]), [row(1)], new Set([id(2)]))).toEqual([id(3)])
  })
})

describe('the watch stream\'s news', () => {
  const watchers = () => ({
    woke: mock(() => {}),
    looked: mock(() => {}),
    wrote: mock(() => {}),
    inboxed: mock(() => {}),
    marked: mock(() => {}),
    read: mock(() => {}),
    relisted: mock(() => {}),
  })

  test('each field goes to its watcher, checked for exactly what it should be', () => {
    const on = watchers()
    heardWake({ kehikko: 3, epics: 5, inbox: 6, rev: 2, dispositions: 7, projects: true, tracker: 8, at: null, refreshing: true }, on)
    expect(on.woke).toHaveBeenCalledWith(3, null, null)
    expect(on.wrote).toHaveBeenCalledWith(5)
    expect(on.inboxed).toHaveBeenCalledWith(6, 2)
    expect(on.marked).toHaveBeenCalledWith(7)
    expect(on.relisted).toHaveBeenCalledTimes(1)
    expect(on.read).toHaveBeenCalledWith(8, { at: null, refreshing: true })
  })

  test('what is not exactly right is not news', () => {
    const on = watchers()
    heardWake({ kehikko: 1.5, epics: '5', inbox: 6, rev: 'x', projects: 'yes', registry: 1, tracker: 8, at: 3, refreshing: true }, on)
    expect(on.woke).not.toHaveBeenCalled()
    expect(on.wrote).not.toHaveBeenCalled()
    expect(on.inboxed).toHaveBeenCalledWith(6, null)
    expect(on.relisted).not.toHaveBeenCalled()
    expect(on.looked).not.toHaveBeenCalled()
    expect(on.read).not.toHaveBeenCalled()
    heardWake(null, on)
    heardWake(42, on)
    expect(on.woke).not.toHaveBeenCalled()
  })

  test('the registry flag looks, with the reading when it came along', () => {
    const on = watchers()
    heardWake({ registry: true }, on)
    expect(on.looked).toHaveBeenCalledWith(undefined)
  })
})
