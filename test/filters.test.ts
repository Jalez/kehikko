import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import type { FilterGroup } from 'roadmap-module-protocol'

import { Label } from '../src/canvas/Filters.tsx'
import { chosen, narrowed, sameChoice, settle } from '../src/host/filters.ts'
import { whileFrozen } from '../src/host/context.ts'
import { contextSchema } from 'roadmap-module-protocol'

/**
 * What the host does with a filter, which is as close to nothing as it can be —
 * and the two ways that "nothing" can go wrong.
 *
 * The first is a remembered choice that outlives the thing it referred to. The
 * second is a stranger's string reaching the layout of the host's own chrome.
 * Both are silent when they happen, and both have already happened here in
 * other forms.
 */

const ignored: FilterGroup = {
  id: 'ignored',
  label: 'ignored files',
  fallback: 'hide',
  options: [
    { id: 'hide', label: 'hide 3 ignored' },
    { id: 'show', label: 'show them' },
  ],
}

const scope: FilterGroup = {
  id: 'scope',
  label: 'which kehikko',
  fallback: 'all',
  options: [
    { id: 'all', label: 'everything' },
    { id: 'here', label: 'this kehikko' },
    { id: 'none', label: 'no kehikko' },
  ],
}

describe('a module is never told a choice it does not offer', () => {
  test('nothing stored is every group at the option its own module named', () => {
    expect(chosen([ignored, scope], {})).toEqual({ ignored: 'hide', scope: 'all' })
  })

  test('a stored choice the module still offers survives', () => {
    expect(chosen([scope], { scope: 'here' })).toEqual({ scope: 'here' })
  })

  /*
   * The failure this whole reconciliation exists for. A module ships a new
   * version with different options and a container is left narrowed by a value
   * that is in no menu: nothing errors, the person sees less than they expect,
   * and there is nothing to press to get the rest back because the thing to
   * press is not there.
   */
  test('a stored option the module no longer offers falls back rather than filtering', () => {
    expect(chosen([scope], { scope: 'this-kehikko-old-spelling' })).toEqual({ scope: 'all' })
  })

  test('a stored group the module no longer has does not reach the module at all', () => {
    expect(chosen([scope], { resolved: 'hide', scope: 'here' })).toEqual({ scope: 'here' })
  })

  /*
   * The answer is built from the offer, so nothing in the store can put a key
   * in it. `constructor` is the one that matters: read off a plain object it
   * finds something inherited that nobody ever chose.
   */
  test('a stored key that is not really a key finds nothing', () => {
    const stored = JSON.parse('{"constructor": "show", "__proto__": "show"}') as Record<string, string>
    expect(chosen([ignored], stored)).toEqual({ ignored: 'hide' })
  })

  test('a module offering nothing is told nothing, whatever is stored', () => {
    expect(chosen([], { scope: 'here' })).toEqual({})
  })
})

describe('what gets written down is less than what gets sent', () => {
  test('a group at its resting option is not stored', () => {
    expect(settle([scope], { scope: 'all' })).toEqual({})
  })

  /*
   * Because a store that recorded "this one is at its default" could not tell
   * somebody who chose the default from somebody who never chose anything — and
   * only one of those should survive the module changing its mind about what
   * the default is.
   */
  test('so a module that changes its default moves the container that never chose', () => {
    const before = settle([scope], { scope: 'all' })
    const relabelled: FilterGroup = { ...scope, fallback: 'here' }
    expect(chosen([relabelled], before)).toEqual({ scope: 'here' })
  })

  test('and does not move the container that chose the old default on purpose', () => {
    const before = settle([scope], { scope: 'none' })
    const relabelled: FilterGroup = { ...scope, fallback: 'here' }
    expect(chosen([relabelled], before)).toEqual({ scope: 'none' })
  })

  /*
   * Reconciling only on read would leave a dead value in the database forever,
   * invisible, ready to come back to life under the same spelling two versions
   * later — attached to a press somebody made before either version existed.
   */
  test('a value for a group the module dropped is pruned, not merely ignored', () => {
    expect(settle([scope], { resolved: 'hide', scope: 'here' })).toEqual({ scope: 'here' })
  })

  test('and one naming an option that is gone goes with it', () => {
    expect(settle([scope], { scope: 'gone' })).toEqual({})
  })
})

describe('the one thing the host can honestly say', () => {
  test('nothing narrowed when every group is where its module left it', () => {
    expect(narrowed([ignored, scope], { ignored: 'hide', scope: 'all' })).toBe(false)
  })

  test('narrowed when any one group is not', () => {
    expect(narrowed([ignored, scope], { ignored: 'hide', scope: 'none' })).toBe(true)
  })

  test('a module offering nothing is never narrowed', () => {
    expect(narrowed([], {})).toBe(false)
  })
})

describe('a press reaches a pinned container', () => {
  /*
   * A pin freezes what a container is ABOUT. A filter is not about anything: it
   * is how this one container is being looked at, and the person setting it is
   * pressing a control on that container's own header while looking straight at
   * it. A pinned container that swallowed the press would leave the header
   * reading "narrowed" — the host stores the choice either way — while the
   * module went on showing everything.
   */
  const held = contextSchema.parse({ epic: 'a', filters: { scope: 'here' } })

  test('a changed filter gets through the freeze', () => {
    const told = contextSchema.parse({ epic: 'b', filters: { scope: 'none' } })
    expect(whileFrozen(held, told)?.filters).toEqual({ scope: 'none' })
  })

  test('and everything the pin froze stays frozen while it does', () => {
    const told = contextSchema.parse({ epic: 'b', filters: { scope: 'none' } })
    expect(whileFrozen(held, told)?.epic).toBe('a')
  })

  test('an unchanged filter is still silence, so the host does not repeat itself', () => {
    const told = contextSchema.parse({ epic: 'b', filters: { scope: 'here' } })
    expect(whileFrozen(held, told)).toBeNull()
  })

  test('and a record rebuilt with the same contents is not a change', () => {
    expect(sameChoice({ scope: 'here' }, { ...{ scope: 'here' } })).toBe(true)
    expect(sameChoice({ scope: 'here' }, { scope: 'none' })).toBe(false)
    expect(sameChoice({ scope: 'here' }, {})).toBe(false)
  })
})

/**
 * The regression this workspace has already paid for once.
 *
 * A `whitespace-nowrap` element carrying a variable string puts a min-content
 * floor under every flex and grid ancestor it has. A sibling module put one in
 * a badge and gave a 220-pixel container an 1187-pixel floor, which does not
 * read as a badge bug — it reads as the whole window refusing to be narrow.
 * Filter labels are exactly that shape of string arriving from a new direction:
 * written by somebody else's program, laid out inside the host's own chrome.
 *
 * There is no browser here to measure in, so these test the two things that
 * actually decide it, and they are both structural rather than visual.
 */
describe('a module’s label cannot widen anything', () => {
  const enormous = 'W'.repeat(4000)

  test('every module string is rendered in an element that may shrink and will clip', () => {
    const html = renderToStaticMarkup(createElement(Label, { text: enormous }))
    /* `truncate` is `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`
       — which on its own is the hazard. `min-w-0` is what makes it safe inside a
       flex child, and its absence is the exact shape of the bug: without it, a
       flex child takes its min-content width from the text and refuses to
       shrink, nowrap or not. */
    expect(html).toContain('truncate')
    expect(html).toContain('min-w-0')
  })

  test('and the whole of it is still readable, in a title', () => {
    const html = renderToStaticMarkup(createElement(Label, { text: enormous }))
    expect(html).toContain(`title="${enormous}"`)
  })

  /*
   * The two rules that keep the above from being got round. `Badge` is
   * `whitespace-nowrap` in shadcn's base with no `min-w-0` anywhere, so a label
   * put in one reintroduces the 1187-pixel floor with no test failing; and a
   * bare `whitespace-nowrap` in this file would do the same thing by hand.
   *
   * A source check rather than a render, because what is being defended is that
   * no FUTURE call site does it — a rendering test can only see the call sites
   * that exist.
   */
  /* Comments stripped, because both words below are discussed at length in this
     file's own essays — a check that could be satisfied by editing a paragraph
     is not a check. What is left is the code. */
  const source = readFileSync(new URL('../src/canvas/Filters.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  test('no badge anywhere near a module’s words', () => {
    expect(source).not.toContain('Badge')
  })

  test('and no hand-written nowrap either', () => {
    expect(source).not.toContain('whitespace-nowrap')
  })

  /*
   * The strongest of the three, and the reason `Label` exists as a component at
   * all rather than as three attributes repeated at three call sites: the
   * header button carries an icon and no module string whatsoever, so there is
   * nothing in the container header for a label to widen even if every rule
   * above were broken at once.
   */
  test('the header control renders no module string at all', () => {
    const button = source.slice(source.indexOf('DropdownMenuTrigger'), source.indexOf('DropdownMenuContent'))
    expect(button).not.toContain('option.label')
    expect(button).not.toContain('group.label')
  })
})
