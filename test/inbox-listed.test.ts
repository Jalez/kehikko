import { describe, expect, test } from 'bun:test'

import { OFFICIAL } from '../server/official.ts'
import { HOST_WORDS, namesOf, officialNames } from '../dev/module-agnostic.ts'
import { inboxModuleOf } from '../src/host/inboxBar.ts'

/** The module that shows the Inbox is on the list by its role, and the host's word for its record stays the host's. */
describe('the listed Inbox module', () => {
  test('one entry says role inbox, needs protocol 2.79.0, and is what the bar offers before it is installed', () => {
    const listed = OFFICIAL.filter((one) => one.role === 'inbox')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.protocol).toBe('2.79.0')
    expect(inboxModuleOf([], OFFICIAL)?.id).toBe(listed[0]!.id)
  })

  test('“Inbox” is the host’s word though a module is named after it; every other name still counts', () => {
    expect(HOST_WORDS).toEqual(['Inbox'])
    expect(officialNames()).toContain('Inbox')
    expect(namesOf()).not.toContain('Inbox')
    expect(namesOf()).toContain('Journeys')
  })
})
