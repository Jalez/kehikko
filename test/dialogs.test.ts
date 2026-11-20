import { describe, expect, test } from 'bun:test'

import { dialogsAfter, NO_DIALOGS } from '../src/app/useDialogs.ts'

/*
 * The host's windows about one module (`app/useDialogs.ts`): independent of
 * each other, as the separate pieces of state in `App.tsx` they replace were,
 * and an act that changes nothing leaves the very same state, so React skips
 * the render as it did for an unchanged `useState` value.
 */
describe('the windows about one module', () => {
  test('opening one closes no other', () => {
    let state = dialogsAfter(NO_DIALOGS, { open: 'tools', id: 'a' })
    state = dialogsAfter(state, { open: 'help', id: 'b' })
    state = dialogsAfter(state, { open: 'prompts', id: 'c' })
    state = dialogsAfter(state, { open: 'skills', id: 'd' })
    state = dialogsAfter(state, { open: 'intro', id: 'e', about: { name: 'E' }, add: true })
    state = dialogsAfter(state, { open: 'settings', id: 'f', target: 'key' })
    expect(state).toEqual({
      toolsFor: 'a',
      helpFor: 'b',
      prompting: 'c',
      skillsFor: 'd',
      introOpen: { id: 'e', about: { name: 'E' }, add: true },
      settingsFor: 'f',
      settingsTarget: 'key',
    })
    const closed = dialogsAfter(state, { close: 'help' })
    expect(closed).toEqual({ ...state, helpFor: null })
  })

  test('closing the settings window forgets the setting it was opened at', () => {
    const state = dialogsAfter(NO_DIALOGS, { open: 'settings', id: 'f', target: 'key' })
    expect(dialogsAfter(state, { close: 'settings' })).toEqual(NO_DIALOGS)
    /* Opened again from the gear: at no setting. */
    expect(dialogsAfter(state, { open: 'settings', id: 'f', target: null })).toEqual({ ...NO_DIALOGS, settingsFor: 'f', settingsTarget: null })
  })

  test('an act that changes nothing is the same state', () => {
    expect(dialogsAfter(NO_DIALOGS, { close: 'tools' })).toBe(NO_DIALOGS)
    expect(dialogsAfter(NO_DIALOGS, { close: 'intro' })).toBe(NO_DIALOGS)
    expect(dialogsAfter(NO_DIALOGS, { close: 'settings' })).toBe(NO_DIALOGS)
    const open = dialogsAfter(NO_DIALOGS, { open: 'skills', id: 'a' })
    expect(dialogsAfter(open, { open: 'skills', id: 'a' })).toBe(open)
    const settings = dialogsAfter(NO_DIALOGS, { open: 'settings', id: 'a', target: null })
    expect(dialogsAfter(settings, { open: 'settings', id: 'a', target: null })).toBe(settings)
  })
})
