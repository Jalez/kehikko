import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { StorageBody } from '../src/canvas/Storage.tsx'
import type { StorageReport, Tally } from '../src/host/storage.ts'

/**
 * The Storage view drawn (`src/canvas/Storage.tsx`): totals per module across
 * projects, each project expandable with its folders, a missing project said,
 * the machine's data as its own section, every number in words, and a link to
 * a module's own storage view only where it offers one.
 */

const tally = (bytes: number, files: number, more: Partial<Tally> = {}): Tally => ({
  bytes,
  files,
  largest: [],
  modified: Date.UTC(2026, 9, 20),
  links: 0,
  cut: false,
  ...more,
})

const report: StorageReport = {
  at: Date.UTC(2026, 9, 20, 12),
  took: 42,
  cut: false,
  projects: [
    {
      id: 1,
      name: 'thesis',
      path: '/Users/somebody/thesis',
      total: tally(2_450_000, 14),
      shares: [
        {
          folder: 'checklist',
          owner: { id: 'kehikot.checklist', name: 'Checklist' },
          tally: tally(2_400_000, 12, { largest: [{ path: 'checklist/big.json', bytes: 2_000_000 }] }),
        },
        { folder: 'host', owner: { id: 'kehikko', name: 'Kehikot' }, tally: tally(50_000, 2) },
      ],
    },
  ],
  missing: [{ id: 2, name: 'old', path: '/Users/somebody/old' }],
  modules: [
    { id: 'kehikot.checklist', name: 'Checklist', bytes: 2_400_000, files: 12, projects: 3, cut: false },
    { id: 'kehikko', name: 'Kehikot', bytes: 50_000, files: 2, projects: 1, cut: true },
  ],
  machine: {
    path: '/Users/somebody/Library/Application Support/Kehikot',
    bytes: 9_000_000,
    parts: [
      { key: 'frame', label: 'Kehikot’s own database', path: '/x/frame.sqlite', tally: tally(1_000_000, 1) },
      {
        key: 'installed',
        label: 'Installed modules',
        path: '/x/installed',
        tally: tally(8_000_000, 900),
        modules: [{ folder: 'kehikot.checklist', owner: { id: 'kehikot.checklist', name: 'Checklist' }, tally: tally(8_000_000, 900) }],
      },
      { key: 'logs', label: 'Logs', path: '/x/logs', tally: null },
    ],
  },
}

describe('the Storage view', () => {
  test('per module across projects, per project expandable, the missing one, and the machine', () => {
    const html = renderToStaticMarkup(<StorageBody report={report} onOpenView={() => {}} />)
    expect(html).toContain('Checklist: 2.4 MB across 3 projects')
    expect(html).toContain('Kehikot: at least 50 KB across 1 project')
    expect(html).toContain('<details')
    expect(html).toContain('thesis</span>: 2.5 MB in 14 files')
    expect(html).toContain('.kehikot/checklist/')
    expect(html).toContain('checklist/big.json')
    expect(html).toContain('2 MB')
    expect(html).toContain('old: its folder is gone, so it was not measured.')
    expect(html).toContain('Kehikot on this computer: 9 MB')
    expect(html).toContain('Installed modules: 8 MB in 900 files')
    expect(html).toContain('Logs: nothing there')
    /* Nothing here deletes: no control but the link to a module's own view. */
    expect(html).not.toMatch(/delete|clear|remove/i)
    expect(html).not.toContain('storage view')
  })

  test('links to a module’s own storage view only where the module offers one', () => {
    const views = { of: (id: string) => id === 'kehikot.checklist', open: async () => ({ ok: true, why: '' }) }
    const html = renderToStaticMarkup(<StorageBody report={report} views={views} onOpenView={() => {}} />)
    expect(html).toContain('open Checklist’s storage view')
    expect(html).not.toContain('open Kehikot’s storage view')
  })

  test('a cut report says so in words', () => {
    const html = renderToStaticMarkup(<StorageBody report={{ ...report, cut: true }} onOpenView={() => {}} />)
    expect(html).toContain('at its time or size limit')
  })
})
