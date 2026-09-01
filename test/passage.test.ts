import { describe, expect, test } from 'bun:test'
import type { Passage } from 'roadmap-module-protocol'

import { makeAsk, type CanvasControls } from '@/host/ask.ts'
import { toWireContext } from '@/host/context.ts'
import { ANSWERED_BY_THE_VIEW, unanswered } from '@/host/division.ts'

/**
 * `passage.set`, answered by the canvas, and what the canvas then says.
 *
 * The method arrived in the protocol before this host had heard of it, and
 * `assertEveryMethodIsAnswered` did exactly what it was written for: it threw
 * at startup with the name in the message. These tests are the other half of
 * that — the assertion says a method is answered SOMEWHERE, and nothing in it
 * says the answer is any good.
 */

function canvasThatRemembers() {
  const pointed: (Passage | null)[] = []
  const controls: CanvasControls = {
    showEpic: () => {},
    select: () => {},
    point: (passage) => pointed.push(passage),
    emit: () => ({ ok: true, delivered: 0 }),
    project: () => null,
    filter: () => ({ ok: true as const, filters: {} }),
  }
  return { controls, pointed }
}

const paragraph: Passage = {
  path: '/Users/x/thesis/chapters/bridge.tex',
  page: 3,
  from: 4120,
  to: 4180,
  quoted: 'the wire is narrow on purpose',
}

describe('the host answers the method the protocol names', () => {
  test('nothing the protocol names falls between the two halves', () => {
    expect(unanswered()).toEqual([])
  })

  test('a passage is answered by the VIEW, for the reason a selection is', () => {
    /* It changes the context, and the context is the canvas's to compose. The
       server holds no frames and would have to push the composed context back
       to the page over a channel invented for the purpose. */
    expect([...ANSWERED_BY_THE_VIEW]).toContain('passage.set')
  })
})

describe('what the canvas does when a module points', () => {
  test('the passage reaches the canvas and the answer repeats it', async () => {
    const { controls, pointed } = canvasThatRemembers()
    const ask = makeAsk('roadmap.paper', controls)

    const answer = await ask('passage.set', { passage: paragraph })

    expect(answer.ok).toBe(true)
    expect(pointed).toEqual([paragraph])
  })

  test('null is a real call and clears it', async () => {
    /* "No document is open" is a state every consumer has to be able to move
       INTO. A module that could not send this would leave a notes container showing
       the notes on a chapter nobody has open. */
    const { controls, pointed } = canvasThatRemembers()
    const ask = makeAsk('roadmap.paper', controls)

    const answer = await ask('passage.set', { passage: null })

    expect(answer.ok).toBe(true)
    expect(pointed).toEqual([null])
  })

  test('the defaults the schema fills reach the canvas, not the raw object', async () => {
    /* A module that names a document and selects nothing in it sends `path`
       alone. The canvas must relay a whole passage — page, from, to and quoted
       filled in — because the context schema is going to apply those defaults
       anyway, and a half-filled object on the way in is a passage that
       validates here and changes shape on the way out. */
    const { controls, pointed } = canvasThatRemembers()
    const ask = makeAsk('roadmap.paper', controls)

    await ask('passage.set', { passage: { path: '/Users/x/thesis/main.tex' } })

    expect(pointed[0]).toEqual({
      path: '/Users/x/thesis/main.tex',
      page: null,
      from: null,
      to: null,
      quoted: '',
    })
  })

  test('a half-range is refused rather than relayed as a coarser answer', async () => {
    /* The protocol calls this malformed rather than imprecise: a consumer
       reading `from` with no `to` has to invent an end, and the end it invents
       is a claim about somebody's document. */
    const { controls, pointed } = canvasThatRemembers()
    const ask = makeAsk('roadmap.paper', controls)

    const answer = await ask('passage.set', {
      passage: { path: '/Users/x/thesis/main.tex', from: 10, to: null },
    })

    expect(answer.ok).toBe(false)
    expect(pointed).toEqual([])
  })

  test('a call with no passage field at all is refused, not read as a clear', async () => {
    /* `passage` is required and nullable rather than optional, and the reason
       is exactly this: a call that left it out would be indistinguishable from
       a caller with a typo in the field name, and one of those means "clear it"
       while the other means nothing at all. */
    const { controls, pointed } = canvasThatRemembers()
    const ask = makeAsk('roadmap.paper', controls)

    const answer = await ask('passage.set', {})

    expect(answer.ok).toBe(false)
    expect(pointed).toEqual([])
  })
})

describe('the passage travels in the context every module is told', () => {
  const roadmap = { id: 1, name: 'roadmap', path: '/Users/x/Projects/roadmap', epics: true, git: true, shared: false }

  test('it goes out whole, unchecked, because the host did not open the file', () => {
    const here = toWireContext({ epic: 'modes-are-modules', project: roadmap }, 'dark', [], null, paragraph)
    expect(here.passage).toEqual(paragraph)
  })

  test('a host nobody has pointed at anything on says null, not a missing field', () => {
    expect(toWireContext({ epic: null, project: null }, 'light').passage).toBeNull()
  })

  test('an epic slug the schema refuses costs the selection and not the passage', () => {
    /* The two are dropped for different reasons and the reasons come out
       differently. A ref was picked out of an epic this context no longer
       names. A passage names a FILE: a person reading chapter three is still
       reading chapter three when a stored slug turns out not to parse, and
       dropping it would make one bad row in a table close somebody's document. */
    const here = toWireContext(
      { epic: 'NOT A SLUG '.repeat(40), project: roadmap },
      'light',
      ['gh#1'],
      { id: 2, name: 'reading' },
      paragraph,
    )
    expect(here.epic).toBeNull()
    expect(here.selection).toEqual([])
    expect(here.passage).toEqual(paragraph)
  })

  test('a passage the schema will not take does not white-screen the host', () => {
    /* `toWireContext` runs during render. A quote past `LIMITS.QUOTE` arriving
       from a module must cost that module its passage and must not take every
       other container on the canvas down with it. */
    const here = toWireContext({ epic: null, project: roadmap }, 'light', [], null, {
      ...paragraph,
      quoted: 'x'.repeat(5000),
    })
    expect(here.passage).toBeNull()
    expect(here.projectPath).toBe('/Users/x/Projects/roadmap')
  })
})
