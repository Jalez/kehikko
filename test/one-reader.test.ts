import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { answer } from '../server/answers.ts'
import { createEpic, listEpics, readEpic, readSteps, retitleEpic } from '../server/holdings.ts'
import { epicsDir } from '../server/hostData.ts'
import { allEpicRefs, epicRefs, refsInEpic } from '../server/trackers/reading.ts'
import { partsOf } from '../src/host/parts.ts'

/**
 * One reader.
 *
 * Everything this host says about an epic's steps, its groups and the
 * references it names comes out of `readEpic` in `server/holdings.ts`. This
 * file holds it to that, from two sides.
 *
 * The first half compares the ANSWERS to each other rather than to the file:
 * the steps `steps.list` hands over are the steps in `epic.get`; the parts
 * and the size on a row of `epics.list` are the ones those steps and groups
 * give; the references a tracker reads for the epic include every one a step
 * names. None of those sentences mentions where an epic is read FROM, on
 * purpose. The reader is about to prefer the Journeys module's record over
 * this host's own file, and when it does every assertion here should go on
 * holding without being edited — and any one of them failing means some
 * answer went on reading the old place by itself.
 *
 * The second half is about the source: which files in this host so much as
 * name the epics directory. A new one is not forbidden. It is asked to say
 * what it is doing there.
 */

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const ME = 'kehikot.someone'
const registered = (id: string) => id === ME

const divided = {
  slug: 'the-posting-seam',
  title: 'The posting seam',
  lede: 'One place a comment is posted from.',
  umbrella: 'gh#1',
  steps: [
    { title: 'Post through one function', body: '', refs: ['gh#2', 'gh#3'], notes: [], part: 'the-agent-seam' },
    { title: 'Retire the second path', body: '', refs: ['gh#4'], notes: ['already half done'] },
    { title: 'Say so on the page', body: '', refs: ['gh#5', 'gh#2'], notes: [], part: 'what-the-page-shows' },
  ],
  groups: [
    { id: 'the-agent-seam', heading: 'The agent seam', refs: ['gh#6'] },
    { heading: 'What the page shows', refs: ['gh#7'] },
  ],
  exists: ['The tracker reading'],
  open: ['Who retries?', 'What about drafts?'],
  watch: ['gh#8'],
}

const plain = { slug: 'plain', title: 'Plain', steps: [{ title: 'Only step', refs: ['gh#20'] }] }

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-one-reader-')))
  made.push(dir)
  mkdirSync(epicsDir(dir), { recursive: true })
  writeFileSync(join(epicsDir(dir), 'the-posting-seam.json'), `${JSON.stringify(divided, null, 2)}\n`)
  writeFileSync(join(epicsDir(dir), 'plain.json'), `${JSON.stringify(plain, null, 2)}\n`)
  return dir
}

function asked(root: string, method: string, params: unknown): Record<string, unknown> {
  const given = answer(ME, method, params, registered, () => {}, root)
  if (!given.ok) throw new Error(`${method} was refused: ${given.error}`)
  return given.data as Record<string, unknown>
}

describe('every answer about an epic is about the same epic', () => {
  for (const slug of ['the-posting-seam', 'plain']) {
    describe(slug, () => {
      const root = project()
      const epic = asked(root, 'epic.get', { epic: slug })
      const steps = asked(root, 'steps.list', { epic: slug }).steps as Array<{ refs?: string[] }>
      const row = (asked(root, 'epics.list', {}).epics as Array<Record<string, unknown>>).find((one) => one.slug === slug)!
      const scope = epicRefs(root, slug)!

      test('`steps.list` hands over the steps `epic.get` has', () => {
        expect(steps.length).toBeGreaterThan(0)
        expect(steps).toEqual(epic.steps as typeof steps)
        expect(readSteps(root, slug)).toEqual(steps)
      })

      test('the row in `epics.list` counts those steps and is divided by those groups', () => {
        const size = steps.length + ((epic.exists as unknown[]) ?? []).length + ((epic.open as unknown[]) ?? []).length
        expect(row.size).toBe(size)
        const parts = partsOf(epic)
        if (parts.length) expect(row.parts).toEqual(parts)
        else expect('parts' in row).toBe(false)
        expect(row.title).toBe(epic.title as string)
      })

      test('the tracker reads every reference a step or a group names', () => {
        for (const step of steps) for (const ref of step.refs ?? []) expect(scope).toContain(ref)
        for (const part of partsOf(epic)) for (const ref of part.refs) expect(scope).toContain(ref)
        expect(scope).toEqual(refsInEpic(epic))
      })

      test('and the direct reading is the one the wire answers with', () => {
        expect(readEpic(root, slug)).toEqual(epic)
      })
    })
  }

  test('a project’s tracker scope is its epics’ scopes, and nothing read some other way', () => {
    const root = project()
    const each = listEpics(root).flatMap((epic) => epicRefs(root, epic.slug) ?? [])
    expect(allEpicRefs(root).sort()).toEqual([...new Set(each)].sort())
    expect(allEpicRefs(root)).toContain('gh#20')
    /* As it has always been: a ref is read out of a `refs` array, a `ref` or
       an `umbrella`, and `watch` is none of those. Pinned so that a change to
       it is somebody's decision and not a side effect of moving the reader. */
    expect(allEpicRefs(root)).not.toContain('gh#8')
  })

  test('an assigned step’s refs reach the part, the step, and the tracker alike', () => {
    const root = project()
    const row = listEpics(root).find((epic) => epic.slug === 'the-posting-seam')!
    expect(row.parts).toEqual([
      { id: 'the-agent-seam', heading: 'The agent seam', refs: ['gh#6', 'gh#2', 'gh#3'], steps: 1 },
      { id: 'what-the-page-shows', heading: 'What the page shows', refs: ['gh#7', 'gh#5', 'gh#2'], steps: 1 },
    ])
    expect(row.size).toBe(6)
  })

  test('what a retitle and a create answer with is a row of that same list', () => {
    const root = project()
    const retitled = retitleEpic(root, 'the-posting-seam', 'Where a comment is posted from')
    expect(retitled.ok).toBe(true)
    const again = retitleEpic(root, 'the-posting-seam', 'Where a comment is posted from')
    const created = createEpic(root, { title: 'A new one' }, '2026-10-07')
    const rows = listEpics(root)
    expect(retitled.ok && retitled.epic).toEqual(rows.find((one) => one.slug === 'the-posting-seam')!)
    expect(again.ok && again.epic).toEqual(rows.find((one) => one.slug === 'the-posting-seam')!)
    expect(created.ok && created.epic).toEqual(rows.find((one) => one.slug === 'a-new-one')!)
  })

  test('an epic this host does not hold is refused by every one of them', () => {
    const root = project()
    for (const method of ['epic.get', 'steps.list']) {
      expect(answer(ME, method, { epic: 'no-such-epic' }, registered, () => {}, root).ok).toBe(false)
    }
    expect(readEpic(root, 'no-such-epic')).toBeNull()
    expect(readSteps(root, 'no-such-epic')).toBeNull()
    expect(epicRefs(root, 'no-such-epic')).toBeNull()
  })
})

describe('only one file opens an epic', () => {
  const HERE = join(import.meta.dir, '..')

  /* Every file under `server/` and `src/` that asks where the epics directory is, and
     what it does with it. `holdings.ts` is the only one that reads an epic's
     CONTENTS. A file missing from this list that starts naming the directory
     fails the test below, and the fix is one of two things: go through
     `readEpic`, or add the file here with what it does instead. */
  const NAMES_THE_DIRECTORY: Record<string, string> = {
    'server/hostData.ts': 'spells the path, and moves a legacy directory into place',
    'server/holdings.ts': 'the one reader; and creates, retitles and deletes the file',
    'server/projects.ts': 'asks whether the directory exists',
    'server/folders.ts': 'asks whether the directory exists',
    'server/content.ts': 'watches the directory for changes; reads no epic',
    'server/server.ts': 'names one file to the content watch after writing it; reads no epic',
  }

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sources(path)
      return /\.tsx?$/.test(entry.name) ? [path] : []
    })
  }

  test('and every other file that asks where the epics directory is says what for', () => {
    const naming = [...sources(join(HERE, 'server')), ...sources(join(HERE, 'src'))]
      .filter((path) => /\bepicsDir\(/.test(readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
      .map((path) => relative(HERE, path))
      .sort()
    expect(naming).toEqual(Object.keys(NAMES_THE_DIRECTORY).sort())
  })

  test('and nothing but the reader takes an epic apart on the server', () => {
    /* `readEpic` is imported by the two files that answer from it. A third
       importer is fine; a file that parses an epic's JSON without it is not,
       and the check above is what finds that one. */
    const importing = sources(join(HERE, 'server'))
      .filter((path) => /import \{[^}]*\b(readEpic|readSteps|listEpics)\b[^}]*\} from '\.\.?\/holdings\.ts'/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(HERE, path))
      .sort()
    expect(importing).toEqual(['server/answers.ts', 'server/server.ts', 'server/trackers/reading.ts'])
  })
})
