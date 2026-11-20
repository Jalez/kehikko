import { overflowOf, type HeaderLayout, type Section, type Trigger } from './headerOffer.ts'
import type { Presence } from './registry.ts'
import type { Showing } from './standing.ts'

/*
 * What a container (`canvas/Container.tsx`) reads off what it was handed
 * before it draws its header and body: pure, so it is tested without a page.
 */

type Entries<K extends Section['kind']> = Extract<Section, { kind: K }>

/**
 * The parts of the header's overflow the container draws itself. The overflow holds the Container
 * rows; when it holds nothing of the module's — the Container trigger, or a "⋯" for a module with no
 * menus — it is drawn by the container (`ownOverflow`), otherwise `HeaderMenus` draws it. `helpEntries`
 * is Help's own "?" while the header has room; under that its rows are a section of the "⋯".
 */
export function overflowParts(layout: HeaderLayout): {
  ownOverflow: Trigger | null
  frameEntries: Entries<'frame'>['entries'] | undefined
  overflowControls: Entries<'controls'>['controls']
  overflowHelp: Entries<'help'>['entries']
  helpEntries: Entries<'help'>['entries'] | null
} {
  const overflow = overflowOf(layout)
  const ownOverflow = overflow.sections.every((section) => section.kind !== 'module') ? overflow : null
  return {
    ownOverflow,
    frameEntries: ownOverflow?.sections.flatMap((section) => (section.kind === 'frame' ? section.entries : [])),
    overflowControls: ownOverflow?.sections.flatMap((section) => (section.kind === 'controls' ? section.controls : [])) ?? [],
    overflowHelp: ownOverflow?.sections.flatMap((section) => (section.kind === 'help' ? section.entries : [])) ?? [],
    helpEntries: layout.triggers.find((trigger) => trigger.which === 'help')?.sections.flatMap((section) => (section.kind === 'help' ? section.entries : [])) ?? null,
  }
}

/** A page loading what a new context asks for, late (protocol 2.84.0): the same cover over its place, in the module's words when it gave some. */
export function veilOf(showing: Showing, loading: { label: string | null } | null): Extract<Showing, { kind: 'cover' }> | null {
  return showing.kind === 'page' && loading ? { kind: 'cover', state: 'loading', ...(loading.label ? { label: loading.label } : {}) } : null
}

/** The condition dot's state: ready while the page shows, a notice's own condition, else the sweep's. */
export function conditionOf(showing: Showing, presence: Pick<Presence, 'condition'>): Presence['condition'] {
  return showing.kind === 'page' ? 'ready' : showing.kind === 'notice' ? showing.condition : presence.condition
}

/** What the condition dot says beside the condition: a cover's wait, or asleep. */
export function lifecycleOf(showing: Showing): Extract<Showing, { kind: 'cover' }>['state'] | 'asleep' | undefined {
  return showing.kind === 'cover' ? showing.state : showing.kind === 'notice' && showing.asleep ? 'asleep' : undefined
}

/** What the header's left side draws, as one key: a change to it starts the header's fit from the most again (`useContainerResize`). */
export function headerContent(name: string, version: string | null, current: string | null, presence: Pick<Presence, 'module' | 'source'>): string {
  return `${name}\u0000${version ?? ''}\u0000${current ?? ''}\u0000${presence.module?.version ?? ''}\u0000${presence.source?.branch ?? ''}`
}
