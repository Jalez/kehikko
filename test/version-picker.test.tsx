import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { VersionList, versionHint } from '../src/canvas/Versions.tsx'
import type { Presence } from '../src/host/registry.ts'
import { indicator, moduleRow, stateText, updateRows } from '../src/host/updateModel.ts'
import { waiting, type Reading } from '../src/host/updates.ts'
import { pinnedPresence, versionLabel, versionRows, type PinView, type VersionListing } from '../src/host/versions.ts'

const listing = (more: Partial<VersionListing> = {}): VersionListing => ({
  module: 'kehikot.notes',
  name: 'Notes',
  latest: { version: '2.1.0', commit: 'abc1234', dataVersion: 2 },
  pinned: null,
  recorded: 2,
  versions: [
    { tag: 'v2.1.0', compatible: true, incompatible: null, dataVersion: 2, blocked: null, prepared: true, running: true },
    { tag: 'v2.0.0', compatible: null, incompatible: null, dataVersion: null, blocked: null, prepared: false, running: false },
    {
      tag: 'v1.4.0',
      compatible: true,
      incompatible: null,
      dataVersion: 1,
      blocked: 'Notes v1.4.0 writes its data in format 1, and this project’s Notes data has already been written in format 2',
      prepared: true,
      running: false,
    },
    {
      tag: 'v0.9.0',
      compatible: false,
      incompatible: 'Notes speaks protocol >=1 <2. This host speaks protocol 2.',
      dataVersion: 1,
      blocked: null,
      prepared: true,
      running: false,
    },
  ],
  hint: null,
  error: null,
  ...more,
})

describe('the picker’s rows', () => {
  test('latest first, saying what the checkout is, then the tags newest first', () => {
    const rows = versionRows(listing())
    expect(rows.map((r) => r.tag)).toEqual([null, 'v2.1.0', 'v2.0.0', 'v1.4.0', 'v0.9.0'])
    expect(rows[0]).toMatchObject({ label: 'Latest', detail: '2.1.0 · abc1234 — its checkout', chosen: true, disabled: null })
    expect(rows[1]).toMatchObject({ detail: 'running · data 2', disabled: null, mark: null })
    expect(rows[2]).toMatchObject({ detail: null, disabled: null })
  })

  test('a blocked tag and an incompatible one are disabled, with the reason', () => {
    const rows = versionRows(listing())
    expect(rows[3]).toMatchObject({ mark: 'blocked', disabled: expect.stringContaining('format 2') })
    expect(rows[4]).toMatchObject({ mark: 'incompatible', disabled: expect.stringContaining('protocol') })
  })

  test('the pinned tag is the chosen one, and is never disabled even when it is blocked', () => {
    const rows = versionRows(listing({ pinned: 'v1.4.0' }))
    expect(rows[0]!.chosen).toBe(false)
    expect(rows[3]).toMatchObject({ chosen: true, disabled: null, mark: 'blocked' })
  })

  test('the control says the pin, or what latest calls itself', () => {
    expect(versionLabel('v1.4.0', '2.1.0')).toBe('v1.4.0')
    expect(versionLabel(null, '2.1.0')).toBe('2.1.0')
    expect(versionLabel(null, null)).toBe('latest')
  })
})

describe('the picker, rendered', () => {
  test('latest, pinned, incompatible and blocked each draw distinctly', () => {
    const html = renderToStaticMarkup(<VersionList listing={listing({ pinned: 'v2.0.0' })} onChoose={() => {}} />)
    const doc = new DOMParserLike(html)
    expect(doc.item('latest')).toMatchObject({ checked: 'false', disabled: false })
    expect(doc.item('latest').text).toContain('Latest')
    expect(doc.item('latest').text).toContain('2.1.0 · abc1234')
    expect(doc.item('v2.0.0')).toMatchObject({ checked: 'true', disabled: false })
    expect(doc.item('v1.4.0')).toMatchObject({ mark: 'blocked', disabled: true })
    expect(doc.item('v1.4.0').text).toContain('format 2')
    expect(doc.item('v0.9.0')).toMatchObject({ mark: 'incompatible', disabled: true })
    expect(doc.item('v0.9.0').text).toContain('This host speaks protocol 2')
    expect(doc.item('v2.1.0')).toMatchObject({ disabled: false, mark: null })
  })

  test('a module with no tags shows only latest, and how to publish a version', () => {
    const html = renderToStaticMarkup(
      <VersionList
        listing={listing({ versions: [], hint: 'Notes has no releases yet. Its author can publish one by tagging, e.g. git tag v1.0.0 && git push --tags.' })}
        onChoose={() => {}}
      />,
    )
    const doc = new DOMParserLike(html)
    expect(doc.items()).toEqual(['latest'])
    expect(html).toContain('data-testid="versions-hint"')
    expect(html).toContain('git tag v1.0.0')
  })
})

/** Enough of a parser for these assertions, without a DOM in this process. */
class DOMParserLike {
  readonly #html: string
  constructor(html: string) {
    this.#html = html
  }
  items(): string[] {
    return [...this.#html.matchAll(/data-version="([^"]+)"/g)].map((m) => m[1]!)
  }
  item(version: string) {
    const start = this.#html.indexOf(`data-version="${version}"`)
    const open = this.#html.lastIndexOf('<button', start)
    const close = this.#html.indexOf('</button>', start)
    const tag = this.#html.slice(open, this.#html.indexOf('>', start))
    const body = this.#html.slice(open, close)
    return {
      checked: /aria-checked="(true|false)"/.exec(tag)?.[1] ?? null,
      disabled: /\sdisabled=""/.test(tag),
      mark: /data-mark="([^"]+)"/.exec(tag)?.[1] ?? null,
      text: body.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' '),
    }
  }
}

describe('what a pinned container shows', () => {
  const latest: Presence = {
    id: 'kehikot.notes',
    at: 'http://127.0.0.1:7920',
    condition: 'ready',
    line: 'Notes',
    name: 'Notes',
    state: '{"kept":1}',
    module: { id: 'kehikot.notes', name: 'Notes', version: '2.1.0', entry: 'http://127.0.0.1:7920/app' } as Presence['module'],
  }
  const pin = (state: PinView['state'], presence: Presence | null = null): PinView => ({
    kehikko: 1,
    module: 'kehikot.notes',
    version: 'v1.4.0',
    state,
    line: `line for ${state}`,
    presence,
  })

  test('latest is the module’s own presence, untouched', () => {
    expect(pinnedPresence(latest, null, undefined)).toEqual({ presence: latest, waiting: false })
  })

  test('a ready version shows its own page, under the module’s id and kept state', () => {
    const version: Presence = {
      ...latest,
      at: 'http://127.0.0.1:7925',
      state: undefined,
      module: { ...latest.module!, version: '1.4.0', entry: 'http://127.0.0.1:7925/app' },
    }
    const got = pinnedPresence(latest, 'v1.4.0', pin('ready', version))
    expect(got.waiting).toBe(false)
    expect(got.presence?.module?.entry).toBe('http://127.0.0.1:7925/app')
    expect(got.presence?.state).toBe('{"kept":1}')
  })

  test('on its way, it says so and offers no Start — that would start latest', () => {
    const got = pinnedPresence(latest, 'v1.4.0', pin('preparing'))
    expect(got).toMatchObject({ waiting: true, presence: { condition: 'silent', lifecycle: 'starting', line: 'line for preparing' } })
    expect(got.presence?.module).toBeUndefined()
    expect(pinnedPresence(latest, 'v1.4.0', undefined).presence?.line).toBe('Preparing Notes v1.4.0…')
  })

  test('blocked, failed or incompatible, it shows the refusal and no page', () => {
    for (const state of ['blocked', 'failed', 'incompatible'] as const) {
      const got = pinnedPresence(latest, 'v1.4.0', pin(state))
      expect(got).toMatchObject({ waiting: true, presence: { condition: 'incompatible', line: `line for ${state}` } })
      expect(got.presence?.lifecycle).toBeUndefined()
    }
  })
})

describe('Updates, with pinned containers', () => {
  const checkout = (id: string, behind: number): Reading => ({
    id,
    name: id,
    dir: `/${id}`,
    branch: 'main',
    commit: 'abc1234',
    dirty: false,
    upstream: 'origin/main',
    behind,
    ahead: 0,
    incoming: [],
    fetchFailed: null,
    blocked: behind ? null : 'already up to date',
  })
  const pins = { 'kehikot.notes': { containers: 2, versions: ['v1.2.0'] } }

  test('a module with pinned containers says so', () => {
    const row = moduleRow(checkout('kehikot.notes', 0), null, null, pins['kehikot.notes'])
    expect(row).toMatchObject({ state: 'pinned', version: 'v1.2.0', reason: '2 containers pinned to v1.2.0' })
    expect(stateText(row)).toBe('2 containers pinned to v1.2.0')
    const behind = moduleRow(checkout('kehikot.notes', 3), null, null, pins['kehikot.notes'])
    expect(stateText(behind)).toBe('2 containers pinned to v1.2.0 · latest has 3 new commits')
  })

  test('and the header does not count it as waiting for an update', () => {
    const rows = updateRows(null, [checkout('kehikot.notes', 3), checkout('kehikot.paper', 1)], {}, null, pins)
    expect(rows.map((r) => r.state)).toEqual(['pinned', 'available'])
    expect(indicator(rows)).toEqual({ label: '1 update', tone: 'info' })
    expect(indicator(updateRows(null, [checkout('kehikot.notes', 3)], {}, null, pins))).toBeNull()
    expect(waiting([checkout('kehikot.notes', 3), checkout('kehikot.paper', 1)], pins)).toBe(1)
  })

  test('an update in flight or just failed still says that, pinned or not', () => {
    expect(moduleRow(checkout('kehikot.notes', 3), null, 'updating', pins['kehikot.notes']).state).toBe('updating')
    expect(moduleRow(checkout('kehikot.notes', 3), { kind: 'failed', why: 'no' }, null, pins['kehikot.notes']).state).toBe('failed')
  })
})

describe('what the version in a header says when pointed at', () => {
  test('the protocol package the module is built with, when it states one', () => {
    expect(versionHint('Notes', null, '0.36.0')).toBe('Notes runs latest · built with protocol 0.36.0 — press to pick a version')
    expect(versionHint('Notes', 'v1.2.0', '0.34.0')).toBe('Notes is pinned to v1.2.0 on this kehikko · built with protocol 0.34.0 — press to change')
  })

  test('and exactly what it said before for a module that does not', () => {
    expect(versionHint('Notes', null, null)).toBe('Notes runs latest — press to pick a version')
    expect(versionHint('Notes', 'v1.2.0', null)).toBe('Notes is pinned to v1.2.0 on this kehikko — press to change')
  })
})
