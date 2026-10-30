import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { open } from '../server/canvases.ts'
import { FRESH_MS, ForgeLogins, RETRY_MS } from '../server/forgeLogins.ts'
import { Inbox } from '../server/inbox.ts'
import { addProject } from '../server/projects.ts'
import { mentionsDesk, releasesIn } from '../server/whatsNewMentions.ts'
import type { Me } from '../server/trackers/common.ts'
import { APP_ITEM, type NewsItem } from '../src/host/whatsNew.ts'
import {
  MENTIONS_BY,
  MENTIONS_MODULE,
  markedPieces,
  mentionId,
  mentionItem,
  mentions,
  mentionsIn,
  parseMentionId,
  releasesToCheck,
  withTag,
} from '../src/host/whatsNewMentions.ts'

/*
 * "You're mentioned in What's new": the handle found in release notes, told
 * once per release in the Inbox as the host's own item, and the login known
 * from what tracker reads learned or one ask, kept. No forge is reached: the
 * login's ask and the notes are stand-ins.
 */

describe('finding the handle', () => {
  test('any case, whole handle only', () => {
    expect(mentions('Thank you, @tp-coder! <3 <3', 'tp-coder')).toBe(true)
    expect(mentions('Thank you, @TP-Coder.', 'tp-coder')).toBe(true)
    expect(mentions('Thanks @tp-coder', 'TP-CODER')).toBe(true)
    expect(mentions('(@tp-coder)', 'tp-coder')).toBe(true)
    expect(mentions('Thank you, @tp-coder2!', 'tp-coder')).toBe(false)
    expect(mentions('Thank you, @tp-coder-bot!', 'tp-coder')).toBe(false)
    expect(mentions('Thank you, @tp-coder_x!', 'tp-coder')).toBe(false)
    expect(mentions('Thank you, @tp-coder.dev', 'tp-coder')).toBe(false)
    expect(mentions('mail me at me@tp-coder', 'tp-coder')).toBe(false)
    expect(mentions('Thank you, @xtp-coder!', 'tp-coder')).toBe(false)
    expect(mentions('Thank you, tp-coder!', 'tp-coder')).toBe(false)
  })

  test('several handles on one line, each found on its own', () => {
    const line = 'Thank you, @mona, @tp-coder and @Hubot! <3'
    expect(mentions(line, 'mona')).toBe(true)
    expect(mentions(line, 'tp-coder')).toBe(true)
    expect(mentions(line, 'hubot')).toBe(true)
    expect(mentions(line, 'mon')).toBe(false)
  })

  test('a login that is not one finds nothing, and is never read as a pattern', () => {
    expect(mentions('@a.*b', 'a.*')).toBe(false)
    expect(mentions('@anything', '')).toBe(false)
  })

  test('the notes as What’s new shows them: its section, as plain text, code left out', () => {
    const body = [
      '### What’s new',
      '- **Faster boards.** Thank you, @tp-coder! <3 <3',
      '- Something else, thanks to @mona',
      '',
      '```',
      'echo @tp-coder',
      '```',
      '',
      '### Other',
      '- @tp-coder again, outside the section',
      '',
      '<sub>Built from abc1234</sub>',
    ].join('\n')
    expect(mentionsIn(body, 'tp-coder')).toEqual([{ excerpt: 'Faster boards. Thank you, @tp-coder! <3 <3' }])
    expect(mentionsIn(body, 'mona')).toHaveLength(1)
    expect(mentionsIn(body, 'nobody')).toEqual([])
  })

  test('a long line is clipped around the handle', () => {
    const line = `${'word '.repeat(80)}Thank you, @tp-coder! ${'more '.repeat(80)}`
    const [found] = mentionsIn(`- ${line}`, 'tp-coder', 80)
    expect(found!.excerpt.length).toBeLessThanOrEqual(80)
    expect(found!.excerpt).toContain('@tp-coder')
    expect(found!.excerpt.startsWith('…')).toBe(true)
    expect(found!.excerpt.endsWith('…')).toBe(true)
  })

  test('the mention marked, as pieces of text', () => {
    expect(markedPieces('Thank you, @TP-coder and @tp-coder2!', 'tp-coder')).toEqual([
      { text: 'Thank you, ', mark: false },
      { text: '@TP-coder', mark: true },
      { text: ' and @tp-coder2!', mark: false },
    ])
    expect(markedPieces('plain', null)).toEqual([{ text: 'plain', mark: false }])
  })
})

describe('the item', () => {
  test('one id per release and handle, read back', () => {
    const id = mentionId({ item: 'kehikot.example', tag: 'v1.6.0' }, 'TP-Coder')
    expect(id).toBe('mention:kehikot.example@v1.6.0:tp-coder')
    expect(parseMentionId(id!)).toEqual({ item: 'kehikot.example', tag: 'v1.6.0', login: 'tp-coder' })
    expect(parseMentionId(mentionId({ item: APP_ITEM, tag: 'v0.1.90' }, 'mona')!)).toEqual({ item: APP_ITEM, tag: 'v0.1.90', login: 'mona' })
    expect(parseMentionId('agent-setup')).toBeNull()
    expect(mentionId({ item: 'x'.repeat(120), tag: 'v1.0.0' }, 'mona')).toBeNull()
  })

  test('its words name the release from data, and its detail is the line', () => {
    const item = mentionItem({ item: APP_ITEM, tag: 'v0.1.90' }, 'tp-coder', 'Kehikot', { excerpt: 'Thank you, @tp-coder!' })
    expect(item).toEqual({
      id: 'mention:kehikot@v0.1.90:tp-coder',
      state: 'done',
      label: 'You’re mentioned in What’s new: Kehikot 0.1.90',
      detail: 'Thank you, @tp-coder!',
    })
    const long = mentionItem({ item: 'm', tag: 'v1.0.0' }, 'a', 'N'.repeat(200), { excerpt: '' })
    expect(long!.label.length).toBeLessThanOrEqual(120)
  })

  test('the releases looked at are the ones the person gets', () => {
    const row = (over: Partial<NewsItem>): NewsItem => ({
      id: 'kehikot.example',
      kind: 'module',
      name: 'Example',
      repo: 'o/r',
      from: '1.0.0',
      to: '1.2.0',
      tags: ['v1.2.0', 'v1.1.0'],
      follows: 'release',
      works: {},
      ack: { module: { release: 'v1.2.0', commit: null } },
      news: true,
      preparing: false,
      ...over,
    })
    expect(
      releasesToCheck(
        [
          row({ id: APP_ITEM, kind: 'app', repo: null, tags: ['v0.1.89'] }),
          row({}),
          row({ id: 'kehikot.shown', news: false }),
          row({ id: 'kehikot.coming', preparing: true }),
          row({ id: 'kehikot.elsewhere', repo: null }),
        ],
        '0.1.90',
      ),
    ).toEqual([
      { item: APP_ITEM, tag: 'v0.1.90' },
      { item: APP_ITEM, tag: 'v0.1.89' },
      { item: 'kehikot.example', tag: 'v1.2.0' },
      { item: 'kehikot.example', tag: 'v1.1.0' },
    ])
  })

  test('the release opened at is among its row’s, newest first', () => {
    expect(withTag(['v1.3.0'], 'v1.1.0')).toEqual(['v1.3.0', 'v1.1.0'])
    expect(withTag(['v1.3.0', 'v1.1.0'], 'v1.2.0')).toEqual(['v1.3.0', 'v1.2.0', 'v1.1.0'])
    expect(withTag(['v1.3.0'], 'v1.3.0')).toEqual(['v1.3.0'])
  })

  test('a request names releases as { item, tag }, nothing else', () => {
    expect(releasesIn([{ item: 'kehikot', tag: 'v0.1.90' }])).toEqual([{ item: 'kehikot', tag: 'v0.1.90' }])
    expect(releasesIn([{ item: 'kehikot', tag: '../x' }])).toBeNull()
    expect(releasesIn('x')).toBeNull()
    expect(releasesIn(Array.from({ length: 65 }, () => ({ item: 'a', tag: 'v1.0.0' })))).toBeNull()
  })
})

describe('told once, in the Inbox', () => {
  let db: Database
  let folder: string
  let project: number
  let other: number
  let clock: number
  let inbox: Inbox
  let login: string | null
  let reads: string[]
  const notes: Record<string, string> = {
    'Jalez/kehikko-desktop@v0.1.90': '### What’s new\n- **Boards.** Thank you, @tp-coder! <3 <3\n',
    'Jalez/kehikko-desktop@v0.1.89': '### What’s new\n- Thank you, @mona!\n',
    'o/example@v1.2.0': '### What’s new\n- Thanks @TP-CODER for the report.\n',
  }

  beforeEach(() => {
    db = open(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-mentions-'))
    mkdirSync(join(folder, 'a'))
    mkdirSync(join(folder, 'b'))
    const one = addProject(db, join(folder, 'a'), 'a')
    const two = addProject(db, join(folder, 'b'), 'b')
    if (!one.ok || !two.ok) throw new Error('no project')
    project = one.project.id
    other = two.project.id
    clock = 10_000_000
    inbox = new Inbox(db, () => clock)
    login = 'tp-coder'
    reads = []
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  const desk = () =>
    mentionsDesk({
      inbox,
      login: async () => login,
      resolve: async (item) => (item === APP_ITEM ? { repo: 'Jalez/kehikko-desktop', name: 'Kehikot' } : item === 'kehikot.example' ? { repo: 'o/example', name: 'Example' } : null),
      notes: async (repo, tag) => {
        reads.push(`${repo}@${tag}`)
        return notes[`${repo}@${tag}`] ?? null
      },
    })

  const releases = [
    { item: APP_ITEM, tag: 'v0.1.90' },
    { item: APP_ITEM, tag: 'v0.1.89' },
    { item: 'kehikot.example', tag: 'v1.2.0' },
  ]

  test('a mention is an open, finished item by Kehikot, one per release', async () => {
    const out = await desk().check(project, releases)
    expect(out.told).toBe(2)
    const open = inbox.open(project)
    expect(open.map((one) => [one.module, one.name, one.id, one.state, one.label]).sort((a, b) => a[2]!.localeCompare(b[2]!))).toEqual([
      [MENTIONS_MODULE, MENTIONS_BY, 'mention:kehikot.example@v1.2.0:tp-coder', 'done', 'You’re mentioned in What’s new: Example 1.2.0'],
      [MENTIONS_MODULE, MENTIONS_BY, 'mention:kehikot@v0.1.90:tp-coder', 'done', 'You’re mentioned in What’s new: Kehikot 0.1.90'],
    ])
    expect(open.find((one) => one.id.includes('v0.1.90'))!.detail).toBe('Boards. Thank you, @tp-coder! <3 <3')
  })

  test('no repeat for the same release: not told again, not even read again, in any project', async () => {
    await desk().check(project, releases)
    reads = []
    clock += 1000
    expect((await desk().check(project, releases)).told).toBe(0)
    expect((await desk().check(other, releases)).told).toBe(0)
    /* The release without a mention is read again (its notes are cached by the release-notes desk); the told ones are not. */
    expect(reads).toEqual(['Jalez/kehikko-desktop@v0.1.89', 'Jalez/kehikko-desktop@v0.1.89'])
    expect(inbox.open(other)).toEqual([])
  })

  test('put away, it stays told: seen and dismissed items close and never come back', async () => {
    await desk().check(project, releases.slice(0, 1))
    const [first] = inbox.open(project)
    inbox.see(project, [first!])
    clock += 1000
    await desk().check(project, releases)
    const live = inbox.open(project).map((one) => one.id)
    expect(live).toEqual(['mention:kehikot.example@v1.2.0:tp-coder'])
    expect(inbox.all(project).find((one) => one.id === first!.id)!.closed).not.toBeNull()
    expect((await desk().check(project, releases)).told).toBe(0)
  })

  test('an unknown login means no items, and no notes read', async () => {
    login = null
    expect(await desk().check(project, releases)).toEqual({ told: 0, rev: null })
    expect(inbox.all(project)).toEqual([])
    expect(reads).toEqual([])
  })

  test('a release with no repository, or notes that cannot be read, is left alone', async () => {
    const out = await desk().check(project, [
      { item: 'kehikot.gone', tag: 'v1.0.0' },
      { item: APP_ITEM, tag: 'v0.0.1' },
    ])
    expect(out.told).toBe(0)
    expect(inbox.all(project)).toEqual([])
  })
})

describe('who the person is', () => {
  let db: Database
  let now: number
  let asked: string[]
  let answer: Me | null
  beforeEach(() => {
    db = open(':memory:')
    now = 1_000_000_000
    asked = []
    answer = { login: 'tp-coder' }
  })
  afterEach(() => db.close())

  const logins = () =>
    new ForgeLogins(
      db,
      async (tracker, host) => {
        asked.push(`${tracker}|${host}`)
        return answer
      },
      () => now,
    )

  test('what a tracker read learned is used, and nothing is asked', async () => {
    const kept = logins()
    kept.learned(new Map([['github|github.com', 'tp-coder'], ['gitlab|gitlab.example.com', 'mona']]))
    expect(await kept.login('github', 'github.com')).toBe('tp-coder')
    expect(kept.known('gitlab', 'gitlab.example.com')).toBe('mona')
    expect(asked).toEqual([])
  })

  test('asked once, kept machine-wide, and not asked again per notes read', async () => {
    const kept = logins()
    const [a, b] = await Promise.all([kept.login('github', 'github.com'), kept.login('github', 'github.com')])
    expect([a, b]).toEqual(['tp-coder', 'tp-coder'])
    for (let i = 0; i < 5; i++) expect(await kept.login('github', 'github.com')).toBe('tp-coder')
    /* A new host process reads what the database kept. */
    expect(await logins().login('github', 'github.com')).toBe('tp-coder')
    expect(asked).toEqual(['github|github.com'])
  })

  test('refreshed rarely: asked again only after FRESH_MS, and kept when that ask fails', async () => {
    const kept = logins()
    await kept.login('github', 'github.com')
    now += FRESH_MS - 1
    await kept.login('github', 'github.com')
    expect(asked).toHaveLength(1)
    now += 2
    answer = { why: 'gh is not logged in to github.com' }
    expect(await kept.login('github', 'github.com')).toBe('tp-coder')
    expect(asked).toHaveLength(2)
    /* A failed ask is not repeated within RETRY_MS. */
    now += RETRY_MS - 1
    await kept.login('github', 'github.com')
    expect(asked).toHaveLength(2)
  })

  test('not logged in: unknown, asked again only after RETRY_MS', async () => {
    answer = { why: 'gh is not logged in to github.com' }
    const kept = logins()
    expect(await kept.login('github', 'github.com')).toBeNull()
    expect(await kept.login('github', 'github.com')).toBeNull()
    expect(asked).toHaveLength(1)
    now += RETRY_MS
    answer = { login: 'tp-coder' }
    expect(await kept.login('github', 'github.com')).toBe('tp-coder')
    expect(asked).toHaveLength(2)
  })
})
