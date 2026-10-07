import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { Parts } from '../src/canvas/Parts.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import type { Part } from '../src/host/parts.ts'

/**
 * The control in the bar, as it stands before anybody opens it.
 *
 * What is asserted is the closed state, on purpose: the failure this control
 * can have is a focus nobody can see, and what a person sees without pressing
 * anything is the trigger.
 */

const parts: Part[] = [
  { id: 'the-posting-seam', heading: 'The posting seam', refs: ['gh#1', 'gh#3'], steps: 0 },
  { id: 'the-agent-seam', heading: 'The agent seam', refs: ['gh#4'], steps: 2 },
  { id: 'what-the-page-shows', heading: 'What the page shows', refs: [], steps: 0 },
]

function draw(list: readonly Part[], picked: readonly string[]): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <Parts parts={list} picked={picked} onPick={() => {}} />
    </TooltipProvider>,
  )
}

describe('the parts control', () => {
  test('an epic with no parts draws nothing at all', () => {
    expect(draw([], [])).toBe('')
    /* Even with something stored: there is nothing for it to be a part of. */
    expect(draw([], ['the-posting-seam'])).toBe('')
  })

  test('nothing picked says all parts, quietly, and offers no clear button', () => {
    const html = draw(parts, [])
    expect(html).toContain('all parts')
    expect(html).toContain('all of them are shown')
    expect(html).not.toContain('data-narrowed')
    expect(html).not.toContain('clear the focus')
  })

  test('one part picked puts its name in the bar, filled, with a way out beside it', () => {
    const html = draw(parts, ['the-agent-seam'])
    expect(html).toContain('data-narrowed')
    expect(html).toContain('The agent seam')
    expect(html).toContain('focused on 1 of 3 parts of this epic')
    expect(html).toContain('clear the focus and show the whole epic')
    expect(html).not.toContain('all parts')
  })

  test('several picked says how many of how many', () => {
    const html = draw(parts, ['the-agent-seam', 'what-the-page-shows'])
    expect(html).toContain('2 of 3 parts')
    expect(html).toContain('focused on 2 of 3 parts of this epic')
  })

  test('a stored pick that names no part is not a focus', () => {
    const html = draw(parts, ['a-part-that-was-renamed'])
    expect(html).toContain('all parts')
    expect(html).not.toContain('data-narrowed')
  })

  test('and the bar says the part is gone, with one press to forget it', () => {
    const html = draw(parts, ['a-part-that-was-removed'])
    expect(html).toContain('data-gone="1"')
    expect(html).toContain('a picked part is gone')
    /* Nothing of the kind when every stored pick is a part, or none is stored. */
    expect(draw(parts, [])).not.toContain('data-gone')
    expect(draw(parts, ['the-agent-seam'])).not.toContain('data-gone')
  })

  test('one part gone and one still here: still narrowed to the one, and still said', () => {
    const html = draw(parts, ['the-agent-seam', 'a-part-that-was-removed'])
    expect(html).toContain('data-narrowed')
    expect(html).toContain('focused on 1 of 3 parts of this epic')
    expect(html).toContain('data-gone="1"')
  })
})
