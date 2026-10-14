import { describe, expect, test } from 'bun:test'

import { foldResult } from 'kehikot-module-protocol'

import { makeAsk, type CanvasControls } from '../src/host/ask.ts'
import { ANSWERED_BY_THE_VIEW, unanswered } from '../src/host/division.ts'
import { asked, foldHint, foldNoteIn, noted, reread, signedBy, standing } from '../src/host/folds.ts'
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

/*
 * A module asking with `view.fold` (protocol 1.1.0): the same write, decided
 * by `asked`, answered through `makeAsk`.
 */
describe('a module asks the host to fold or unfold', () => {
  const box = (i: string, y: number, collapsed = false) => ({ i, x: 0, y, w: 4, h: collapsed ? 1 : 8, wish: 8, collapsed })
  const SLIDES = 'kehikot.slides'
  const PAPER = 'kehikot.paper'
  const NOTES = 'kehikot.notes'
  const here = [box(SLIDES, 0), box(PAPER, 8), box(NOTES, 16, true)]

  test('it folds and unfolds what was named, and says exactly what it changed', () => {
    const out = asked(here, SLIDES, { fold: [PAPER], unfold: [NOTES] }, null)
    expect(out.outcome).toBe('changed')
    expect(out.folded).toEqual([PAPER])
    expect(out.unfolded).toEqual([NOTES])
    expect(out.placements.map((p) => p.collapsed)).toEqual([false, true, false])
    /* Nothing but the fold and the drawn heights: no wish, position or width. */
    expect(out.placements.map((p) => [p.i, p.x, p.w, p.wish])).toEqual(here.map((p) => [p.i, p.x, p.w, p.wish]))
  })

  test('a module may fold itself', () => {
    const out = asked(here, SLIDES, { fold: [SLIDES], unfold: [] }, null)
    expect(out.outcome).toBe('changed')
    expect(out.folded).toEqual([SLIDES])
    expect(out.placements[0]?.collapsed).toBe(true)
  })

  test('a container already as asked is left alone and is in neither list', () => {
    const some = asked(here, SLIDES, { fold: [PAPER, NOTES], unfold: [] }, null)
    expect(some.outcome).toBe('changed')
    expect(some.folded).toEqual([PAPER])

    const none = asked(here, SLIDES, { fold: [NOTES], unfold: [SLIDES, PAPER] }, null)
    expect(none).toMatchObject({ outcome: 'unchanged', folded: [], unfolded: [], why: '' })
    expect(none.placements).toBe(here)
  })

  test('an id that is not on this kehikko changes nothing, not even the ids that are', () => {
    const out = asked(here, SLIDES, { fold: [PAPER, 'kehikot.diff'], unfold: [] }, null)
    expect(out.outcome).toBe('no-such-container')
    expect(out.why).toBe('kehikot.diff is not on this kehikko. Nothing was folded or unfolded.')
    expect(out.placements).toBe(here)
  })

  test('a call naming as many strangers as the schema allows is still answered, in a sentence that fits', () => {
    /* 64 ids of 64 characters in each list: every one listed would be a `why`
       twenty times what the protocol holds, and the answer would not parse. */
    const strangers = (prefix: string) =>
      Array.from({ length: 64 }, (_, n) => `${prefix}.${String(n).padStart(2, '0')}${'x'.repeat(64 - prefix.length - 3)}`)
    const out = asked(here, SLIDES, { fold: strangers('kehikot.a'), unfold: strangers('kehikot.b') }, null)
    expect(out.outcome).toBe('no-such-container')
    expect(out.why).toEndWith(' and 125 more are not on this kehikko. Nothing was folded or unfolded.')
    const { placements: _same, ...answer } = out
    expect(foldResult.safeParse(answer).success).toBe(true)
  })

  test('an id named twice is folded once and handed back once', () => {
    const out = asked(here, SLIDES, { fold: [PAPER, PAPER], unfold: [NOTES, NOTES] }, null)
    expect(out.folded).toEqual([PAPER])
    expect(out.unfolded).toEqual([NOTES])
  })

  test('a module that is not on the open kehikko acts on nothing there', () => {
    const out = asked(here, 'kehikot.diff', { fold: [PAPER], unfold: [] }, null)
    expect(out.outcome).toBe('declined')
    expect(out.why).toContain('kehikot.diff is not on the kehikko that is open')
    expect(out.placements).toBe(here)
  })

  test('while the person is in the middle of something it is declined, with their reason', () => {
    const out = asked(here, SLIDES, { fold: [PAPER], unfold: [] }, 'A container is being moved or resized.')
    expect(out).toMatchObject({ outcome: 'declined', folded: [], unfolded: [], why: 'A container is being moved or resized.' })
    expect(out.placements).toBe(here)
  })

  test('what it changed, handed back the other way round, puts the kehikko as it was', () => {
    const out = asked(here, SLIDES, { fold: [PAPER], unfold: [NOTES] }, null)
    const back = asked(out.placements, SLIDES, { fold: out.unfolded, unfold: out.folded }, null)
    expect(back.placements.map((p) => [p.i, p.collapsed, p.h])).toEqual(here.map((p) => [p.i, p.collapsed, p.h]))
  })

  test('it is signed with the module’s name, on the control that puts it back', () => {
    const out = asked(here, SLIDES, { fold: [PAPER], unfold: [NOTES] }, null)
    const marks = noted({}, { by: 'Slides', fold: out.folded, unfold: out.unfolded })
    const paper = out.placements.find((p) => p.i === PAPER)!
    const notes = out.placements.find((p) => p.i === NOTES)!
    expect(foldHint(paper.collapsed, signedBy(marks, paper))).toBe(
      'folded by Slides — the module is still running. Press to put it back at the height it had',
    )
    expect(foldHint(notes.collapsed, signedBy(marks, notes))).toBe(
      'unfolded by Slides. Press to fold it down to its header again',
    )
    /* The person presses Paper's control: one press, and the mark is gone. */
    const pressed = out.placements.map((p) => (p.i === PAPER ? { ...p, collapsed: false } : p))
    expect(signedBy(standing(marks, pressed), pressed.find((p) => p.i === PAPER)!)).toBeNull()
  })
})

describe('view.fold on the wire', () => {
  function canvas(answer: ReturnType<CanvasControls['fold']>) {
    const calls: { from: string; call: { fold: string[]; unfold: string[] } }[] = []
    const controls: CanvasControls = {
      showEpic: () => {},
      goto: () => ({ outcome: 'declined', epic: null, why: '' }),
      select: () => {},
      point: () => {},
      show: () => {},
      emit: () => ({ ok: true, delivered: 0 }),
      project: () => null,
      filter: () => ({ ok: true as const, filters: {} }),
      pickProject: () => Promise.resolve({ outcome: 'declined' as const, project: null, why: '' }),
      fold: (from, call) => {
        calls.push({ from, call })
        return answer
      },
    }
    return { controls, calls }
  }

  test('the host answers the method the protocol names, in the view', () => {
    expect(unanswered()).toEqual([])
    expect(ANSWERED_BY_THE_VIEW as readonly string[]).toContain('view.fold')
  })

  test('the asker is named by the host, both lists arrive, and the answer is the protocol’s shape', async () => {
    const { controls, calls } = canvas({ outcome: 'changed', folded: [], unfolded: ['kehikot.learning'], why: '' })
    const out = await makeAsk('kehikot.slides', controls)('view.fold', { unfold: ['kehikot.learning'] })
    expect(calls).toEqual([{ from: 'kehikot.slides', call: { fold: [], unfold: ['kehikot.learning'] } }])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(foldResult.parse(out.data)).toEqual({ outcome: 'changed', folded: [], unfolded: ['kehikot.learning'], why: '' })
  })

  test('a decline is an answer, not a failure', async () => {
    const { controls } = canvas({ outcome: 'declined', folded: [], unfolded: [], why: 'A container is being moved or resized.' })
    const out = await makeAsk('kehikot.slides', controls)('view.fold', { fold: ['kehikot.paper'] })
    expect(out).toEqual({
      ok: true,
      data: { outcome: 'declined', folded: [], unfolded: [], why: 'A container is being moved or resized.' },
    })
  })

  test('a call naming nothing, or one container both ways, never reaches the canvas', async () => {
    const { controls, calls } = canvas({ outcome: 'unchanged', folded: [], unfolded: [], why: '' })
    const ask = makeAsk('kehikot.slides', controls)
    expect((await ask('view.fold', {})).ok).toBe(false)
    expect((await ask('view.fold', { fold: ['kehikot.paper'], unfold: ['kehikot.paper'] })).ok).toBe(false)
    expect((await ask('view.fold', { fold: ['Not An Id'] })).ok).toBe(false)
    expect(calls).toEqual([])
  })
})
