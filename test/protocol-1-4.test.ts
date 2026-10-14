import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LIMITS, METHOD_NAMES, MESSAGE, PROTOCOL, helloSchema, navigationResult } from 'kehikot-module-protocol'

import { makeAsk, type CanvasControls } from '../src/host/ask.ts'
import { answeredFor } from '../src/host/division.ts'
import { Conversation } from '../src/host/conversation.ts'
import { toWireContext } from '../src/host/context.ts'
import { enterFullscreen, leaveFullscreen, whenLeft } from '../src/host/surface.ts'
import { Presses } from '../src/host/presses.ts'

/**
 * Protocol 1.4.0, the host's half: the greeting's `answers` and `header`,
 * `view.goto` with `parts` and `kehikko`, and full screen for a run. "Has
 * spoken" (`partsHeld`) is in `parts-of-the-epic.test.ts`, beside the
 * fallback it changes.
 */

const everyCapability = Object.values(
  (await import('kehikot-module-protocol')).METHODS as Record<string, string>,
)

describe('answers: what this host will answer for THIS module', () => {
  test('nothing declared, nothing answered', () => {
    expect(answeredFor([])).toEqual([])
  })

  test('held to declares.uses, method by method', () => {
    expect(answeredFor(['epics:read'])).toEqual(['epics.list', 'epic.get'])
    expect(answeredFor(['view:navigate', 'parts:set'])).toEqual(['view.goto', 'parts.set'])
    expect(answeredFor(['no:such:capability'])).toEqual([])
  })

  test('what it always refuses is left out even when declared, and every other method is in', () => {
    const all = answeredFor(everyCapability)
    expect(all).not.toContain('stage.report')
    expect(all).toContain('parts.set')
    expect(all).toContain('view.goto')
    expect(all.length).toBe(METHOD_NAMES.length - 1)
    expect(all.length).toBeLessThanOrEqual(LIMITS.ANSWERS)
  })
})

describe('the greeting', () => {
  const sentBy = (greet: (c: Conversation) => void) => {
    const sent: Record<string, unknown>[] = []
    const contentWindow = { postMessage: (m: unknown) => void sent.push(m as Record<string, unknown>) } as unknown as Window
    const quiet = { ready() {}, silent() {}, fault() {}, height() {}, filters() {}, clearable() {}, refreshable() {}, header() {} }
    const c = new Conversation({ contentWindow }, 'example.notes', null, async () => ({ ok: true, data: null }), quiet, { session: 's' })
    greet(c)
    c.close()
    return sent[0]!
  }
  const context = toWireContext({ epic: null, project: null }, 'dark')

  test('carries answers and header: true', () => {
    const hello = sentBy((c) => c.greet(context, null, ['epics.list', 'view.goto']))
    expect(hello.type).toBe(MESSAGE.HELLO)
    expect(hello.answers).toEqual(['epics.list', 'view.goto'])
    expect(hello.header).toBe(true)
    expect(helloSchema.parse(hello)).toMatchObject({ protocol: PROTOCOL, answers: ['epics.list', 'view.goto'], header: true })
  })

  test('a module whose manifest was not read gets no answers, not a wrong list', () => {
    const hello = sentBy((c) => c.greet(context, null, null))
    expect('answers' in hello).toBe(false)
    expect(hello.header).toBe(true)
    expect(helloSchema.parse(hello).answers).toBeUndefined()
  })

  test('an empty list is "answers nothing", which is a fact', () => {
    const hello = sentBy((c) => c.greet(context, null, answeredFor([])))
    expect(hello.answers).toEqual([])
  })

  describe('a module built on 1.3.0', () => {
    let old: Record<string, any> | null = null
    const dirs: string[] = []
    beforeAll(async () => {
      try {
        const repo = '/Users/jaakkorajala/Projects/kehikko-protocol'
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikot-host14-')))
        dirs.push(dir)
        mkdirSync(dir, { recursive: true })
        execFileSync('sh', ['-c', `git -C "${repo}" archive v1.3.0 | tar -x -C "${dir}"`], { stdio: 'ignore' })
        symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'))
        old = await import(join(dir, 'src/index.ts'))
      } catch (error) {
        console.warn("v1.3.0 is not available here: the 1.3.0 checks are skipped", String(error))
      }
    }, 60_000)
    afterAll(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    }, 30_000)

    test('parses the greeting, and strips the two new fields', () => {
      if (!old) return
      const hello = sentBy((c) => c.greet(context, 'kept', answeredFor(['view:navigate'])))
      const read = old.helloSchema.safeParse(hello)
      expect(read.success).toBe(true)
      expect(read.data.state).toBe('kept')
      expect(read.data.answers).toBeUndefined()
      expect(read.data.header).toBeUndefined()
      expect(read.data.context.epic).toBe(null)
    })

    test('and view.goto with parts and kehikko is read, and the extras stripped', () => {
      if (!old) return
      const read = old.methodParams['view.goto'].safeParse({ epic: 'thesis', parts: ['a'], kehikko: 'k' })
      expect(read.success).toBe(true)
      expect(read.data).toEqual({ epic: 'thesis' })
    })
  })
})

describe('view.goto with parts and kehikko', () => {
  const seen: unknown[] = []
  const canvas = (out: ReturnType<CanvasControls['goto']>): CanvasControls =>
    ({
      showEpic: (epic: string) => void seen.push({ showEpic: epic }),
      goto: (call) => (seen.push({ goto: call }), out),
      select() {},
      point() {},
      show() {},
      emit: () => ({ ok: true, delivered: 0 }),
      filter: () => ({ ok: true, filters: {} }),
      pickProject: async () => ({ outcome: 'cancelled', project: null, why: '' }),
      fold: () => ({ outcome: 'unchanged', folded: [], unfolded: [], why: '' }),
      project: () => null,
    }) as CanvasControls
  const ask = (out: ReturnType<CanvasControls['goto']>, params: unknown, uses = ['view:navigate']) =>
    makeAsk('example.notes', canvas(out), (capability) => uses.includes(capability))('view.goto', params)

  test('an epic alone is what it was: the epic is made the subject', async () => {
    seen.length = 0
    const out = await ask({ outcome: 'declined', epic: null, why: '' }, { epic: 'thesis' })
    expect(seen).toEqual([{ showEpic: 'thesis' }])
    expect(out).toEqual({ ok: true, data: { outcome: 'moved', epic: 'thesis', why: '' } })
  })

  test('parts and kehikko go to the canvas with the epic, and its outcome is the answer', async () => {
    seen.length = 0
    const out = await ask({ outcome: 'moved', epic: 'thesis', why: '' }, { epic: 'thesis', parts: ['methods'], kehikko: 'writing' })
    expect(seen).toEqual([{ goto: { epic: 'thesis', parts: ['methods'], kehikko: 'writing' } }])
    expect(out).toEqual({ ok: true, data: { outcome: 'moved', epic: 'thesis', why: '' } })
  })

  test('an unknown epic, part or kehikko is no-such-target, in the protocol’s shape', async () => {
    const out = await ask({ outcome: 'no-such-target', epic: null, why: 'thesis has no part nope.' }, { epic: 'thesis', parts: ['nope'] })
    expect(out.ok).toBe(true)
    if (out.ok) expect(navigationResult.parse(out.data).outcome).toBe('no-such-target')
  })

  test('parts or kehikko without an epic is refused, and moves nothing', async () => {
    seen.length = 0
    for (const params of [{ parts: ['a'] }, { kehikko: 'k' }]) {
      const out = await ask({ outcome: 'moved', epic: 'x', why: '' }, params)
      expect(out.ok).toBe(false)
    }
    expect(seen).toEqual([])
  })

  test('the grant stays view:navigate', async () => {
    seen.length = 0
    const out = await ask({ outcome: 'moved', epic: 'thesis', why: '' }, { epic: 'thesis', parts: ['a'] }, [])
    expect(seen).toEqual([])
    expect(out.ok && navigationResult.parse(out.data).outcome).toBe('declined')
  })
})

describe('full screen: the frame element, from the click', () => {
  const doc = (over: Record<string, unknown> = {}) => {
    const listeners = new Map<string, Set<() => void>>()
    const d: Record<string, unknown> = {
      fullscreenEnabled: true,
      fullscreenElement: null,
      addEventListener: (name: string, fn: () => void) => void (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(fn),
      removeEventListener: (name: string, fn: () => void) => void listeners.get(name)?.delete(fn),
      exitFullscreen: async () => {
        d.fullscreenElement = null
      },
      fire: () => listeners.get('fullscreenchange')?.forEach((fn) => fn()),
      listeners,
      ...over,
    }
    return d as unknown as Document & { fire(): void; listeners: Map<string, Set<() => void>> }
  }

  test('the request is made before enterFullscreen returns', async () => {
    let asked = false
    const frame = { requestFullscreen: () => ((asked = true), Promise.resolve()) } as unknown as HTMLElement
    const promise = enterFullscreen(frame, doc())
    expect(asked).toBe(true)
    expect(await promise).toBe(true)
  })

  test('a refused request, a missing API and a throw all answer false', async () => {
    expect(await enterFullscreen({ requestFullscreen: () => Promise.reject(new Error('no')) } as unknown as HTMLElement, doc())).toBe(false)
    expect(await enterFullscreen({} as HTMLElement, doc())).toBe(false)
    expect(
      await enterFullscreen({ requestFullscreen: () => { throw new Error('x') } } as unknown as HTMLElement, doc()),
    ).toBe(false)
    expect(await enterFullscreen({ requestFullscreen: () => Promise.resolve() } as unknown as HTMLElement, doc({ fullscreenEnabled: false }))).toBe(false)
  })

  test('leaving only ends this frame’s full screen', () => {
    const frame = {} as HTMLElement
    let exited = 0
    leaveFullscreen(frame, doc({ fullscreenElement: {}, exitFullscreen: async () => void exited++ }))
    expect(exited).toBe(0)
    leaveFullscreen(frame, doc({ fullscreenElement: frame, exitFullscreen: async () => void exited++ }))
    expect(exited).toBe(1)
  })

  test('whenLeft fires once, on the exit and not on the enter', () => {
    const d = doc()
    let n = 0
    whenLeft(() => n++, d)
    ;(d as unknown as { fullscreenElement: unknown }).fullscreenElement = {}
    d.fire()
    expect(n).toBe(0)
    ;(d as unknown as { fullscreenElement: unknown }).fullscreenElement = null
    d.fire()
    d.fire()
    expect(n).toBe(1)
    expect(d.listeners.get('fullscreenchange')!.size).toBe(0)
  })

  test('the registry asks the frame that is standing, and answers false when there is none', async () => {
    const presses = new Presses()
    expect(await presses.fullscreen('gone')).toBe(false)
    let asked = 0
    presses.join('here', {
      clear() {},
      refresh() {},
      walk: async () => ({ found: false, why: '' }),
      item: async () => ({ ok: true, why: '' }),
      focus() {},
      fullscreen: async () => (asked++, true),
    })
    expect(await presses.fullscreen('here')).toBe(true)
    expect(asked).toBe(1)
    presses.leaveFullscreen('gone')
  })
})
