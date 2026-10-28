import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { manifestSchema } from 'kehikot-module-protocol'

import {
  AUTOMATIC,
  HOST_NODE,
  chosen,
  connectionsOf,
  connectionsText,
  delivered,
  doorsHanded,
  isAutomatic,
  meetingSkill,
  readersFor,
  reset,
  settingIn,
  sidesOf,
  stepsWithheld,
  switched,
  tidy,
  withheldFor,
  type ConnectionModule,
  type OnKehikko,
} from '../src/host/connections.ts'

/*
 * The connections between the modules on a kehikko, derived from REAL manifests: each fixture in
 * `test/fixtures/manifests/` is a module's `MANIFEST` as its `main` builds it (Flows with the skills
 * its server adds), with `build` taken off. Every one still parses with the protocol's own schema.
 */

const DIR = join(import.meta.dir, 'fixtures/manifests')
const MANIFESTS = new Map<string, ConnectionModule>(
  readdirSync(DIR).map((file) => {
    const manifest = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as ConnectionModule
    return [file.replace(/\.json$/, ''), manifest]
  }),
)
const on = (...names: string[]): OnKehikko[] =>
  names.map((name) => {
    const manifest = MANIFESTS.get(name)!
    return { id: manifest.id, name: (manifest as { name: string }).name, manifest }
  })
const id = (name: string) => `kehikot.${name}`
const pairs = (kind: string, all: ReturnType<typeof connectionsOf>) =>
  all.filter((one) => one.kind === kind).map((one) => `${one.from.replace('kehikot.', '')} > ${one.to.replace('kehikot.', '')}${one.about ? ` (${one.about})` : ''}`)

describe('the fixtures', () => {
  test('are manifests the protocol reads', () => {
    for (const [name, manifest] of MANIFESTS) expect(manifestSchema.safeParse(manifest).success, name).toBe(true)
  })
})

describe('derived from the manifests', () => {
  const writing = connectionsOf(on('paper', 'notes', 'learning', 'source', 'flows'))

  test('a passage: Paper, Notes, Learning and Flows set it; whoever reacts to it follows', () => {
    expect(pairs('passage', writing)).toEqual([
      'paper > notes', 'paper > learning', 'paper > source', 'paper > flows',
      'notes > paper', 'notes > learning', 'notes > source', 'notes > flows',
      'learning > paper', 'learning > notes', 'learning > source', 'learning > flows',
      'flows > paper', 'flows > notes', 'flows > learning', 'flows > source',
    ])
    const one = writing.find((c) => c.key === `passage|${id('paper')}|${id('notes')}|`)!
    expect(one.said).toBe('Notes follows the passage Paper points at.')
    expect(one.offSaid).toBe('Notes doesn’t follow Paper’s passage here.')
    expect(one).toMatchObject({ switchable: true, on: true })
  })

  test('a code location: Diff, Review and Source set it and follow it', () => {
    expect(pairs('location', connectionsOf(on('diff', 'review', 'source')))).toEqual([
      'diff > review', 'diff > source', 'review > diff', 'review > source', 'source > diff', 'source > review',
    ])
  })

  test('a selection: Journeys and References pick out; Browser, Checklist and each other follow', () => {
    expect(pairs('selection', connectionsOf(on('journeys', 'references', 'browser', 'checklist')))).toEqual([
      'journeys > references', 'journeys > browser', 'journeys > checklist',
      'references > journeys', 'references > browser', 'references > checklist',
    ])
  })

  test('addresses: every module that opens one, to the Browser, which shows pages', () => {
    expect(pairs('address', connectionsOf(on('checklist', 'journeys', 'review', 'browser')))).toEqual([
      'checklist > browser', 'journeys > browser', 'review > browser',
    ])
  })

  test('steps: Journeys provides them; References and Flows read them', () => {
    expect(pairs('steps', connectionsOf(on('journeys', 'references', 'flows', 'paper')))).toEqual(['journeys > references', 'journeys > flows'])
  })

  test('published results: Claude’s and Checklist’s notifications, to Notifications', () => {
    const all = connectionsOf(on('claude', 'checklist', 'notifications'))
    expect(pairs('extension', all)).toEqual([
      'claude > notifications (kehikot.notifications@1)',
      'checklist > notifications (kehikot.notifications@1)',
    ])
    expect(all.find((c) => c.kind === 'extension')!.said).toBe('Notifications shows Claude’s notifications.')
  })

  test('skills: /flow-design works because Paper (documents) is here, /flow-roadmap because Journeys (steps) is', () => {
    const all = connectionsOf(on('flows', 'paper', 'journeys'))
    expect(pairs('skill', all)).toEqual(['paper > flows (flow-design)', 'journeys > flows (flow-roadmap)'])
    expect(all.find((c) => c.kind === 'skill')!.said).toBe('Flows’s /flow-design works here because Paper is here.')
    /* Without Journeys, /flow-roadmap has nobody to count on, and no connection is drawn for it. */
    expect(pairs('skill', connectionsOf(on('flows', 'paper')))).toEqual(['paper > flows (flow-design)'])
  })

  test('agents: Claude’s and Codex’s sessions are handed every door here', () => {
    const all = connectionsOf(on('claude', 'codex', 'notes', 'paper'))
    expect(pairs('agent', all)).toEqual(['codex > claude', 'notes > claude', 'paper > claude', 'claude > codex', 'notes > codex', 'paper > codex'])
    expect(all.find((c) => c.key === `agent|${id('notes')}|${id('claude')}|`)!.said).toBe('Claude’s agent sessions are handed Notes’s tools.')
  })

  test('parts: the bar’s pick to every module that narrows (switchable), and Paper’s edits of the list (drawn only)', () => {
    const all = connectionsOf(on('paper', 'notes'))
    const parts = all.filter((c) => c.kind === 'parts')
    expect(parts.map((c) => [c.from, c.to, c.switchable])).toEqual([
      [HOST_NODE, id('paper'), true],
      [HOST_NODE, id('notes'), true],
      [id('paper'), id('notes'), false],
    ])
    expect(parts[2]!.why).toContain('epic’s list')
  })

  test('Kehikot as a node: the tracker it keeps, and its Inbox, neither switchable', () => {
    const all = connectionsOf(on('claude', 'review'))
    expect(pairs('tracker', all)).toEqual(['kehikko > review'])
    expect(pairs('inbox', all)).toEqual(['claude > kehikko'])
    expect(all.filter((c) => c.kind === 'tracker' || c.kind === 'inbox').every((c) => !c.switchable && c.on)).toBe(true)
  })

  test('a module the host has no manifest for is on the kehikko with no connections', () => {
    const all = connectionsOf([...on('paper'), { id: 'kehikot.asleep', name: 'Asleep', manifest: null }])
    expect(all.some((c) => c.from === 'kehikot.asleep' || c.to === 'kehikot.asleep')).toBe(false)
  })
})

describe('the person’s switches', () => {
  const paper = id('paper')
  const notes = id('notes')
  const learning = id('learning')
  const edge = { kind: 'passage' as const, from: paper, to: notes, about: '' }

  test('off is one connection, and only it', () => {
    const off = switched(AUTOMATIC, edge, false)
    expect(delivered(off, 'passage', paper, notes)).toBe(false)
    expect(delivered(off, 'passage', paper, learning)).toBe(true)
    expect(delivered(off, 'passage', learning, notes)).toBe(true)
    expect(delivered(off, 'selection', paper, notes)).toBe(true)
    const all = connectionsOf(on('paper', 'notes', 'learning'), off)
    expect(all.filter((c) => !c.on).map((c) => c.key)).toEqual([`passage|${paper}|${notes}|`])
    expect(switched(off, edge, true)).toEqual(AUTOMATIC)
  })

  test('choosing a provider: only Paper, then any again', () => {
    const only = chosen(AUTOMATIC, { kind: 'passage', to: notes, about: '' }, [paper])
    expect(delivered(only, 'passage', paper, notes)).toBe(true)
    expect(delivered(only, 'passage', learning, notes)).toBe(false)
    /* A provider added to the kehikko later is not taken either: that is what "only" means. */
    expect(delivered(only, 'passage', id('flows'), notes)).toBe(false)
    expect(chosen(only, { kind: 'passage', to: notes, about: '' }, null)).toEqual(AUTOMATIC)
    /* Switching on one the choice left out widens the choice. */
    expect(delivered(switched(only, { ...edge, from: learning }, true), 'passage', learning, notes)).toBe(true)
  })

  test('the sides: what Paper provides and to whom, what Notes takes and from whom, with the choice', () => {
    const modules = on('paper', 'notes', 'learning')
    const setting = chosen(AUTOMATIC, { kind: 'passage', to: notes, about: '' }, [paper])
    const sides = sidesOf(modules, connectionsOf(modules, setting), setting)
    const notesSide = sides.find((s) => s.id === notes)!
    const passage = notesSide.consumes.find((r) => r.kind === 'passage')!
    expect(passage.edges.map((e) => [e.from, e.on])).toEqual([[paper, true], [learning, false]])
    expect(passage.only).toEqual([paper])
    expect(sides.find((s) => s.id === paper)!.provides.find((r) => r.kind === 'passage')!.edges.map((e) => e.to)).toEqual([notes, learning])
    expect(sides.map((s) => s.id)).toContain(HOST_NODE)
  })

  test('reset: a row, and everything', () => {
    const modules = on('paper', 'notes', 'learning')
    let setting = switched(AUTOMATIC, edge, false)
    setting = switched(setting, { kind: 'parts', from: HOST_NODE, to: notes, about: '' }, false)
    const row = sidesOf(modules, connectionsOf(modules, setting), setting).find((s) => s.id === notes)!.consumes.find((r) => r.kind === 'passage')!
    const after = reset(setting, row.edges)
    expect(delivered(after, 'passage', paper, notes)).toBe(true)
    expect(delivered(after, 'parts', HOST_NODE, notes)).toBe(false)
    expect(isAutomatic(reset(after, connectionsOf(modules, after)))).toBe(true)
  })

  test('read from anywhere: tidied, bounded, and automatic when it will not read', () => {
    expect(settingIn('')).toEqual(AUTOMATIC)
    expect(settingIn('{nope')).toEqual(AUTOMATIC)
    expect(settingIn({ off: [{ kind: 'nonsense', from: paper, to: notes }] })).toEqual(AUTOMATIC)
    expect(settingIn({ off: [{ kind: 'tracker', from: HOST_NODE, to: notes }] })).toEqual(AUTOMATIC)
    const twice = { off: [{ kind: 'passage', from: paper, to: notes }, { kind: 'passage', from: paper, to: notes }], only: [] }
    expect(settingIn(JSON.stringify(twice)).off).toHaveLength(1)
    expect(tidy(settingIn(twice))).toEqual(settingIn(twice))
  })

  test('read_canvas says each connection, on or off, and that only the person changes them', () => {
    const lines = connectionsText(connectionsOf(on('paper', 'notes'), switched(AUTOMATIC, edge, false)))
    expect(lines[0]).toContain('only the person changes these')
    expect(lines).toContain('  [off] passage: Notes doesn’t follow Paper’s passage here.')
    expect(lines).toContain('  [on]  passage: Paper follows the passage Notes points at.')
  })
})

describe('what each enforcement asks', () => {
  const paper = id('paper')
  const notes = id('notes')
  test('withheldFor: nothing switched is null — the shared context', () => {
    expect(withheldFor(AUTOMATIC, notes, { placed: [paper, notes], selectedBy: null, locationBy: null, addressBy: null })).toBeNull()
  })
  test('withheldFor: a held-back selection takes the code location with it', () => {
    const off = switched(AUTOMATIC, { kind: 'selection', from: id('journeys'), to: notes, about: '' }, false)
    expect(withheldFor(off, notes, { placed: [paper, notes], selectedBy: id('journeys'), locationBy: null, addressBy: null })).toMatchObject({ selection: true, location: true, address: false, parts: false })
  })
  test('steps: a provider switched off is left out of the answer, and the same object comes back when none is', () => {
    const data = { steps: [{ id: 'a', module: id('journeys') }, { id: 'b', module: 'kehikot.other' }], phases: [{ id: 'p', module: id('journeys') }], providers: [{ module: id('journeys') }, { module: 'kehikot.other' }] }
    expect(stepsWithheld(data, () => true)).toBe(data)
    expect(stepsWithheld(data, (p) => p !== id('journeys'))).toEqual({ steps: [{ id: 'b', module: 'kehikot.other' }], phases: [], providers: [{ module: 'kehikot.other' }] })
  })
  test('addresses, skills and doors: filtered by the same rule', () => {
    const browser = id('browser')
    const off = tidy({
      off: [
        { kind: 'address', from: id('review'), to: browser },
        { kind: 'skill', from: paper, to: id('flows'), about: 'flow-design' },
        { kind: 'agent', from: notes, to: id('claude') },
      ],
      only: [],
    })
    expect(readersFor(off, id('review'), [browser])).toEqual([])
    expect(readersFor(off, id('journeys'), [browser])).toEqual([browser])
    expect(meetingSkill(off, id('flows'), 'flow-design', [{ id: paper }, { id: id('flows') }]).map((m) => m.id)).toEqual([id('flows')])
    expect(meetingSkill(off, id('flows'), 'flow-roadmap', [{ id: paper }]).map((m) => m.id)).toEqual([paper])
    expect(doorsHanded(off, id('claude'), [{ module: HOST_NODE }, { module: notes }, { module: paper }]).map((d) => d.module)).toEqual([HOST_NODE, paper])
    expect(doorsHanded(off, id('codex'), [{ module: notes }]).map((d) => d.module)).toEqual([notes])
  })
})
