import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import type { FilterGroup } from 'roadmap-module-protocol'

import { Label, saying } from '../src/canvas/Filters.tsx'
import { chosen, narrowed, sameChoice, settle } from '../src/host/filters.ts'
import { whileFrozen } from '../src/host/context.ts'
import { LIMITS, contextSchema } from 'roadmap-module-protocol'

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
  /*
   * `<` on both ends, and it is not a detail. Without the angle brackets these
   * matched the IMPORT list at the top of the file, where `DropdownMenuContent`
   * is named before `DropdownMenuTrigger` — so the slice ran from a later index
   * to an earlier one and came back empty, and `expect('').not.toContain(...)`
   * passes for every input there has ever been. The test was green from the day
   * it was written and was asserting nothing at all.
   *
   * It was found by writing a POSITIVE assertion against the same slice: a
   * check that something IS in the button fails loudly on an empty string,
   * where a check that something is not in it cannot. Worth remembering as a
   * shape — a source-slice test made only of `not.toContain` cannot tell you
   * whether it found the source.
   */
  const inTheButton = (from: string) =>
    from.slice(from.indexOf('<DropdownMenuTrigger'), from.indexOf('<DropdownMenuContent'))

  test('the slice this is asserted against is really the button', () => {
    expect(inTheButton(source).length).toBeGreaterThan(0)
    expect(inTheButton(source)).toContain('aria-label')
  })

  test('the header control renders no module string at all', () => {
    const button = inTheButton(source)
    expect(button).not.toContain('option.label')
    expect(button).not.toContain('group.label')
  })
})

/**
 * The control a person was told they had and could not find.
 *
 * Its accessible name was "what Notifications shows". Every word of that is
 * true, and the control was in practice invisible: the owner of this host went
 * looking for a filter among seven unlabelled icons in a container header and
 * reported it missing. It was in front of them. Nobody hunting for a filter
 * searches for the phrase "what Notifications shows", and the word "filter"
 * appeared nowhere on the screen, in any tooltip, or in any accessible name.
 *
 * This workspace has already removed a control for exactly this failure — the
 * refresh button, whose essay in `Bar.tsx` says that a control nobody can name
 * is one pressed by accident or never at all. That one could be deleted,
 * because the capability behind it could happen without a button. This one
 * cannot, so it is renamed instead — and the naming is a pure function so that
 * a test can hold it there. Two ternaries at a call site are a wording nothing
 * can assert against, which is a wording that drifts back.
 */
describe('a control has to say what it is', () => {
  test('the word somebody would actually go looking for is in the name', () => {
    expect(saying('Notifications', false).name).toContain('filter')
    expect(saying('Notifications', true).name).toContain('filter')
  })

  /*
   * And in the tooltip, which is the version read with the eyes rather than
   * heard. Both, because they reach different people, and only one of them is
   * the accessible name — see the essay in `Hint.tsx` on why the tooltip is
   * deliberately not it.
   */
  test('and in the sentence shown on hover or focus', () => {
    expect(saying('Notifications', false).hint).toContain('filter')
    expect(saying('Notifications', true).hint).toContain('filter')
  })

  /*
   * The module's name stays in it. A container header is six icon buttons, and
   * read out one after another "filter", "pin", "fold" say nothing about WHICH
   * container is being talked about. Every other control in that header names
   * its module for the same reason.
   */
  test('the module is named, because six identical icons are not', () => {
    expect(saying('Notifications', false).name).toContain('Notifications')
    expect(saying('Notifications', true).name).toContain('Notifications')
  })

  /*
   * The verb does not swap round the way the pin's and the fold's do, because
   * pressing this does the same thing in either state: it opens a menu. What
   * changes is the state appended to it — which `aria-pressed` carries as well,
   * and saying it twice is deliberate, because a screen reader may or may not
   * announce a pressed state along with the name.
   */
  test('and the name says when something is being hidden', () => {
    expect(saying('Notifications', true).name).not.toBe(saying('Notifications', false).name)
    expect(saying('Notifications', true).name).toContain('narrowed')
    expect(saying('Notifications', false).name).not.toContain('narrowed')
  })

  /*
   * The icon is drawn at full weight whenever the control exists at all, which
   * is a departure from the pin and the fold beside it and is argued at length
   * in `Filters.tsx`. The short version: those are on every container in one of
   * two states, so weight is how the state is read; this one is on almost no
   * containers, so its presence IS the message — "this module can be narrowed"
   * — and a fifth grey icon in a row of grey icons does not deliver it. A
   * container with an offer and nothing chosen used to be indistinguishable at
   * a glance from a container with nothing to filter.
   *
   * Whether anything is actually narrowed is said with fill instead, which
   * costs no pixels. That was the constraint that ruled out a dot, a count and
   * a word: the header is a flex row with six controls and a truncating name
   * in a container that is routinely 220 pixels wide, and its surplus was
   * clipping the remove button until recently.
   */
  const trigger = readFileSync(new URL('../src/canvas/Filters.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const button = trigger.slice(trigger.indexOf('<DropdownMenuTrigger'), trigger.indexOf('<DropdownMenuContent'))

  test('the slice this is asserted against is really the button', () => {
    expect(button.length).toBeGreaterThan(0)
  })

  test('the icon is not dim when a module has an offer and nothing is chosen', () => {
    expect(button).not.toContain('text-muted-foreground')
    expect(button).toContain('text-foreground')
  })

  test('and it fills in when something is', () => {
    expect(button).toContain('fill-current')
  })
})

/**
 * The second kind of group, which the host understands exactly as little of as
 * the first.
 *
 * A typed value has no options to reconcile against and no fallback to fall to,
 * and both absences are one fact: its resting state is empty, and empty is
 * spelled by not being in the record. What is worth testing is that each of
 * this file's three functions does the right nothing with one.
 */
describe('a group somebody types into', () => {
  const search: FilterGroup = { id: 'search', label: 'search', kind: 'text', options: [] }
  const kinds: FilterGroup = {
    id: 'kind',
    label: 'kind',
    fallback: 'all',
    options: [
      { id: 'all', label: 'All 24' },
      { id: 'issue', label: 'Issues 17' },
    ],
  }

  test('what was typed is handed back to the module as it stands', () => {
    expect(chosen([search], { search: 'rbac jaakko' })).toEqual({ search: 'rbac jaakko' })
  })

  /*
   * The asymmetry with a choice group, and the reason for it. `chosen` fills in
   * every choice group even when nobody has pressed it, because the module has
   * to be told which option it is on. There is no equivalent for an input: the
   * honest value for "nothing typed" is nothing, and a key with an empty string
   * under it would be a module told it had been narrowed by the empty query.
   */
  test('an empty one is absent rather than an empty string', () => {
    expect(chosen([search], {})).toEqual({})
    expect(chosen([search], { search: '' })).toEqual({})
    expect(chosen([kinds], {})).toEqual({ kind: 'all' })
  })

  test('a value nobody offers a menu for is still kept, because it is not a menu', () => {
    /* The one place a text group must NOT behave like a choice group. A stored
       option id that is in no menu is unreachable and is dropped; a stored
       QUERY is right there in the input to be edited, and dropping it would
       throw away what somebody typed every time a module restarted. */
    expect(settle([search], { search: 'anything at all' })).toEqual({ search: 'anything at all' })
    expect(settle([kinds], { kind: 'gone' })).toEqual({})
  })

  test('and an empty one is dropped, exactly as a group on its resting option is', () => {
    expect(settle([search], { search: '' })).toEqual({})
    expect(settle([kinds], { kind: 'all' })).toEqual({})
  })

  test('a long one is clipped rather than refused', () => {
    const long = 'x'.repeat(LIMITS.FILTER_TEXT + 50)
    expect(settle([search], { search: long }).search).toHaveLength(LIMITS.FILTER_TEXT)
  })

  /*
   * The always-visible signal. The host cannot know what a query will match and
   * does not need to: the claim it makes by filling the funnel is "something
   * has been typed here", which is exactly as true as "something other than the
   * resting option is pressed", and is the same thing a person needs to see
   * when a list looks short.
   */
  test('anything typed counts as narrowed, and nothing typed does not', () => {
    expect(narrowed([search], { search: 'rbac' })).toBe(true)
    expect(narrowed([search], { search: '' })).toBe(false)
    expect(narrowed([search], {})).toBe(false)
  })

  test('the two kinds compose in one offer, which is the case this was built for', () => {
    expect(chosen([kinds, search], { kind: 'issue', search: 'rbac' })).toEqual({
      kind: 'issue',
      search: 'rbac',
    })
    expect(settle([kinds, search], { kind: 'all', search: 'rbac' })).toEqual({ search: 'rbac' })
  })
})
