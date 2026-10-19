import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import { AppReleaseList } from '../src/canvas/AppVersion.tsx'
import { Markdown } from '../src/canvas/ReleaseNotes.tsx'
import { AppRow } from '../src/canvas/Updates.tsx'
import { VersionList } from '../src/canvas/Versions.tsx'
import type { AppUpdateStatus } from '../src/host/appUpdate.ts'
import { parseMarkdown, plainText, safeHref, whatsNew } from '../src/host/markdown.ts'
import {
  appReleaseRows,
  notesLabel,
  notesTitle,
  openExternal,
  tagFor,
  versionHintFor,
  versionShown,
  type ReleaseSummary,
} from '../src/host/releaseNotes.ts'
import { appNotes, appRow } from '../src/host/updateModel.ts'
import { versionRows, type VersionListing } from '../src/host/versions.ts'

const status = (more: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  enabled: true,
  current: '0.1.24',
  state: 'uptodate',
  version: null,
  progress: null,
  error: null,
  checkedAt: 1,
  ...more,
})

describe('the version beside the name', () => {
  test('inside the app, the app’s own version', () => {
    expect(versionShown({ app: status(), engine: true, settled: true, host: '0.1.0' })).toEqual({ kind: 'app', version: '0.1.24', text: '0.1.24' })
    /* Even an app whose updater is off says what it is. */
    expect(versionShown({ app: status({ enabled: false }), engine: true, settled: true, host: '0.1.0' })?.kind).toBe('app')
  })

  test('elsewhere, the host’s, said as the host’s so it never reads as a release', () => {
    const shown = versionShown({ app: null, engine: false, settled: true, host: '0.1.0' })
    expect(shown).toEqual({ kind: 'host', version: '0.1.0', text: 'host 0.1.0' })
    expect(versionHintFor(shown!)).toContain('not a Kehikot release')
  })

  test('inside the app, nothing until the app has answered — and the host’s if it never does', () => {
    expect(versionShown({ app: null, engine: true, settled: false, host: '0.1.0' })).toBeNull()
    expect(versionShown({ app: null, engine: true, settled: true, host: '0.1.0' })?.text).toBe('host 0.1.0')
    expect(versionShown({ app: null, engine: false, settled: true, host: null })).toBeNull()
  })

  test('words', () => {
    expect(tagFor('0.1.24')).toBe('v0.1.24')
    expect(tagFor('v1.0.0')).toBe('v1.0.0')
    expect(notesTitle('Kehikot', '0.1.24')).toBe("What's new in Kehikot 0.1.24")
    expect(notesLabel('v1.2.0')).toBe('Show release notes for v1.2.0')
  })
})

describe('Kehikot’s releases', () => {
  const releases: ReleaseSummary[] = ['v0.1.25', 'v0.1.24', 'v0.1.23'].map((tag) => ({
    repo: 'Jalez/kehikko-desktop',
    tag,
    name: null,
    url: `https://github.com/Jalez/kehikko-desktop/releases/tag/${tag}`,
    publishedAt: '2026-10-19T11:35:41Z',
    prerelease: false,
  }))

  test('the installed one is marked, and an update on its way', () => {
    expect(appReleaseRows(releases, status()).map((r) => [r.version, r.mark])).toEqual([
      ['0.1.25', null],
      ['0.1.24', 'installed'],
      ['0.1.23', null],
    ])
    expect(appReleaseRows(releases, status({ state: 'downloading', version: '0.1.25' }))[0]!.mark).toBe('downloading')
    expect(appReleaseRows(releases, status({ state: 'ready', version: '0.1.25' }))[0]!.mark).toBe('ready')
    expect(appReleaseRows(releases, null).every((r) => r.mark === null)).toBe(true)
  })

  test('drawn read-only: one notes button per row, saying which version, and nothing to install', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AppReleaseList rows={appReleaseRows(releases, status({ state: 'ready', version: '0.1.25' }))} onNotes={() => {}} />
      </TooltipProvider>,
    )
    const labels = [...html.matchAll(/aria-label="(Show release notes for [^"]+)"/g)].map((m) => m[1])
    expect(labels).toEqual(['Show release notes for 0.1.25', 'Show release notes for 0.1.24', 'Show release notes for 0.1.23'])
    expect(html).toContain('data-mark="installed"')
    expect(html).toContain('ready to install')
    expect(html).not.toMatch(/role="menuitem/)
    expect(html.match(/<button/g)).toHaveLength(3)
  })
})

describe('the Updates menu’s app row', () => {
  test('what’s new for the version it runs', () => {
    expect(appNotes(appRow(status())!)).toEqual([{ version: '0.1.24', label: "What's new", pending: false }])
  })

  test('and for the one on its way, while it downloads or waits for a restart', () => {
    for (const state of ['downloading', 'installing', 'ready'] as const) {
      expect(appNotes(appRow(status({ state, version: '0.1.25' }))!)).toEqual([
        { version: '0.1.24', label: "What's new", pending: false },
        { version: '0.1.25', label: "Kehikot 0.1.25 — what's new", pending: true },
      ])
    }
    expect(appNotes(appRow(status({ state: 'failed', version: '0.1.25', error: 'x' }))!)).toHaveLength(1)
  })

  test('drawn: a notes button beside the running version, and a line for the coming one', () => {
    const draw = (one: AppUpdateStatus) =>
      renderToStaticMarkup(
        <TooltipProvider>
          <AppRow row={appRow(one)!} onApply={() => {}} onRetry={() => {}} onNotes={() => {}} />
        </TooltipProvider>,
      )
    const labels = (html: string) => [...html.matchAll(/aria-label="(Show release notes for [^"]+)"/g)].map((m) => m[1])
    expect(labels(draw(status()))).toEqual(['Show release notes for 0.1.24'])
    const ready = draw(status({ state: 'ready', version: '0.1.25' }))
    expect(labels(ready)).toEqual(['Show release notes for 0.1.24', 'Show release notes for 0.1.25'])
    expect(ready).toContain('Kehikot 0.1.25 — what&#x27;s new')
  })
})

describe('a module’s version picker', () => {
  const listing = (more: Partial<VersionListing> = {}): VersionListing => ({
    module: 'kehikot.notes',
    name: 'Notes',
    latest: { version: '2.1.0', commit: 'abc1234', dataVersion: 2, release: 'v2.1.0' },
    repo: 'Jalez/kehikko-notes',
    pinned: null,
    recorded: 2,
    versions: [
      { tag: 'v2.1.0', compatible: true, incompatible: null, dataVersion: 2, blocked: null, prepared: true, running: true, release: true },
      { tag: 'v2.0.0', compatible: null, incompatible: null, dataVersion: null, blocked: null, prepared: false, running: false, release: false },
      { tag: 'v1.0.0', compatible: false, incompatible: 'old protocol', dataVersion: 1, blocked: null, prepared: false, running: false, release: true },
    ],
    hint: null,
    error: null,
    ...more,
  })

  test('a tag offers notes only when it has a GitHub release; latest only when it is a released tag', () => {
    expect(versionRows(listing()).map((r) => [r.tag, r.notes])).toEqual([
      [null, 'v2.1.0'],
      ['v2.1.0', 'v2.1.0'],
      ['v2.0.0', null],
      ['v1.0.0', 'v1.0.0'],
    ])
    expect(versionRows(listing({ latest: { version: '2.2.0', commit: null, dataVersion: null, release: null } }))[0]!.notes).toBeNull()
  })

  test('no repository on GitHub, or an older server, offers none', () => {
    expect(versionRows(listing({ repo: null })).every((r) => r.notes === null)).toBe(true)
    const older = listing({ repo: undefined, versions: listing().versions.map(({ release: _r, ...one }) => one) })
    expect(versionRows(older).every((r) => r.notes === null)).toBe(true)
  })

  test('drawn: a button per released row, beside the row and not inside it; even a disabled row has its notes', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <VersionList listing={listing()} onChoose={() => {}} onNotes={() => {}} />
      </TooltipProvider>,
    )
    const labels = [...html.matchAll(/aria-label="(Show release notes for [^"]+)"/g)].map((m) => m[1])
    expect(labels).toEqual(['Show release notes for v2.1.0', 'Show release notes for v2.1.0', 'Show release notes for v1.0.0'])
    /* Never a button inside a button. */
    for (const row of html.split('role="none"').slice(1)) {
      const first = row.indexOf('</button>')
      expect(row.slice(0, first).match(/<button/g)).toHaveLength(1)
    }
  })

  test('without a way to show them, no buttons are drawn', () => {
    const html = renderToStaticMarkup(<VersionList listing={listing()} onChoose={() => {}} />)
    expect(html).not.toContain('Show release notes')
  })
})

describe('the notes, rendered safely', () => {
  const ours = [
    '**Download** `Kehikot_0.1.24_aarch64.dmg` for Macs.',
    '',
    "### What's new",
    '- **Modules from before the rename work again.** Nothing is deleted.',
    '- Clearer pick lists, see [the docs](https://github.com/Jalez/kehikko).',
    '',
    '<sub>Built from [Jalez/kehikko@63387c5](https://github.com/Jalez/kehikko/commit/63387c5).</sub>',
  ].join('\n')

  test('headings, bullets, bold, code spans, links and the footer', () => {
    const blocks = parseMarkdown(ours)
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'heading', 'list', 'small'])
    const html = renderToStaticMarkup(<Markdown source={ours} />)
    expect(html).toContain('<strong>Download</strong>')
    expect(html).toMatch(/<code[^>]*>Kehikot_0.1.24_aarch64.dmg<\/code>/)
    expect(html).toMatch(/<h5[^>]*>What&#x27;s new<\/h5>/)
    expect(html.match(/<li>/g)).toHaveLength(2)
    expect(html).toContain('href="https://github.com/Jalez/kehikko"')
    expect(html).not.toContain('<sub>')
    expect(html).toMatch(/<p class="text-muted-foreground[^"]*text-\[11px\]">Built from <a/)
  })

  test('a script, raw HTML and a javascript: link stay inert text', () => {
    const evil = [
      '<script>alert(1)</script>',
      '',
      '<img src=x onerror="alert(2)">',
      '',
      '- [click](javascript:alert(3)) and [data](data:text/html,<b>x</b>) and [plain](http://example.com)',
      '',
      '<sub><script>alert(4)</script></sub>',
      '',
      '<div onclick="x()">**bold**</div>',
    ].join('\n')
    const html = renderToStaticMarkup(<Markdown source={evil} />)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/<div onclick/i)
    expect(html).not.toMatch(/<b>/)
    expect(html).not.toContain('javascript:')
    expect(html).toContain('<li>click and data and plain</li>')
    expect(html).not.toContain('href="data:')
    expect(html).not.toContain('href="http:')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;')
    expect(html.match(/<a /g)).toBeNull()
  })

  test('only https addresses are links', () => {
    expect(safeHref('https://github.com/x')).toBe('https://github.com/x')
    expect(safeHref('http://github.com/x')).toBeNull()
    expect(safeHref(' javascript:alert(1)')).toBeNull()
    expect(safeHref('/relative')).toBeNull()
    const [block] = parseMarkdown('[a **b**](javascript:x)')
    expect(block?.kind === 'paragraph' ? plainText(block.children) : null).toBe('a b')
  })

  test('opening a page outside: https only', () => {
    const opened: string[] = []
    expect(openExternal('https://github.com/Jalez/kehikko-desktop/releases/tag/v0.1.24', (u) => opened.push(u))).toBe(true)
    expect(openExternal('javascript:alert(1)', (u) => opened.push(u))).toBe(false)
    expect(openExternal('file:///etc/passwd', (u) => opened.push(u))).toBe(false)
    expect(opened).toEqual(['https://github.com/Jalez/kehikko-desktop/releases/tag/v0.1.24'])
  })
})

describe('whatsNew: what the notes modal shows of a body', () => {
  const footer = '<sub>Built from [Jalez/kehikko@abc1234](https://github.com/Jalez/kehikko/commit/abc1234)</sub>'

  test('only the What’s new section, without its heading, the install steps or the footer', () => {
    const body = ["### What's new", '- one', '- two', '', '### Install', '**Download** it.', '', footer].join('\n')
    expect(whatsNew(body)).toBe('- one\n- two')
  })

  test('a curly apostrophe, any case, and the section running to the end', () => {
    expect(whatsNew(['## WHAT’S NEW', '- one', '', footer].join('\n'))).toBe('- one')
  })

  test('a heading at another level: ends at the same or a higher level, not a lower one', () => {
    const body = ['## What\'s new', '- one', '### Details', 'more', '# Install', 'x'].join('\n')
    expect(whatsNew(body)).toBe('- one\n### Details\nmore')
    expect(whatsNew(['#### What\'s new', 'a', '### Install', 'b'].join('\n'))).toBe('a')
  })

  test('without the heading: the whole body minus the footer', () => {
    expect(whatsNew(['- Fixed a thing', '', footer].join('\n'))).toBe('- Fixed a thing')
    expect(whatsNew('- Fixed a thing')).toBe('- Fixed a thing')
  })

  test('a footer-only or empty body is empty', () => {
    expect(whatsNew(footer)).toBe('')
    expect(whatsNew('')).toBe('')
  })

  test('an empty section falls back to the whole body', () => {
    const body = ["### What's new", '', '### Install', 'Download it.', '', footer].join('\n')
    expect(whatsNew(body)).toBe("### What's new\n\n### Install\nDownload it.")
  })

  test('a heading inside a code fence is not a heading', () => {
    const body = ["### What's new", '```', '# not a heading', '```', '### Install', 'x'].join('\n')
    expect(whatsNew(body)).toBe('```\n# not a heading\n```')
  })
})
