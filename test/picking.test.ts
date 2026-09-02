import { describe, expect, test } from 'bun:test'
import { METHOD_NAMES } from 'roadmap-module-protocol'

import { ANSWERED_BY_THE_SERVER, ANSWERED_BY_THE_VIEW, unanswered } from '../src/host/division.ts'
import { makeAsk, type CanvasControls, type Picked } from '../src/host/ask.ts'

/**
 * A module asking the person which project — from the host's side.
 *
 * The feature is one row in a dialog and the whole of the design is what the
 * asking program is NOT told. So these are not tests of a picker: they are
 * tests that a framed program cannot learn what projects exist, cannot learn
 * that there are none, and cannot be left waiting on a dialog somebody closed.
 *
 * `assertEveryMethodIsAnswered` has caught a method neither half answered twice
 * now, so the first case here is the same guard from the other end.
 */

function canvasThatIsAsked(answer: Picked, seen: string[] = []): CanvasControls {
  return {
    showEpic: () => {},
    select: () => {},
    point: () => {},
    show: () => {},
    emit: () => ({ ok: true, delivered: 0 }),
    project: () => null,
    filter: () => ({ ok: true as const, filters: {} }),
    pickProject: (from) => {
      seen.push(from)
      return Promise.resolve(answer)
    },
  }
}

describe('the division', () => {
  test('nothing the protocol names falls between the two halves', () => {
    expect(unanswered()).toEqual([])
  })

  test('projects.pick is answered by the VIEW, because answering it needs a person', () => {
    /* The server holds the projects and looks like the half that should answer.
       It is not: what this needs is somebody looking at a dialog, and a server
       answering out of its own table without anybody being asked IS the
       enumeration the method is shaped to prevent. */
    expect([...ANSWERED_BY_THE_VIEW]).toContain('projects.pick')
    expect([...ANSWERED_BY_THE_SERVER]).not.toContain('projects.pick')
  })

  test('and there is still no method that lists projects', () => {
    expect(METHOD_NAMES).not.toContain('projects.list')
  })
})

describe('what a module is told', () => {
  test('a picked project comes back as one path and one name, and nothing else', async () => {
    const ask = makeAsk(
      'roadmap.checklist',
      canvasThatIsAsked({
        outcome: 'picked',
        project: { path: '/Users/x/thesis', name: 'thesis' },
        why: '',
      }),
    )

    const answer = await ask('projects.pick', {})

    expect(answer.ok).toBe(true)
    expect(answer.ok && answer.data).toEqual({
      outcome: 'picked',
      project: { path: '/Users/x/thesis', name: 'thesis' },
      why: '',
    })
  })

  test('the asker is named out of the registration, not out of anything the frame said', async () => {
    /* The dialog says who is asking. A module that could name itself would be
       signing somebody else's name to a request for a folder — the same rule
       that supplies `from` to `emit` and `filters.set`. */
    const seen: string[] = []
    const ask = makeAsk(
      'roadmap.checklist',
      canvasThatIsAsked({ outcome: 'cancelled', project: null, why: '' }, seen),
    )

    await ask('projects.pick', { from: 'roadmap.notes', suggest: '/etc' })

    expect(seen).toEqual(['roadmap.checklist'])
  })

  test('a cancellation and a decline carry the same nothing', async () => {
    /* This is the fence. If a host ever answers "there are no projects" as
       something a module can tell apart from a refusal, a program learns about
       the disk by asking, and everything else here is decoration. */
    const cancelled = await makeAsk(
      'roadmap.checklist',
      canvasThatIsAsked({ outcome: 'cancelled', project: null, why: '' }),
    )('projects.pick', {})
    const declined = await makeAsk(
      'roadmap.checklist',
      canvasThatIsAsked({ outcome: 'declined', project: null, why: 'This roadmap will not ask right now.' }),
    )('projects.pick', {})

    expect(cancelled.ok && (cancelled.data as { project: unknown }).project).toBeNull()
    expect(declined.ok && (declined.data as { project: unknown }).project).toBeNull()
  })

  test('every outcome is ok: true — the question succeeded, the picking may not have', async () => {
    for (const outcome of ['picked', 'cancelled', 'declined'] as const) {
      const answer = await makeAsk(
        'roadmap.checklist',
        canvasThatIsAsked({
          outcome,
          project: outcome === 'picked' ? { path: '/p', name: 'p' } : null,
          why: '',
        }),
      )('projects.pick', {})
      expect(answer.ok).toBe(true)
    }
  })

  test('a host that filled in a project beside a cancellation is caught by its own shape check', async () => {
    /* `shaped()` runs the protocol's schema over the host's OWN answer. It is
       hygiene for most methods; here it is what enforces the arrangement that
       makes a decline uninformative. A `cancelled` carrying a path is a fault
       in this host, and it is refused here rather than at the module. */
    const ask = makeAsk(
      'roadmap.checklist',
      canvasThatIsAsked({
        outcome: 'cancelled',
        /* Deliberately wrong: an empty path is not a path. */
        project: { path: '', name: 'leaked' },
        why: '',
      }),
    )

    const answer = await ask('projects.pick', {})

    expect(answer.ok).toBe(false)
  })
})
