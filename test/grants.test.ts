import { describe, expect, test } from 'bun:test'
import { foldResult, METHOD_NAMES, METHODS, navigationResult, projectPickResult, trackerRefreshResult } from 'kehikot-module-protocol'

import { answer, answerCall, type Grants } from '../server/answers.ts'
import { makeAsk, type CanvasControls } from '@/host/ask.ts'
import { ANSWERED_BY_THE_SERVER, ANSWERED_BY_THE_VIEW } from '@/host/division.ts'
import { ANSWERED_UNDECLARED, capabilityOf, hold } from '@/host/grants.ts'

/**
 * Every method is held to the capability the protocol files it under: a module
 * whose manifest did not ask (`declares.uses`) is not answered.
 */

const ME = 'example.module'
const known = (id: string) => id === ME
const grantsOf = (uses: string[]): Grants => ({ may: (_module, capability) => uses.includes(capability) })
const ask = (method: string, params: unknown, uses: string[]) =>
  answer(ME, method, params, known, undefined, null, undefined, null, null, null, grantsOf(uses))

/** Params each method accepts, so a refusal below is about the grant and nothing else. */
const PARAMS: Record<string, unknown> = {
  'epics.list': {},
  'epic.get': { epic: 'one' },
  'steps.list': { epic: 'one' },
  'live.get': { epic: 'one' },
  'stage.report': { ref: '#1', stage: 'working' },
  'state.set': { state: 'x' },
  'disposition.set': { ref: '#1', value: 'done' },
  'tracker.get': { project: true },
  'tracker.refresh': { project: true },
  'tracker.columns': {},
  'content.changed': {},
  'parts.set': { epic: 'one', add: { name: 'A part' } },
  'view.goto': { epic: 'one' },
  'view.fold': { fold: [ME] },
  'selection.set': { refs: [] },
  'passage.set': { passage: null },
  'location.set': { location: null },
  'filters.set': { filters: {} },
  'showing.set': { refs: [], documents: [] },
  'projects.pick': {},
  'activity.set': { items: [] },
  'events.emit': { extension: 'kehikot.notifications@1', payload: {} },
}

describe('the rule', () => {
  test('every method the protocol names has a capability, and params here to ask with', () => {
    for (const method of METHOD_NAMES) {
      expect(capabilityOf(method)).toBe(METHODS[method])
      expect(Object.hasOwn(PARAMS, method)).toBe(true)
    }
  })

  test('a name the protocol does not have is held to nothing, and neither is one off a prototype', () => {
    expect(capabilityOf('constructor')).toBeNull()
    expect(hold('constructor', () => false)).toEqual({ held: false })
  })

  test('held without the capability, answered with it', () => {
    expect(hold('state.set', () => true)).toEqual({ held: false })
    const held = hold('state.set', () => false)
    expect(held.held).toBe(true)
    if (held.held) expect(held.why).toContain('state:keep')
  })

  test('no method is answered undeclared today', () => {
    expect([...ANSWERED_UNDECLARED]).toEqual([])
  })
})

describe('the server holds every method it answers', () => {
  for (const method of ANSWERED_BY_THE_SERVER) {
    test(`${method} is not answered for a manifest that did not ask`, async () => {
      const capability = METHODS[method]
      const out = await answerCall(ME, method, PARAMS[method], known, () => {
        throw new Error('kept state for a module that may not keep any')
      }, null, () => {
        throw new Error('marked for a module that may not mark')
      }, null, () => {
        throw new Error('announced for a module that may not report')
      }, { may: () => false, edit: () => { throw new Error('edited') } }, grantsOf([]))
      if (method === 'parts.set' || method === 'tracker.refresh') {
        /* The protocol gives these an outcome for "the host will not". */
        expect(out.ok).toBe(true)
        if (out.ok) {
          const said = out.data as { outcome: string; why: string }
          expect(said.outcome).toBe('declined')
          expect(said.why).toContain(capability)
        }
        if (out.ok && method === 'tracker.refresh') expect(trackerRefreshResult.safeParse(out.data).success).toBe(true)
        return
      }
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.reason).toBe('failed')
        expect(out.error).toContain(capability)
        expect(out.error).toContain('declares.uses')
      }
    })

    test(`${method} gets past the grant for a manifest that asked`, () => {
      if (method === 'parts.set') return
      const out = ask(method, PARAMS[method], [METHODS[method]])
      if (!out.ok) expect(out.error).not.toContain('declares.uses')
    })
  }

  test('another capability is not this one', () => {
    expect(ask('state.set', { state: 'x' }, ['epics:read']).ok).toBe(false)
    expect(ask('state.set', { state: 'x' }, ['state:keep'])).toEqual({ ok: true, data: { kept: true } })
    expect(ask('epics.list', {}, ['epics:read'])).toEqual({ ok: true, data: { epics: [] } })
  })

  test('what was not asked for is refused before its params are read', () => {
    const out = ask('state.set', { state: 7 }, [])
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('state:keep')
  })

  test('with nobody to ask about manifests, nothing is held', () => {
    expect(answer(ME, 'state.set', { state: 'x' }, known)).toEqual({ ok: true, data: { kept: true } })
  })
})

describe('the canvas holds every method it answers', () => {
  const calls: string[] = []
  const canvas: CanvasControls = {
    showEpic: () => void calls.push('showEpic'),
    goto: () => ({ outcome: 'declined', epic: null, why: '' }),
    select: () => void calls.push('select'),
    point: () => void calls.push('point'),
    locate: () => (calls.push('locate'), { outcome: 'taken' as const, why: '' }),
    show: () => void calls.push('show'),
    emit: () => (calls.push('emit'), { ok: true, delivered: 0 }),
    filter: () => (calls.push('filter'), { ok: true, filters: {} }),
    pickProject: async () => (calls.push('pick'), { outcome: 'cancelled', project: null, why: '' }),
    fold: () => (calls.push('fold'), { outcome: 'unchanged', folded: [], unfolded: [], why: '' }),
    activity: () => (calls.push('activity'), { outcome: 'taken', taken: 0, why: '' }),
    project: () => null,
  }

  for (const method of ANSWERED_BY_THE_VIEW) {
    test(`${method} moves nothing for a manifest that did not ask`, async () => {
      calls.length = 0
      const out = await makeAsk(ME, canvas, () => false)(method, PARAMS[method])
      expect(calls).toEqual([])
      const shapes = { 'view.goto': navigationResult, 'view.fold': foldResult, 'projects.pick': projectPickResult }
      if (Object.hasOwn(shapes, method)) {
        expect(out.ok).toBe(true)
        if (!out.ok) return
        const read = shapes[method as keyof typeof shapes].parse(out.data)
        expect(read.outcome).toBe('declined')
        expect(read.why).toContain(METHODS[method])
        return
      }
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error).toContain(METHODS[method])
    })

    test(`${method} reaches the canvas for a manifest that asked`, async () => {
      calls.length = 0
      await makeAsk(ME, canvas, (capability) => capability === METHODS[method])(method, PARAMS[method])
      expect(calls.length).toBe(1)
    })
  }

  test('with no manifest to read, nothing is held', async () => {
    calls.length = 0
    const out = await makeAsk(ME, canvas)('selection.set', { refs: [] })
    expect(out.ok).toBe(true)
    expect(calls).toEqual(['select'])
  })
})
