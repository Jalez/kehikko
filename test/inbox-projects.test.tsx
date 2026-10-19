import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityItem } from 'kehikot-module-protocol'

import { InboxControl, InboxPanel, type InboxView } from '../src/canvas/Inbox.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import { byProject } from '../src/canvas/useInbox.ts'
import { tally, type Entry } from '../src/host/inbox.ts'

/** Switching project silences nothing: other projects' items are filed, shown and counted. */

const THESIS = { id: 2, name: 'thesis_latex', path: '/Users/me/CS-DEGREE' }
const PORTAL = { id: 3, name: 'Community portal', path: '/Users/me/hippos-portal' }
const item = (id: string, more: Partial<ActivityItem> = {}): ActivityItem => ({ id, state: 'attention', label: id, ...more })

describe('a tagged list, filed by project', () => {
  test('each item under the project its folder names, without the field; untagged under the open one', () => {
    const { lists, unknown } = byProject(
      [item('a', { project: THESIS.path }), item('b', { project: `${PORTAL.path}/` }), item('c')],
      THESIS.id,
      [THESIS, PORTAL],
    )
    expect(unknown).toBe(0)
    expect(lists.get(THESIS.id)).toEqual([item('a'), item('c')])
    expect(lists.get(PORTAL.id)).toEqual([item('b')])
  })

  test('complete across projects: a project reported to before and named by nothing now is told []', () => {
    const { lists } = byProject([item('a', { project: THESIS.path })], THESIS.id, [THESIS, PORTAL], [PORTAL.id])
    expect(lists.get(PORTAL.id)).toEqual([])
  })

  test('a folder no project is in is kept nowhere, and counted', () => {
    const { lists, unknown } = byProject([item('a', { project: '/elsewhere/entirely' })], THESIS.id, [THESIS, PORTAL])
    expect(unknown).toBe(1)
    expect(lists.size).toBe(0)
  })

  test('with no project open, a tagged item still has somewhere to go and an untagged one does not', () => {
    const { lists, unknown } = byProject([item('a', { project: PORTAL.path }), item('b')], null, [THESIS, PORTAL])
    expect(lists.get(PORTAL.id)).toEqual([item('a')])
    expect(unknown).toBe(1)
  })
})

describe('other projects in the Inbox', () => {
  const entry = (id: string, state: Entry['state'], more: Partial<Entry> = {}): Entry => ({
    module: 'kehikot.claude',
    name: 'Claude',
    id,
    state,
    label: id,
    priority: 'normal',
    refs: [],
    entered: Date.now() - 60_000,
    opened: Date.now() - 60_000,
    closed: null,
    how: null,
    seen: null,
    dismissed: null,
    origin: 'activity',
    ...more,
  })
  const view = (entries: Entry[], elsewhere: InboxView['elsewhere']): InboxView => {
    const at = { epic: 'thesis', kehikko: 'k1' }
    return {
      entries,
      elsewhere,
      onGoElsewhere: () => {},
      onDismissElsewhere: () => {},
      earlierCount: 0,
      at,
      scope: 'everywhere',
      onScope: () => {},
      names: { epic: () => null, part: () => null, kehikko: () => null },
      tally: tally(entries, at),
      next: null,
      open: true,
      onOpenChange: () => {},
      onGo: () => {},
      onNext: () => {},
      onSee: () => {},
      onDismiss: () => {},
      onForget: () => {},
      onSeeAll: () => {},
      loadLog: async () => ({ rows: [], more: false, total: 0 }),
      rev: 1,
      shortcut: 'Alt+Shift+N',
      now: () => Date.now(),
    }
  }

  test('the panel shows each other project under its name, what needs the person first', () => {
    const html = renderToStaticMarkup(
      <InboxPanel view={view([], [{ project: PORTAL, entries: [entry('w', 'working', { label: 'Building the reel' }), entry('q', 'attention', { label: 'Kiosk reel', place: { epic: 'kiosk-info-reel' } })] }])} />,
    )
    expect(html).toContain('In Community portal')
    expect(html).toContain('data-inbox-project="3"')
    expect(html.indexOf('Kiosk reel')).toBeLessThan(html.indexOf('Building the reel'))
    expect(html).toContain('Community portal · kiosk-info-reel')
    /* Something waits elsewhere, so "Nothing needs you." would not be true. */
    expect(html).toContain('Nothing needs you here.')
  })

  test('the control counts them and says where they are', () => {
    const v = { ...view([], [{ project: PORTAL, entries: [entry('q', 'attention'), entry('d', 'done')] }]), open: false }
    const html = renderToStaticMarkup(<TooltipProvider><InboxControl view={v} worst="attention" /></TooltipProvider>)
    expect(html).toContain('data-activity-count="">1<')
    expect(html).toContain('1 needs you in other projects')
  })
})
