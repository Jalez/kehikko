import { describe, expect, test } from 'bun:test'

import { planGo, type Here, type Target } from '../src/host/goToPlace.ts'

/** Pressing an Inbox item goes to where it happened, as far as there is anywhere to go. */

const DESIGN = { key: 'k-design', name: 'Design', modules: ['kehikot.claude', 'kehikot.paper'] }
const REVIEWS = { key: 'k-reviews', name: 'Reviews', modules: ['kehikot.checklist'] }
const target = (more: Partial<Target> = {}): Target => ({ project: 3, kehikot: [DESIGN, REVIEWS], epics: ['kiosk', 'tables'], ...more })
const here = (more: Partial<Here> = {}): Here => ({ project: 3, epic: 'kiosk', parts: [], kehikko: 'k-design', ...more })
const claude = (place?: { epic?: string; parts?: string[]; kehikko?: string }) => ({
  module: 'kehikot.claude',
  name: 'Claude',
  ...(place ? { place } : {}),
})

describe('planGo', () => {
  test('same kehikko and epic: only the container is lit', () => {
    expect(planGo(claude({ epic: 'kiosk', kehikko: 'k-design' }), here(), target())).toEqual({
      steps: [{ kind: 'highlight', module: 'kehikot.claude' }],
      note: null,
    })
  })

  test('another epic: the epic is switched, then the container lit', () => {
    expect(planGo(claude({ epic: 'tables', kehikko: 'k-design' }), here(), target()).steps).toEqual([
      { kind: 'epic', epic: 'tables', parts: [] },
      { kind: 'highlight', module: 'kehikot.claude' },
    ])
  })

  test('the same epic with other parts picked: the parts are set to the place\'s', () => {
    expect(planGo(claude({ epic: 'kiosk', parts: ['p1'], kehikko: 'k-design' }), here(), target()).steps[0]).toEqual({
      kind: 'epic',
      epic: 'kiosk',
      parts: ['p1'],
    })
    expect(planGo(claude({ epic: 'kiosk', kehikko: 'k-design' }), here({ parts: ['p1'] }), target()).steps[0]).toEqual({
      kind: 'epic',
      epic: 'kiosk',
      parts: [],
    })
  })

  test('another kehikko: that kehikko is opened by its key, and the container lit there', () => {
    const plan = planGo(claude({ epic: 'kiosk', kehikko: 'k-design' }), here({ kehikko: 'k-reviews' }), target())
    expect(plan).toEqual({
      steps: [
        { kind: 'kehikko', key: 'k-design' },
        { kind: 'highlight', module: 'kehikot.claude' },
      ],
      note: null,
    })
  })

  test('another project: the project first, then every step there', () => {
    const plan = planGo(claude({ epic: 'tables', kehikko: 'k-design' }), here({ project: 5 }), target({ epics: null }))
    expect(plan.steps).toEqual([
      { kind: 'project', project: 3 },
      { kind: 'kehikko', key: 'k-design' },
      { kind: 'epic', epic: 'tables', parts: [] },
      { kind: 'highlight', module: 'kehikot.claude' },
    ])
  })

  test('a kehikko that is gone: as far as the epic, nothing lit, and it is said', () => {
    const plan = planGo(claude({ epic: 'tables', kehikko: 'k-gone' }), here(), target())
    expect(plan.steps).toEqual([{ kind: 'epic', epic: 'tables', parts: [] }])
    expect(plan.note).toContain('gone')
  })

  test('a module no longer on its kehikko: that kehikko and epic, nothing lit elsewhere, and it is said', () => {
    const plan = planGo(claude({ epic: 'tables', kehikko: 'k-reviews' }), here(), target())
    expect(plan.steps).toEqual([
      { kind: 'kehikko', key: 'k-reviews' },
      { kind: 'epic', epic: 'tables', parts: [] },
    ])
    expect(plan.note).toBe('Claude is not on Reviews any more, so nothing is lit.')
  })

  test('an epic the project no longer has is not gone to, and it is said', () => {
    const plan = planGo(claude({ epic: 'old', kehikko: 'k-design' }), here(), target())
    expect(plan.steps).toEqual([{ kind: 'highlight', module: 'kehikot.claude' }])
    expect(plan.note).toContain('no epic old')
  })

  test('a place of an epic alone: the epic, and the module where it is', () => {
    const paper = { module: 'kehikot.checklist', name: 'Checklist', place: { epic: 'tables' } }
    expect(planGo(paper, here(), target()).steps).toEqual([
      { kind: 'kehikko', key: 'k-reviews' },
      { kind: 'epic', epic: 'tables', parts: [] },
      { kind: 'highlight', module: 'kehikot.checklist' },
    ])
  })

  test('no place: the module where it is, as before, with a hint', () => {
    const plan = planGo(claude(), here({ kehikko: 'k-reviews', epic: 'tables' }), target())
    expect(plan.steps).toEqual([
      { kind: 'kehikko', key: 'k-design' },
      { kind: 'highlight', module: 'kehikot.claude' },
    ])
    expect(plan.note).toBe('This notice did not say where it came from, so its module is shown where it is.')
    expect(planGo(claude(), here(), target()).steps).toEqual([{ kind: 'highlight', module: 'kehikot.claude' }])
  })
})
