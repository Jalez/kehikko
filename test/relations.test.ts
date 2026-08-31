import { describe, expect, test } from 'bun:test'

import { labelFor, relate, sentenceFor, standingOf, type Placings } from '../src/host/relations.ts'
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
    reacts: [],
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
  reacts: ['selection'],
  declares: { protocol: '>=2', uses: ['events:emit', 'state:keep'], storage: false },
})
const NOTIFICATIONS = presence('roadmap.notifications', 'Notifications', {
  extensions: { emits: [], consumes: ['roadmap.notifications@1'] },
})
const ATLAS = presence('roadmap.mapmaker', 'Atlas', {
  declares: { protocol: '>=2', uses: ['epics:read', 'view:navigate', 'state:keep'], storage: false },
})
const REFERENCES = presence('roadmap.references', 'References', {
  declares: { protocol: '>=2', uses: ['epics:read', 'selection:set'], storage: false },
})
const PAPER = presence('roadmap.paper', 'Paper', {
  declares: { protocol: '>=2', uses: ['epics:read'], storage: false },
})
const POINTER = presence('roadmap.pointer', 'Pointer', {
  declares: { protocol: '>=2', uses: ['passage:set'], storage: false },
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
      onCanvas: new Set(['roadmap.mapmaker', 'roadmap.paper']),
      elsewhere: new Map(),
    })
    const relationship = found.get('roadmap.mapmaker')?.[0]
    expect(relationship?.kind).toBe('navigation')
    expect(relationship?.direct).toBe(false)
    expect(relationship?.with).toEqual([])
    expect(relationship?.told).toBe(1)
    expect(sentenceFor('Mapmaker', relationship!)).toContain('one module beside this one')
  })

  test('the count is of the modules that would actually be told', () => {
    const silent = { ...PAPER, condition: 'silent' as const }
    const found = relate([ATLAS, silent, presence('roadmap.tests', 'Tests')], {
      onCanvas: new Set(['roadmap.mapmaker', 'roadmap.paper', 'roadmap.tests']),
      elsewhere: new Map(),
    })
    expect(found.get('roadmap.mapmaker')?.[0]?.told).toBe(1)
  })

  test('selection is drawn from selection:set and says who reacts is unknowable', () => {
    const found = relate([REFERENCES, PAPER], {
      onCanvas: new Set(['roadmap.references', 'roadmap.paper']),
      elsewhere: new Map(),
    })
    const relationship = found.get('roadmap.references')?.[0]
    expect(relationship?.kind).toBe('selection')
    expect(relationship?.role).toBe('sets')
    expect(relationship?.direct).toBe(false)
    /* Nobody registered here says they react to one, and the sentence says
       exactly that rather than the older, stronger claim it used to make —
       that WHICH module reacts is unknowable. It is knowable now, when a
       module has written it down. It simply has not been written down here. */
    expect(relationship?.with).toEqual([])
    expect(sentenceFor('References', relationship!)).toContain(
      'None of them says in its manifest that it reacts to a selection',
    )
  })

  test('a passage is drawn from passage:set and is not folded into the selection', () => {
    /* Two modules, one that can broadcast refs and one that can broadcast a
       file, a place in it and a paragraph of what was there. Those are not the
       same offer, and a person deciding whether to place either is entitled to
       read which one they are being made. */
    const found = relate([REFERENCES, POINTER], {
      onCanvas: new Set(['roadmap.references', 'roadmap.pointer']),
      elsewhere: new Map(),
    })
    const relationship = found.get('roadmap.pointer')?.[0]
    expect(relationship?.kind).toBe('passage')
    expect(relationship?.direct).toBe(false)
    const said = sentenceFor('Pointer', relationship!)
    expect(said).toContain('where in a document')
    /* The receiving half again: neither of these two declares a reaction, so
       the sending end is named and the other end honestly is not. */
    expect(said).toContain('None of them says in its manifest that it reacts to a passage')
    expect(labelFor(relationship!)).toBe('points at a passage')
  })

  test('an empty kehikko is said to be empty rather than counted as one', () => {
    const found = relate([ATLAS], NOWHERE)
    const relationship = found.get('roadmap.mapmaker')?.[0]
    expect(relationship?.told).toBe(0)
    expect(sentenceFor('Mapmaker', relationship!)).toContain('nothing else is on this one')
  })

  test('the badge itself carries no prose', () => {
    const found = relate([ATLAS, REFERENCES], NOWHERE)
    expect(labelFor(found.get('roadmap.mapmaker')![0]!)).toBe('moves the epic')
    expect(labelFor(found.get('roadmap.references')![0]!)).toBe('sets the selection')
  })
})

describe('the receiving half, now that a module can declare one', () => {
  /* The half this file used to say was unnameable. `reacts` is a description a
     module writes about itself, never a permission — nothing in `relate` gates
     on it, and nothing may, because the context is broadcast to every framed
     module whether or not it said a word. What it buys is that a registry can
     name both ends of one relationship instead of one and a half. */
  const NOTES = presence('roadmap.notes', 'Notes', { reacts: ['passage'] })
  const READER = presence('roadmap.reader', 'Reader', { reacts: ['selection'] })

  test('a declared setter and a declared reactor are a nameable pair', () => {
    const found = relate([POINTER, NOTES], {
      onCanvas: new Set(['roadmap.pointer', 'roadmap.notes']),
      elsewhere: new Map(),
    })

    const sets = found.get('roadmap.pointer')?.[0]
    expect(sets?.kind).toBe('passage')
    expect(sets?.role).toBe('sets')
    expect(sets?.with.map((one) => one.name)).toEqual(['Notes'])
    expect(sentenceFor('Pointer', sets!)).toContain('Notes says it reacts to a passage')

    const reacts = found.get('roadmap.notes')?.[0]
    expect(reacts?.kind).toBe('passage')
    expect(reacts?.role).toBe('reacts')
    expect(reacts?.with.map((one) => one.name)).toEqual(['Pointer'])
    expect(labelFor(reacts!)).toBe('follows a passage')
  })

  test('naming both ends is still not a claim that anything is carried', () => {
    /* The property that separates this from an event, and the one most likely
       to be lost by somebody tidying the two into one code path. `direct` is
       what the badge and the sentence key off, and it stays false: two
       manifests agreeing is not the host delivering. */
    const found = relate([POINTER, NOTES], NOWHERE)
    expect(found.get('roadmap.pointer')?.[0]?.direct).toBe(false)
    expect(found.get('roadmap.notes')?.[0]?.direct).toBe(false)
    const said = sentenceFor('Notes', found.get('roadmap.notes')![0]!)
    expect(said).toContain('what the modules say about themselves')
    expect(said).toContain('carries nothing between these two')
  })

  test('a reactor with nothing registered that sets it is not drawn', () => {
    /* Half a relationship is not one, and the asymmetry with the setter above
       is deliberate: a `passage:set` badge is drawn alone because the HOST will
       broadcast what that module sets. A reaction to something nothing on this
       machine produces is only a stranger's sentence, and repeating it would be
       the host asserting a link out of one manifest. */
    expect(relate([NOTES, PAPER], NOWHERE).get('roadmap.notes')).toBeUndefined()
  })

  test('a word this host has never heard of is drawn as nothing, not as everything', () => {
    const odd = presence('roadmap.odd', 'Odd', { reacts: ['weather', 'passage'] })
    const found = relate([POINTER, odd], NOWHERE)
    const relationships = found.get('roadmap.odd') ?? []
    expect(relationships).toHaveLength(1)
    expect(relationships[0]?.kind).toBe('passage')
  })

  test('a module that both sets and follows a passage is not its own counterpart', () => {
    /* A notes pane is genuinely both — it follows a passage, and points at one
       when somebody presses a note. Two rows, and neither names itself. */
    const both = presence('roadmap.both', 'Both', {
      reacts: ['passage'],
      declares: { protocol: '>=2', uses: ['passage:set'], storage: false },
    })
    const alone = relate([both], NOWHERE).get('roadmap.both')
    expect(alone).toHaveLength(1)
    expect(alone?.[0]?.role).toBe('sets')
    expect(alone?.[0]?.with).toEqual([])

    const withPointer = relate([both, POINTER], NOWHERE).get('roadmap.both')
    expect(withPointer?.map((one) => one.role)).toEqual(['sets', 'reacts'])
  })

  test('a selection reactor and a passage reactor are not the same relationship', () => {
    const found = relate([REFERENCES, POINTER, NOTES, READER], NOWHERE)
    expect(found.get('roadmap.notes')?.[0]?.kind).toBe('passage')
    expect(found.get('roadmap.reader')?.[0]?.kind).toBe('selection')
    expect(labelFor(found.get('roadmap.reader')![0]!)).toBe('follows the selection')
  })

  test('the count of who is told is unchanged by anybody declaring a reaction', () => {
    /* The strongest statement that this is not a permission: `told` is how many
       modules the host WILL broadcast to, and it is the same number whether or
       not any of them said they react. If those two numbers ever differ, the
       broadcast has been filtered and a permission has been built. */
    const canvas = {
      onCanvas: new Set(['roadmap.pointer', 'roadmap.notes', 'roadmap.paper']),
      elsewhere: new Map<string, string[]>(),
    }
    const silentAboutIt = presence('roadmap.notes', 'Notes')
    expect(relate([POINTER, NOTES, PAPER], canvas).get('roadmap.pointer')?.[0]?.told).toBe(2)
    expect(relate([POINTER, silentAboutIt, PAPER], canvas).get('roadmap.pointer')?.[0]?.told).toBe(2)
  })
})

describe('the two halves the list shows', () => {
  test('a module with several relationships gets each counterpart once, per side', () => {
    /* Six relationships must not become six names repeated: the sentence is
       about modules, and one module on the other end of three of them belongs
       in it once. */
    const second = presence('roadmap.second', 'Second', {
      extensions: { emits: [], consumes: ['roadmap.notifications@1'] },
    })
    const hub = presence('roadmap.hub', 'Hub', {
      extensions: { emits: ['roadmap.notifications@1'], consumes: ['roadmap.calls@1'] },
      reacts: ['passage', 'selection'],
      declares: { protocol: '>=2', uses: ['events:emit', 'passage:set'], storage: false },
    })
    const caller = presence('roadmap.caller', 'Caller', {
      extensions: { emits: ['roadmap.calls@1'], consumes: [] },
      reacts: ['passage'],
    })
    const found = relate([hub, NOTIFICATIONS, second, caller, REFERENCES], NOWHERE)
    const standing = standingOf(hub, found.get('roadmap.hub') ?? [])

    expect(standing.consumer).toBe(true)
    expect(standing.provider).toBe(true)
    /* Caller emits the format Hub shows AND says it follows the passage Hub can
       set, so it is on both sides — and appears once on each. */
    expect(standing.consumes.map((one) => one.name)).toEqual(['Caller', 'References'])
    expect(standing.providesTo.map((one) => one.name)).toEqual(['Notifications', 'Second', 'Caller'])
  })

  test('a provider with no declared audience keeps its badge and gets no list', () => {
    const found = relate([POINTER], NOWHERE)
    const standing = standingOf(POINTER, found.get('roadmap.pointer') ?? [])
    expect(standing.provider).toBe(true)
    expect(standing.consumer).toBe(false)
    /* Not "provides to: nobody". The host does not know that — it knows no
       registered module has said it takes anything from this one, which is a
       fact about who is installed today. */
    expect(standing.providesTo).toEqual([])
  })

  test('the badges are read off the module alone, so they survive an empty machine', () => {
    const lonely = presence('roadmap.lonely', 'Lonely', { reacts: ['selection'] })
    const standing = standingOf(lonely, [])
    expect(standing.consumer).toBe(true)
    expect(standing.provider).toBe(false)
    expect(standing.consumes).toEqual([])
  })

  test('a module that touches nothing gets neither word', () => {
    const standing = standingOf(PAPER, [])
    expect(standing.consumer).toBe(false)
    expect(standing.provider).toBe(false)
  })

  test('moving the epic puts nobody in either list', () => {
    /* Navigation names nobody by design — it moves the canvas, and everything
       on the canvas feels it without being its correspondent. It makes a mover
       a provider and gives it no audience to print. */
    const found = relate([ATLAS, PAPER], {
      onCanvas: new Set(['roadmap.mapmaker', 'roadmap.paper']),
      elsewhere: new Map(),
    })
    const standing = standingOf(ATLAS, found.get('roadmap.mapmaker') ?? [])
    expect(standing.provider).toBe(true)
    expect(standing.providesTo).toEqual([])
    expect(standing.consumes).toEqual([])
  })
})

describe('the ten modules on this machine', () => {
  /* The real declarations, read off the running host, so that a change in what
     a module says about itself shows up here as a change in what the list would
     draw rather than as a surprise in a popover. */
  const live: Presence[] = [
    CHECKLIST,
    presence('roadmap.citations', 'Citations'),
    presence('roadmap.diff', 'Diff', { reacts: ['selection'] }),
    presence('roadmap.journeys', 'Journeys'),
    NOTIFICATIONS,
    presence('roadmap.orchestrator', 'Orchestrator'),
    PAPER,
    REFERENCES,
    presence('roadmap.terminal', 'Terminal'),
    presence('roadmap.tests', 'Tests', { reacts: ['selection'] }),
  ]

  test('five of ten have anything to show, and the rest honestly have none', () => {
    /* It was three, and the two that joined did not change what they DO — Diff
       and Tests have both been rebuilt by the canvas selection since they were
       written, and Diff's own manifest said so in prose. What changed is that
       there is now a field to say it in, so the host can read it instead of
       nobody being able to. */
    const found = relate(live, NOWHERE)
    expect([...found.keys()].sort()).toEqual([
      'roadmap.checklist',
      'roadmap.diff',
      'roadmap.notifications',
      'roadmap.references',
      'roadmap.tests',
    ])
  })

  test('the one module that sets the selection is now named on both sides of it', () => {
    /* The sentence the modules list was asked for, on the real declarations:
       References provides to the three that say they follow a selection, and
       Checklist is on both sides at once — it follows the selection and emits
       the notifications another module shows. */
    const found = relate(live, NOWHERE)
    const references = standingOf(REFERENCES, found.get('roadmap.references') ?? [])
    expect(references.provider).toBe(true)
    expect(references.consumer).toBe(false)
    expect(references.providesTo.map((one) => one.name).sort()).toEqual(['Checklist', 'Diff', 'Tests'])

    const checklist = standingOf(CHECKLIST, found.get('roadmap.checklist') ?? [])
    expect(checklist.consumer).toBe(true)
    expect(checklist.provider).toBe(true)
    expect(checklist.consumes.map((one) => one.name)).toEqual(['References'])
    expect(checklist.providesTo.map((one) => one.name)).toEqual(['Notifications'])
  })

  test('nothing on this machine declares view:navigate any more', () => {
    /* Atlas did, and Atlas was retired when the project and epic pickers moved
       into the host's own header — a module that picks the epic is duplicating
       chrome once the chrome can do it.

       The capability did not go with it. `view.goto` is still a protocol method
       and this host still answers it, so the derivation above must keep working
       for a module that declares it; the fixture tests earlier in this file are
       what keep that true. What changed is only that nobody currently does, and
       the badge correctly stops being drawn rather than being special-cased
       away. */
    const found = relate(live, NOWHERE)
    for (const [, relationships] of found) {
      expect(relationships.some((r) => r.kind === 'navigation')).toBe(false)
    }
  })

  test('the paper and the citations over one corpus are not among them', () => {
    const found = relate(live, NOWHERE)
    expect(found.has('roadmap.paper')).toBe(false)
    expect(found.has('roadmap.citations')).toBe(false)
  })
})
