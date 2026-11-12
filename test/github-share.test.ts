import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { settingsRoute } from '../server/agentSettings.ts'
import { decide, floorOf, SHARE, shareOf, type Limit, type Spend } from '../server/githubAccount.ts'
import { readGithubShare, writeGithubShare } from '../server/githubShare.ts'
import { OPEN_EVENT, SETTINGS_TARGETS, openSettings, onOpenSettings, settingsLinkOf } from '../src/host/agentSettings.ts'
import { isShareNotice, shareChange, shareFromInput, sharePercentOf, SHARE_PERCENT } from '../src/host/githubShare.ts'
import { revealTarget, targetIn } from '../src/host/settingsTarget.ts'

const T0 = 1_700_000_000_000
const RESET = T0 + 30 * 60_000
const limit = (remaining: number): Limit => ({ limit: 5000, used: 5000 - remaining, remaining, reset: RESET })
const spent = (used: number): Spend => ({ used, reset: RESET, started: T0 })

describe('the share setting', () => {
  test('bounds: whole percent from 5 to 50', () => {
    expect([4, 5, 20, 50, 51, 12.5, '20', null].map(sharePercentOf)).toEqual([null, 5, 20, 50, null, null, null, null])
    expect(shareChange({ share: 30 })).toBe(30)
    expect(shareChange({ share: 60 })).toBeNull()
    expect(shareChange({ share: 30, other: 1 })).toBeNull()
    expect(shareChange([])).toBeNull()
    expect(shareFromInput('99')).toBe(SHARE_PERCENT.max)
    expect(shareFromInput('1')).toBe(SHARE_PERCENT.min)
    expect(shareFromInput('')).toBeNull()
    expect(shareFromInput('abc')).toBeNull()
  })

  test('persists, and applies to the rule', () => {
    const db = new Database(':memory:')
    expect(readGithubShare(db)).toBe(20)
    writeGithubShare(db, 35)
    expect(readGithubShare(db)).toBe(35)
    expect(shareOf(5000, 0.35)).toBe(1750)
    expect(shareOf(5000)).toBe(shareOf(5000, SHARE))
    const base = { resource: 'graphql' as const, urgency: 'background' as const, now: T0, limit: limit(4000), backoff: null, spend: spent(1200) }
    expect(decide(base)).toMatchObject({ go: false, kind: 'share' })
    expect(decide({ ...base, share: 0.35 })).toEqual({ go: true })
    expect(floorOf(5000)).toBe(500)
  })

  test('the settings route answers it, takes a change and refuses a bad one', async () => {
    const db = new Database(':memory:')
    db.exec('create table if not exists settings (key text primary key, value text not null)')
    const route = settingsRoute({
      db,
      status: () => ({ at: 0, running: false, problems: [], modules: [] }),
     
      skillsAt: () => '/scratch/.claude/skills',
      hook: () => ({ file: '/scratch/.claude/settings.json', on: false }),
    })
    const url = new URL('http://127.0.0.1/host/settings')
    expect((await (await route(new Request(url), url))!.json()).github).toEqual({ share: 20 })
    const post = (body: unknown) => route(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url)
    expect((await (await post({ github: { share: 40 } }))!.json()).github).toEqual({ share: 40 })
    expect(readGithubShare(db)).toBe(40)
    expect((await post({ github: { share: 3 } }))!.status).toBe(400)
    expect(readGithubShare(db)).toBe(40)
  })
})

describe('the limit notice and the deep link', () => {
  test('the notice is recognised, other sentences are not', () => {
    expect(isShareNotice("Kehikot's share of your GitHub GraphQL limit is used until 09:52 AM.")).toBe(true)
    expect(isShareNotice("Kehikot's share of your GitHub limit is used until 11:00")).toBe(true)
    expect(isShareNotice('Your GitHub limit is down to 400 of 5,000; Kehikot leaves the last 500 to you')).toBe(false)
    expect(isShareNotice(null)).toBe(false)
  })

  test('a link is read strictly', () => {
    expect(settingsLinkOf('modules')).toEqual({ section: 'modules', target: null })
    expect(settingsLinkOf({ section: 'modules', target: 'github-share' })).toEqual({ section: 'modules', target: 'github-share' })
    expect(settingsLinkOf({ section: 'nope', target: '"><x' })).toEqual({ section: null, target: null })
    expect(settingsLinkOf(null)).toEqual({ section: null, target: null })
    expect(SETTINGS_TARGETS.githubShare).toEqual({ section: 'trackers', target: 'github-share' })
  })

  test('openSettings carries the section and the target to a listener', () => {
    const heard: unknown[] = []
    const listeners = new Set<(event: Event) => void>()
    const had = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: (name: string, fn: (event: Event) => void) => name === OPEN_EVENT && listeners.add(fn),
      removeEventListener: (_: string, fn: (event: Event) => void) => listeners.delete(fn),
      dispatchEvent: (event: Event) => void listeners.forEach((fn) => fn(event)),
    }
    try {
      const off = onOpenSettings((section, target) => heard.push([section, target]))
      openSettings()
      openSettings('tools')
      openSettings('modules', 'github-share')
      off()
      openSettings('about')
      expect(heard).toEqual([[null, null], ['tools', null], ['modules', 'github-share']])
    } finally {
      ;(globalThis as { window?: unknown }).window = had
    }
  })

  test('revealing a target scrolls, focuses and lights it, then puts the light out', () => {
    const calls: string[] = []
    const attrs = new Map<string, string>()
    const input = { focus: () => calls.push('focus') }
    const row = {
      getAttribute: (name: string) => (name === 'data-settings-target' ? 'github-share' : null),
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
      scrollIntoView: () => calls.push('scroll'),
      matches: () => false,
      querySelector: () => input,
    }
    const root = { querySelectorAll: () => [row] } as unknown as ParentNode
    expect(targetIn(root, 'other')).toBeNull()
    expect(revealTarget(root, 'other')).toBe(false)
    let off = () => {}
    expect(revealTarget(root, 'github-share', (fn) => (off = fn))).toBe(true)
    expect(calls).toEqual(['scroll', 'focus'])
    expect(attrs.get('data-lit')).toBe('true')
    off()
    expect(attrs.has('data-lit')).toBe(false)
  })
})
