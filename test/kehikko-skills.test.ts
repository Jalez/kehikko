import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KEHIKKO_SKILL_LIMITS, placeDoorsSchema, skillTextIssue } from 'kehikot-module-protocol'

import { createCanvas, open, type Canvas } from '../server/canvases.ts'
import { createEpic } from '../server/holdings.ts'
import { PAGE_ONLY, refusal, type Own } from '../server/guard.ts'
import {
  listKehikkoSkills,
  readSkillText,
  removeKehikkoSkill,
  saveKehikkoSkill,
  skillsFolder,
  skillsForSession,
} from '../server/kehikkoSkills.ts'
import { call, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { placeDesk } from '../server/placeRoutes.ts'
import { addProject, projectById, type Project } from '../server/projects.ts'
import { draftIssue, previewOf, slugOf } from '../src/host/kehikkoSkills.ts'

/**
 * A kehikko's own skills (protocol 2.53.0): written by the person, kept in the project beside the
 * kehikko, handed to every agent session placed on it, read — never written — by an agent.
 */

let db: Database
let folder: string
let project: Project
let writing: Canvas
let review: Canvas

beforeEach(() => {
  db = open(':memory:')
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-skills-')))
  const added = addProject(db, folder, 'thesis')
  if (!added.ok) throw new Error(added.why)
  project = projectById(db, added.project.id)!
  createEpic(folder, { title: 'Methods', slug: 'methods' })
  createEpic(folder, { title: 'Results', slug: 'results' })
  writing = createCanvas(db, 'writing', project.id)
  review = createCanvas(db, 'review', project.id)
})
afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

const good = { name: 'review-checklist', description: 'When reviewing a change on this kehikko.', body: '# Review\n\n- Read the diff.\n- Run the tests.' }

describe('the store', () => {
  test('a skill saved is read back whole, from the project’s .kehikot/host/skills/<key>/<name>/SKILL.md', () => {
    const saved = saveKehikkoSkill(folder, writing.key, good)
    expect(saved.ok).toBe(true)
    const file = join(folder, '.kehikot', 'host', 'skills', writing.key, 'review-checklist', 'SKILL.md')
    expect(existsSync(file)).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(skillTextIssue(text, 'review-checklist')).toBeNull()
    expect(text).toContain('description: "When reviewing a change on this kehikko."')
    const [one] = listKehikkoSkills(folder, writing.key)
    expect(one).toEqual({ name: good.name, description: good.description, body: good.body, text })
    /* Another kehikko of the same project has none. */
    expect(listKehikkoSkills(folder, review.key)).toEqual([])
  })

  test('changed, renamed and removed', () => {
    saveKehikkoSkill(folder, writing.key, good)
    const changed = saveKehikkoSkill(folder, writing.key, { ...good, body: 'Only this.', was: good.name })
    expect(changed.ok && changed.said).toBe('Saved review-checklist.')
    expect(listKehikkoSkills(folder, writing.key)[0]!.body).toBe('Only this.')
    const renamed = saveKehikkoSkill(folder, writing.key, { ...good, name: 'checklist', was: good.name })
    expect(renamed.ok && renamed.said).toBe('Renamed review-checklist to checklist.')
    expect(listKehikkoSkills(folder, writing.key).map((one) => one.name)).toEqual(['checklist'])
    expect(removeKehikkoSkill(folder, writing.key, 'checklist').ok).toBe(true)
    expect(listKehikkoSkills(folder, writing.key)).toEqual([])
    expect(removeKehikkoSkill(folder, writing.key, 'checklist').ok).toBe(false)
  })

  test('refuses with a sentence: a bad name, no description, a name taken, too many, a change to nothing', () => {
    const refused = (input: Record<string, unknown>) => {
      const got = saveKehikkoSkill(folder, writing.key, input)
      return got.ok ? null : got.why
    }
    expect(refused({ ...good, name: 'Not A Name' })).toContain('lowercase')
    expect(refused({ ...good, name: '../escape' })).toContain('lowercase')
    expect(refused({ ...good, description: '' })).toContain('description')
    expect(refused({ ...good, body: 'x'.repeat(KEHIKKO_SKILL_LIMITS.BODY + 1) })).toContain('at most')
    saveKehikkoSkill(folder, writing.key, good)
    expect(refused(good)).toContain('already has a skill called review-checklist')
    expect(refused({ ...good, name: 'other', was: 'missing' })).toContain('no skill called missing')
    for (let i = 1; i < KEHIKKO_SKILL_LIMITS.MOST; i++) saveKehikkoSkill(folder, writing.key, { ...good, name: `s${i}` })
    expect(refused({ ...good, name: 'one-too-many' })).toContain(`at most ${KEHIKKO_SKILL_LIMITS.MOST}`)
    expect(saveKehikkoSkill(null, writing.key, good).ok).toBe(false)
    expect(skillsFolder(folder, '../x')).toBeNull()
  })

  test('a hand-edited file is read as written, and one that does not read is left out', () => {
    const dir = join(folder, '.kehikot', 'host', 'skills', writing.key)
    mkdirSync(join(dir, 'by-hand'), { recursive: true })
    writeFileSync(join(dir, 'by-hand', 'SKILL.md'), '---\nname: by-hand\ndescription: Bare words: fine\n---\nDo it.\n')
    mkdirSync(join(dir, 'broken'), { recursive: true })
    writeFileSync(join(dir, 'broken', 'SKILL.md'), 'no front matter')
    mkdirSync(join(dir, 'Not_A_Name'), { recursive: true })
    const all = listKehikkoSkills(folder, writing.key)
    expect(all.map((one) => one.name)).toEqual(['by-hand'])
    expect(all[0]!.description).toBe('Bare words: fine')
    expect(all[0]!.text).toContain('description: "Bare words: fine"')
    expect(readSkillText('nothing')).toBeNull()
  })
})

describe('every session on the kehikko gets them', () => {
  const desk = () =>
    placeDesk({
      db,
      hostUrl: () => 'http://127.0.0.1:4180/mcp',
      doors: async () => [],
      known: () => new Map(),
      open: () => null,
      changed: () => {},
      originOf: async () => null,
      fetch: (async () => new Response('{}')) as unknown as typeof fetch,
    })
  const issue = async (d: ReturnType<typeof desk>, module: string, token: string, kehikko: string | null) => {
    const reply = await d.route(
      new Request('http://127.0.0.1:4180/host/place', { method: 'POST', body: JSON.stringify({ module, token, project: folder, kehikko }) }),
      new URL('http://127.0.0.1:4180/host/place'),
    )
    return placeDoorsSchema.parse(await reply!.json())
  }

  test('each agent module, on any epic, is handed the kehikko’s skills; another kehikko’s sessions are not', async () => {
    saveKehikkoSkill(folder, writing.key, good)
    const d = desk()
    const a = await issue(d, 'kehikot.claude', 'a'.repeat(32), writing.key)
    const b = await issue(d, 'kehikot.codex', 'b'.repeat(32), writing.key)
    const c = await issue(d, 'kehikot.claude', 'c'.repeat(32), review.key)
    const none = await issue(d, 'kehikot.claude', 'd'.repeat(32), null)
    expect(a.kehikkoSkills?.map((one) => one.name)).toEqual(['review-checklist'])
    expect(b.kehikkoSkills).toEqual(a.kehikkoSkills)
    expect(a.kehikkoSkills![0]!.text).toBe(skillsForSession(folder, writing.key)[0]!.text)
    expect(c.kehikkoSkills).toEqual([])
    expect(none.kehikkoSkills).toBeUndefined()
  })

  test('an edit reaches the next ask, the same token', async () => {
    const d = desk()
    expect((await issue(d, 'kehikot.claude', 'a'.repeat(32), writing.key)).kehikkoSkills).toEqual([])
    saveKehikkoSkill(folder, writing.key, good)
    expect((await issue(d, 'kehikot.claude', 'a'.repeat(32), writing.key)).kehikkoSkills?.length).toBe(1)
  })
})

describe('an agent reads them and never writes them', () => {
  const door = (): Door => {
    const openness = new Openness()
    openness.reported('page', writing.id)
    return {
      db,
      which: () => openness.open(),
      watched: () => openness.every(),
      wake: () => {},
      epicsChanged: () => {},
      dispositionsChanged: () => {},
      seen: async () => [],
    } as Door
  }

  test('kehikko_skills lists them, and gives one whole by name', async () => {
    saveKehikkoSkill(folder, writing.key, good)
    const list = await call('kehikko_skills', {}, door())
    expect(list.failed).toBe(false)
    expect(list.text).toContain('- review-checklist — "When reviewing a change on this kehikko."')
    expect(list.text).toContain('Only the person adds, changes or removes them')
    const one = await call('kehikko_skills', { name: 'review-checklist' }, door())
    expect(one.text).toContain('- Run the tests.')
    expect((await call('kehikko_skills', { name: 'missing' }, door())).failed).toBe(true)
    expect((await call('kehikko_skills', { name: '../x' }, door())).failed).toBe(true)
  })

  test('the write is the page’s alone', () => {
    expect(PAGE_ONLY).toContain('/host/kehikko-skills')
    const self: Own = { origins: ['http://127.0.0.1:4181'], hosts: new Set(['127.0.0.1:4180']) }
    const asked = (headers: Record<string, string>) =>
      refusal({ method: 'POST', pathname: '/host/kehikko-skills', headers: new Headers({ host: '127.0.0.1:4180', 'content-type': 'application/json', 'content-length': '2', ...headers }) }, self)
    expect(asked({})?.status).toBe(403)
    expect(asked({ origin: 'http://127.0.0.1:4181' })).toBeNull()
  })
})

describe('the page’s helpers', () => {
  test('a typed name becomes a skill name; a draft is refused as the server would; the preview is the SKILL.md', () => {
    expect(slugOf('Review Checklist!')).toBe('review-checklist')
    expect(slugOf('  2nd pass ')).toBe('nd-pass')
    expect(draftIssue(good)).toBeNull()
    expect(draftIssue({ ...good, name: '' })).toContain('name')
    expect(previewOf(good)).toBe(skillsText())
  })
})

function skillsText(): string {
  saveKehikkoSkill(folder, writing.key, good)
  return listKehikkoSkills(folder, writing.key)[0]!.text
}

