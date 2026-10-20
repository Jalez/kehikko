import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

import { BranchMark } from '../src/canvas/Branch.tsx'
import { VersionPicker } from '../src/canvas/Versions.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import type { Source } from '../src/host/source.ts'

/**
 * The version and the branch sit side by side in a container's header, and a
 * folded header is one dense row. Layout cannot be measured here, so this holds
 * the classes that keep them apart: both are flex items that can shrink
 * (`min-w-*`, a shrink factor, a truncating label) and neither is squared to
 * eighteen pixels by the dense rule. Measured in a browser at 380, 280 and 200
 * pixels, folded and unfolded, they do not overlap.
 */
const source: Source = { dir: '/x', registered: true, branch: 'fix-x', upstream: 'origin/main', behind: 0, ahead: 0, dirty: false }
const version = (pinned: string | null) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <VersionPicker module="kehikot.notes" name="Notes" kehikko={null} pinned={pinned} current="1.2.3" protocol={null} onPicked={() => {}} />
    </TooltipProvider>,
  )
const branch = (s: Source) => renderToStaticMarkup(<TooltipProvider><BranchMark source={s} /></TooltipProvider>)

describe('the version and the branch in a header', () => {
  for (const [name, html] of [
    ['latest version', version(null)],
    ['pinned version', version('v1.2.3')],
    ['quiet branch', branch({ ...source, branch: 'main' })],
    ['marked branch', branch(source)],
  ] as const) {
    test(`${name}: shrinks, with a truncating label`, () => {
      expect(html).not.toMatch(/^<[^>]*\sclass="[^"]*\bshrink-0\b/)
      expect(html).toMatch(/min-w-5 shrink-\[\d+\]/)
      expect(html).toContain('min-w-0 truncate')
    })
  }

  test('the version gives way before the branch, and the labels before the chips', () => {
    expect(version('v1.2.3')).toContain('shrink-[50]')
    expect(branch(source)).toContain('shrink-[20]')
    expect(version('v1.2.3')).toContain('@max-[300px]/container:hidden')
    expect(branch(source)).toContain('@max-[220px]/container:hidden')
  })

  test('the version is marked as a chip, which the folded header does not square to eighteen pixels', () => {
    expect(version(null)).toContain('data-chip=""')
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    expect(css).toContain(".container-grip[data-dense='true'] button:not([data-chip])")
  })
})
