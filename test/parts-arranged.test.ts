import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { CONTENT_HOST, JOURNEYS_FILE, JOURNEYS_MODULE, moduleFile, partsOf as protocolPartsOf, slugFrom as protocolSlugFrom } from 'kehikot-module-protocol'

import { Contents } from '../server/content.ts'
import { listEpics } from '../server/holdings.ts'
import { epicsDir } from '../server/hostData.ts'
import { slugFrom as epicSlugFrom } from '../src/host/epics.ts'
import { focusSaid, goneSaid, partsOf, partsOnWire, pickedIn, slugFrom } from '../src/host/parts.ts'

/**
 * A part made, reworded or removed in the Journeys module, as this host
 * comes to hear of it.
 *
 * Journeys can arrange a journey into parts from its own page now. This host
 * never wrote a group and still does not; what it owes is that the bar and
 * `context.parts` follow what was written there, with no reload, and that a
 * focus naming a part which has since been removed neither hides everything
 * nor goes without saying.
 *
 * The chain has three links and each is held here by what it is made of:
 * the change is announced as the host's own (`Contents`), the page then reads
 * `epics.list` again (`App.tsx`, on any `CONTENT_HOST` entry), and the row it
 * gets carries the parts of the record as it is NOW (`listEpics`).
 */

const made: string[] = []
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const SLUG = 'the-posting-seam'

function project(): { root: string; write(groups: unknown[], steps?: unknown[]): void; parts(): ReturnType<typeof partsOf> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-arranged-')))
  made.push(root)
  mkdirSync(epicsDir(root), { recursive: true })
  /* The host's own file, which has no groups at all: every part below can only have come from the record. */
  writeFileSync(join(epicsDir(root), `${SLUG}.json`), `${JSON.stringify({ slug: SLUG, title: 'The posting seam', steps: [] })}\n`)
  const file = moduleFile(root, JOURNEYS_MODULE, JOURNEYS_FILE)!
  mkdirSync(join(file, '..'), { recursive: true })
  const write = (groups: unknown[], steps: unknown[] = [{ title: 'One', refs: ['gh#1'] }]) =>
    writeFileSync(file, `${JSON.stringify({ version: 1, journeys: { [SLUG]: { slug: SLUG, title: 'The posting seam', steps, groups } } }, null, 2)}\n`)
  const parts = () => listEpics(root).find((one) => one.slug === SLUG)?.parts ?? []
  return { root, write, parts }
}

describe('there is one derivation, and it is the protocol’s', () => {
  test('this host’s `partsOf` and `slugFrom` are the protocol’s own functions, not copies of them', () => {
    expect(partsOf).toBe(protocolPartsOf)
    expect(slugFrom).toBe(protocolSlugFrom)
    expect(epicSlugFrom).toBe(protocolSlugFrom)
  })
})

describe('a part arranged in Journeys reaches the bar', () => {
  test('a change to the journeys is announced as a change to what this host answers', () => {
    const contents = new Contents()
    const said = contents.announce('/p', JOURNEYS_MODULE, SLUG)
    /* The entry `App.tsx` reads `epics.list` again on. */
    expect(said.some((one) => one.source === CONTENT_HOST && one.epic === SLUG)).toBe(true)
  })

  test('made, reworded and removed: the row follows the record each time it is read', () => {
    const { write, parts } = project()
    write([])
    expect(parts()).toEqual([])

    /* Made — the way Journeys writes one: with its id on it from the start. */
    write([{ heading: 'The agent seam', refs: [], id: 'the-agent-seam' }])
    expect(parts()).toEqual([{ id: 'the-agent-seam', heading: 'The agent seam', refs: [], steps: 0 }])

    /* A step filed under it brings its refs. */
    write([{ heading: 'The agent seam', refs: [], id: 'the-agent-seam' }], [{ title: 'One', refs: ['gh#1'], part: 'the-agent-seam' }])
    expect(parts()).toEqual([{ id: 'the-agent-seam', heading: 'The agent seam', refs: ['gh#1'], steps: 1 }])

    /* Reworded: the id stays, so a stored focus on it still holds. */
    write([{ heading: 'Everything an agent touches', refs: [], id: 'the-agent-seam' }], [{ title: 'One', refs: ['gh#1'], part: 'the-agent-seam' }])
    expect(parts().map((part) => [part.id, part.heading])).toEqual([['the-agent-seam', 'Everything an agent touches']])
    expect(partsOnWire(parts(), ['the-agent-seam']).map((part) => part.picked)).toEqual([true])
    expect(goneSaid(parts(), ['the-agent-seam'])).toBeNull()

    /* Removed: the step is still there, and says no part. */
    write([{ heading: 'Later', refs: [], id: 'later' }], [{ title: 'One', refs: ['gh#1'] }])
    expect(parts().map((part) => part.id)).toEqual(['later'])
  })
})

describe('a focus on a part that has been removed', () => {
  const parts = partsOf({
    groups: [
      { heading: 'The posting seam', refs: ['gh#1'] },
      { heading: 'What the page shows', refs: ['gh#2'] },
    ],
  })

  test('hides nothing: no part goes out picked, so every module shows the whole epic', () => {
    const stored = ['the-agent-seam']
    expect(pickedIn(parts, stored)).toEqual([])
    expect(partsOnWire(parts, stored).some((part) => part.picked)).toBe(false)
    expect(focusSaid(parts, stored).narrowed).toBe(false)
  })

  test('and the bar says so, with the list to store once it is forgotten', () => {
    const said = goneSaid(parts, ['the-agent-seam'])
    expect(said).toMatchObject({ gone: ['the-agent-seam'], kept: [], label: 'a picked part is gone' })
    expect(said?.hint).toContain('this project was focused on a part this epic no longer has (the-agent-seam)')
    expect(said?.hint).toContain('every module is shown the whole epic')
  })

  test('one gone and one still here: narrowed to the one, and the other is still said', () => {
    const stored = ['what-the-page-shows', 'the-agent-seam', 'another-gone']
    expect(partsOnWire(parts, stored).map((part) => part.picked)).toEqual([false, true])
    const said = goneSaid(parts, stored)
    expect(said).toMatchObject({ gone: ['the-agent-seam', 'another-gone'], kept: ['what-the-page-shows'], label: '2 picked parts are gone' })
    expect(said?.hint).toContain('the focus is the one part still here')
  })

  test('nothing is said when every stored pick is a part, or none is stored', () => {
    expect(goneSaid(parts, [])).toBeNull()
    expect(goneSaid(parts, ['the-posting-seam', 'what-the-page-shows'])).toBeNull()
  })
})
