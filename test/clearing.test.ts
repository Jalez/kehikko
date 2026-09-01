import { describe, expect, test } from 'bun:test'

import { DISARM_AFTER_MS, saying } from '../src/canvas/Clearing.tsx'
import { Presses } from '../src/host/presses.ts'

/**
 * The one control on this canvas that destroys something.
 *
 * Two things are worth testing without a browser and they are the two that
 * would fail silently: what the control is CALLED in each of its two states,
 * and whether a press reaches a frame at all.
 *
 * The wording is not decoration here. `Filters.tsx` has the story of a control
 * the owner was told existed, went looking for, and could not find — it was in
 * front of them, unlabelled, in a row of seven icons — and the fix was the
 * accessible name. This control has the same problem with a worse consequence:
 * a person who cannot tell the armed state from the resting one presses twice.
 */

describe('what the delete control is called', () => {
  test('the resting state says what it would delete, in the module’s words', () => {
    const said = saying('Notifications', 'forget 12 shown', false)
    expect(said.name).toContain('forget 12 shown')
    expect(said.hint).toContain('forget 12 shown')
  })

  /* The word somebody hunting for this would search for. "Clear", "forget" and
     "discard" are all things a module might call its own action; the host's
     contribution has to be the plain one. */
  test('and both states carry the plain word for what this is', () => {
    expect(saying('Notes', 'clear 3', false).name).toContain('delete')
    expect(saying('Notes', 'clear 3', true).name).toContain('delete')
  })

  /* The module's name, for the same reason every other control in this header
     carries it: it is what distinguishes six otherwise identical icon buttons
     when they are read out one after another. */
  test('both states name the module', () => {
    expect(saying('Notifications', 'x', false).name).toContain('Notifications')
    expect(saying('Notifications', 'x', true).name).toContain('Notifications')
  })

  /*
   * The one that matters most. `Filters.tsx` keeps one verb across its two
   * states because pressing it does the same thing either way — it opens a
   * menu. Pressing this does two entirely different things, and a name that did
   * not change would leave a screen reader user unable to tell that the next
   * press deletes.
   */
  test('the armed state says that THIS press is the one that deletes', () => {
    const armed = saying('Notifications', 'forget 12 shown', true)
    expect(armed.name).toContain('again')
    expect(armed.hint).toContain('again')
    expect(armed.name).not.toBe(saying('Notifications', 'forget 12 shown', false).name)
  })

  /* Both states say it is permanent, because the arm is the only warning this
     control gets — there is no modal behind it and cannot be. */
  test('and both say there is no getting it back', () => {
    expect(saying('N', 'x', false).hint).toContain('two presses')
    expect(saying('N', 'x', true).hint).toContain('nothing brings them back')
  })

  /* A module's label is quoted, never paraphrased: the host does not know what
     it counts. Anything long is the tooltip's and the name's problem, never the
     header's — no module string is laid out in that row. See `Clearing.tsx`. */
  test('a long label is carried whole rather than clipped', () => {
    const long = 'forget everything from this run and the one before it'
    expect(saying('N', long, false).hint).toContain(long)
  })

  test('the arm does not stay armed indefinitely', () => {
    expect(DISARM_AFTER_MS).toBeGreaterThan(1000)
    expect(DISARM_AFTER_MS).toBeLessThanOrEqual(10_000)
  })
})

/**
 * Whether a press reaches a frame.
 *
 * The two outcomes are "it reached the module" and "it reached nothing", and
 * from outside they look identical — the host learns nothing about what a
 * module did with a press, deliberately. So `press` answers, purely so this
 * can be told apart here.
 */
describe('reaching the frame that has to do the deleting', () => {
  test('a press reaches the module it names and no other', () => {
    const presses = new Presses()
    const said: string[] = []
    presses.join('a.one', { clear: () => said.push('a'), refresh: () => {} })
    presses.join('b.two', { clear: () => said.push('b'), refresh: () => {} })

    expect(presses.press('a.one')).toBe(true)
    expect(said).toEqual(['a'])
  })

  /* A container removed between somebody's first press and their second is a
     module that is no longer there, and silence is the correct answer rather
     than an error thrown inside a click handler. */
  test('a press at a module that has gone does nothing', () => {
    const presses = new Presses()
    let pressed = 0
    presses.join('a.one', { clear: () => (pressed += 1), refresh: () => {} })
    presses.leave('a.one')

    expect(presses.press('a.one')).toBe(false)
    expect(pressed).toBe(0)
  })

  test('and a press at a module that never existed does nothing either', () => {
    expect(new Presses().press('never.here')).toBe(false)
  })

  /*
   * The ids here are read out of manifests strangers wrote, so the register is
   * a `Map` and not an object — the protocol's essay on `own()` is about
   * exactly this, and `constructor` is a key every plain object in the world
   * already answers to.
   */
  test('a module calling itself constructor cannot press anything by accident', () => {
    const presses = new Presses()
    expect(presses.press('constructor')).toBe(false)
    expect(presses.press('__proto__')).toBe(false)
  })

  /* Re-joining under the same id replaces rather than accumulates. A frame that
     reloads builds a new conversation, and a press must reach the live one and
     not a window that has gone. */
  test('a frame that came back replaces the one that went', () => {
    const presses = new Presses()
    const said: string[] = []
    presses.join('a.one', { clear: () => said.push('old'), refresh: () => {} })
    presses.join('a.one', { clear: () => said.push('new'), refresh: () => {} })

    presses.press('a.one')
    expect(said).toEqual(['new'])
  })
})
