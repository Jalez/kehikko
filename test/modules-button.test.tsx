import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { Bar } from '../src/canvas/Bar.tsx'
import type { Presence, RegistryView } from '../src/host/registry.ts'

/*
 * What needs the person among the modules is on the button that opens their list — a "!" in the
 * warning colour, and the count and names in its label — and not a sentence of its own in the strip.
 */

const AT = 'http://127.0.0.1:7870'
const presence = (over: Partial<Presence> & { id: string }): Presence => ({ at: AT, condition: 'ready', reached: true, line: `${over.id} answers.`, ...over })
const fine = presence({ id: 'kehikot.paper', name: 'Paper', tags: ['writing'] })
const broken = presence({ id: 'kehikot.source', name: 'Source', condition: 'silent', reached: true, line: 'Something is answering, and it is not this.' })
const nothing = () => {}

function bar(presences: Presence[]): string {
  const project = { id: 1, name: 'proj', path: '/p', epics: true } as never
  const canvas = { id: 1, key: 'k', name: 'writing', project: 1, placements: [] } as never
  return renderToStaticMarkup(
    <Bar
      registry={{ presences, sweep: { dir: '/x', rejected: [] } } as unknown as RegistryView}
      canvases={[canvas]}
      open={canvas}
      placed={[]}
      subject={{ epic: 'one', project } as never}
      projects={[project]}
      project={project}
      held={{ epics: [{ slug: 'one', title: 'One' }], holds: true } as never}
      onRetitleEpic={async () => true}
      onCreateEpic={async () => true}
      onDeleteEpic={nothing}
      onProject={nothing}
      onAddProject={nothing}
      onShareProject={nothing}
      onForgetProject={nothing}
      onOpen={nothing}
      onCreate={nothing}
      onDelete={nothing}
      onSubject={nothing}
      parts={[]}
      pickedParts={[]}
      onParts={nothing}
      onPlace={nothing}
      onUnplace={nothing}
      onTools={nothing}
      trouble={null}
      onLookAgain={nothing}
      looking={false}
    />,
  )
}

const trigger = (html: string) => html.match(/<button[^>]*data-tour="modules"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''

describe('the module list button', () => {
  test('a module that needs the person: a "!" on the button, and the count and name in its label', () => {
    const button = trigger(bar([fine, broken]))
    expect(button).toContain('aria-label="Kehikko modules — 1 needs you: Source"')
    expect(button).toContain('data-needing="1"')
    expect(button).toContain('text-amber-600')
    expect(button).toMatch(/data-modules-mark=""[^>]*>!<\/span>/)
  })

  test('nothing needing the person: the plain button, with no mark', () => {
    const button = trigger(bar([fine]))
    expect(button).toContain('aria-label="Kehikko modules"')
    expect(button).not.toContain('data-needing')
    expect(button).not.toContain('data-modules-mark')
    expect(button).toContain('text-muted-foreground')
  })

  test('the strip no longer says it in a sentence of its own', () => {
    const html = bar([fine, broken])
    expect(html).not.toMatch(/needs? attention/)
    /* "needs you" is said once: in the button's label. */
    expect(html.match(/needs you/g) ?? []).toHaveLength(1)
  })
})
