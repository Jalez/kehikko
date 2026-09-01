import { describe, expect, test } from 'bun:test'

import { toWireContext, whileFrozen } from '@/host/context.ts'

/**
 * A pin freezes what a container is ABOUT, and nothing else.
 *
 * It was implemented as freezing the whole context, which also froze the theme
 * — so switching the host from dark to light left every pinned container dark,
 * indefinitely, since a pin is what you press on the containers you want held
 * still. It was reported as two modules "not having light mode"; those two were
 * simply the two that happened to be pinned.
 */

const roadmap = { id: 1, name: 'roadmap', path: '/w/roadmap', epics: true, git: true, shared: false }

const held = toWireContext({ epic: 'modes-are-modules', project: roadmap }, 'dark', [], null, null)

describe('what a pinned container is still told', () => {
  test('a changed theme gets through', () => {
    const told = toWireContext({ epic: 'something-else', project: roadmap }, 'light', [], null, null)
    const sent = whileFrozen(held, told)
    expect(sent?.theme).toBe('light')
  })

  /* The whole point of the pin: the subject it froze must survive a theme
     change untouched. A relit context that carried the canvas's current epic
     would be the pin quietly ending the first time somebody changed the
     lighting. */
  test('and the frozen subject is not disturbed by it', () => {
    const told = toWireContext({ epic: 'something-else', project: null }, 'light', [], null, null)
    const sent = whileFrozen(held, told)
    expect(sent?.epic).toBe('modes-are-modules')
    expect(sent?.project).toBe('roadmap')
  })

  /* Asked on every context the canvas produces. Answering with the held context
     each time would be the host repeating itself to a module that already knows
     — the identical-broadcast problem the memo in `ModuleFrame` exists to
     avoid. */
  test('an unchanged theme is silence, however much else moved', () => {
    const told = toWireContext({ epic: 'something-else', project: null }, 'dark', [], null, null)
    expect(whileFrozen(held, told)).toBeNull()
  })

  /* Nothing has gone out yet, so there is no frozen subject to preserve and
     nothing to substitute a theme into. Sending the live context here would
     hand a pinned container the canvas's current subject as its first word. */
  test('a container that has been told nothing is told nothing', () => {
    const told = toWireContext({ epic: 'anything', project: roadmap }, 'light', [], null, null)
    expect(whileFrozen(null, told)).toBeNull()
  })

  test('and it works in both directions', () => {
    const lit = toWireContext({ epic: 'modes-are-modules', project: roadmap }, 'light', [], null, null)
    const back = toWireContext({ epic: 'modes-are-modules', project: roadmap }, 'dark', [], null, null)
    expect(whileFrozen(lit, back)?.theme).toBe('dark')
  })
})
