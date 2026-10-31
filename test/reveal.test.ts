import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REVEAL_ENTER_MS, REVEAL_LEAVE_MS, Reveals, focusHandlers, revealHandlers } from '../src/host/reveal.ts'

/*
 * Focus mode's reveal (`host/reveal.ts`): the header and footer show while the
 * pointer is anywhere over a container — its page or its own rows — and on focus
 * within it, debounced so that the page moving under the pointer cannot hide
 * what the pointer just revealed. With fake timers: no flicker, no loop.
 */

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

function counted() {
  const reveals = new Reveals()
  const told = { n: 0 }
  reveals.subscribe(() => void (told.n += 1))
  return { reveals, told }
}

describe('reveal on hover anywhere over the container', () => {
  test('the pointer entering the page reveals after a short wait, and leaving hides after a longer one', () => {
    const { reveals, told } = counted()
    reveals.hold('a', 'frame', true)
    jest.advanceTimersByTime(REVEAL_ENTER_MS - 1)
    expect(reveals.revealed('a')).toBe(false)
    jest.advanceTimersByTime(1)
    expect(reveals.revealed('a')).toBe(true)
    reveals.hold('a', 'frame', false)
    jest.advanceTimersByTime(REVEAL_LEAVE_MS - 1)
    expect(reveals.revealed('a')).toBe(true)
    jest.advanceTimersByTime(1)
    expect(reveals.revealed('a')).toBe(false)
    expect(told.n).toBe(2)
  })

  test('a pointer passing through on its way elsewhere reveals nothing and starts no reflow', () => {
    const { reveals, told } = counted()
    for (const id of ['a', 'b', 'c']) {
      reveals.hold(id, 'frame', true)
      jest.advanceTimersByTime(20)
      reveals.hold(id, 'frame', false)
    }
    jest.advanceTimersByTime(1000)
    expect(told.n).toBe(0)
    expect(['a', 'b', 'c'].some((id) => reveals.revealed(id))).toBe(false)
  })

  test('each container is its own', () => {
    const { reveals } = counted()
    reveals.hold('a', 'frame', true)
    jest.advanceTimersByTime(REVEAL_ENTER_MS)
    expect(reveals.revealed('a')).toBe(true)
    expect(reveals.revealed('b')).toBe(false)
  })
})

describe('no flicker loop', () => {
  test('the page pushed down hands the pointer to the header, and the reveal holds', () => {
    const { reveals, told } = counted()
    reveals.hold('a', 'frame', true)
    jest.advanceTimersByTime(REVEAL_ENTER_MS)
    expect(told.n).toBe(1)
    /* The reveal moved the page: its leave and the header's enter arrive together, in either order. */
    reveals.hold('a', 'frame', false)
    reveals.hold('a', 'chrome', true)
    jest.advanceTimersByTime(5000)
    expect(reveals.revealed('a')).toBe(true)
    reveals.hold('a', 'frame', true)
    reveals.hold('a', 'chrome', false)
    jest.advanceTimersByTime(5000)
    expect(reveals.revealed('a')).toBe(true)
    expect(told.n).toBe(1)
  })

  test('a resize that bounces the pointer across the boundary many times is still one change', () => {
    const { reveals, told } = counted()
    reveals.hold('a', 'frame', true)
    jest.advanceTimersByTime(REVEAL_ENTER_MS)
    for (let n = 0; n < 50; n += 1) {
      reveals.hold('a', 'frame', false)
      jest.advanceTimersByTime(16)
      reveals.hold('a', 'frame', true)
      jest.advanceTimersByTime(16)
    }
    jest.advanceTimersByTime(5000)
    expect(told.n).toBe(1)
    expect(reveals.revealed('a')).toBe(true)
  })

  test('a leave that falls just short of the hide, then comes back, never hides', () => {
    const { reveals, told } = counted()
    reveals.hold('a', 'chrome', true)
    jest.advanceTimersByTime(REVEAL_ENTER_MS)
    reveals.hold('a', 'chrome', false)
    jest.advanceTimersByTime(REVEAL_LEAVE_MS - 10)
    reveals.hold('a', 'frame', true)
    jest.advanceTimersByTime(REVEAL_LEAVE_MS * 4)
    expect(told.n).toBe(1)
  })
})

describe('focus', () => {
  test('focus within the container holds the reveal while the pointer is gone, and focus moving inside keeps it', () => {
    const { reveals } = counted()
    const box = { contains: (node: unknown) => node === 'inside' } as unknown as Element
    const on = focusHandlers(reveals, 'a') as { onFocus(): void; onBlur(event: { currentTarget: Element; relatedTarget: unknown }): void }
    on.onFocus()
    jest.advanceTimersByTime(REVEAL_ENTER_MS)
    expect(reveals.revealed('a')).toBe(true)
    on.onBlur({ currentTarget: box, relatedTarget: 'inside' })
    jest.advanceTimersByTime(REVEAL_LEAVE_MS * 2)
    expect(reveals.revealed('a')).toBe(true)
    on.onBlur({ currentTarget: box, relatedTarget: null })
    jest.advanceTimersByTime(REVEAL_LEAVE_MS)
    expect(reveals.revealed('a')).toBe(false)
  })

  test('outside focus mode nothing is attached', () => {
    expect(revealHandlers(null, 'a', 'frame')).toEqual({})
    expect(focusHandlers(null, 'a')).toEqual({})
  })

  test('a container that goes away lets go of its reveal', () => {
    const { reveals, told } = counted()
    reveals.hold('a', 'frame', true)
    jest.advanceTimersByTime(REVEAL_ENTER_MS)
    reveals.forget('a')
    expect(reveals.revealed('a')).toBe(false)
    jest.advanceTimersByTime(5000)
    expect(told.n).toBe(2)
  })
})

describe('the stylesheet pushes, never covers', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'src', 'index.css'), 'utf8')
  const start = css.indexOf('.focus-mode .react-grid-item .container-reveal')
  const end = css.indexOf('/* No fade while a container is being dragged.')
  const rules = css.slice(start, end)

  test('the header and footer rows stay in the column: no absolute positioning, no layer over the page', () => {
    expect(start).toBeGreaterThan(0)
    expect(rules).not.toMatch(/position:\s*absolute/)
    expect(rules).not.toMatch(/z-index/)
    expect(rules).toContain('.container-footer-reveal')
  })

  test('hidden is no height at all; revealed is one row; an open menu and focus within keep it', () => {
    expect(rules).toMatch(/height:\s*0;/)
    expect(rules).toMatch(/\[data-revealed\], :focus-within, :has\(\[data-slot='dropdown-menu-trigger'\]\[data-state='open'\]\)\)[^{]*\{\s*height:\s*2rem;/)
  })

  test('one short height transition, and none where motion is asked to be less', () => {
    expect(rules).toMatch(/transition:\s*height 1\d\dms/)
    expect(rules).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*container-footer-reveal[\s\S]*transition:\s*none/)
  })

  test('folded keeps its header; selected keeps its header', () => {
    expect(rules).toContain(':not([data-collapsed]):not([data-selected])')
  })
})
