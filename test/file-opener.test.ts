import { describe, expect, test } from 'bun:test'

import { fileOpenerFor } from '../src/host/fileOpener.ts'

/* "Open the file" in a module's settings opens it with whichever module says `opens: ['file']` (protocol 2.33.0). Stand-in ids. */
describe('which module opens a file', () => {
  const opener = (id: string, condition = 'ready') => ({ id, condition, module: { opens: ['file'] } })
  const other = (id: string) => ({ id, condition: 'ready', module: {} })

  test('one on the open kehikko, in the kehikko’s order', () => {
    const presences = [opener('kehikot.viewer'), opener('kehikot.reader'), other('kehikot.list')]
    expect(fileOpenerFor(['kehikot.list', 'kehikot.reader', 'kehikot.viewer'], presences)).toEqual({ id: 'kehikot.reader', placed: true })
  })

  test('else an installed one that answers, to be placed for the press', () => {
    expect(fileOpenerFor(['kehikot.list'], [other('kehikot.list'), opener('kehikot.sleeping', 'silent'), opener('kehikot.viewer')])).toEqual({ id: 'kehikot.viewer', placed: false })
  })

  test('none: the form shows the file itself', () => {
    expect(fileOpenerFor(['kehikot.list'], [other('kehikot.list'), opener('kehikot.sleeping', 'silent')])).toBeNull()
    expect(fileOpenerFor([], [])).toBeNull()
    /* A manifest that says nothing about opens, or another word, opens nothing. */
    expect(fileOpenerFor(['kehikot.x'], [{ id: 'kehikot.x', module: { opens: ['page'] } }])).toBeNull()
  })
})
