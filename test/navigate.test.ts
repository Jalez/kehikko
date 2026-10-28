import { describe, expect, test } from 'bun:test'
import { MANIFEST_KIND, PACKAGE_VERSION, PROTOCOL, contextSchema, fitOf, navigationResult } from 'kehikot-module-protocol'

import { makeAsk, type CanvasControls, type GotoAnswer, type GotoCall } from '../src/host/ask.ts'
import {
  AGENT_PRESS_HOLD_MS,
  NAVIGATE_SAYS,
  planJump,
  projectFor,
  showReceivers,
  shownBy,
  type HeldProject,
  type JumpFacts,
} from '../src/host/navigate.ts'

/** Protocol 2.28.0, the host's half: `view.goto { project, show }` and `context.show`. */

const projects: HeldProject[] = [
  { id: 1, name: 'kehikko', path: '/Users/me/kehikko', uid: 'p-kehikko-1' },
  { id: 2, name: 'thesis', path: '/Users/me/thesis', uid: 'p-thesis-22' },
  { id: 3, name: 'old', path: '/Users/me/old', uid: null },
  { id: 4, name: 'gone', path: '/Users/me/gone', uid: 'p-gone-4444', missing: true },
]

const pressed = { onScreen: true, focused: true, agentPressedAt: null, now: 1_000_000 }
const facts = (over: Partial<JumpFacts> = {}): JumpFacts => ({
  name: 'Test runs',
  navigates: ['project', 'show'],
  projects,
  open: 1,
  press: pressed,
  ...over,
})

describe('which project a view.goto names', () => {
  test('by its id, else by its folder now', () => {
    expect(projectFor(projects, 'p-thesis-22')).toEqual({ ok: true, project: projects[1]! })
    expect(projectFor(projects, '/Users/me/old')).toEqual({ ok: true, project: projects[2]! })
    expect(projectFor(projects, '/Users/me/old/')).toEqual({ ok: true, project: projects[2]! })
  })
  test('one this host does not hold is said without naming any other', () => {
    for (const key of ['p-nobody-99', '/Users/me', '/Users/me/thesis/sub', 'thesis']) {
      const found = projectFor(projects, key)
      expect(found).toEqual({ ok: false, why: NAVIGATE_SAYS.unknownProject })
    }
    expect(NAVIGATE_SAYS.unknownProject).not.toContain('thesis')
  })
  test('one whose folder is gone is refused', () => {
    expect(projectFor(projects, 'p-gone-4444')).toEqual({ ok: false, why: NAVIGATE_SAYS.goneProject('gone') })
  })
})

describe('switching from another project', () => {
  const call = { epic: 'queue', kehikko: 'k-dev', parts: ['seam'], project: 'p-thesis-22', show: { subject: 'agent-session', id: 's1' } }

  test('a person’s press in front of them switches, and the rest of the call goes there', () => {
    expect(planJump(call, facts())).toEqual({
      kind: 'switch',
      project: projects[1]!,
      call: { epic: 'queue', kehikko: 'k-dev', parts: ['seam'], show: { subject: 'agent-session', id: 's1' } },
    })
  })
  test('the open project is a move within it', () => {
    expect(planJump({ ...call, project: '/Users/me/kehikko' }, facts()).kind).toBe('here')
  })
  test('a call without project or show is what it was', () => {
    expect(planJump<GotoCall>({ epic: 'queue', kehikko: 'k' }, facts({ navigates: [] }))).toEqual({ kind: 'here', call: { epic: 'queue', kehikko: 'k' } } as never)
  })
  test('refuses an unknown project, and does not switch', () => {
    expect(planJump({ ...call, project: 'p-nobody-99' }, facts())).toEqual({ kind: 'decline', why: NAVIGATE_SAYS.unknownProject })
  })
  test('held to declares.navigates', () => {
    expect(planJump(call, facts({ navigates: [] }))).toEqual({ kind: 'decline', why: NAVIGATE_SAYS.undeclaredProject('Test runs') })
    expect(planJump({ epic: 'q', show: call.show }, facts({ navigates: ['project'] }))).toEqual({
      kind: 'decline',
      why: NAVIGATE_SAYS.undeclaredShow('Test runs'),
    })
  })
  test('only a person’s press: on screen, focused, and not just after an agent pressed the module', () => {
    expect(planJump(call, facts({ press: { ...pressed, onScreen: false } }))).toEqual({ kind: 'decline', why: NAVIGATE_SAYS.notInFront })
    expect(planJump(call, facts({ press: { ...pressed, focused: false } }))).toEqual({ kind: 'decline', why: NAVIGATE_SAYS.notFocused })
    const agent = { ...pressed, agentPressedAt: pressed.now - 500 }
    expect(planJump(call, facts({ press: agent }))).toEqual({ kind: 'decline', why: NAVIGATE_SAYS.agentPressed })
    const later = { ...pressed, agentPressedAt: pressed.now - AGENT_PRESS_HOLD_MS - 1 }
    expect(planJump(call, facts({ press: later })).kind).toBe('switch')
  })
})

describe('view.goto reaches the canvas with project, show and who asked', () => {
  const seen: { call: GotoCall; from?: string }[] = []
  const canvas = (out: GotoAnswer | Promise<GotoAnswer>): CanvasControls =>
    ({
      showEpic() {},
      goto: (call: GotoCall, from?: string) => (seen.push({ call, from }), out),
      project: () => null,
    }) as unknown as CanvasControls
  const ask = (out: GotoAnswer | Promise<GotoAnswer>, params: unknown) =>
    makeAsk('kehikot.queue', canvas(out), (capability) => capability === 'view:navigate')('view.goto', params)

  test('a switch answers when the canvas has arrived', async () => {
    seen.length = 0
    const arrived = Promise.resolve<GotoAnswer>({ outcome: 'moved', epic: 'queue', why: '' })
    const out = await ask(arrived, { epic: 'queue', project: 'p-thesis-22', show: { subject: 'agent-session', id: 's1' } })
    expect(seen).toEqual([{ call: { epic: 'queue', project: 'p-thesis-22', show: { subject: 'agent-session', id: 's1' } }, from: 'kehikot.queue' }])
    expect(out.ok && navigationResult.parse(out.data).outcome).toBe('moved')
  })
  test('a refusal is declined, in the protocol’s shape', async () => {
    const out = await ask({ outcome: 'declined', epic: null, why: NAVIGATE_SAYS.unknownProject }, { epic: 'queue', project: 'p-nobody-99' })
    expect(out.ok && navigationResult.parse(out.data)).toEqual({ outcome: 'declined', epic: null, why: NAVIGATE_SAYS.unknownProject })
  })
  test('a project without an epic is refused before the canvas', async () => {
    seen.length = 0
    const out = await ask({ outcome: 'moved', epic: 'x', why: '' }, { project: 'p-thesis-22' })
    expect(out.ok).toBe(false)
    expect(seen).toEqual([])
  })
})

describe('context.show goes only to a declaring module on the destination kehikko', () => {
  const show = shownBy({ subject: 'agent-session', id: 's1' }, 'kehikot.queue', new Date('2026-10-28T10:00:00Z'))
  const manifests: Record<string, { shows?: string[] }> = {
    'kehikot.claude': { shows: ['agent-session'] },
    'kehikot.codex': { shows: ['agent-session'] },
    'kehikot.paper': {},
    'kehikot.slides': { shows: ['slide'] },
  }
  const of = (id: string) => manifests[id]
  const placed = ['kehikot.claude', 'kehikot.paper', 'kehikot.slides', 'kehikot.queue']

  test('stamped with who asked and when', () => {
    expect(show).toEqual({ subject: 'agent-session', id: 's1', by: 'kehikot.queue', at: '2026-10-28T10:00:00.000Z' })
    expect(contextSchema.parse({ show }).show).toEqual(show)
  })
  test('the declaring modules placed there, and nobody else', () => {
    expect(showReceivers({ kehikko: 7, show }, 7, placed, of)).toEqual(['kehikot.claude'])
    expect(showReceivers({ kehikko: 7, show }, 7, [...placed, 'kehikot.codex'], of)).toEqual(['kehikot.claude', 'kehikot.codex'])
  })
  test('not on another kehikko, and nothing without a show', () => {
    expect(showReceivers({ kehikko: 7, show }, 8, placed, of)).toEqual([])
    expect(showReceivers(null, 7, placed, of)).toEqual([])
  })
})

describe('the fit check', () => {
  const manifest = {
    kind: MANIFEST_KIND,
    protocol: PROTOCOL,
    id: 'kehikot.queue',
    name: 'Test runs',
    version: '0.3.0',
    entry: '/app',
    modes: [{ id: 'queue', label: 'Test runs', scope: 'global' }],
    partless: 'Runs are this computer’s.',
    declares: { uses: ['view:navigate'], navigates: ['project', 'show'] },
  }
  test('this host is 2.28 or later and fits a module that goes to other projects', () => {
    expect(Bun.semver.order(PACKAGE_VERSION, '2.28.0')).toBeGreaterThanOrEqual(0)
    expect(fitOf(manifest).fit).toBe('fits')
  })
  test('a host before 2.28 is too old for it', () => {
    const fit = fitOf(manifest, { version: '2.27.0' })
    expect(fit.fit).toBe('host-too-old')
    if (fit.fit === 'host-too-old') expect(fit.since).toBe('2.28.0')
  })
  test('a module that only says it shows things fits an older host', () => {
    expect(fitOf({ ...manifest, declares: { uses: [] }, shows: ['agent-session'], build: { protocol: '2.28.0' } }, { version: '2.27.0' }).fit).toBe('fits')
  })
})
