import { describe, expect, test } from 'bun:test'

import { foldHint, foldNoteIn, noted, reread, signedBy, standing } from '../src/host/folds.ts'
import { Writer } from '../src/host/writer.ts'

/*
 * Who folded a container, when it was not the person — the page's half of
 * `fold_modules`. See `src/host/folds.ts`.
 */

const drawn = (collapsed: Record<string, boolean>) => Object.entries(collapsed).map(([i, c]) => ({ i, collapsed: c }))

describe('a fold somebody else made is signed', () => {
  test('each container the note names is marked with who and the state it was left in', () => {
    const marks = noted({}, { by: 'an agent', fold: ['a.one'], unfold: ['a.two'] })
    expect(marks).toEqual({ 'a.one': { by: 'an agent', collapsed: true }, 'a.two': { by: 'an agent', collapsed: false } })
    expect(signedBy(marks, { i: 'a.one', collapsed: true })).toBe('an agent')
    expect(signedBy(marks, { i: 'a.three', collapsed: true })).toBeNull()
  })

  test('the control says who and what a press does, and says what it always said when nobody else did', () => {
    expect(foldHint(true, 'an agent')).toBe(
      'folded by an agent — the module is still running. Press to put it back at the height it had',
    )
    expect(foldHint(false, 'an agent')).toBe('unfolded by an agent. Press to fold it down to its header again')
    expect(foldHint(true, null)).toBe('folded — the module is still running. Press to put it back at the height it had')
    expect(foldHint(false, null)).toBe('fold it down to this header. The module keeps running and keeps what is in it')
  })
})

describe('a mark goes with what it describes', () => {
  const marks = noted({}, { by: 'an agent', fold: ['a.one', 'a.two'], unfold: [] })

  test('it stands while the container is as it was left, and is the same object', () => {
    expect(standing(marks, drawn({ 'a.one': true, 'a.two': true, 'a.three': false }))).toBe(marks)
  })

  test('the person’s press on the control takes it, and only that container’s', () => {
    expect(standing(marks, drawn({ 'a.one': false, 'a.two': true }))).toEqual({
      'a.two': { by: 'an agent', collapsed: true },
    })
  })

  test('a container taken off takes its mark', () => {
    expect(standing(marks, drawn({ 'a.two': true }))).toEqual({ 'a.two': { by: 'an agent', collapsed: true } })
  })

  test('a mark is not drawn on a state it does not describe, even before it is dropped', () => {
    expect(signedBy(marks, { i: 'a.one', collapsed: false })).toBeNull()
  })

  test('whoever folded putting it back themselves leaves no mark at all', () => {
    expect(noted(marks, { by: 'an agent', fold: [], unfold: ['a.one'] })).toEqual({
      'a.two': { by: 'an agent', collapsed: true },
    })
  })

  test('the same fold said twice is one mark', () => {
    expect(noted(marks, { by: 'an agent', fold: ['a.one'], unfold: [] })).toEqual(marks)
  })
})

describe('a note off the stream is bounded before it is believed', () => {
  test('a whole one is read', () => {
    expect(foldNoteIn({ by: 'an agent', fold: ['a.one'], unfold: [] })).toEqual({ by: 'an agent', fold: ['a.one'], unfold: [] })
  })

  test('anything else is no note', () => {
    for (const bad of [
      undefined,
      null,
      'an agent',
      { by: '', fold: [], unfold: [] },
      { by: 'x'.repeat(65), fold: [], unfold: [] },
      { by: 'an agent', fold: 'a.one', unfold: [] },
      { by: 'an agent', fold: [7], unfold: [] },
      { by: 'an agent', fold: [] },
      { by: 'an agent', fold: Array.from({ length: 65 }, (_, n) => `m${n}`), unfold: [] },
    ]) {
      expect(foldNoteIn(bad)).toBeNull()
    }
  })
})

describe('the page reads again only after its own writes have landed', () => {
  test('flushAll settles when the pending write has been answered, not when it was sent', async () => {
    let answer!: () => void
    const order: string[] = []
    const writer = new Writer(
      () =>
        new Promise<void>((resolve) => {
          order.push('sent')
          answer = () => {
            order.push('answered')
            resolve()
          }
        }),
      () => {},
      10_000,
    )
    writer.write(1, { name: 'a' })
    expect(writer.pending(1)).toBe(true)
    const flushed = writer.flushAll().then(() => order.push('flushed'))
    expect(writer.pending(1)).toBe(false)
    await Promise.resolve()
    expect(order).toEqual(['sent'])
    answer()
    await flushed
    expect(order).toEqual(['sent', 'answered', 'flushed'])
  })

  test('a write already on its way when the flush is asked for is waited for too', async () => {
    let answer!: () => void
    let settled = false
    const writer = new Writer(() => new Promise<void>((resolve) => (answer = resolve)), () => {}, 10_000)
    writer.write(1, { name: 'a' })
    void writer.flushAll()
    const second = writer.flushAll().then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    answer()
    await second
    expect(settled).toBe(true)
  })

  test('a change made while a read is out is known about when the read comes back, sent or not', async () => {
    const writer = new Writer(async () => {}, () => {}, 10_000)
    writer.write(1, { name: 'a' })
    await writer.flushAll()
    const before = writer.stamp()
    writer.write(2, { name: 'b' })
    expect(writer.pending(2)).toBe(true)
    expect(writer.edits(2)).not.toBe(before.get(2) ?? 0)
    /* Sent and answered while the read was still out: no longer pending, and
       still a change the read cannot be trusted over. */
    await writer.flushAll()
    expect(writer.pending(2)).toBe(false)
    expect(writer.edits(2)).not.toBe(before.get(2) ?? 0)
    expect(writer.edits(1)).toBe(before.get(1)!)
  })
})

describe('a re-read after a wake, when the person’s own hand crossed it', () => {
  const box = (i: string, y: number, collapsed = false) => ({ i, x: 0, y, w: 6, h: collapsed ? 1 : 8, wish: 8, collapsed })
  const canvas = (id: number, placements: ReturnType<typeof box>[]) => ({ id, placements })
  const note = { by: 'an agent', fold: ['a.one'], unfold: [] }
  const state = (c: { placements: { i: string; collapsed: boolean }[] }) =>
    Object.fromEntries(c.placements.map((p) => [p.i, p.collapsed]))

  test('with nothing of theirs in the way, what was read is what is shown and nothing is written', () => {
    const was = [canvas(1, [box('a.one', 0), box('a.two', 8)])]
    const found = [canvas(1, [box('a.one', 0, true), box('a.two', 8)])]
    const next = reread(was, found, new Set(), { kehikko: 1, note, saved: false })
    expect(next.canvases).toEqual(found)
    expect(next.write).toBeNull()
  })

  test('a press made while the read was out stands, and the door’s fold is put onto it', () => {
    /* The person folded a.two; the read, made before that was saved, has the agent's a.one. */
    const was = [canvas(1, [box('a.one', 0), box('a.two', 8, true)])]
    const found = [canvas(1, [box('a.one', 0, true), box('a.two', 8)])]
    const next = reread(was, found, new Set([1]), { kehikko: 1, note, saved: false })
    expect(state(next.canvases[0]!)).toEqual({ 'a.one': true, 'a.two': true })
    expect(next.write?.kehikko).toBe(1)
    expect(next.write?.placements).toEqual(next.canvases[0]!.placements)
  })

  test('an unsaved change sent ahead of the read took the fold with it, and it is put back', () => {
    /* Their arrangement was saved over the door's, so the read is theirs: a.two folded, a.one not. */
    const found = [canvas(1, [box('a.one', 0), box('a.two', 8, true)])]
    const next = reread(found, found, new Set(), { kehikko: 1, note, saved: true })
    expect(state(next.canvases[0]!)).toEqual({ 'a.one': true, 'a.two': true })
    expect(next.write).not.toBeNull()
  })

  test('a drag of theirs is kept whole: only the fold is added', () => {
    const was = [canvas(1, [{ ...box('a.one', 0), x: 6, w: 4 }, box('a.two', 8)])]
    const found = [canvas(1, [box('a.one', 0, true), box('a.two', 8)])]
    const next = reread(was, found, new Set([1]), { kehikko: 1, note, saved: false })
    expect(next.canvases[0]!.placements[0]).toMatchObject({ i: 'a.one', x: 6, w: 4, wish: 8, collapsed: true })
  })

  test('a container they took off meanwhile is not brought back', () => {
    const was = [canvas(1, [box('a.two', 0)])]
    const found = [canvas(1, [box('a.one', 0, true), box('a.two', 8)])]
    const next = reread(was, found, new Set([1]), { kehikko: 1, note, saved: false })
    expect(next.canvases[0]!.placements.map((p) => p.i)).toEqual(['a.two'])
    expect(next.write).toBeNull()
  })

  test('a wake that is not a fold never writes, and another kehikko of theirs is left alone', () => {
    const was = [canvas(1, [box('a.one', 0)]), canvas(2, [box('a.one', 0, true)])]
    const found = [canvas(1, [box('a.one', 0, true)]), canvas(2, [box('a.one', 0)])]
    const plain = reread(was, found, new Set([2]), null)
    expect(plain.canvases).toEqual([found[0]!, was[1]!])
    expect(plain.write).toBeNull()
    const folding = reread(was, found, new Set([2]), { kehikko: 1, note, saved: false })
    expect(folding.canvases).toEqual([found[0]!, was[1]!])
    expect(folding.write).toBeNull()
  })
})
