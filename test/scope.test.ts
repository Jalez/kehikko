import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { manifestSchema } from 'kehikot-module-protocol'

import { createCanvas, editCanvas, listCanvases, open as openDb, type Placement } from '../server/canvases.ts'
import { parse, serialize } from '../server/kehikot.ts'
import { scopeWords } from '../server/mcp.ts'
import { toWireContext, whileFrozen, type Subject } from '../src/host/context.ts'
import {
  SCOPE_ICONS,
  coveredForScope,
  onlyScopeSaid,
  scopeOfContainer,
  scopeRowTooltip,
  scopeToKeep,
  scopeToTell,
  scopeTooltip,
} from '../src/host/scope.ts'
import { arrange, rowsOf } from '../src/host/moduleMenu.ts'
import { placementSchema } from '../src/host/canvases.ts'
import type { Presence } from '../src/host/registry.ts'

/*
 * A module's scope (protocol 2.29.0): what its content belongs to, declared by
 * the module as modes (the default first), picked by the person per container,
 * kept with the arrangement only when it is not the default, told to the module
 * in `context.scope`, and said by `read_canvas`.
 */

const base = { kind: 'kehikot.module', protocol: 2, id: 'kehikot.kanban', name: 'Kanban', entry: '/', partless: 'x' }
const kanban = manifestSchema.parse({
  ...base,
  modes: [
    { id: 'board', label: 'Kanban', scope: 'epic', scopeSays: 'the open epic’s issues and changes' },
    { id: 'all', label: 'All epics', scope: 'project', scopeSays: 'every epic’s issues and changes, each labelled' },
  ],
})
const runs = manifestSchema.parse({
  ...base,
  id: 'kehikot.queue',
  modes: [{ id: 'queue', label: 'Test runs', scope: 'machine', scopeSays: 'every project’s test runs, whatever is open here' }],
})
const paper = manifestSchema.parse({ ...base, id: 'kehikot.paper', modes: [{ id: 'paper', label: 'Paper', scope: 'epic' }] })
const old = manifestSchema.parse({ ...base, id: 'kehikot.history', modes: [{ id: 'history', label: 'History', scope: 'global' }] })

describe('a container’s scope', () => {
  test('is the module’s default until the person picks another it lists', () => {
    const at = scopeOfContainer(kanban, null)
    expect(at).toMatchObject({ active: 'epic', name: 'Epic', isDefault: true, defaultScope: 'epic', says: 'the open epic’s issues and changes' })
    expect(at.supported.map((one) => [one.scope, one.name, one.isDefault])).toEqual([
      ['epic', 'Epic', true],
      ['project', 'Project', false],
    ])
    expect(scopeOfContainer(kanban, 'project')).toMatchObject({ active: 'project', isDefault: false })
    /* A pick the module does not list reads as its default. */
    expect(scopeOfContainer(kanban, 'machine')).toMatchObject({ active: 'epic', isDefault: true })
  })

  test('an old or missing word reads as Epic, with the scope’s own meaning for a line', () => {
    expect(scopeOfContainer(old, null)).toMatchObject({ active: 'epic', name: 'Epic', says: 'The open epic.' })
    expect(scopeOfContainer({}, null).active).toBe('epic')
  })

  test('the tooltips say the name, default or changed, and the module’s line', () => {
    expect(scopeTooltip(scopeOfContainer(kanban, null))).toBe('Scope: Epic (default). The open epic’s issues and changes.')
    expect(scopeTooltip(scopeOfContainer(kanban, 'project'))).toBe('Scope: Project (changed). Every epic’s issues and changes, each labelled.')
    expect(scopeRowTooltip(scopeOfContainer(kanban, null))).toBe('Scope: Epic. The open epic’s issues and changes. Can also work for: Project.')
    expect(scopeRowTooltip(scopeOfContainer(runs, null))).toBe('Scope: This computer. Every project’s test runs, whatever is open here.')
    expect(onlyScopeSaid(scopeOfContainer(runs, null))).toBe('This module only works for This computer.')
    expect(Object.keys(SCOPE_ICONS)).toEqual(['machine', 'project', 'epic', 'part', 'kehikko'])
  })

  test('is kept only when it is not the default, and never as one the module does not list', () => {
    expect(scopeToKeep(kanban, 'project')).toBe('project')
    expect(scopeToKeep(kanban, 'epic')).toBeNull()
    expect(scopeToKeep(kanban, 'machine')).toBeNull()
    expect(scopeToKeep(runs, 'machine')).toBeNull()
    expect(scopeToKeep(kanban, null)).toBeNull()
  })
})

describe('delivery: what a container is told', () => {
  test('its scope, and project on All epics for one at Epic or Part, unless it is pinned', () => {
    expect(scopeToTell('machine', false)).toBe('machine')
    expect(scopeToTell('epic', true)).toBe('project')
    expect(scopeToTell('part', true)).toBe('project')
    expect(scopeToTell('machine', true)).toBe('machine')
    expect(scopeToTell('epic', true, true)).toBe('epic')
  })

  test('All epics covers a container at Epic whose module cannot work at Project, and nothing else', () => {
    expect(coveredForScope('project', paper)).toBe(true)
    expect(coveredForScope('project', kanban)).toBe(false)
    expect(coveredForScope('project', runs)).toBe(false)
    expect(coveredForScope('project', paper, true)).toBe(false)
    expect(coveredForScope('epic', paper)).toBe(false)
    /* The deprecated declaration still counts. */
    expect(coveredForScope('project', { modes: [{ scope: 'epic' }], declares: { scopes: ['epic', 'project'] } })).toBe(false)
  })

  const subject: Subject = { epic: 'checkout', project: { id: 1, name: 'Shop', path: '/tmp/shop' } as Subject['project'] }

  test('a scope picked for a pinned container passes the pin; nothing else does', () => {
    const held = { ...toWireContext(subject, 'light'), scope: 'epic' as const }
    expect(whileFrozen(held, { ...toWireContext(subject, 'light'), scope: 'epic' })).toBeNull()
    const passed = whileFrozen(held, { ...toWireContext({ ...subject, epic: 'other' }, 'light'), scope: 'project' })
    expect(passed?.scope).toBe('project')
    /* The epic it was pinned on stays. */
    expect(passed?.epic).toBe('checkout')
  })
})

describe('storage: the scope travels with the arrangement', () => {
  const placement = (over: Partial<Placement> = {}): Placement => ({
    i: 'kehikot.kanban', x: 0, y: 0, w: 6, h: 20, grow: false, pinned: false, prompt: '', promptFor: null, collapsed: false,
    wish: 20, selected: false, filters: {}, refreshEvery: null, version: null, scope: null, ...over,
  })
  const stored = (over: Partial<Placement>) => {
    const db: Database = openDb(':memory:')
    const made = createCanvas(db, 'board')
    editCanvas(db, made.id, { placements: [placement(over)] })
    return listCanvases(db)
  }

  test('a pick is a column, and a word that is not a scope is the default', () => {
    expect(stored({ scope: 'project' })[0]!.placements[0]!.scope).toBe('project')
    expect(stored({ scope: null })[0]!.placements[0]!.scope).toBeNull()
    expect(stored({ scope: 'galaxy' as never })[0]!.placements[0]!.scope).toBeNull()
  })

  test('the shared file says it only when it is set, so a file on defaults reads in an older host', () => {
    const defaults = serialize(stored({}))
    expect(defaults).not.toContain('"scope"')
    const picked = serialize(stored({ scope: 'project' }))
    expect(picked).toContain('"scope":"project"')
    const read = parse(picked)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.kehikot[0]!.containers[0]!.scope).toBe('project')
    /* A word that is not a scope is refused with the file, like any other malformed field. */
    expect(parse(picked.replace('"scope":"project"', '"scope":"galaxy"')).ok).toBe(false)
  })

  test('the page reads any arrangement, the scope defaulted and a stranger word dropped', () => {
    const { scope: _none, ...before } = placement()
    expect(placementSchema.parse(before).scope).toBeNull()
    expect(placementSchema.parse({ ...before, scope: 'part' }).scope).toBe('part')
    expect(placementSchema.parse({ ...before, scope: 'galaxy' }).scope).toBeNull()
  })
})

describe('agents read it; the modules list shows and finds it', () => {
  test('read_canvas says the scope, default or changed, and the others', () => {
    expect(scopeWords(scopeOfContainer(kanban, null))).toBe(
      'scope: Epic (default) — the open epic’s issues and changes; can also work for Project — the person picks in its settings',
    )
    expect(scopeWords(scopeOfContainer(kanban, 'project'))).toBe(
      'scope: Project (changed by the person) — every epic’s issues and changes, each labelled; can also work for Epic (its default) — the person picks in its settings',
    )
    expect(scopeWords(scopeOfContainer(runs, null))).toBe('scope: This computer (default) — every project’s test runs, whatever is open here')
  })

  test('a registered module’s row carries its scope, and a search finds it by the scope’s name', () => {
    const presence = (id: string, module: object) => ({ id, name: id, condition: 'ready', module }) as unknown as Presence
    const rows = rowsOf([presence('kehikot.queue', runs), presence('kehikot.kanban', kanban)], new Set())
    expect(rows.map((row) => row.scope?.active)).toEqual(['machine', 'epic'])
    expect(arrange(rows, 'this computer').flatMap((section) => section.rows.map((row) => row.id))).toEqual(['kehikot.queue'])
    expect(arrange(rows, 'project').flatMap((section) => section.rows.map((row) => row.id))).toEqual(['kehikot.kanban'])
  })
})
