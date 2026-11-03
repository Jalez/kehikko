import { describe, expect, test } from 'bun:test'

import { blurWentToFrame, focusIsInFrame } from '../src/lib/menus.ts'

/*
 * The two facts `useCloseOnFrameBlur` turns into a close: which element holds
 * the keyboard, and which `blur` is the window's own. Pure, so no DOM needed.
 */

const el = (tag: string) => ({ tagName: tag }) as unknown as Element
const doc = (active: Element | null, view: object | null = {}) => ({ activeElement: active, defaultView: view }) as unknown as Document
const event = (target: unknown) => ({ target }) as unknown as Event

describe('focusIsInFrame', () => {
  test('the frame holding a module page is the active element', () => {
    expect(focusIsInFrame(doc(el('IFRAME')))).toBe(true)
  })

  test('anything else is not: another element, or nothing focused', () => {
    expect(focusIsInFrame(doc(el('BODY')))).toBe(false)
    expect(focusIsInFrame(doc(el('BUTTON')))).toBe(false)
    expect(focusIsInFrame(doc(null))).toBe(false)
  })
})

describe('blurWentToFrame', () => {
  test('the window losing focus to a frame', () => {
    const view = {}
    expect(blurWentToFrame(event(view), doc(el('IFRAME'), view))).toBe(true)
  })

  test('an element blur passing through the capture phase is not the window own', () => {
    const view = {}
    expect(blurWentToFrame(event(el('BUTTON')), doc(el('IFRAME'), view))).toBe(false)
  })

  test('the window deactivated without a frame taking the focus is not a click into a module', () => {
    const view = {}
    expect(blurWentToFrame(event(view), doc(el('BODY'), view))).toBe(false)
    expect(blurWentToFrame(event(view), doc(null, view))).toBe(false)
  })
})
