import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { LIMITS, skillPath, type ModuleSkill } from 'kehikot-module-protocol'

import { PAGE_ONLY, refusal, type Own } from '../server/guard.ts'
import {
  claudeSkillsDir,
  fetchSkillText,
  MARKER,
  readLocal,
  sha256,
  skillRows,
  skillsRoute,
  statusOf,
  syncSkill,
  type SkillsOf,
} from '../server/skills.ts'
import { lineDiff, pressFor, removable, skillsSaying, whyNot } from '../src/host/skills.ts'

/** A module's Claude Code skills (protocol 2.5.0): read, installed, updated and removed in a scratch CLAUDE_CONFIG. */

const ORIGIN = 'http://127.0.0.1:7999'
const MODULE = 'kehikot.claude'
const text = (name: string, body = 'Do the thing.') => `---\nname: ${name}\ndescription: A skill.\n---\n\n${body}\n`
const skill = (name: string, version = '1'): ModuleSkill => ({ name, summary: `About ${name}.`, version })

/** A module serving texts from a table; a missing name is a 404. Records what was asked. */
function serving(table: Record<string, string>) {
  const asked: string[] = []
  const fetcher = (async (url: string) => {
    asked.push(url)
    const path = new URL(url).pathname
    const name = Object.keys(table).find((one) => skillPath(one) === path)
    return name === undefined ? new Response('no', { status: 404 }) : new Response(table[name], { status: 200 })
  }) as unknown as typeof fetch
  return { fetcher, asked, table }
}

/** A fresh skills directory under the suite's scratch CLAUDE_CONFIG. */
function freshRoot(): string {
  const root = join(claudeSkillsDir(), `t-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  return root
}

describe('where skills go', () => {
  test('beside the scratch CLAUDE_CONFIG, never under the real home', () => {
    const at = claudeSkillsDir()
    expect(at).toBe(join(process.env.CLAUDE_CONFIG!.replace(/\/[^/]+$/, ''), '.claude', 'skills'))
    expect(realpathSync(tmpdir()) && at.startsWith(realpathSync(homedir()) + '/.claude')).toBe(false)
  })
  test('without CLAUDE_CONFIG: CLAUDE_CONFIG_DIR, then ~/.claude/skills', () => {
    expect(claudeSkillsDir({ CLAUDE_CONFIG_DIR: '/x/cfg', HOME: '/h' })).toBe('/x/cfg/skills')
    expect(claudeSkillsDir({ HOME: '/h' })).toBe('/h/.claude/skills')
  })
})

describe('install, update and remove', () => {
  test('install writes SKILL.md and a marker with module, version and sha256', () => {
    const root = freshRoot()
    const done = syncSkill(root, MODULE, skill('cite', '1.0'), 'install', text('cite'))
    expect(done.ok).toBe(true)
    expect(readFileSync(join(root, 'cite', 'SKILL.md'), 'utf8')).toBe(text('cite'))
    const marker = JSON.parse(readFileSync(join(root, 'cite', MARKER), 'utf8'))
    expect(marker).toMatchObject({ module: MODULE, name: 'cite', version: '1.0', sha256: sha256(text('cite')) })
    /* Nothing half-written is left beside it. */
    expect(require('node:fs').readdirSync(root)).toEqual(['cite'])
    expect(statusOf(readLocal(root, 'cite', MODULE), text('cite'))).toBe('installed')
  })

  test('a changed module text is outdated; update replaces it; remove deletes the folder', () => {
    const root = freshRoot()
    syncSkill(root, MODULE, skill('cite', '1'), 'install', text('cite'))
    const next = text('cite', 'Do it better.')
    expect(statusOf(readLocal(root, 'cite', MODULE), next)).toBe('outdated')
    expect(syncSkill(root, MODULE, skill('cite', '2'), 'install', next)).toMatchObject({ ok: false })
    expect(syncSkill(root, MODULE, skill('cite', '2'), 'update', next).ok).toBe(true)
    expect(readFileSync(join(root, 'cite', 'SKILL.md'), 'utf8')).toBe(next)
    expect(statusOf(readLocal(root, 'cite', MODULE), next)).toBe('installed')
    expect(syncSkill(root, MODULE, skill('cite'), 'remove').ok).toBe(true)
    expect(existsSync(join(root, 'cite'))).toBe(false)
    expect(statusOf(readLocal(root, 'cite', MODULE), next)).toBe('absent')
  })

  test('an edited file is changed by you, and is neither updated nor removed', () => {
    const root = freshRoot()
    syncSkill(root, MODULE, skill('cite'), 'install', text('cite'))
    writeFileSync(join(root, 'cite', 'SKILL.md'), text('cite', 'My own words.'))
    expect(statusOf(readLocal(root, 'cite', MODULE), text('cite'))).toBe('edited')
    const update = syncSkill(root, MODULE, skill('cite', '2'), 'update', text('cite', 'New.'))
    expect(update).toMatchObject({ ok: false, status: 409 })
    expect(update.ok ? '' : update.why).toMatch(/changed since Kehikot installed it/)
    expect(syncSkill(root, MODULE, skill('cite'), 'remove')).toMatchObject({ ok: false })
    expect(readFileSync(join(root, 'cite', 'SKILL.md'), 'utf8')).toBe(text('cite', 'My own words.'))
  })

  test('a file added beside it is an edit too', () => {
    const root = freshRoot()
    syncSkill(root, MODULE, skill('cite'), 'install', text('cite'))
    writeFileSync(join(root, 'cite', 'notes.md'), 'mine')
    expect(readLocal(root, 'cite', MODULE).kind).toBe('edited')
    expect(syncSkill(root, MODULE, skill('cite'), 'remove')).toMatchObject({ ok: false })
    expect(existsSync(join(root, 'cite', 'notes.md'))).toBe(true)
  })

  test('a name held by a skill Kehikot did not install, or by another module, is refused', () => {
    const root = freshRoot()
    mkdirSync(join(root, 'cite'))
    writeFileSync(join(root, 'cite', 'SKILL.md'), text('cite', 'Somebody else’s.'))
    expect(statusOf(readLocal(root, 'cite', MODULE), text('cite'))).toBe('taken')
    const install = syncSkill(root, MODULE, skill('cite'), 'install', text('cite'))
    expect(install.ok ? '' : install.why).toMatch(/Kehikot did not install/)
    expect(syncSkill(root, MODULE, skill('cite'), 'remove')).toMatchObject({ ok: false })
    expect(readFileSync(join(root, 'cite', 'SKILL.md'), 'utf8')).toBe(text('cite', 'Somebody else’s.'))

    syncSkill(root, 'kehikot.paper', skill('build'), 'install', text('build'))
    expect(readLocal(root, 'build', MODULE)).toMatchObject({ kind: 'taken', who: 'a skill kehikot.paper installed' })
    expect(syncSkill(root, MODULE, skill('build'), 'install', text('build'))).toMatchObject({ ok: false })
    expect(syncSkill(root, MODULE, skill('build'), 'remove')).toMatchObject({ ok: false })
  })
})

describe('the module’s text', () => {
  test('is fetched from the origin plus skillPath, and read against the protocol', async () => {
    const big = text('big', 'x'.repeat(LIMITS.SKILL_TEXT))
    const { fetcher, asked } = serving({ cite: text('cite'), bare: '# no front matter', big, other: text('someone') })
    expect(await fetchSkillText(ORIGIN, 'cite', fetcher)).toMatchObject({ ok: true, sha256: sha256(text('cite')) })
    expect(asked).toEqual([`${ORIGIN}/kehikot/skills/cite.md`])
    expect(await fetchSkillText(ORIGIN, 'bare', fetcher)).toMatchObject({ ok: false, why: expect.stringMatching(/front matter/) })
    expect(await fetchSkillText(ORIGIN, 'big', fetcher)).toMatchObject({ ok: false, why: expect.stringMatching(/64 KB/) })
    expect(await fetchSkillText(ORIGIN, 'other', fetcher)).toMatchObject({ ok: false, why: expect.stringMatching(/names it/) })
    expect(await fetchSkillText(ORIGIN, 'gone', fetcher)).toMatchObject({ ok: false, why: expect.stringMatching(/404/) })
    expect(await fetchSkillText(ORIGIN, '../etc', fetcher)).toMatchObject({ ok: false })
  })
})

describe('the rows the dialog draws', () => {
  test('each status, with its words, its press and why not', async () => {
    const root = freshRoot()
    const found: Extract<SkillsOf, { ok: true }> = {
      ok: true,
      module: MODULE,
      name: 'Claude',
      origin: ORIGIN,
      skills: ['fresh', 'same', 'older', 'mine', 'theirs', 'broken'].map((name) => skill(name)),
    }
    syncSkill(root, MODULE, skill('same'), 'install', text('same'))
    syncSkill(root, MODULE, skill('older'), 'install', text('older', 'Old.'))
    syncSkill(root, MODULE, skill('mine'), 'install', text('mine'))
    writeFileSync(join(root, 'mine', 'SKILL.md'), text('mine', 'Edited.'))
    mkdirSync(join(root, 'theirs'))
    writeFileSync(join(root, 'theirs', 'SKILL.md'), text('theirs'))
    const { fetcher } = serving({ fresh: text('fresh'), same: text('same'), older: text('older'), mine: text('mine'), theirs: text('theirs'), broken: 'nope' })

    const rows = await skillRows(found, root, fetcher)
    const by = Object.fromEntries(rows.map((row) => [row.name, row]))
    expect(rows.map((row) => [row.name, row.status, row.says])).toEqual([
      ['fresh', 'absent', 'Not installed'],
      ['same', 'installed', 'Installed'],
      ['older', 'outdated', 'Outdated'],
      ['mine', 'edited', 'Changed by you'],
      ['theirs', 'taken', 'Name taken'],
      ['broken', 'absent', 'Not installed'],
    ])
    expect(rows.map(pressFor)).toEqual(['install', null, 'update', null, null, null])
    expect(rows.map(removable)).toEqual([false, true, true, false, false, false])
    /* The text to read, and for an update what is installed, for the diff. */
    expect(by.fresh!.text).toBe(text('fresh'))
    expect(by.older!.installedText).toBe(text('older', 'Old.'))
    expect(by.same!.installedText).toBeNull()
    expect(whyNot(by.mine!)).toMatch(/Kehikot leaves your changes alone/)
    expect(whyNot(by.theirs!)).toMatch(/will not write over it/)
    expect(whyNot(by.broken!)).toMatch(/front matter/)
    expect(by.broken!.text).toBeNull()
  })

  test('the diff and the Frame row', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
    ])
    expect(skillsSaying([], 'Claude')).toBeNull()
    expect(skillsSaying(undefined, 'Claude')).toBeNull()
    expect(skillsSaying([{ name: 'a' }], 'Claude')!.state).toBe('1 skill offered')
  })
})

describe('the routes', () => {
  const offered = [skill('cite', '1')]
  const lookup = async (id: string): Promise<SkillsOf> =>
    id === MODULE ? { ok: true, module: MODULE, name: 'Claude', origin: ORIGIN, skills: offered } : { ok: false, status: 404, why: 'Nothing is registered.' }
  const post = (body: unknown) =>
    new Request('http://127.0.0.1:4180/host/skills', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const at = new URL('http://127.0.0.1:4180/host/skills')

  test('read, then install what was read; the text comes from the module, not the request', async () => {
    const root = freshRoot()
    const module = serving({ cite: text('cite') })
    const route = skillsRoute({ lookup, fetcher: module.fetcher, root: () => root })
    const got = await route(new Request(`${at}?module=${MODULE}`), new URL(`${at}?module=${MODULE}`))
    const body = (await got!.json()) as { skills: { status: string; sha256: string }[]; writesTo: string }
    expect(body.writesTo).toBe(root)
    expect(body.skills[0]!.status).toBe('absent')

    /* A text in the body is ignored; a hash that is not of the module's text now is refused. */
    const wrong = await route(post({ module: MODULE, name: 'cite', press: 'install', sha256: 'f'.repeat(64), text: 'evil' }), at)
    expect(wrong!.status).toBe(409)
    expect(existsSync(join(root, 'cite'))).toBe(false)

    const ok = await route(post({ module: MODULE, name: 'cite', press: 'install', sha256: body.skills[0]!.sha256 }), at)
    expect(((await ok!.json()) as { ok: boolean }).ok).toBe(true)
    expect(readFileSync(join(root, 'cite', 'SKILL.md'), 'utf8')).toBe(text('cite'))

    /* The module changes its text: shown again before it is accepted. */
    module.table.cite = text('cite', 'Changed.')
    const stale = await route(post({ module: MODULE, name: 'cite', press: 'update', sha256: body.skills[0]!.sha256 }), at)
    expect(stale!.status).toBe(409)
    const fresh = await route(post({ module: MODULE, name: 'cite', press: 'update', sha256: sha256(text('cite', 'Changed.')) }), at)
    expect(fresh!.status).toBe(200)
    expect((await route(post({ module: MODULE, name: 'cite', press: 'remove' }), at))!.status).toBe(200)
    expect(existsSync(join(root, 'cite'))).toBe(false)
  })

  test('refuses a skill the module does not offer, an unknown module, a bad press and an oversized text', async () => {
    const root = freshRoot()
    const big = text('cite', 'x'.repeat(LIMITS.SKILL_TEXT))
    const route = skillsRoute({ lookup, fetcher: serving({ cite: big }).fetcher, root: () => root })
    expect((await route(post({ module: MODULE, name: 'other', press: 'install', sha256: 'x' }), at))!.status).toBe(404)
    expect((await route(post({ module: 'kehikot.nobody', name: 'cite', press: 'install' }), at))!.status).toBe(404)
    expect((await route(post({ module: MODULE, name: '../x', press: 'install' }), at))!.status).toBe(400)
    expect((await route(post({ module: MODULE, name: 'cite', press: 'wipe' }), at))!.status).toBe(400)
    expect((await route(post({ module: MODULE, name: 'cite', press: 'install', sha256: sha256(big) }), at))!.status).toBe(502)
    expect(existsSync(join(root, 'cite'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  test('the POST is the page’s alone', () => {
    expect(PAGE_ONLY).toContain('/host/skills')
    const self: Own = { origins: ['http://127.0.0.1:4181'], hosts: new Set(['127.0.0.1:4180']) }
    const ask = (headers: Record<string, string>) =>
      refusal({ method: 'POST', pathname: '/host/skills', headers: new Headers({ host: '127.0.0.1:4180', 'content-type': 'application/json', 'content-length': '2', ...headers }) }, self)
    expect(ask({ origin: 'http://127.0.0.1:4181' })).toBeNull()
    /* A program, a module's own page, a sandboxed frame: refused. */
    expect(ask({})!.status).toBe(403)
    expect(ask({ origin: 'http://127.0.0.1:7999' })!.status).toBe(403)
    expect(ask({ origin: 'null' })!.status).toBe(403)
  })
})
