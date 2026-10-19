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

const webapp = { id: 1, name: 'webapp', path: '/w/webapp', epics: true, git: true, shared: false }

const held = toWireContext({ epic: 'modes-are-modules', project: webapp }, 'dark', [], null, null)

describe('what a pinned container is still told', () => {
  test('a changed theme gets through', () => {
    const told = toWireContext({ epic: 'something-else', project: webapp }, 'light', [], null, null)
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
    expect(sent?.project).toBe('webapp')
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
    const told = toWireContext({ epic: 'anything', project: webapp }, 'light', [], null, null)
    expect(whileFrozen(null, told)).toBeNull()
  })

  test('and it works in both directions', () => {
    const lit = toWireContext({ epic: 'modes-are-modules', project: webapp }, 'light', [], null, null)
    const back = toWireContext({ epic: 'modes-are-modules', project: webapp }, 'dark', [], null, null)
    expect(whileFrozen(lit, back)?.theme).toBe('dark')
  })
})

/*
 * A project is its id. After a rename or a move the host relinks it and the
 * canvas's context names the new folder under the same id; a pinned container
 * compared by path took that for another project, kept the old path, and went
 * deaf to the marks, the tracker and the content.
 */
describe('a pinned container after its project was relinked', () => {
  const uid = '6f1c2a9e-0b7d-4c55-9a3e-2d8f1b4c7e10'
  const before = { ...webapp, uid }
  const after = { ...webapp, name: 'webapp-renamed', path: '/w/webapp-renamed', uid }
  const pinnedOn = toWireContext({ epic: 'modes-are-modules', project: before }, 'dark', [], null, null)

  test('is told the new path, and keeps what it was pinned on', () => {
    const told = toWireContext({ epic: 'something-else', project: after }, 'dark', [], null, null)
    const sent = whileFrozen(pinnedOn, told)
    expect(sent?.projectPath).toBe('/w/webapp-renamed')
    expect(sent?.project).toBe('webapp-renamed')
    expect(sent?.projectId).toBe(uid)
    expect(sent?.epic).toBe('modes-are-modules')
  })

  test('and still hears the marks, the tracker and the content on the new path', () => {
    const relinked = whileFrozen(pinnedOn, toWireContext({ epic: 'something-else', project: after }, 'dark', [], null, null))!
    const live = toWireContext({ epic: 'something-else', project: after }, 'dark', [], null, null)
    const dispositions = [{ ref: '#1', value: 'done' }] as unknown as typeof live.dispositions
    const tracker = { ...(live.tracker ?? {}), at: 'later' } as unknown as typeof live.tracker
    const content = { ...(live.content ?? {}), changed: ['x'] } as unknown as typeof live.content
    const marked = whileFrozen(relinked, { ...live, dispositions })
    expect(marked?.dispositions).toEqual(dispositions)
    expect(marked?.projectPath).toBe('/w/webapp-renamed')
    expect(whileFrozen(relinked, { ...live, tracker })?.tracker).toEqual(tracker)
    expect(whileFrozen(relinked, { ...live, content })?.content).toEqual(content)
  })

  test('once told, the same place is silence', () => {
    const live = toWireContext({ epic: 'something-else', project: after }, 'dark', [], null, null)
    const relinked = whileFrozen(pinnedOn, live)!
    expect(whileFrozen(relinked, live)).toBeNull()
  })

  test('another project with another id is still not this one', () => {
    const other = { ...webapp, name: 'other', path: '/w/other', uid: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }
    const live = toWireContext({ epic: 'x', project: other }, 'dark', [], null, null)
    const dispositions = [{ ref: '#1', value: 'done' }] as unknown as typeof live.dispositions
    expect(whileFrozen(pinnedOn, { ...live, dispositions })).toBeNull()
  })
})
