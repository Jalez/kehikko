import { describe, expect, test } from 'bun:test'

import { COVER_SHORT, LINE_BELOW, SMALL_BELOW_HEIGHT, SMALL_BELOW_WIDTH, coverLayoutFor, standingHint, standingOf } from '../src/host/coverFit.ts'
import { COVER_WORDS, noticeOf, type Showing } from '../src/host/standing.ts'

/* Which cover a container draws for the room it has (`src/host/coverFit.ts`). */

describe('coverLayoutFor', () => {
  test('folded to one row is the header, whatever was measured', () => {
    expect(coverLayoutFor(600, 600, 1)).toBe('header')
    expect(coverLayoutFor(null, null, 1)).toBe('header')
  })

  test('folded to two rows is one line', () => {
    expect(coverLayoutFor(600, 600, 2)).toBe('line')
  })

  test('not measured yet is the full cover', () => {
    expect(coverLayoutFor(null, null, 0)).toBe('full')
    expect(coverLayoutFor(0, 0, 0)).toBe('full')
  })

  test('under the line height is one line, at any width', () => {
    expect(coverLayoutFor(800, LINE_BELOW - 1, 0)).toBe('line')
    expect(coverLayoutFor(120, 40, 0)).toBe('line')
  })

  test('short or narrow is small', () => {
    expect(coverLayoutFor(800, LINE_BELOW, 0)).toBe('small')
    expect(coverLayoutFor(800, SMALL_BELOW_HEIGHT - 1, 0)).toBe('small')
    expect(coverLayoutFor(SMALL_BELOW_WIDTH - 1, 600, 0)).toBe('small')
  })

  test('enough room is the full cover', () => {
    expect(coverLayoutFor(SMALL_BELOW_WIDTH, SMALL_BELOW_HEIGHT, 0)).toBe('full')
    expect(coverLayoutFor(1200, 900, 0)).toBe('full')
  })
})

describe('standingOf', () => {
  const at = 'http://127.0.0.1:8110'

  test('a cover: the short word, the sentence, no press, and the address only as detail', () => {
    const one = standingOf({ kind: 'cover', state: 'updating' }, null, at)
    expect(one).toEqual({ tone: 'working', word: COVER_SHORT.updating, sentence: COVER_WORDS.updating, more: [at], action: null })
    expect(one.word).not.toContain(at)
    expect(standingHint(one).split('\n')).toEqual([COVER_WORDS.updating, at])
  })

  test('a restart that failed: Failed, Retry restart, and what it printed before the address', () => {
    const showing: Extract<Showing, { kind: 'notice' }> = { kind: 'notice', condition: 'silent', asleep: false, line: 'It did not come back.', restartFailed: ['boom'] }
    const one = standingOf(showing, noticeOf(showing, {}), at)
    expect(one.tone).toBe('failed')
    expect(one.word).toBe('Failed')
    expect(one.action).toEqual({ kind: 'retry', label: 'Retry restart' })
    expect(one.more).toEqual(['boom', at])
  })

  test('a module that is not running: Stopped, and Start', () => {
    const showing: Extract<Showing, { kind: 'notice' }> = { kind: 'notice', condition: 'silent', asleep: false, line: 'Nothing answers.' }
    const one = standingOf(showing, noticeOf(showing, {}), at)
    expect([one.word, one.action?.kind]).toEqual(['Stopped', 'start'])
    const asleep = standingOf({ ...showing, asleep: true }, noticeOf({ ...showing, asleep: true }, {}), at)
    expect(asleep.word).toBe('Asleep')
  })
})
