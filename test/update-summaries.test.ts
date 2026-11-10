import { describe, expect, test } from 'bun:test'

import type { ModuleRelease } from '../src/host/moduleReleases.ts'
import {
  capped,
  compatBadge,
  firstSentence,
  moreSaid,
  NEEDS_NEWER_APP,
  noteSummaries,
  summaryLines,
  summaryTags,
} from '../src/host/updateSummaries.ts'

const release = (more: Partial<ModuleRelease> = {}): ModuleRelease => ({
  follows: 'release',
  installed: 'v1.4.0',
  newest: 'v1.6.0',
  target: 'v1.6.0',
  notes: ['v1.6.0', 'v1.5.0'],
  needsNewer: null,
  repo: 'owner/repo',
  error: null,
  ...more,
})

describe('the bold summaries of release notes', () => {
  test('each bullet gives its bold part, without the rest, the heading, the works-with sentence or the footer', () => {
    const body = [
      "### What's new",
      '- **Has an introduction.** Kehikot can show what it is for in a few slides.',
      '- **Faster start** when a project is opened.',
      '',
      'Works with Kehikot 0.1.117 and later.',
      '',
      '<sub>Built from 19f68dc</sub>',
    ].join('\n')
    expect(noteSummaries(body)).toEqual(['Has an introduction.', 'Faster start'])
  })

  test('a bullet with no bold part gives its first sentence, cut short', () => {
    expect(noteSummaries("### What's new\n- Reviewers who commented are shown as started. The rest is detail.")).toEqual([
      'Reviewers who commented are shown as started.',
    ])
    const long = `- ${'word '.repeat(40)}end.`
    const [line] = noteSummaries(long)
    expect(line!.length).toBeLessThanOrEqual(90)
    expect(line!.endsWith('…')).toBe(true)
    expect(firstSentence('No full stop at all')).toBe('No full stop at all')
  })

  test('nested: sub-bullets are left out, and bold, italics, code and links inside read as their words', () => {
    const body = [
      "## What's new",
      '- **Opens [the dialog](https://example.com) with _one_ `press`.** More.',
      '  - **A detail** that the parent covers.',
      '- *Italic only*, then [a link](javascript:alert(1)) at the end.',
    ].join('\n')
    expect(noteSummaries(body)).toEqual(['Opens the dialog with one press.', 'Italic only, then a link at the end.'])
  })

  test('markup in the notes stays characters', () => {
    expect(noteSummaries('- **<img src=x onerror=alert(1)>** shown')).toEqual(['<img src=x onerror=alert(1)>'])
  })

  test('a body with no bullets gives the first sentence of each paragraph', () => {
    expect(noteSummaries('One thing changed. Details.\n\nWorks with Kehikot 0.1.2 and later.')).toEqual(['One thing changed.'])
    expect(noteSummaries('')).toEqual([])
  })
})

describe('several releases, and the cap', () => {
  test('every release between installed and new, newest first', () => {
    expect(summaryTags(release({ notes: ['v1.6.0', 'v1.5.1', 'v1.5.0'] }))).toEqual(['v1.6.0', 'v1.5.1', 'v1.5.0'])
    expect(summaryTags(release({ target: null, notes: ['v1.4.0'] }))).toEqual([])
    expect(summaryTags(release({ repo: null }))).toEqual([])
    expect(summaryTags(release({ back: { to: 'v1.3.0', ask: null }, target: 'v1.3.0' }))).toEqual([])
    const lines = summaryLines([
      { tag: 'v1.6.0', lines: ['C', 'D'] },
      { tag: 'v1.5.0', lines: ['A'] },
    ])
    expect(lines).toEqual([
      { tag: 'v1.6.0', text: 'C' },
      { tag: 'v1.6.0', text: 'D' },
      { tag: 'v1.5.0', text: 'A' },
    ])
  })

  test('about three lines, then "+N more"', () => {
    expect(capped(['a', 'b', 'c'])).toEqual({ shown: ['a', 'b', 'c'], more: 0 })
    /* "+1 more" would take the line the last one needs. */
    expect(capped(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b', 'c', 'd'], more: 0 })
    expect(capped(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual({ shown: ['a', 'b', 'c'], more: 3 })
    expect(moreSaid(3)).toBe('+3 more')
  })
})

describe('the compatibility badge', () => {
  const works = { 'v1.6.0': { kind: 'from' as const, need: '2.10.0', from: '0.1.129', until: null } }

  test('quiet when the running Kehikot meets it', () => {
    expect(compatBadge(release({ works }), 'v1.6.0', { app: '0.1.130' })).toEqual({
      text: 'Kehikot 0.1.129+',
      warn: false,
      tip: 'Works with Kehikot 0.1.129 and later',
      detail: 'module protocol 2.10 or later',
    })
    /* Outside the app, nothing to compare: quiet. */
    expect(compatBadge(release({ works }), 'v1.6.0', {})?.warn).toBe(false)
  })

  test('a warning, with what to do, when it does not', () => {
    expect(compatBadge(release({ works }), 'v1.6.0', { app: '0.1.128' })).toEqual({
      text: 'Kehikot 0.1.129+',
      warn: true,
      tip: NEEDS_NEWER_APP,
      detail: 'module protocol 2.10 or later',
    })
    const unreleased = { 'v1.6.0': { kind: 'unreleased' as const, need: '2.11.0', newest: { app: '0.1.41', protocol: '2.10.0' } } }
    expect(compatBadge(release({ works: unreleased }), 'v1.6.0')).toEqual({ text: 'Kehikot newer than 0.1.41', warn: true, tip: NEEDS_NEWER_APP, detail: 'module protocol 2.11 or later' })
    const unknown = { 'v1.6.0': { kind: 'unknown' as const, need: '2.11.0' } }
    expect(compatBadge(release({ works: unknown }), 'v1.6.0', { protocol: '2.10.0' })).toMatchObject({ text: 'Newer Kehikot', warn: true })
    expect(compatBadge(release({ works: unknown }), 'v1.6.0', { protocol: '2.12.0' })).toMatchObject({ text: 'This Kehikot', warn: false })
    expect(compatBadge(release({ works: unknown }), 'v1.6.0')).toMatchObject({ text: 'Kehikot version not known', warn: false })
  })

  test('the badge never shows a protocol number; only its tooltip does', () => {
    const cases = {
      'v1.0.0': { kind: 'from' as const, need: '2.10.0', from: '0.1.129', until: null },
      'v1.1.0': { kind: 'from' as const, need: '1.1.0', from: '0.1.15', until: { last: '0.1.21', next: '0.1.22', major: 2 } },
      'v1.2.0': { kind: 'unreleased' as const, need: '2.11.0', newest: { app: '0.1.41', protocol: '2.10.0' } },
      'v1.3.0': { kind: 'unknown' as const, need: '2.11.0' },
    }
    for (const tag of Object.keys(cases)) {
      for (const have of [{}, { app: '0.1.20' }, { protocol: '2.10.0' }, { protocol: '2.12.0' }]) {
        const badge = compatBadge(release({ works: cases }), tag, have)!
        expect(badge.text).toMatch(/Kehikot/)
        expect(badge.text).not.toMatch(/protocol/i)
        expect(badge.tip).not.toMatch(/protocol/i)
        expect(badge.detail).toMatch(/^module protocol \d/)
      }
    }
  })

  test('nothing when nothing is known', () => {
    expect(compatBadge(release(), 'v1.6.0')).toBeNull()
    expect(compatBadge(release({ works }), null)).toBeNull()
  })
})
