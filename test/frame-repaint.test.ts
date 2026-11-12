import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { hiddenFrame } from '@/canvas/Frames.tsx'
import { nudgeRepaint, REPAINT_OPACITY } from '@/canvas/repaint.ts'

describe('a page under a loading cover or hidden', () => {
  test('is not focusable or clickable', () => {
    expect(hiddenFrame(false)).toEqual({ inert: true, 'aria-hidden': true })
    expect(hiddenFrame(true)).toEqual({})
    const src = readFileSync('src/canvas/Frames.tsx', 'utf8')
    expect(src).toContain("pointerEvents: seen && moving === null && !still ? 'auto' : 'none'")
    expect(src).toContain('{...hiddenFrame(seen && !still)}')
  })
})

describe('uncovering a page', () => {
  test('nudges opacity for two frames, then puts it back', () => {
    const el = { style: { opacity: '' } as CSSStyleDeclaration }
    const queue: Array<() => void> = []
    nudgeRepaint(el, (run) => queue.push(run))
    expect(el.style.opacity).toBe(REPAINT_OPACITY)
    queue.shift()!()
    expect(el.style.opacity).toBe(REPAINT_OPACITY)
    queue.shift()!()
    expect(el.style.opacity).toBe('')
  })

  test('changes no box: only opacity is touched', () => {
    const touched: string[] = []
    const style = new Proxy({} as Record<string, string>, { set: (t, k: string, v) => { touched.push(k); t[k] = v; return true } })
    nudgeRepaint({ style: style as unknown as CSSStyleDeclaration }, () => undefined)
    expect(touched).toEqual(['opacity'])
  })

  test('every un-hide goes through the one wrapper', () => {
    const src = readFileSync('src/canvas/Frames.tsx', 'utf8')
    expect(src).toContain('useRepaintOnUncover(ref, seen)')
    expect(src).toContain('<FrameBox')
  })
})
