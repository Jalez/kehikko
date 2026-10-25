import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JOURNEYS_FILE, JOURNEYS_MODULE, SERVER_ASK_PATH, moduleFile, serverAskResult, stepsListResult } from 'kehikot-module-protocol'
import { writePlan } from 'kehikot-module-protocol/serve'

import { answer, type Grants } from '../server/answers.ts'
import { setDisposition } from '../server/dispositions.ts'
import { editParts, readEpic } from '../server/holdings.ts'
import { modulesOn, type ModuleAbout } from '../server/placeRoutes.ts'
import { serverAskDesk, type ServerAskDeps } from '../server/serverAsk.ts'
import { asRead, builtBefore221, loadsSkillsHere, providesHere, skillLoaders } from '../src/host/providers.ts'

/**
 * Protocol 2.21.0, the host's half:
 *
 *  - an epic's steps are the union of every module that publishes a plan (`steps.json`), with
 *    Journeys' old file read as one more provider until Journeys publishes (`server/plans.ts`);
 *  - a skill's needs are matched against what the modules on the kehikko provide, say or ask for,
 *    and kehikko-bound skills go only to a module that loads skills (`src/host/providers.ts`);
 *  - a module's server reads epics, steps, parts and dispositions with no page open, held to the
 *    same capability as its page (`/host/server-ask`).
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-plans-')))
  mkdirSync(join(folder, '.kehikot', 'host', 'epics'), { recursive: true })
  writeFileSync(join(folder, '.kehikot', 'host', 'epics', 'seam.json'), JSON.stringify({ slug: 'seam', title: 'The seam' }))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const ME = 'kehikot.reader'
const known = (id: string) => id === ME || id === 'kehikot.planner'
const asked = (method: string, params: unknown) => {
  const said = answer(ME, method, params, known, () => {}, folder)
  if (!said.ok) throw new Error(said.error)
  return said.data as Record<string, unknown>
}

/** The Journeys module's own file, as it keeps it before 2.21.0. */
function journeys(steps: unknown[]): void {
  const file = moduleFile(folder, JOURNEYS_MODULE, JOURNEYS_FILE)!
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, journeys: { seam: { slug: 'seam', title: 'The seam', steps } } }))
}

const PLAN = {
  phases: [{ id: 'build', title: 'Building' }],
  steps: [
    { id: 'draft', title: 'Draft it', refs: ['gh#12'], phase: 'build' },
    { id: 'wire', title: 'Wire it', refs: ['gh#13'], after: ['draft'], gates: [{ id: 'legal', title: 'Legal signs off', kind: 'decision' as const }] },
  ],
}

describe('steps.list: the union of every provider', () => {
  test('a second module publishing steps appears beside Journeys, each step saying whose it is', () => {
    journeys([{ title: 'Journeys’ own step', refs: ['gh#1'], part: 'core' }])
    writePlan(folder, 'kehikot.planner', 'seam', PLAN)
    const said = stepsListResult.parse(asked('steps.list', { epic: 'seam' }))
    expect(said.steps!.map((step) => `${step.module} ${step.id}`)).toEqual([
      'kehikot.journeys core',
      'kehikot.planner draft',
      'kehikot.planner wire',
    ])
    expect(said.providers).toEqual([{ module: JOURNEYS_MODULE, fallback: true }, { module: 'kehikot.planner' }])
    expect(said.phases).toEqual([{ id: 'build', title: 'Building', module: 'kehikot.planner' }])
    const wire = said.steps!.find((step) => step.id === 'wire')!
    expect(wire.after).toEqual(['draft'])
    expect(wire.gates).toEqual([{ id: 'legal', title: 'Legal signs off', kind: 'decision', waitsOn: [], done: false }])
    /* `epic.get` carries the same steps once anybody publishes. */
    expect(asked('epic.get', { epic: 'seam' }).steps).toEqual(said.steps)
  })

  test('once Journeys publishes, its old file is no longer read for steps', () => {
    journeys([{ title: 'Stale', refs: ['gh#1'] }])
    writePlan(folder, JOURNEYS_MODULE, 'seam', { steps: [{ id: 'fresh', title: 'Fresh' }] })
    const said = stepsListResult.parse(asked('steps.list', { epic: 'seam' }))
    expect(said.steps!.map((step) => `${step.module} ${step.id}`)).toEqual(['kehikot.journeys fresh'])
    expect(said.providers).toEqual([{ module: JOURNEYS_MODULE }])
    /* Even for another epic it has no plan for: the module publishes, so the file is not its steps. */
    writeFileSync(join(folder, '.kehikot', 'host', 'epics', 'other.json'), JSON.stringify({ slug: 'other', title: 'Other' }))
    expect(asked('steps.list', { epic: 'other' })).toEqual({ steps: [], phases: [], providers: [] })
  })

  test('with nobody publishing, the epic reads exactly as before', () => {
    journeys([{ title: 'Only', refs: ['gh#1'], body: '', notes: [] }])
    expect(readEpic(folder, 'seam')!.steps).toEqual([{ title: 'Only', refs: ['gh#1'], body: '', notes: [] }])
  })

  test('an epic the host has no file for is not an epic, whoever publishes for it', () => {
    writePlan(folder, 'kehikot.planner', 'nowhere', PLAN)
    expect(answer(ME, 'steps.list', { epic: 'nowhere' }, known, () => {}, folder).ok).toBe(false)
  })
})

describe('parts.get and dispositions.get', () => {
  const grants = (uses: string[]): Grants => ({ may: (_module, capability) => uses.includes(capability) })

  test('the parts with what the modules hold, nothing picked; the project’s marks', () => {
    const added = editParts(folder, 'seam', { add: { name: 'UI' } })
    setDisposition(folder, { ref: 'gh#9', value: 'done', note: '' }, 'Someone')
    const parts = answer(ME, 'parts.get', { epic: 'seam' }, known, () => {}, folder, undefined, null, null, null, grants(['parts:read']))
    expect(parts).toEqual({ ok: true, data: { parts: [{ id: added.result.id!, heading: 'UI', refs: [], picked: false }] } })
    const marks = answer(ME, 'dispositions.get', {}, known, () => {}, folder, undefined, null, null, null, grants(['dispositions:read']))
    expect(marks.ok && (marks.data as { dispositions: { ref: string }[] }).dispositions.map((one) => one.ref)).toEqual(['gh#9'])
  })

  test('each held to its own capability', () => {
    expect(answer(ME, 'parts.get', { epic: 'seam' }, known, () => {}, folder, undefined, null, null, null, grants([])).ok).toBe(false)
    expect(answer(ME, 'dispositions.get', {}, known, () => {}, folder, undefined, null, null, null, grants(['parts:read'])).ok).toBe(false)
  })
})

describe('a module’s server reads epics and steps with no page open', () => {
  const PASS = 'p'.repeat(40)
  const ORIGIN = 'http://127.0.0.1:8061'

  function desk(uses: string[]) {
    const may = (_module: string, capability: string) => uses.includes(capability)
    const deps: ServerAskDeps = {
      known: (id) => id === 'kehikot.planner',
      originOf: async (id) => (id === 'kehikot.planner' ? ORIGIN : null),
      may,
      projectAt: (path) => (path === folder ? folder : null),
      /* The page's own answer, as the server wires it: nothing about a page is needed. */
      answer: (module, method, params, root) => answer(module, method, params, (id) => id === 'kehikot.planner', () => {}, root, undefined, null, null, null, { may }),
      fetch: (async (url: string | URL | Request) => Response.json({ ok: true, minted: new URL(String(url)).searchParams.get('pass') === PASS })) as typeof fetch,
    }
    return serverAskDesk(deps).route
  }
  const ask = async (route: ReturnType<typeof desk>, method: string, params: Record<string, unknown>) => {
    const request = new Request(`http://127.0.0.1:4170${SERVER_ASK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'kehikot.planner', pass: PASS, project: folder, method, params }),
    })
    return serverAskResult.parse(await (await route(request, new URL(request.url)))!.json())
  }

  test('epics.list and steps.list, answered as the page would be', async () => {
    writePlan(folder, 'kehikot.planner', 'seam', PLAN)
    const route = desk(['epics:read', 'steps:read'])
    const epics = await ask(route, 'epics.list', {})
    expect(epics.ok && (epics.data as { epics: { slug: string }[] }).epics.map((one) => one.slug)).toEqual(['seam'])
    const steps = await ask(route, 'steps.list', { epic: 'seam' })
    expect(steps.ok).toBe(true)
    if (steps.ok) expect(stepsListResult.parse(steps.data).steps!.map((step) => step.id)).toEqual(['draft', 'wire'])
    expect(await ask(route, 'epic.get', { epic: 'seam' })).toMatchObject({ ok: true, data: { slug: 'seam', title: 'The seam' } })
  })

  test('and refused without the capability', async () => {
    const route = desk(['epics:read'])
    expect(await ask(route, 'steps.list', { epic: 'seam' })).toMatchObject({ ok: false, refused: 'grant' })
    expect(await ask(desk([]), 'epics.list', {})).toMatchObject({ ok: false, refused: 'grant' })
    expect(await ask(desk(['epics:read']), 'parts.get', { epic: 'seam' })).toMatchObject({ ok: false, refused: 'grant' })
  })
})

describe('what a module provides, and who loads skills', () => {
  const at = (protocol: string) => ({ build: { protocol } })

  test('a manifest says it; Journeys and Claude from before 2.21.0 are read as having said it', () => {
    expect(providesHere({ id: 'kehikot.planner', declares: { provides: ['steps'] } })).toEqual(['steps'])
    expect(providesHere({ id: JOURNEYS_MODULE })).toEqual(['steps'])
    expect(providesHere({ id: JOURNEYS_MODULE, ...at('2.20.0') })).toEqual(['steps'])
    expect(providesHere({ id: JOURNEYS_MODULE, ...at('2.21.0') })).toEqual([])
    expect(providesHere({ id: JOURNEYS_MODULE, declares: { provides: [] } })).toEqual([])
    expect(providesHere({ id: 'kehikot.other' })).toEqual([])
    expect(loadsSkillsHere({ id: 'kehikot.claude', ...at('2.20.0') })).toBe(true)
    expect(loadsSkillsHere({ id: 'kehikot.claude', ...at('2.21.0') })).toBe(false)
    expect(loadsSkillsHere({ id: 'kehikot.claude', declares: { agentSessions: { loadsSkills: false } } })).toBe(false)
    expect(loadsSkillsHere({ id: 'kehikot.codex', declares: { agentSessions: { loadsSkills: true } }, ...at('2.21.0') })).toBe(true)
    expect(skillLoaders([{ id: 'kehikot.claude' }, { id: 'kehikot.terminal' }, { id: 'kehikot.codex', declares: { agentSessions: { loadsSkills: true } } }])).toEqual(['kehikot.claude', 'kehikot.codex'])
    expect(builtBefore221({ build: null })).toBe(true)
    expect(builtBefore221(at('3.0.0'))).toBe(false)
    expect(asRead({ id: JOURNEYS_MODULE }).declares?.provides).toEqual(['steps'])
  })
})

describe('a skill’s needs, matched against what is on the kehikko', () => {
  const flows: ModuleAbout = {
    id: 'kehikot.flows',
    name: 'Flows',
    skills: [
      { name: 'flow-roadmap', needs: [{ provides: 'steps' }] },
      { name: 'flow-design', needs: [{ provides: 'documents' }] },
      { name: 'flows', needs: [] },
    ],
  }
  const planner: ModuleAbout = { id: 'kehikot.planner', name: 'Planner', skills: [], manifest: { declares: { provides: ['steps'] }, build: { protocol: '2.21.0' } } }
  const notes: ModuleAbout = { id: 'kehikot.notes', name: 'Notes', skills: [], manifest: { build: { protocol: '2.21.0' } } }
  const journeysOld: ModuleAbout = { id: JOURNEYS_MODULE, name: 'Journeys', skills: [], manifest: { build: { protocol: '2.20.0' } } }
  const on = (...ids: string[]) => ({ placements: ids.map((i, x) => ({ i, x, y: 0, w: 1, h: 1 })) }) as never
  const offered = (canvas: never, about: ModuleAbout[], loads = true) => modulesOn(canvas, about, [], loads).find((one) => one.module === 'kehikot.flows')!.skills

  test('{ provides: steps } is offered when any steps provider is on the kehikko, and not otherwise', () => {
    expect(offered(on('kehikot.flows', 'kehikot.planner'), [flows, planner])).toEqual(['flow-roadmap', 'flows'])
    expect(offered(on('kehikot.flows', JOURNEYS_MODULE), [flows, journeysOld])).toEqual(['flow-roadmap', 'flows'])
    expect(offered(on('kehikot.flows', 'kehikot.notes'), [flows, notes])).toEqual(['flows'])
    expect(offered(on('kehikot.flows'), [flows])).toEqual(['flows'])
    /* A provider registered but not on this kehikko provides nothing here. */
    expect(offered(on('kehikot.flows'), [flows, planner])).toEqual(['flows'])
  })

  test('a needed id still works as it did', () => {
    const factory: ModuleAbout = { id: 'kehikot.factory', name: 'Factory', skills: [{ name: 'review-factory', needs: ['kehikot.review'] }] }
    const skills = (ids: string[]) => modulesOn(on(...ids), [factory], []).find((one) => one.module === 'kehikot.factory')!.skills
    expect(skills(['kehikot.factory', 'kehikot.review'])).toEqual(['review-factory'])
    expect(skills(['kehikot.factory'])).toEqual([])
  })

  test('kehikko-bound skills go only to a session from a module that loads skills', () => {
    expect(offered(on('kehikot.flows', 'kehikot.planner'), [flows, planner], false)).toEqual(['flows'])
  })
})
