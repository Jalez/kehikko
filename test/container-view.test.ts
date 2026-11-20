import { describe, expect, test } from 'bun:test'

import { conditionOf, headerContent, lifecycleOf, overflowParts, veilOf } from '../src/host/containerView.ts'
import { layoutOf } from '../src/host/headerOffer.ts'
import type { Presence } from '../src/host/registry.ts'
import type { Showing } from '../src/host/standing.ts'

/*
 * What a container reads off what it was handed before it draws
 * (`host/containerView.ts`): the overflow it draws itself, the veil over a
 * late page, the condition dot's state and the key that restarts the header's fit.
 */

const notice = (over: Partial<Extract<Showing, { kind: 'notice' }>> = {}): Showing =>
  ({ kind: 'notice', condition: 'silent', asleep: false, line: 'gone', ...over }) as Showing

describe('the overflow a container draws itself', () => {
  test('roomy: the Container trigger holds the frame rows, and Help has its own "?"', () => {
    const layout = layoutOf({ items: [], frame: ['tools', 'remove'], help: ['help', 'feedback'], controls: ['filter'] }, 'words', false)
    const parts = overflowParts(layout)
    expect(parts.ownOverflow?.which).toBe('frame')
    expect(parts.frameEntries).toEqual(['tools'])
    expect(parts.overflowControls).toEqual([])
    expect(parts.overflowHelp).toEqual([])
    expect(parts.helpEntries).toEqual(['help', 'feedback'])
  })

  test('merged with no module menus: one "⋯" with the row controls, Help and the frame rows', () => {
    const layout = layoutOf({ items: [], frame: ['tools', 'remove'], help: ['help'], controls: ['filter'] }, 'merged', false)
    const parts = overflowParts(layout)
    expect(parts.ownOverflow?.which).toBe('more')
    expect(parts.frameEntries).toEqual(['tools', 'remove'])
    expect(parts.overflowControls).toEqual(['filter'])
    expect(parts.overflowHelp).toEqual(['help'])
    expect(parts.helpEntries).toBeNull()
  })

  test('merged with module menus: the "⋯" is HeaderMenus\' to draw', () => {
    const items = [{ kind: 'switch', id: 'pane', label: 'Pane', value: 'a', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] as never
    const parts = overflowParts(layoutOf({ items, frame: ['tools'], help: [], controls: [] }, 'merged', false))
    expect(parts.ownOverflow).toBeNull()
    expect(parts.frameEntries).toBeUndefined()
    expect(parts.overflowControls).toEqual([])
  })
})

describe('the veil over a late page', () => {
  test('only over the page, in the module\'s words when it gave some', () => {
    expect(veilOf({ kind: 'page' }, null)).toBeNull()
    expect(veilOf({ kind: 'page' }, { label: null })).toEqual({ kind: 'cover', state: 'loading' })
    expect(veilOf({ kind: 'page' }, { label: 'Loading the plan…' })).toEqual({ kind: 'cover', state: 'loading', label: 'Loading the plan…' })
    expect(veilOf({ kind: 'cover', state: 'starting' }, { label: 'x' })).toBeNull()
  })
})

describe('the condition dot', () => {
  const presence = { condition: 'silent' } as Pick<Presence, 'condition'>
  test('ready while the page shows, the notice\'s condition, else the sweep\'s', () => {
    expect(conditionOf({ kind: 'page' }, presence)).toBe('ready')
    expect(conditionOf(notice({ condition: 'incompatible' }), presence)).toBe('incompatible')
    expect(conditionOf({ kind: 'cover', state: 'installing' }, presence)).toBe('silent')
  })
  test('a cover says its wait, a sleeping notice says asleep', () => {
    expect(lifecycleOf({ kind: 'cover', state: 'installing' })).toBe('installing')
    expect(lifecycleOf(notice({ asleep: true }))).toBe('asleep')
    expect(lifecycleOf(notice())).toBeUndefined()
    expect(lifecycleOf({ kind: 'page' })).toBeUndefined()
  })
})

test('the header\'s content key moves with the name, the pin, the running version and the branch', () => {
  const presence = { module: { version: '1.0.0' }, source: { branch: 'main' } } as unknown as Pick<Presence, 'module' | 'source'>
  const key = headerContent('Scratch', null, null, presence)
  expect(headerContent('Scratch', null, null, presence)).toBe(key)
  expect(headerContent('Other', null, null, presence)).not.toBe(key)
  expect(headerContent('Scratch', 'v1', null, presence)).not.toBe(key)
  expect(headerContent('Scratch', null, '1.1.0', presence)).not.toBe(key)
  expect(headerContent('Scratch', null, null, { ...presence, source: { branch: 'dev' } } as never)).not.toBe(key)
})
