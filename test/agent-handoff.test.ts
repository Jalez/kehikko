import { describe, expect, test } from 'bun:test'

import { shownFor, handedSaid } from '../src/host/agentHandoff.ts'
import { place, type Placement } from '../src/host/canvases.ts'

/** Handing something to an agent, the page's half: its container is on the kehikko and open. */

const base = (): Placement[] => place(place([], 'kehikot.notes'), 'kehikot.agent')

describe('shownFor', () => {
  test('missing: added where a new container goes', () => {
    const before = place([], 'kehikot.notes')
    const after = shownFor(before, 'kehikot.agent')!
    expect(after.map((one) => one.i)).toEqual(['kehikot.notes', 'kehikot.agent'])
    expect(after).toEqual(place(before, 'kehikot.agent'))
  })
  test('folded: unfolded; a tile: restored', () => {
    const folded = base().map((one) => (one.i === 'kehikot.agent' ? { ...one, collapsed: true } : one))
    expect(shownFor(folded, 'kehikot.agent')!.find((one) => one.i === 'kehikot.agent')!.collapsed).toBeFalsy()
    const tiled = base().map((one) => (one.i === 'kehikot.agent' ? { ...one, tiled: true } : one))
    expect(shownFor(tiled, 'kehikot.agent')!.find((one) => one.i === 'kehikot.agent')!.tiled).toBeFalsy()
  })
  test('already on it and open: nothing to write', () => {
    expect(shownFor(base(), 'kehikot.agent')).toBeNull()
  })
  test('what the person is told', () => {
    expect(handedSaid('Agent')).toBe('Agent is on it in its container.')
  })
})
