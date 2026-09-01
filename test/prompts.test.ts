import { describe, expect, test } from 'bun:test'

import { promptFor, type Placement } from '@/host/canvases.ts'

/**
 * Composing what one module is told.
 *
 * The host composes rather than handing a module a list of fragments to merge —
 * see the essay on `prompt` in the protocol's `wire.ts`. That makes the
 * composition the host's decision, and a decision is a thing to test.
 */

const container = (i: string, at: [number, number], prompt = '', promptFor: string | null = null): Placement => ({
  i,
  x: at[0],
  y: at[1],
  w: 6,
  h: 10,
  grow: false,
  pinned: false,
  prompt,
  promptFor,
  collapsed: false,
  openH: null,
  selected: false,
  filters: {},
  refreshEvery: null,
})

describe('nothing aimed at a module is null, not an empty string', () => {
  test('an empty canvas tells nobody anything', () => {
    expect(promptFor([], 'a.target')).toBeNull()
  })

  test('prompts aimed elsewhere are not this module’s', () => {
    const canvas = [container('a.one', [0, 0], 'for somebody else', 'a.other')]
    expect(promptFor(canvas, 'a.target')).toBeNull()
  })

  test('a prompt aimed at nobody reaches nobody', () => {
    /* Written down, and going nowhere until a target is chosen. The dialog says
       so in words; this is the half that makes it true. */
    expect(promptFor([container('a.one', [0, 0], 'unaimed', null)], 'a.target')).toBeNull()
  })

  test('whitespace is not a prompt', () => {
    const canvas = [container('a.one', [0, 0], '   \n  ', 'a.target')]
    expect(promptFor(canvas, 'a.target')).toBeNull()
  })
})

describe('what a module is told', () => {
  test('one prompt arrives with the container that wrote it named', () => {
    const canvas = [container('a.author', [0, 0], 'be terse', 'a.target')]
    expect(promptFor(canvas, 'a.target')).toBe('## from a.author\n\nbe terse')
  })

  test('several are joined in the order the canvas reads', () => {
    /* Top to bottom, then left to right — the order a person reads their own
       arrangement in, and therefore the order they will expect. Any other rule
       is one they cannot see. */
    const canvas = [
      container('a.lower', [0, 5], 'third', 'a.target'),
      container('a.right', [6, 0], 'second', 'a.target'),
      container('a.left', [0, 0], 'first', 'a.target'),
    ]
    const told = promptFor(canvas, 'a.target')
    expect(told).toBe(
      '## from a.left\n\nfirst\n\n## from a.right\n\nsecond\n\n## from a.lower\n\nthird',
    )
  })

  test('a prompt is trimmed, so a stray newline does not become a blank heading', () => {
    const canvas = [container('a.author', [0, 0], '\n\n  mind the gap  \n\n', 'a.target')]
    expect(promptFor(canvas, 'a.target')).toBe('## from a.author\n\nmind the gap')
  })

  test('a container can aim at a module that is not on this canvas without breaking anything', () => {
    /* A container can be taken off and put back; throwing the text away in between
       would lose something somebody typed. */
    const canvas = [container('a.author', [0, 0], 'still here', 'a.gone')]
    expect(promptFor(canvas, 'a.target')).toBeNull()
    expect(promptFor(canvas, 'a.gone')).toBe('## from a.author\n\nstill here')
  })
})
