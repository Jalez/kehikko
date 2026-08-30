import { describe, expect, test } from 'bun:test'

import { labelFor, relate, sentenceFor, type Placings } from '../src/host/relations.ts'
import type { FramedModule, Presence } from '../src/host/registry.ts'

/**
 * The relationship model, without a browser.
 *
 * `relate` is manifests in and relationships out, which is the whole reason it
 * is a function in `host/` rather than a `useMemo` inside the popover: the
 * thing that must not overstate is the derivation, and a derivation that can
 * only be exercised by clicking is a derivation nobody checks.
 *
 * The refusals get as much room as the findings. A module naming a format
 * nobody consumes, a consumer whose emitter is not installed, and a module that
 * speaks to nothing at all are the three ways this can be asked to invent a
 * link, and all three must come back empty.
 */

function module(over: Partial<FramedModule> & { id: string }): FramedModule {
  return {
    name: over.id,
    version: '1',
    summary: '',
    entry: '/',
    icon: null,
    health: null,
    mcp: null,
    modes: [{ id: 'one', label: 'One', scope: 'epic' }],
    extensions: { emits: [], consumes: [] },
    declares: { protocol: '>=2', uses: [], storage: false },
    ...over,
  }
}

function presence(id: string, name: string, over: Partial<FramedModule> = {}): Presence {
  return {
    id,
    at: 'http://127.0.0.1:1',
    condition: 'ready',
    line: '',
    name,
    module: module({ id, name, ...over }),
  }
}

const NOWHERE: Placings = { onCanvas: new Set(), elsewhere: new Map() }

const CHECKLIST = presence('roadmap.checklist', 'Checklist', {
  extensions: { emits: ['roadmap.notifications@1'], consumes: [] },
  declares: { protocol: '>=2', uses: ['events:emit', 'state:keep'], storage: false },
})
const NOTIFICATIONS = presence('roadmap.notifications', 'Notifications', {
  extensions: { emits: [], consumes: ['roadmap.notifications@1'] },
})
const ATLAS = presence('roadmap.atlas', 'Atlas', {
  declares: { protocol: '>=2', uses: ['epics:read', 'view:navigate', 'state:keep'], storage: false },
})
const REFERENCES = presence('roadmap.references', 'References', {
  declares: { protocol: '>=2', uses: ['epics:read', 'selection:set'], storage: false },
})
const PAPER = presence('roadmap.paper', 'Paper', {
  declares: { protocol: '>=2', uses: ['epics:read'], storage: false },
})

describe('an event between two modules', () => {
  test('names both ends, in both directions', () => {
    const found = relate([CHECKLIST, NOTIFICATIONS], NOWHERE)

    const emits = found.get('roadmap.checklist')
    expect(emits).toHaveLength(1)
    expect(emits?.[0]?.kind).toBe('emits')
    expect(emits?.[0]?.direct).toBe(true)
    expect(emits?.[0]?.extension).toBe('roadmap.notifications@1')
    expect(emits?.[0]?.with.map((one) => one.id)).toEqual(['roadmap.notifications'])

    const consumes = found.get('roadmap.notifications')
    expect(consumes?.[0]?.kind).toBe('consumes')
    expect(consumes?.[0]?.direct).toBe(true)
    expect(consumes?.[0]?.with.map((one) => one.name)).toEqual(['Checklist'])
  })

  test('says the counterpart is here, when it is on the open kehikko', () => {
    const found = relate([CHECKLIST, NOTIFICATIONS], {
      onCanvas: new Set(['roadmap.checklist', 'roadmap.notifications']),
      elsewhere: new Map(),
    })
    const relationship = found.get('roadmap.checklist')?.[0]
    expect(relationship?.with[0]?.reach).toEqual({ where: 'here' })
    expect(sentenceFor('Checklist', relationship!)).toContain('Notifications is on this kehikko')
  })

  test('names the other kehikko, because the bus delivers across them', () => {
    const found = relate([CHECKLIST, NOTIFICATIONS], {
      onCanvas: new Set(['roadmap.checklist']),
      elsewhere: new Map([['roadmap.notifications', ['Reading']]]),
    })
    const relationship = found.get('roadmap.checklist')?.[0]
    expect(relationship?.with[0]?.reach).toEqual({ where: 'elsewhere', kehikkos: ['Reading'] })
    const said = sentenceFor('Checklist', relationship!)
    expect(said).toContain('“Reading”')
    expect(said).toContain('carries events across kehikkos')
  })

  test('will not claim delivery to a module that is on no kehikko', () => {
    const found = relate([CHECKLIST, NOTIFICATIONS], {
      onCanvas: new Set(['roadmap.checklist']),
      elsewhere: new Map(),
    })
    const relationship = found.get('roadmap.checklist')?.[0]
    expect(relationship?.with[0]?.reach).toEqual({ where: 'unplaced' })
    expect(sentenceFor('Checklist', relationship!)).toContain('nothing is being carried')
  })

  test('a counterpart that is not answering is said to be not answering', () => {
    const silent = { ...NOTIFICATIONS, condition: 'silent' as const }
    const found = relate([CHECKLIST, silent], {
      onCanvas: new Set(['roadmap.checklist', 'roadmap.notifications']),
      elsewhere: new Map(),
    })
    const relationship = found.get('roadmap.checklist')?.[0]
    expect(relationship?.with[0]?.reach).toEqual({ where: 'silent' })
    expect(sentenceFor('Checklist', relationship!)).toContain('not answering')
  })

  test('a module that consumes what it emits is not its own counterpart', () => {
    const both = presence('roadmap.both', 'Both', {
      extensions: { emits: ['roadmap.calls@1'], consumes: ['roadmap.calls@1'] },
    })
    expect(relate([both], NOWHERE).get('roadmap.both')).toBeUndefined()
  })

  test('several consumers collapse to a count and the sentence names them all', () => {
    const second = presence('roadmap.second', 'Second', {
      extensions: { emits: [], consumes: ['roadmap.notifications@1'] },
    })
    const found = relate([CHECKLIST, NOTIFICATIONS, second], NOWHERE)
    const relationship = found.get('roadmap.checklist')?.[0]
    expect(labelFor(relationship!)).toBe('2 modules')
    expect(sentenceFor('Checklist', relationship!)).toContain('Notifications and Second')
  })
})

describe('what it refuses to draw', () => {
  test('an extension nobody consumes is not a relationship', () => {
    expect(relate([CHECKLIST], NOWHERE).get('roadmap.checklist')).toBeUndefined()
  })

  test('a consumer whose emitter is not registered is not a relationship', () => {
    expect(relate([NOTIFICATIONS], NOWHERE).get('roadmap.notifications')).toBeUndefined()
  })

  test('a module that declares nothing of the kind gets nothing', () => {
    expect(relate([PAPER, NOTIFICATIONS], NOWHERE).get('roadmap.paper')).toBeUndefined()
  })

  test('a module the host never read a manifest from gets nothing', () => {
    const quiet: Presence = { id: 'roadmap.quiet', at: 'http://127.0.0.1:2', condition: 'silent', line: '' }
    expect(relate([quiet, CHECKLIST, NOTIFICATIONS], NOWHERE).get('roadmap.quiet')).toBeUndefined()
  })

  test('a shared subject is not drawn, however many modules share it', () => {
    const found = relate([PAPER, presence('roadmap.citations', 'Citations')], {
      onCanvas: new Set(['roadmap.paper', 'roadmap.citations']),
      elsewhere: new Map(),
    })
    expect(found.size).toBe(0)
  })
})

describe('the indirect kinds', () => {
  test('navigation is drawn from view:navigate and names nobody', () => {
    const found = relate([ATLAS, PAPER], {
      onCanvas: new Set(['roadmap.atlas', 'roadmap.paper']),
      elsewhere: new Map(),
    })
    const relationship = found.get('roadmap.atlas')?.[0]
    expect(relationship?.kind).toBe('navigation')
    expect(relationship?.direct).toBe(false)
    expect(relationship?.with).toEqual([])
    expect(relationship?.told).toBe(1)
    expect(sentenceFor('Atlas', relationship!)).toContain('one module beside this one')
  })

  test('the count is of the modules that would actually be told', () => {
    const silent = { ...PAPER, condition: 'silent' as const }
    const found = relate([ATLAS, silent, presence('roadmap.tests', 'Tests')], {
      onCanvas: new Set(['roadmap.atlas', 'roadmap.paper', 'roadmap.tests']),
      elsewhere: new Map(),
    })
    expect(found.get('roadmap.atlas')?.[0]?.told).toBe(1)
  })

  test('selection is drawn from selection:set and says who reacts is unknowable', () => {
    const found = relate([REFERENCES, PAPER], {
      onCanvas: new Set(['roadmap.references', 'roadmap.paper']),
      elsewhere: new Map(),
    })
    const relationship = found.get('roadmap.references')?.[0]
    expect(relationship?.kind).toBe('selection')
    expect(relationship?.direct).toBe(false)
    expect(sentenceFor('References', relationship!)).toContain('in no manifest')
  })

  test('an empty kehikko is said to be empty rather than counted as one', () => {
    const found = relate([ATLAS], NOWHERE)
    const relationship = found.get('roadmap.atlas')?.[0]
    expect(relationship?.told).toBe(0)
    expect(sentenceFor('Atlas', relationship!)).toContain('nothing else is on this one')
  })

  test('the badge itself carries no prose', () => {
    const found = relate([ATLAS, REFERENCES], NOWHERE)
    expect(labelFor(found.get('roadmap.atlas')![0]!)).toBe('moves the epic')
    expect(labelFor(found.get('roadmap.references')![0]!)).toBe('sets the selection')
  })
})

describe('the eleven modules on this machine', () => {
  /* The real declarations, read off the running host, so that a change in what
     a module says about itself shows up here as a change in what the list would
     draw rather than as a surprise in a popover. */
  const live: Presence[] = [
    ATLAS,
    CHECKLIST,
    presence('roadmap.citations', 'Citations'),
    presence('roadmap.diff', 'Diff'),
    presence('roadmap.journeys', 'Journeys'),
    NOTIFICATIONS,
    presence('roadmap.orchestrator', 'Orchestrator'),
    PAPER,
    REFERENCES,
    presence('roadmap.terminal', 'Terminal'),
    presence('roadmap.tests', 'Tests'),
  ]

  test('four of eleven have anything to show, and the rest honestly have none', () => {
    const found = relate(live, NOWHERE)
    expect([...found.keys()].sort()).toEqual([
      'roadmap.atlas',
      'roadmap.checklist',
      'roadmap.notifications',
      'roadmap.references',
    ])
  })

  test('the paper and the citations over one corpus are not among them', () => {
    const found = relate(live, NOWHERE)
    expect(found.has('roadmap.paper')).toBe(false)
    expect(found.has('roadmap.citations')).toBe(false)
  })
})
