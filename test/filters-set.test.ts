import { describe, expect, test } from 'bun:test'
import type { FilterGroup } from 'roadmap-module-protocol'

import { makeAsk, type CanvasControls } from '../src/host/ask.ts'
import { settle } from '../src/host/filters.ts'

/*
 * A module asking where its own container's filters should go.
 *
 * The method exists because the offer went one way. A module could say what it
 * was narrowable by and never ask for a choice, which cost References two
 * behaviours it refused to lose — answering `view.goto` by clearing whatever
 * hides the target row, and a Clear that clears everything. See `filters.set`
 * in the protocol.
 *
 * What is tested here is the HOST's half: that the sender cannot be named by
 * the caller, that a refusal is a sentence, and that what comes back is what
 * the canvas settled on rather than what was asked for.
 */

const OFFER: FilterGroup[] = [
  { id: 'kind', label: 'Kind', fallback: 'all', options: [{ id: 'all', label: 'All' }, { id: 'issues', label: 'Issues' }] },
  { id: 'state', label: 'State', fallback: 'any', options: [{ id: 'any', label: 'Any' }, { id: 'open', label: 'Open' }] },
]

/** A canvas that records what it was asked and answers as the real one would. */
function canvasThat(reply: (from: string, choice: Record<string, string>) => ReturnType<CanvasControls['filter']>) {
  const asked: { from: string; choice: Record<string, string> }[] = []
  const controls = {
    showEpic: () => {},
    select: () => {},
    point: () => {},
    emit: () => ({ ok: true as const, delivered: 0 }),
    project: () => null,
    filter: (from: string, choice: Record<string, string>) => {
      asked.push({ from, choice })
      return reply(from, choice)
    },
  } as unknown as CanvasControls
  return { controls, asked }
}

/* Through `makeAsk`, which is the door a framed module actually reaches — and
   the reason the sender cannot be named: `makeAsk` closes over the module id
   from the registration this conversation was built on. */
async function ask(controls: CanvasControls, moduleId: string, params: unknown) {
  return makeAsk(moduleId, controls)('filters.set', params as Record<string, unknown>)
}

describe('a module asking for its own filters', () => {
  test('is answered with what the canvas settled on, not with what was asked', async () => {
    /* `settle` drops a group on its resting option — a store that recorded "at
       its default" cannot tell somebody who chose the default from somebody who
       never chose. So asking for `state: any` comes back without it, and a
       module that assumed otherwise would draw one thing and be told another on
       the next context. */
    const { controls } = canvasThat((_from, choice) => ({ ok: true, filters: settle(OFFER, choice) }))
    const out = await ask(controls, 'roadmap.references', { filters: { kind: 'issues', state: 'any' } })
    expect(out.ok).toBe(true)
    expect((out as { data: { filters: Record<string, string> } }).data.filters).toEqual({ kind: 'issues' })
  })

  /*
   * The sender is supplied by the host out of the registration, exactly as it
   * is for `events.emit`, and here it matters more: a module that could name
   * its own target would move ANOTHER container's filters, and a filter is what
   * somebody is looking through.
   */
  test('cannot name a target: the sender is the host’s to supply', async () => {
    const { controls, asked } = canvasThat(() => ({ ok: true, filters: {} }))
    await ask(controls, 'roadmap.references', { filters: { kind: 'issues' }, from: 'roadmap.notes', module: 'roadmap.notes' })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.from).toBe('roadmap.references')
  })

  test('an empty choice is a real request — it is what clearing the narrowing is', async () => {
    const { controls, asked } = canvasThat(() => ({ ok: true, filters: {} }))
    const out = await ask(controls, 'roadmap.references', { filters: {} })
    expect(out.ok).toBe(true)
    expect(asked[0]?.choice).toEqual({})
  })

  test('a refusal arrives as the canvas’s own sentence', async () => {
    /* Pinned, not on the open kehikko, offering nothing: three grounds, each
       with a sentence a module's author can act on. A number could not be. */
    const { controls } = canvasThat(() => ({ ok: false, error: 'roadmap.references is pinned, so it would not be told.' }))
    const out = await ask(controls, 'roadmap.references', { filters: { kind: 'issues' } })
    expect(out.ok).toBe(false)
    expect(JSON.stringify(out)).toContain('pinned')
  })

  test('a malformed ask is refused before the canvas is troubled', async () => {
    const { controls, asked } = canvasThat(() => ({ ok: true, filters: {} }))
    for (const params of [{}, { filters: 'everything' }, { filters: { kind: 5 } }]) {
      expect((await ask(controls, 'roadmap.references', params)).ok).toBe(false)
    }
    expect(asked).toHaveLength(0)
  })
})
