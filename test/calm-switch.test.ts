import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'

import type { Framing } from '@/canvas/Frames.tsx'
import { arranged, type Wished } from '@/host/columns.ts'
import { CANVAS_ROWS } from '@/host/fit.ts'
import {
  ask,
  due,
  foldsOnlyChanged,
  held,
  interactive,
  layoutOf,
  looks,
  pagesHeld,
  seenAt,
  shown,
  slow,
  STILL,
  step,
  stillCopy,
  TIMING,
  timingFor,
  type Switch,
} from '@/host/switching.ts'

/**
 * Switching kehikko or project without the fidget. See `host/switching.ts` for
 * what moved before and why; `dev/calm-switch.drive.mjs` measures it in a
 * browser, frame by frame. What is held here is the rule: when the incoming
 * kehikko is shown, what each layer looks like on the way, which pages are
 * held where they were, what layout the grid is handed, and that the grid
 * animates nothing a person did not do.
 */

/** Frames at a steady 16 ms from `from`, each reading `layout`. */
function frames(state: Switch, from: number, layouts: Array<string | null>, timing = TIMING): { state: Switch; at: number; phases: string[] } {
  let at = from
  const phases: string[] = []
  for (const layout of layouts) {
    at += 16
    state = step(state, at, layout, timing)
    phases.push(state.phase)
  }
  return { state, at, phases }
}

describe('the switch, phase by phase', () => {
  test('preparing → settled after two still frames → leaving → arriving → shown', () => {
    let state = ask(shown(0), 0, true)
    expect(state.phase).toBe('preparing')
    expect(interactive(state.phase)).toBe(false)
    expect(pagesHeld(state.phase)).toBe(true)

    /* Drawn at one layout, corrected once, then still for two frames. */
    const run = frames(state, 0, ['a', 'b', 'b', 'b'])
    expect(run.phases).toEqual(['preparing', 'preparing', 'preparing', 'leaving'])
    state = run.state
    expect(pagesHeld(state.phase)).toBe(true)
    expect(interactive(state.phase)).toBe(false)

    /* The fades run on time, whatever is read. */
    state = step(state, run.at + TIMING.leaveMs - 1, 'b')
    expect(state.phase).toBe('leaving')
    state = step(state, run.at + TIMING.leaveMs, 'b')
    expect(state.phase).toBe('arriving')
    expect(pagesHeld(state.phase)).toBe(false)
    expect(interactive(state.phase)).toBe(true)
    state = step(state, state.since + TIMING.arriveMs, 'b')
    expect(state.phase).toBe('shown')
    expect(step(state, state.since + 10_000, 'x')).toBe(state)
  })

  test('a layout that keeps moving is shown at the cap, counted from when it was first drawn', () => {
    let state = ask(shown(0), 0, true)
    /* Not drawn yet for half a second: nothing settles and the cap has not started. */
    const waiting = frames(state, 0, Array.from({ length: 30 }, () => null))
    expect(waiting.state.phase).toBe('preparing')
    expect(waiting.state.drawn).toBeNull()
    state = waiting.state
    /* Then a layout that never stops changing. */
    let at = waiting.at
    let drawnAt: number | null = null
    for (let i = 0; state.phase === 'preparing' && i < 100; i += 1) {
      at += 16
      state = step(state, at, `moving-${i}`)
      drawnAt ??= state.drawn
    }
    expect(state.phase).toBe('leaving')
    expect(at - drawnAt!).toBeGreaterThanOrEqual(TIMING.capMs)
    expect(at - drawnAt!).toBeLessThan(TIMING.capMs + 16)
  })

  test('with nothing on screen to leave, there is no fading out: preparing → arriving → shown', () => {
    const run = frames(ask(shown(0), 0, false), 0, ['a', 'a', 'a'])
    expect(run.phases).toEqual(['preparing', 'preparing', 'arriving'])
    const look = looks(run.state)
    expect(look.pages.opacity).toBe(1)
    /* And while preparing, no page appears in a box that is not there yet. */
    expect(looks(ask(shown(0), 0, false)).pages.opacity).toBe(0)
  })

  test('a second press while preparing waits for the newest, and keeps what is on screen', () => {
    let state = ask(shown(0), 0, true)
    state = frames(state, 0, ['a']).state
    expect(state.drawn).not.toBeNull()
    const again = ask(state, 40, false)
    expect(again.phase).toBe('preparing')
    expect(again.asked).toBe(0)
    expect(again.drawn).toBeNull()
    expect(again.outgoing).toBe(true)
  })

  test('a press mid-fade starts a new switch', () => {
    const fading: Switch = { ...ask(shown(0), 0, true), phase: 'arriving', since: 100 }
    const again = ask(fading, 150, true)
    expect(again.phase).toBe('preparing')
    expect(again.asked).toBe(150)
  })

  test('a hidden tab paints no frames, and the switch still ends: `due` says when to look again', () => {
    let state = ask(shown(0), 0, true)
    expect(due(state, 0)).toBeNull()
    state = step(state, 10, 'a')
    expect(due(state, 10)).toBe(TIMING.capMs)
    /* One late look, with no frames between, is past the cap. */
    state = step(state, 10 + TIMING.capMs, 'a')
    expect(state.phase).toBe('leaving')
    expect(due(state, state.since)).toBe(TIMING.leaveMs)
  })

  test('the quiet word only after 400 ms without being shown, never for a quick switch', () => {
    const state = ask(shown(0), 0, true)
    expect(TIMING.slowMs).toBe(400)
    expect(slow(state, 150)).toBe(false)
    expect(slow(state, 399)).toBe(false)
    expect(slow(state, 400)).toBe(true)
    expect(slow({ ...state, phase: 'leaving' }, 900)).toBe(false)
  })
})

describe('what each layer looks like', () => {
  test('preparing: the incoming kehikko is invisible, the outgoing one and its pages are fully there', () => {
    const look = looks(ask(shown(0), 0, true))
    expect(look.incoming).toEqual({ opacity: 0, ms: 0 })
    expect(look.outgoing).toEqual({ opacity: 1, ms: 0 })
    expect(look.pages).toEqual({ opacity: 1, ms: 0 })
  })

  test('the chrome crosses in one movement of 150–200 ms; the pages fade through, gone before they move', () => {
    const leaving: Switch = { ...ask(shown(0), 0, true), phase: 'leaving', since: 0 }
    const look = looks(leaving)
    const cross = TIMING.leaveMs + TIMING.arriveMs
    expect(cross).toBeGreaterThanOrEqual(150)
    expect(cross).toBeLessThanOrEqual(200)
    expect(look.incoming).toMatchObject({ opacity: 1, ms: cross })
    expect(look.outgoing).toMatchObject({ opacity: 0, ms: cross })
    expect(look.pages.opacity).toBe(0)
    /* Their fade ends before the phase that moves them begins. */
    expect(look.pages.ms).toBeLessThan(TIMING.leaveMs)
    const arriving = looks({ ...leaving, phase: 'arriving' })
    expect(arriving.pages).toMatchObject({ opacity: 1, ms: TIMING.arriveMs })
    expect(looks({ ...leaving, phase: 'shown' })).toEqual({
      incoming: { opacity: 1, ms: 0 },
      outgoing: { opacity: 0, ms: 0 },
      pages: { opacity: 1, ms: 0 },
    })
  })

  test('reduced motion: the same waiting, then an instant swap', () => {
    expect(timingFor(true)).toBe(STILL)
    expect(timingFor(false)).toBe(TIMING)
    expect(STILL.capMs).toBe(TIMING.capMs)
    expect(STILL.settledFrames).toBe(TIMING.settledFrames)
    const run = frames(ask(shown(0), 0, true), 0, ['a', 'a', 'a'], STILL)
    /* Not shown before it has settled… */
    expect(run.phases).toEqual(['preparing', 'preparing', 'shown'])
    /* …and nothing fades on the way. */
    for (const phase of ['preparing', 'leaving', 'arriving', 'shown'] as const) {
      const look = looks({ ...run.state, phase }, STILL)
      expect([look.incoming.ms, look.outgoing.ms, look.pages.ms]).toEqual([0, 0, 0])
    }
  })
})

describe('the pages, held where they were seen', () => {
  const framing = (id: string, shown: boolean, rect: Framing['rect']): Framing =>
    ({ module: { id }, shown, rect, away: false, generation: 0, state: null, pinned: false, prompt: null, filters: {} }) as unknown as Framing
  const at = (x: number) => ({ x, y: 0, width: 100, height: 100 })

  test('only the pages that were shown are remembered', () => {
    const seen = seenAt([framing('a', true, at(0)), framing('b', false, at(10)), framing('c', true, null)])
    expect([...seen.keys()]).toEqual(['a'])
  })

  test('a page that was seen stays put and visible; every other waits hidden at its NEW place', () => {
    const seen = new Map([['a', at(0)]])
    const live = [framing('a', true, at(500)), framing('b', true, at(600)), framing('c', false, at(700))]
    const drawn = held(live, seen)
    expect(drawn.map((one) => [one.module.id, one.rect?.x, one.shown])).toEqual([
      ['a', 0, true],
      ['b', 600, false],
      ['c', 700, false],
    ])
    /* Not held: the pages as they are. */
    expect(held(live, null)).toBe(live)
  })
})

describe('the layout the grid is handed', () => {
  const box = (i: string, x: number, y: number, w: number, h: number, wish: number, collapsed = false): Wished =>
    ({ i, x, y, w, h, wish, collapsed }) as Wished

  test('is the one it settles on: heights from the STORED wishes, tops compacted', () => {
    /* Stored with stale heights and a gap: the module asked for more since, and
       a container above was removed. */
    const stored = [box('top', 0, 0, 6, 4, 10), box('under', 0, 9, 6, 4, 8), box('beside', 6, 3, 6, 5, 5)]
    const drawn = arranged(stored)
    const by = new Map(drawn.map((one) => [one.i, one]))
    expect(by.get('top')).toMatchObject({ y: 0, h: 10 })
    expect(by.get('under')).toMatchObject({ y: 10, h: 8 })
    expect(by.get('beside')).toMatchObject({ y: 0, h: 5 })
    /* Asking again changes nothing: it is the settled arrangement. */
    const again = arranged(drawn)
    again.forEach((one, index) => expect(one).toBe(drawn[index]!))
  })

  test('a column that cannot pay every wish is drawn within the canvas, and a fold is one row', () => {
    const stored = [box('a', 0, 0, 12, 4, CANVAS_ROWS), box('b', 0, 4, 12, 4, CANVAS_ROWS), box('c', 0, 8, 12, 9, 9, true)]
    const drawn = arranged(stored)
    const bottom = Math.max(...drawn.map((one) => one.y + one.h))
    expect(bottom).toBeLessThanOrEqual(CANVAS_ROWS)
    expect(drawn.find((one) => one.i === 'c')?.h).toBe(1)
  })

  test('an arrangement already settled comes back as the same objects', () => {
    const settled = [box('a', 0, 0, 6, 10, 10), box('b', 6, 0, 6, 12, 12)]
    arranged(settled).forEach((one, index) => expect(one).toBe(settled[index]!))
  })
})

describe('what the grid animates', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  test('nothing, unless the host says it is in motion', () => {
    expect(css).toMatch(/\.react-grid-layout:not\(\.in-motion\) \.react-grid-item \{\s*transition: none;/)
    /* The old fixed window is gone: it hid 250 ms and animated everything after. */
    expect(css).not.toContain('.settling')
  })

  test('in motion only for a drag or resize in hand, a glide after it, and a fold', () => {
    expect(app).toContain("className={moving !== null || gliding ? 'min-h-full in-motion' : 'min-h-full'}")
    /* A switch never sets either: `moving` is the hand's, `gliding` a release's or a fold's. */
    const gliding = [...app.matchAll(/setGliding\(\(n\) => n \+ 1\)/g)].length
    expect(gliding).toBe(3)
  })

  test('the grid is told its width, so it is never born at the 1280 pixels it would guess', () => {
    expect(app).not.toContain('WidthProvider')
    expect(app).toContain('width={width}')
    expect(app).toContain('{width === null ? null : (')
  })

  test('only a fold or an unfold counts as one', () => {
    const a = { i: 'a', collapsed: false }
    const b = { i: 'b', collapsed: false }
    expect(foldsOnlyChanged([a, b], [{ ...a, collapsed: true }, b])).toBe(true)
    expect(foldsOnlyChanged([a, b], [a, b])).toBe(false)
    /* Another kehikko's containers, or one added: not a fold. */
    expect(foldsOnlyChanged([a], [{ i: 'c', collapsed: true }])).toBe(false)
    expect(foldsOnlyChanged([a], [a, { i: 'c', collapsed: true }])).toBe(false)
  })
})

describe('the still copy of the kehikko being left', () => {
  test('is a picture: inert, hidden from readers, and found by nothing that finds containers', () => {
    const window = new Window()
    const document = window.document
    document.body.innerHTML = `
      <div class="react-grid-layout in-motion" id="grid">
        <div class="react-grid-item" style="transform: translate(8px, 40px)">
          <div data-module="kehikot.alpha" data-tour="fold">
            <header class="container-grip"><button id="radix-1" data-tour="frame">menu</button></header>
            <div data-body="kehikot.alpha" data-activity-flash=""></div>
          </div>
        </div>
      </div>`
    const grid = document.getElementById('grid')!
    const copy = stillCopy(grid as unknown as Element)
    expect(copy.hasAttribute('data-outgoing')).toBe(true)
    expect(copy.getAttribute('aria-hidden')).toBe('true')
    expect(copy.hasAttribute('inert')).toBe(true)
    expect(copy.classList.contains('in-motion')).toBe(false)
    for (const attribute of ['id', 'data-module', 'data-body', 'data-tour', 'data-activity-flash']) {
      expect(copy.querySelector(`[${attribute}]`)).toBeNull()
      expect(copy.hasAttribute(attribute)).toBe(false)
    }
    /* Still drawn where it was. */
    expect((copy.querySelector('.react-grid-item') as HTMLElement).getAttribute('style')).toContain('translate(8px, 40px)')
    /* And the real one is untouched. */
    expect(grid.querySelector('[data-module="kehikot.alpha"]')).not.toBeNull()
    void window.happyDOM.close()
  })

  test('the layout read is the bodies, or nothing to read', () => {
    expect(layoutOf(null)).toBeNull()
    const window = new Window()
    window.document.body.innerHTML = '<div id="in"><div data-body="a"></div><div data-body="b"></div></div>'
    expect(layoutOf(window.document.getElementById('in') as unknown as ParentNode)).toBe('a:0,0,0,0 b:0,0,0,0')
    void window.happyDOM.close()
  })
})
