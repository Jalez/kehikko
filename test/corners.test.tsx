import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CornerHandle, cornerHandle } from '../src/canvas/CornerHandle.tsx'
import { FOLDED_ROWS, SQUEEZED_ROWS, mostUp, onTopOf, redrawn, topEdge, type Wished } from '../src/host/columns.ts'
import { cornerOf } from '../src/host/corners.ts'

/**
 * A container resizes from any of its four corners.
 *
 * The side edges are the grid's (`react-grid-layout` moves `x` and `w` together
 * so the opposite edge stays put); the top edge is this host's, because the
 * grid compacts upward and a column is a height budget (`columns.ts`). What is
 * here is the top edge's arithmetic, and what makes the corners usable without
 * costing the header anything.
 */
const box = (i: string, x: number, y: number, w: number, h: number, extra: Partial<Wished> = {}): Wished => ({
  i, x, y, w, h, wish: h, collapsed: false, ...extra,
})

describe('a top edge pulled up', () => {
  const column = [box('a', 0, 0, 6, 16), box('b', 0, 16, 6, 20), box('side', 6, 0, 6, 56)]

  test('keeps the bottom edge and takes the rows from the container on top', () => {
    const pull = topEdge(column, 'b', 28)
    expect(pull.h).toBe(28)
    expect(pull.y).toBe(8)
    expect(pull.y + pull.h).toBe(16 + 20)
    expect(pull.given.get('a')).toBe(8)
    expect(pull.given.has('side')).toBe(false)
  })

  test('stops where the container on top is at its floor', () => {
    const pull = topEdge(column, 'b', 80)
    expect(mostUp(column, 'b')).toBe(16 - SQUEEZED_ROWS)
    expect(pull.h).toBe(20 + 16 - SQUEEZED_ROWS)
    expect(pull.given.get('a')).toBe(SQUEEZED_ROWS)
    expect(pull.y).toBe(SQUEEZED_ROWS)
  })

  test('a container with nothing on top has no top edge to raise', () => {
    expect(mostUp(column, 'a')).toBe(0)
    const pull = topEdge(column, 'a', 24)
    expect(pull.h).toBe(16)
    expect(pull.y).toBe(0)
    expect(pull.given.size).toBe(0)
  })

  test('a folded container on top has nothing to spare', () => {
    const folded = [box('a', 0, 0, 6, 2, { wish: 16, collapsed: true }), box('b', 0, 2, 6, 20)]
    expect(mostUp(folded, 'b')).toBe(0)
    expect(topEdge(folded, 'b', 40).h).toBe(20)
  })

  test('every container flush on top gives the same rows', () => {
    const wide = [box('a', 0, 0, 3, 16), box('c', 3, 0, 3, 12), box('b', 0, 16, 6, 16)]
    expect(onTopOf(wide, wide[2]!).map((one) => one.i)).toEqual(['a'])
    const flush = [box('a', 0, 0, 3, 16), box('c', 3, 0, 3, 16), box('b', 0, 16, 6, 16)]
    expect(topEdge(flush, 'b', 22).given).toEqual(new Map([['a', 10], ['c', 10]]))
  })
})

describe('a top edge pushed down', () => {
  const column = [box('a', 0, 0, 6, 16), box('b', 0, 16, 6, 20)]

  test('gives the rows to the container on top, bottom edge fixed', () => {
    const pull = topEdge(column, 'b', 12)
    expect(pull.h).toBe(12)
    expect(pull.y).toBe(24)
    expect(pull.y + pull.h).toBe(36)
    expect(pull.given.get('a')).toBe(24)
  })

  test('never below the folded height, which is a fold', () => {
    expect(topEdge(column, 'b', -5).h).toBe(FOLDED_ROWS)
    expect(topEdge(column, 'b', 0).h).toBe(FOLDED_ROWS)
  })

  test('without anything on top it shortens in place and the grid settles it back', () => {
    const alone = [box('a', 0, 0, 6, 20)]
    const pull = topEdge(alone, 'a', 8)
    expect(pull).toMatchObject({ h: 8, y: 0 })
  })
})

describe('a top edge at rest', () => {
  test('changes nothing, and what it gives is what the arrangement already draws', () => {
    const column = [box('a', 0, 0, 6, 16), box('b', 0, 16, 6, 20)]
    const pull = topEdge(column, 'b', 20)
    expect(pull).toMatchObject({ h: 20, y: 16 })
    expect(pull.given.get('a')).toBe(16)
    const settled = column.map((one) => (pull.given.has(one.i) ? { ...one, wish: pull.given.get(one.i)! } : one))
    expect(redrawn(settled)).toEqual(settled)
  })

  test('after a pull the stored arrangement is the one the wishes draw, so the release writes it once', () => {
    const column = [box('a', 0, 0, 6, 16), box('b', 0, 16, 6, 20)]
    const pull = topEdge(column, 'b', 28)
    const written = [
      { ...column[0]!, h: pull.given.get('a')!, wish: pull.given.get('a')! },
      { ...column[1]!, y: pull.y, h: pull.h, wish: pull.h },
    ]
    expect(redrawn(written)).toEqual(written)
    expect(written.reduce((rows, one) => Math.max(rows, one.y + one.h), 0)).toBe(36)
  })
})

describe('which corner a press landed on', () => {
  test('reads the handle, or a child of it', () => {
    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
      const handle = { closest: (s: string) => (s === '[data-corner]' ? { getAttribute: () => corner } : null) }
      expect(cornerOf(handle as unknown as EventTarget)).toBe(corner)
    }
  })
  test('is nothing for anything else', () => {
    expect(cornerOf(null)).toBeNull()
    expect(cornerOf({ closest: () => null } as unknown as EventTarget)).toBeNull()
    expect(cornerOf({ closest: () => ({ getAttribute: () => 'n' }) } as unknown as EventTarget)).toBeNull()
  })
})

describe('the corner handle', () => {
  test('carries its corner, a class the grid styles, and the props the grid hands it', () => {
    const html = renderToStaticMarkup(<CornerHandle corner="nw" onMouseDown={() => {}} />)
    expect(html).toContain('data-corner="nw"')
    expect(html).toContain('react-resizable-handle-nw')
    expect(html).toContain('corner-handle')
    expect(renderToStaticMarkup(cornerHandle('se', createRef()))).toContain('data-corner="se"')
  })

  test('is a small hit area that stays out from over the header, whose controls sit above it', () => {
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    const handle = css.match(/\.react-grid-item > \.react-resizable-handle\.corner-handle \{([^}]*)\}/)![1]!
    const size = Number(handle.match(/width:\s*(\d+)px/)![1])
    const layer = Number(handle.match(/z-index:\s*(\d+)/)![1])
    expect(size).toBeLessThanOrEqual(12)
    const container = readFileSync(new URL('../src/canvas/Container.tsx', import.meta.url), 'utf8')
    const remove = container.match(/className="([^"]*-mr-1 size-6[^"]*)"/)![1]!
    expect(remove).toContain('relative')
    expect(Number(remove.match(/\bz-(\d+)\b/)![1])).toBeGreaterThan(layer)
    /* The top-right handle covers the right-most twelve pixels of the header;
       the remove button's box begins six pixels in (header padding of ten, less
       the -mr-1), so what is left to the handle is a corner the button is
       lifted above. Nothing else in the header reaches the edge. */
    expect(container).toContain('container-grip bg-card pointer-events-auto flex h-8 shrink-0 cursor-move items-center gap-2 border-b px-2.5')
  })

  test('is not drawn: the old grip is gone and the arc is tinted from the theme', () => {
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    expect(css).not.toContain('border-right-color: var(--muted-foreground)')
    expect(css).toContain('border-top-left-radius: var(--radius)')
    expect(css).toContain('color-mix(in oklab, var(--foreground)')
    expect(css).toContain('cursor: nwse-resize')
    expect(css).toContain('cursor: nesw-resize')
  })
})
