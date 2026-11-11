import { describe, expect, test } from 'bun:test'

import { makeAsk, type CanvasControls } from '@/host/ask.ts'
import { forwarded } from '@/host/forwarded.ts'

/**
 * A frame reaches the canvas's controls through `forwarded` (`host/forwarded.ts`). It used to
 * forward a hand-written list, and a control left off it was answered as absent: a module's
 * Expand on its tile said "This canvas shows nothing large." on a canvas that shows one large.
 */

const ME = 'example.agent'

function canvas(over: Partial<CanvasControls> = {}): CanvasControls {
  return {
    showEpic: () => {},
    goto: () => ({ outcome: 'declined', epic: null, why: '' }),
    select: () => {},
    point: () => {},
    locate: () => ({ outcome: 'declined', why: '' }) as never,
    openAddress: () => ({ outcome: 'declined', why: '' }) as never,
    show: () => {},
    emit: () => ({ ok: true, delivered: 0 }) as never,
    filter: () => ({ outcome: 'declined', why: '' }) as never,
    pickProject: () => Promise.resolve({ outcome: 'declined', project: null, why: '' }) as never,
    fold: () => ({ outcome: 'unchanged', folded: [], unfolded: [], why: '' }),
    project: () => null,
    ...over,
  }
}

describe('a frame’s view of the canvas', () => {
  test('Expand reaches the canvas: a pressed view.expand is expanded, never "shows nothing large"', async () => {
    const asked: unknown[] = []
    const ref = { current: canvas({ expand: (from, call, pressed) => (asked.push({ from, call, pressed }), { outcome: 'expanded', why: '' }) }) }
    const ask = makeAsk(ME, forwarded(ref), (capability) => capability === 'view:expand')
    const answer = await ask('view.expand', { expand: true }, { pressed: true })
    expect(answer).toEqual({ ok: true, data: { outcome: 'expanded', why: '' } })
    expect(asked).toEqual([{ from: ME, call: { expand: true }, pressed: true }])
    expect(JSON.stringify(answer)).not.toContain('nothing large')
  })

  test('every control the canvas has is the frame’s, read at the moment of the call', () => {
    const calls: string[] = []
    const ref = { current: canvas({ walkStep: () => void calls.push('first walk'), withhold: (_m, _x, data) => data }) }
    const seen = forwarded(ref)
    expect(typeof seen.walkStep).toBe('function')
    expect(typeof seen.withhold).toBe('function')
    expect(typeof seen.fold).toBe('function')
    const walk = seen.walkStep!
    ref.current = canvas({ walkStep: () => void calls.push('second walk') })
    walk({ epic: 'e', step: 1 }, ME)
    expect(calls).toEqual(['second walk'])
  })

  test('a control the canvas lacks is still absent, and the frame’s own win', () => {
    const ref = { current: canvas({ kehikko: () => 1 }) }
    const seen = forwarded(ref, { kehikko: () => 9 })
    expect(seen.expand).toBeUndefined()
    expect('expand' in seen).toBe(false)
    expect(seen.kehikko?.()).toBe(9)
  })
})
