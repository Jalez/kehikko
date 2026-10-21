import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appProtocolSource,
  appProtocolsFrom,
  appProtocolsOn,
  appTagsFromLsRemote,
  REFRESH_EVERY_MS,
  RETRY_AFTER_MS,
} from '../server/appProtocols.ts'
import type { Runner } from '../server/versions.ts'
import { needsKehikotSaid, protocolSaid, satisfies, worksWith, worksWithSaid, type AppProtocol } from '../src/host/worksWith.ts'

/*
 * Which Kehikot a module release works with: the app tags of the host
 * repository → the protocol each app shipped → the first app that meets a
 * release's need. The network is stubbed: `git ls-remote` is a runner that
 * answers, `raw.githubusercontent.com` is a fetch that answers.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-works-with-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let made = 0
const cacheFile = () => join(root, `app-protocols-${(made += 1)}.json`)

/** The mapping as the real tags had it when this was written (app-v0.1.11 … app-v0.1.41, abridged). */
const APPS: AppProtocol[] = [
  { app: '0.1.11', protocol: '0.36.0' },
  { app: '0.1.12', protocol: '1.0.0' },
  { app: '0.1.15', protocol: '1.1.0' },
  { app: '0.1.21', protocol: '1.7.0' },
  { app: '0.1.22', protocol: '2.0.0' },
  { app: '0.1.26', protocol: '2.2.0' },
  { app: '0.1.34', protocol: '2.5.0' },
  { app: '0.1.37', protocol: '2.6.0' },
  { app: '0.1.38', protocol: '2.7.0' },
  { app: '0.1.39', protocol: '2.10.0' },
  { app: '0.1.40', protocol: '2.10.0' },
  { app: '0.1.41', protocol: '2.10.0' },
]

const sha = (n: number) => n.toString(16).padStart(40, '0')
const hostPkg = (pin: string) => JSON.stringify({ name: 'kehikko', dependencies: { 'kehikot-module-protocol': `git+ssh://git@github.com/Jalez/kehikko-protocol.git#${pin}` } })

describe('the first Kehikot a release works with', () => {
  test('is the first app whose protocol meets the need', () => {
    expect(worksWith('2.6.0', APPS)).toEqual({ kind: 'from', need: '2.6.0', from: '0.1.37', until: null })
    expect(worksWith('2.8.0', APPS)).toMatchObject({ kind: 'from', from: '0.1.39' })
    expect(worksWith('2.10.0', APPS)).toMatchObject({ kind: 'from', from: '0.1.39' })
    expect(worksWithSaid(worksWith('2.10.0', APPS))).toBe('Works with Kehikot 0.1.39 and later')
  })

  test('the order the apps come in does not matter', () => {
    expect(worksWith('2.6.0', [...APPS].reverse())).toMatchObject({ from: '0.1.37' })
  })

  test('an upper bound only when an app on a higher major exists', () => {
    const one = worksWith('1.1.0', APPS)
    expect(one).toEqual({ kind: 'from', need: '1.1.0', from: '0.1.15', until: { last: '0.1.21', next: '0.1.22', major: 2 } })
    expect(worksWithSaid(one)).toBe('Works with Kehikot 0.1.15 to 0.1.21 (0.1.22 moved to protocol 2)')
    expect(worksWithSaid(worksWith('0.30.0', APPS))).toBe('Works with Kehikot 0.1.11 (0.1.12 moved to protocol 1)')
    /* On the newest major: no bound, whatever comes later. */
    expect(worksWith('2.0.0', APPS)).toMatchObject({ from: '0.1.22', until: null })
  })

  test('a need no app has yet, and one no app ever had', () => {
    const later = worksWith('2.11.0', APPS)
    expect(later).toEqual({ kind: 'unreleased', need: '2.11.0', newest: { app: '0.1.41', protocol: '2.10.0' } })
    expect(worksWithSaid(later)).toBe('Needs a Kehikot newer than 0.1.41 (protocol 2.11 or later)')
    expect(worksWith('3.0.0', APPS).kind).toBe('unreleased')
    expect(worksWith('1.8.0', APPS).kind).toBe('none')
  })

  test('without the mapping, the protocol and never a guessed app', () => {
    expect(worksWithSaid(worksWith('2.6.0', null))).toBe('Needs protocol 2.6 or later')
    expect(worksWithSaid(worksWith('2.6.1', []))).toBe('Needs protocol 2.6.1 or later')
    expect(needsKehikotSaid('1.2.0', worksWith('2.11.0', null), { protocol: '2.10.0' })).toBe(
      '1.2.0 needs protocol 2.11 or later; this Kehikot has protocol 2.10.',
    )
  })

  test('the skip sentence names the app, and the one you have', () => {
    const apps = [...APPS, { app: '0.1.42', protocol: '2.11.0' }]
    expect(needsKehikotSaid('1.7.0', worksWith('2.11.0', apps), { app: '0.1.41' })).toBe('1.7.0 needs Kehikot 0.1.42 or later; you have 0.1.41.')
    expect(needsKehikotSaid('1.7.0', worksWith('2.11.0', apps))).toBe('1.7.0 needs Kehikot 0.1.42 or later.')
  })

  test('the same major, and not older', () => {
    expect(satisfies('2.6.0', '2.10.0')).toBe(true)
    expect(satisfies('2.6.0', '2.6.0')).toBe(true)
    expect(satisfies('2.6.0', '2.5.9')).toBe(false)
    expect(satisfies('2.6.0', '3.0.0')).toBe(false)
    expect(satisfies('2.x', '2.6.0')).toBe(false)
    expect(protocolSaid('2.6.0')).toBe('2.6')
    expect(protocolSaid('2.6.3')).toBe('2.6.3')
  })
})

describe('the mapping from the app tags', () => {
  test('ls-remote: app tags only, an annotated tag by the commit it names', () => {
    const out = [
      `${sha(1)}\trefs/tags/app-v0.1.40`,
      `${sha(2)}\trefs/tags/app-v0.1.40^{}`,
      `${sha(3)}\trefs/tags/app-v0.1.41`,
      `${sha(4)}\trefs/tags/v1.0.0`,
      `${sha(5)}\trefs/tags/app-v0.1.42-beta.1`,
      'garbage',
    ].join('\n')
    expect([...appTagsFromLsRemote(out)]).toEqual([
      ['app-v0.1.40', sha(2)],
      ['app-v0.1.41', sha(3)],
    ])
  })

  test('each tag by its pin, oldest first; an app pinned to main is left out', () => {
    expect(
      appProtocolsFrom({
        'app-v0.1.10': { commit: sha(1), protocol: null },
        'app-v0.1.39': { commit: sha(3), protocol: '2.10.0' },
        'app-v0.1.9': { commit: sha(2), protocol: '0.30.0' },
      }),
    ).toEqual([
      { app: '0.1.9', protocol: '0.30.0' },
      { app: '0.1.39', protocol: '2.10.0' },
    ])
    expect(appProtocolsFrom({})).toBeNull()
  })

  test('off by the environment, as the suite has it', () => {
    expect(appProtocolsOn({ KEHIKOT_APP_PROTOCOLS: 'off' })).toBe(false)
    expect(appProtocolsOn({})).toBe(true)
    expect(appProtocolsOn()).toBe(false)
  })
})

/** A host repository with app tags, behind a stubbed `git ls-remote` and a stubbed raw fetch. */
function remote(tags: Record<string, { n: number; pin: string }>) {
  let listed = 0
  const fetched: string[] = []
  let down = false
  const run: Runner = async (argv) => {
    listed += 1
    expect(argv.slice(0, 3)).toEqual(['git', 'ls-remote', '--tags'])
    if (down) return { ok: false, why: 'could not resolve host' }
    return { ok: true, out: Object.entries(tags).map(([tag, one]) => `${sha(one.n)}\trefs/tags/${tag}`).join('\n') }
  }
  const fetch = async (url: string) => {
    fetched.push(url)
    if (down) throw new Error('offline')
    const one = Object.values(tags).find((t) => url.includes(sha(t.n)))
    return one ? new Response(hostPkg(one.pin)) : new Response('missing', { status: 404 })
  }
  return {
    run,
    fetch,
    tags,
    get listed() {
      return listed
    },
    fetched,
    set down(value: boolean) {
      down = value
    },
  }
}

describe('the source', () => {
  test('reads the tags and each package.json, keeps the result, and asks again at most daily', async () => {
    const r = remote({ 'app-v0.1.38': { n: 1, pin: 'v2.7.0' }, 'app-v0.1.39': { n: 2, pin: 'v2.10.0' }, 'app-v0.1.10': { n: 3, pin: 'main' } })
    let clock = 1_000_000
    const cache = cacheFile()
    const source = appProtocolSource({ run: r.run, fetch: r.fetch, cache, now: () => clock })
    expect(source.apps()).toBeNull()
    await source.refresh()
    expect(source.apps()).toEqual([
      { app: '0.1.38', protocol: '2.7.0' },
      { app: '0.1.39', protocol: '2.10.0' },
    ])
    expect(r.fetched.length).toBe(3)
    expect(r.fetched.every((url) => url.startsWith('https://raw.githubusercontent.com/Jalez/kehikko/'))).toBe(true)

    /* Within the day: nothing asked. */
    clock += REFRESH_EVERY_MS - 1
    await source.refresh()
    expect(r.listed).toBe(1)

    /* A day on, a new app tag: only it is read. */
    r.tags['app-v0.1.40'] = { n: 4, pin: 'v2.10.0' }
    clock += 2
    await source.refresh()
    expect(r.listed).toBe(2)
    expect(r.fetched.length).toBe(4)
    expect(source.apps()?.at(-1)).toEqual({ app: '0.1.40', protocol: '2.10.0' })

    const kept = JSON.parse(readFileSync(cache, 'utf8'))
    expect(kept.from).toBe('Jalez/kehikko')
    expect(kept.tags['app-v0.1.10']).toEqual({ commit: sha(3), protocol: null })
  })

  test('a start reads the last good mapping from the cache, and does not ask that day', async () => {
    const r = remote({ 'app-v0.1.39': { n: 2, pin: 'v2.10.0' } })
    const cache = cacheFile()
    const now = 5_000_000
    writeFileSync(
      cache,
      JSON.stringify({ from: 'Jalez/kehikko', read: new Date(now - 1000).toISOString(), tags: { 'app-v0.1.39': { commit: sha(2), protocol: '2.10.0' } } }),
    )
    const source = appProtocolSource({ run: r.run, fetch: r.fetch, cache, now: () => now })
    expect(source.apps()).toEqual([{ app: '0.1.39', protocol: '2.10.0' }])
    await source.refresh()
    expect(r.listed).toBe(0)
  })

  test('a cache from elsewhere, or one that does not read, is as if it were not there', () => {
    const cache = cacheFile()
    writeFileSync(cache, JSON.stringify({ from: 'someone/else', read: new Date().toISOString(), tags: { 'app-v0.1.39': { commit: sha(2), protocol: '2.10.0' } } }))
    expect(appProtocolSource({ run: remote({}).run, cache }).apps()).toBeNull()
    writeFileSync(cache, '{ not json')
    expect(appProtocolSource({ run: remote({}).run, cache }).apps()).toBeNull()
  })

  test('offline: the last good mapping stays, and it is asked again after an hour, not a day', async () => {
    const r = remote({ 'app-v0.1.39': { n: 2, pin: 'v2.10.0' } })
    let clock = 1_000_000
    const lines: string[] = []
    const source = appProtocolSource({ run: r.run, fetch: r.fetch, cache: cacheFile(), now: () => clock, log: (line) => lines.push(line) })
    await source.refresh()
    clock += REFRESH_EVERY_MS + 1
    r.down = true
    await source.refresh()
    expect(source.apps()).toEqual([{ app: '0.1.39', protocol: '2.10.0' }])
    expect(source.standing().stale).toBe(true)
    expect(lines.join('\n')).toContain('could not resolve host')
    r.down = false
    clock += RETRY_AFTER_MS - 1
    await source.refresh()
    expect(r.listed).toBe(2)
    clock += 2
    await source.refresh()
    expect(r.listed).toBe(3)
    expect(source.standing().stale).toBe(false)
  })

  test('raw refused: asked through gh', async () => {
    const r = remote({ 'app-v0.1.39': { n: 2, pin: 'v2.10.0' } })
    const asked: string[] = []
    const source = appProtocolSource({
      run: r.run,
      cache: null,
      fetch: async () => new Response('', { status: 429 }),
      gh: async (path) => {
        asked.push(path)
        return { encoding: 'base64', content: Buffer.from(hostPkg('v2.10.0')).toString('base64') }
      },
    })
    await source.refresh()
    expect(asked).toEqual([`repos/Jalez/kehikko/contents/package.json?ref=${sha(2)}`])
    expect(source.apps()).toEqual([{ app: '0.1.39', protocol: '2.10.0' }])
  })

  test('off asks nobody', async () => {
    const r = remote({ 'app-v0.1.39': { n: 2, pin: 'v2.10.0' } })
    const source = appProtocolSource({ run: r.run, fetch: r.fetch, cache: cacheFile(), on: false })
    await source.refresh()
    expect(r.listed).toBe(0)
    expect(source.apps()).toBeNull()
  })
})
