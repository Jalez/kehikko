import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ActivityDot } from '../src/canvas/Activity.tsx'
import { EpicSize } from '../src/canvas/Epics.tsx'
import { HIT_AREA, Remove, RowPencil, removeWords } from '../src/canvas/Menu.tsx'
import { sizeWords } from '../src/host/projects.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listEpics, sizePartsOf } from '../server/holdings.ts'

const noop = () => {}

describe('the number on an epic row', () => {
  test('names only the non-zero parts, singular at one', () => {
    expect(sizeWords({ parts: 20, steps: 26, exists: 5, open: 3 })).toBe(
      '20 parts · 26 steps · 5 already in place · 3 open questions',
    )
    expect(sizeWords({ parts: 1, steps: 1, exists: 0, open: 1 })).toBe('1 part · 1 step · 1 open question')
    expect(sizeWords({ parts: 0, steps: 9, exists: 3, open: 0 })).toBe('no parts yet · 9 steps · 3 already in place')
  })

  test('the number carries the same words as its label', () => {
    const html = renderToStaticMarkup(<EpicSize size={12} parts={{ parts: 12, steps: 1, exists: 7, open: 4 }} />)
    expect(html).toContain('aria-label="12 parts · 1 step · 7 already in place · 4 open questions"')
    expect(html).toContain('>12<')
  })

  test('an older server, with no breakdown, still gets a label', () => {
    expect(renderToStaticMarkup(<EpicSize size={5} />)).toContain('aria-label="5: ')
  })
})

describe('the breakdown the server sends', () => {
  test('is the lists kept apart, and null where there is nothing or the steps are elsewhere', () => {
    expect(sizePartsOf({ steps: [1, 2], exists: [1], open: [1, 2, 3] }, 4)).toEqual({ parts: 4, steps: 2, exists: 1, open: 3 })
    expect(sizePartsOf({ open: [1] }, 0)).toEqual({ parts: 0, steps: 0, exists: 0, open: 1 })
    expect(sizePartsOf({}, 0)).toBeNull()
    expect(sizePartsOf({ steps: [], exists: [], open: [] }, 0)).toBeNull()
    expect(
      sizePartsOf({ steps: [], open: [1], stepsFrom: { projector: 'paper', where: 'a.tex', why: 'Sections.' } }, 3),
    ).toBeNull()
  })

  test('the number on the row is the count the parts menu shows, and steps stand in for no parts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kehikko-size-'))
    const epics = join(dir, '.kehikot', 'kehikko', 'epics')
    mkdirSync(epics, { recursive: true })
    const parts = ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase() }))
    const write = (slug: string, body: object) => writeFileSync(join(epics, `${slug}.json`), JSON.stringify({ slug, ...body }))
    write('divided', { parts, steps: [{ title: 's1' }, { title: 's2' }], exists: [{}], open: [{}, {}] })
    write('flat', { steps: [{ title: 's1' }, { title: 's2' }] })
    write('empty', {})
    const rows = listEpics(dir)
    const divided = rows.find((r) => r.slug === 'divided')!
    expect(divided.parts?.length).toBe(3)
    expect(divided.size).toBe(3)
    expect(divided.sizeParts).toEqual({ parts: 3, steps: 2, exists: 1, open: 2 })
    /* `row.parts` is what the page gives the Parts menu, whose "all N parts" is its length. */
    const flat = rows.find((r) => r.slug === 'flat')!
    expect(flat.size).toBe(2)
    expect(flat.sizeParts).toEqual({ parts: 0, steps: 2, exists: 0, open: 0 })
    const empty = rows.find((r) => r.slug === 'empty')!
    expect('size' in empty).toBe(false)
    expect('sizeParts' in empty).toBe(false)
  })
})

describe('icon controls in the pick lists', () => {
  test('a remove says what it does, or why it is flat, and has no native title', () => {
    expect(removeWords({ label: 'delete thesis' })).toBe('delete thesis')
    expect(removeWords({ label: 'remove it', why: 'the only kehikko cannot be removed' })).toBe(
      'the only kehikko cannot be removed',
    )
    const html = renderToStaticMarkup(
      <Remove armed={false} label="delete thesis" question="delete its file?" onArm={noop} onConfirm={noop} />,
    )
    expect(html).not.toContain('title=')
    expect(html).toContain('aria-label="delete thesis"')
  })

  test('a remove reaches 24px: the glyph is 12 and the pseudo-element adds 6 on each side', () => {
    expect(HIT_AREA).toContain('after:-inset-1.5')
    const html = renderToStaticMarkup(
      <Remove armed={false} label="delete thesis" question="delete its file?" onArm={noop} onConfirm={noop} />,
    )
    expect(html).toContain('after:-inset-1.5')
    expect(html).toContain('size-3')
  })

  test('the armed confirm is as easy to hit', () => {
    const html = renderToStaticMarkup(
      <Remove armed label="delete thesis" question="delete its file?" onArm={noop} onConfirm={noop} />,
    )
    expect(html).toContain('delete its file?')
    expect(html).toContain('after:-inset-y-1.5')
  })

  test('the pencil has the same reach and no native title', () => {
    const html = renderToStaticMarkup(<RowPencil label="rename x" title="rename (F2)" onStart={noop} />)
    expect(html).toContain('after:-inset-1.5')
    expect(html).not.toContain('title=')
    expect(html).toContain('aria-label="rename x"')
  })

  test('an activity dot labels its state and has no native title', () => {
    const html = renderToStaticMarkup(<ActivityDot state="attention" what="thesis" />)
    expect(html).toContain('aria-label="thesis — ')
    expect(html).not.toContain('title=')
  })
})
