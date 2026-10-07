import { describe, expect, test } from 'bun:test'
import { JOURNEYS_MODULE } from 'kehikot-module-protocol'

import {
  MAKER,
  PARTS_REF,
  makerOf,
  nextMove,
  unansweredSaid,
  undividedSaid,
  unopenedSaid,
  type Maker,
} from '../src/host/dividing.ts'
import type { OfficialModule } from '../src/host/official.ts'
import { Presses } from '../src/host/presses.ts'

/**
 * An epic with no parts, and the one press that gets a person to where one is
 * made.
 *
 * Three questions, each answered by a pure function: where is the module that
 * makes parts; what is the next thing to do about that; and what does the bar
 * say meanwhile. The effect that strings them together is driven in a browser.
 */

const journeys = { id: JOURNEYS_MODULE, name: 'Journeys' }
const paper = { id: 'kehikot.paper', name: 'Paper' }
const listed = (more: Partial<OfficialModule> = {}): OfficialModule => ({
  id: JOURNEYS_MODULE,
  name: 'Journeys',
  repo: 'Jalez/kehikko-journeys',
  summary: '',
  tags: [],
  installed: false,
  ...more,
})

describe('where the module that makes parts is', () => {
  test('it is Journeys, by the protocol’s own spelling of its id', () => {
    expect(MAKER).toBe(JOURNEYS_MODULE)
    expect(MAKER).toBe('kehikot.journeys')
  })

  test('on this kehikko — and whether its container is folded', () => {
    expect(makerOf([journeys, paper], [{ i: MAKER }, { i: 'kehikot.paper' }], null)).toEqual({ at: 'here', name: 'Journeys', collapsed: false })
    expect(makerOf([journeys], [{ i: MAKER, collapsed: true }], null)).toEqual({ at: 'here', name: 'Journeys', collapsed: true })
  })

  test('registered and not on this kehikko, whatever the official list says', () => {
    expect(makerOf([journeys, paper], [{ i: 'kehikot.paper' }], null)).toEqual({ at: 'elsewhere', name: 'Journeys' })
    expect(makerOf([journeys], [], [listed({ installed: true })])).toEqual({ at: 'elsewhere', name: 'Journeys' })
  })

  test('a placement left behind by a module that is no longer registered is not “here”', () => {
    expect(makerOf([paper], [{ i: MAKER }], [listed()])).toMatchObject({ at: 'shelf' })
  })

  test('not installed: on the official list, with the step an install is on or why it stopped', () => {
    expect(makerOf([paper], [], [listed()])).toEqual({ at: 'shelf', name: 'Journeys', step: null, failed: null })
    expect(makerOf([], [], [listed({ install: { state: 'installing', step: 'cloning' } })])).toMatchObject({ at: 'shelf', step: 'cloning', failed: null })
    expect(makerOf([], [], [listed({ install: { state: 'failed', why: 'git said no' } })])).toMatchObject({ at: 'shelf', step: null, failed: 'git said no' })
  })

  test('still looking: the list has not been read, or says installed before the sweep has found it', () => {
    expect(makerOf([paper], [], null)).toEqual({ at: 'looking', name: 'Journeys' })
    expect(makerOf([], [], [listed({ installed: true })])).toEqual({ at: 'looking', name: 'Journeys' })
  })

  test('nowhere: not registered and not on the list, or the list could not be read', () => {
    expect(makerOf([paper], [], [])).toEqual({ at: 'nowhere', name: 'Journeys', why: null })
    expect(makerOf([], [], null, 'the host’s server answered 502')).toEqual({ at: 'nowhere', name: 'Journeys', why: 'the host’s server answered 502' })
  })
})

describe('the next step toward the parts', () => {
  const at = (maker: Maker) => nextMove(maker)

  test('one step at a time, each read off where Journeys is now', () => {
    expect(at({ at: 'shelf', name: 'Journeys', step: null, failed: null })).toBe('install')
    expect(at({ at: 'shelf', name: 'Journeys', step: 'installing', failed: null })).toBe('wait')
    expect(at({ at: 'looking', name: 'Journeys' })).toBe('wait')
    expect(at({ at: 'elsewhere', name: 'Journeys' })).toBe('place')
    expect(at({ at: 'here', name: 'Journeys', collapsed: true })).toBe('unfold')
    expect(at({ at: 'here', name: 'Journeys', collapsed: false })).toBe('walk')
  })

  test('and nothing at all when there is nothing this host can do', () => {
    expect(at({ at: 'shelf', name: 'Journeys', step: null, failed: 'git said no' })).toBe('stop')
    expect(at({ at: 'nowhere', name: 'Journeys', why: null })).toBe('stop')
  })
})

describe('what the bar says about an epic with no parts', () => {
  test('always: that it is not divided, and what a part is for', () => {
    const said = undividedSaid({ at: 'here', name: 'Journeys', collapsed: false })
    expect(said.label).toBe('no parts')
    expect(said.lead).toContain('This epic is not divided into parts yet.')
    expect(said.lead).toContain('ticked here to point every module at those only')
  })

  test('Journeys on this kehikko: one press, named for what it does', () => {
    expect(undividedSaid({ at: 'here', name: 'Journeys', collapsed: true })).toMatchObject({
      where: 'Parts are made in Journeys, which is on this kehikko.',
      press: 'divide this epic into parts in Journeys',
      busy: false,
      trouble: null,
    })
  })

  test('Journeys not on this kehikko: says so, and the press puts it here first', () => {
    expect(undividedSaid({ at: 'elsewhere', name: 'Journeys' })).toMatchObject({
      where: 'Parts are made in Journeys, which is not on this kehikko.',
      press: 'put Journeys here and divide this epic into parts',
    })
  })

  test('Journeys not installed: says so, and the press installs it', () => {
    expect(undividedSaid({ at: 'shelf', name: 'Journeys', step: null, failed: null })).toMatchObject({
      where: 'Parts are made in Journeys, which is not installed on this computer.',
      press: 'install Journeys and divide this epic into parts',
    })
    /* An install that stopped says why, and the press is to try again. */
    expect(undividedSaid({ at: 'shelf', name: 'Journeys', step: null, failed: 'git said no' })).toMatchObject({
      press: 'try installing Journeys again',
      trouble: 'Journeys did not install: git said no',
    })
    /* One somebody else started is said, with no second press to race it. */
    expect(undividedSaid({ at: 'shelf', name: 'Journeys', step: 'cloning', failed: null })).toMatchObject({ press: null, busy: true })
  })

  test('Journeys nowhere to be found: a sentence and no press', () => {
    const said = undividedSaid({ at: 'nowhere', name: 'Journeys', why: null })
    expect(said.press).toBeNull()
    expect(said.where).toContain('this host cannot find it: it is not registered on this computer and is not on the list of modules it can install.')
    expect(undividedSaid({ at: 'nowhere', name: 'Journeys', why: 'the host’s server answered 502' }).where).toContain('could not be read (the host’s server answered 502)')
  })

  test('while a press is in flight it says which step, and offers no second press', () => {
    const shelf: Maker = { at: 'shelf', name: 'Journeys', step: 'cloning', failed: null }
    expect(undividedSaid(shelf, { epic: 'thesis', step: 'installing' })).toMatchObject({
      where: 'Installing Journeys — cloning… It is put on this kehikko and opened on this epic’s parts when it is ready.',
      press: null,
      busy: true,
    })
    expect(undividedSaid({ at: 'elsewhere', name: 'Journeys' }, { epic: 'thesis', step: 'placing' }).where).toBe('Putting Journeys on this kehikko…')
    expect(undividedSaid({ at: 'here', name: 'Journeys', collapsed: false }, { epic: 'thesis', step: 'opening' }).where).toBe('Opening this epic’s parts in Journeys…')
  })

  test('a press that did not arrive leaves its sentence, and the press is still there', () => {
    const said = undividedSaid({ at: 'here', name: 'Journeys', collapsed: false }, null, unansweredSaid('Journeys'))
    expect(said.trouble).toContain('Journeys is on this kehikko and has not answered yet')
    expect(said.press).toBe('divide this epic into parts in Journeys')
  })

  test('a module that answered and did not open its parts is quoted, not paraphrased', () => {
    expect(unopenedSaid('Journeys', 'Nothing in this journey names journeys:parts.')).toBe(
      'Journeys is on this kehikko and did not open its parts — it answered “Nothing in this journey names journeys:parts.”. '
        + 'Press “divide into parts” in Journeys itself; if there is no such press, it is an older Journeys and wants updating.',
    )
  })
})

describe('the walk itself', () => {
  test('names a reference no tracker issues', () => {
    expect(PARTS_REF).toBe('journeys:parts')
  })

  test('reaches the frame it names and hands back what the module answered', async () => {
    const presses = new Presses()
    const asked: unknown[] = []
    presses.join(MAKER, {
      clear: () => {},
      refresh: () => {},
      walk: (target) => {
        asked.push(target)
        return Promise.resolve({ found: true, why: '' })
      },
    })
    expect(await presses.walk(MAKER, { ref: PARTS_REF, epic: 'thesis' })).toEqual({ found: true, why: '' })
    expect(asked).toEqual([{ ref: PARTS_REF, epic: 'thesis' }])
  })

  test('a module with no frame yet is null — “not yet”, which is not “found nothing”', () => {
    expect(new Presses().walk(MAKER, { ref: PARTS_REF })).toBeNull()
  })
})
