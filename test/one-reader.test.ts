import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { JOURNEYS_FILE, JOURNEYS_MODULE, moduleFile, stepsOf, journeyIn } from 'kehikot-module-protocol'
import { readJourneys } from 'kehikot-module-protocol/serve'

import { answer } from '../server/answers.ts'
import { createEpic, deleteEpic, listEpics, readEpic, readSteps, readStepsSaid, retitleEpic } from '../server/holdings.ts'
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

/**
 * And now the reader prefers the Journeys module's record.
 *
 * Everything above was written before it did and none of it was edited when
 * it did: those projects keep no journeys, so the reader falls back to this
 * host's own file and every sentence holds as it held.
 *
 * Below is the project the change is FOR — the one where the two copies have
 * come apart. This host's file is a snapshot with two steps and one group;
 * the Journeys record for the same epic has three steps, two groups, a
 * different umbrella, and has dropped a field the snapshot still carries. The
 * same sentences are asked of it, and then the ones that are new: which copy
 * was read, what stays this host's, and what happens when there is no record
 * to prefer.
 */
describe('when the two copies of an epic disagree', () => {
  /* What this host wrote down once and has not touched since. */
  const snapshot = {
    slug: 'the-posting-seam',
    title: 'The posting seam, as the host titles it',
    lede: 'The lede from before.',
    umbrella: 'gh#1',
    steps: [
      { title: 'Post through one function', body: '', refs: ['gh#2'], notes: [] },
      { title: 'Retire the second path', body: '', refs: ['gh#4'], notes: [] },
    ],
    groups: [{ heading: 'The agent seam', refs: ['gh#6'] }],
    exists: ['The tracker reading'],
    open: ['Who retries?'],
    /* Deleted from the journey since; must not go on being answered. */
    missing: 'Something assumed and not built, according to the snapshot.',
  }
  /* Where the steps have been edited ever since. */
  const record = {
    slug: 'the-posting-seam',
    title: 'The posting seam, as the journey still calls it',
    lede: 'One place a comment is posted from.',
    umbrella: 'gh#100',
    steps: [
      { title: 'Post through one function', body: '', refs: ['gh#2', 'gh#3'], notes: [], part: 'the-agent-seam' },
      { title: 'Retire the second path', body: '', refs: ['gh#4'], notes: ['already half done'] },
      { title: 'Say so on the page', body: '', refs: ['gh#5'], notes: [], part: 'what-the-page-shows' },
    ],
    groups: [
      { id: 'the-agent-seam', heading: 'The agent seam', refs: ['gh#6'] },
      { heading: 'What the page shows', refs: ['gh#7'] },
    ],
    exists: ['The tracker reading', 'The posting function'],
    open: [],
    blockedBy: { 'gh#3': ['gh#2'] },
    watch: ['gh#8'],
    /* Something a newer Journeys writes and this host has never heard of. */
    reviewedBy: { who: 'grace' },
  }
  /* An epic written as a paper: its steps are the paper's sections. */
  const paper = {
    slug: 'a-paper',
    title: 'A paper',
    steps: [],
    stepsFrom: { projector: 'paper', where: 'chapters/seam.tex', why: 'The steps are its sections.' },
    groups: [{ heading: 'Method', refs: ['gh#30'] }],
    exists: ['A draft'],
    open: ['Which venue?'],
  }

  function journeys(root: string, records: Record<string, unknown>): void {
    const file = moduleFile(root, JOURNEYS_MODULE, JOURNEYS_FILE)!
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ version: 1, journeys: records }, null, 2)}\n`)
  }

  function disagreeing(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-one-reader-')))
    made.push(dir)
    mkdirSync(epicsDir(dir), { recursive: true })
    writeFileSync(join(epicsDir(dir), 'the-posting-seam.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
    writeFileSync(join(epicsDir(dir), 'plain.json'), `${JSON.stringify(plain, null, 2)}\n`)
    writeFileSync(join(epicsDir(dir), 'a-paper.json'), `${JSON.stringify({ slug: 'a-paper', title: 'A paper' }, null, 2)}\n`)
    journeys(dir, {
      'the-posting-seam': record,
      'a-paper': paper,
      /* A journey for an epic this host does not hold. */
      'nobody-points-here': { slug: 'nobody-points-here', title: 'Orphan', steps: [{ title: 'x', refs: ['gh#99'] }] },
    })
    return dir
  }

  describe('every answer is still about the same epic', () => {
    for (const slug of ['the-posting-seam', 'plain']) {
      test(slug, () => {
        const root = disagreeing()
        const epic = asked(root, 'epic.get', { epic: slug })
        const steps = asked(root, 'steps.list', { epic: slug }).steps as Array<{ refs?: string[] }>
        const row = (asked(root, 'epics.list', {}).epics as Array<Record<string, unknown>>).find((one) => one.slug === slug)!
        const scope = epicRefs(root, slug)!

        expect(steps.length).toBeGreaterThan(0)
        expect(steps).toEqual(epic.steps as typeof steps)
        expect(readSteps(root, slug)).toEqual(steps)
        expect(row.size).toBe(steps.length + ((epic.exists as unknown[]) ?? []).length + ((epic.open as unknown[]) ?? []).length)
        const parts = partsOf(epic)
        if (parts.length) expect(row.parts).toEqual(parts)
        else expect('parts' in row).toBe(false)
        expect(row.title).toBe(epic.title as string)
        for (const step of steps) for (const ref of step.refs ?? []) expect(scope).toContain(ref)
        for (const part of parts) for (const ref of part.refs) expect(scope).toContain(ref)
        expect(scope).toEqual(refsInEpic(epic))
        expect(readEpic(root, slug)).toEqual(epic)
      })
    }
  })

  test('the steps, the groups and the prose are the journey’s', () => {
    const root = disagreeing()
    const epic = asked(root, 'epic.get', { epic: 'the-posting-seam' })
    expect(asked(root, 'steps.list', { epic: 'the-posting-seam' }).steps).toEqual(record.steps)
    expect(epic.steps).toEqual(record.steps)
    expect(epic.groups).toEqual(record.groups)
    expect(epic.lede).toBe(record.lede)
    expect(epic.umbrella).toBe('gh#100')
    expect(epic.blockedBy).toEqual(record.blockedBy)
    /* What a newer writer added arrives; nothing is stripped on the way. */
    expect(epic.reviewedBy).toEqual({ who: 'grace' })
  })

  test('the slug and the title are this host’s', () => {
    const root = disagreeing()
    const epic = asked(root, 'epic.get', { epic: 'the-posting-seam' })
    expect(epic.slug).toBe('the-posting-seam')
    expect(epic.title).toBe(snapshot.title)
    expect(listEpics(root).find((one) => one.slug === 'the-posting-seam')?.title).toBe(snapshot.title)
  })

  test('and a retitle shows at once, though the journey still calls it something else', () => {
    const root = disagreeing()
    const retitled = retitleEpic(root, 'the-posting-seam', 'Where a comment is posted from')
    expect(retitled.ok && retitled.epic.title).toBe('Where a comment is posted from')
    expect(asked(root, 'epic.get', { epic: 'the-posting-seam' }).title).toBe('Where a comment is posted from')
    /* The retitle wrote this host's file and not the journey. */
    expect(journeyIn(readJourneys(root), 'the-posting-seam')?.title).toBe(record.title)
    expect(retitled.ok && retitled.epic).toEqual(listEpics(root).find((one) => one.slug === 'the-posting-seam')!)
  })

  test('it is the record whole: what the journey no longer says, the stale file does not say for it', () => {
    const root = disagreeing()
    const epic = asked(root, 'epic.get', { epic: 'the-posting-seam' })
    expect('missing' in epic).toBe(false)
    expect(epic.open).toEqual([])
    expect(epic.umbrella).not.toBe(snapshot.umbrella)
  })

  test('the row, the parts and the tracker all moved with it, and none stayed behind', () => {
    const root = disagreeing()
    const row = listEpics(root).find((one) => one.slug === 'the-posting-seam')!
    /* 3 steps + 2 exists + 0 open, where the snapshot would have said 2 + 1 + 1. */
    expect(row.size).toBe(5)
    expect(row.lede).toBe(record.lede)
    expect(row.parts).toEqual([
      { id: 'the-agent-seam', heading: 'The agent seam', refs: ['gh#6', 'gh#2', 'gh#3'], steps: 1 },
      { id: 'what-the-page-shows', heading: 'What the page shows', refs: ['gh#7', 'gh#5'], steps: 1 },
    ])
    const scope = epicRefs(root, 'the-posting-seam')!
    for (const ref of ['gh#100', 'gh#2', 'gh#3', 'gh#4', 'gh#5', 'gh#6', 'gh#7']) expect(scope).toContain(ref)
    /* The snapshot's umbrella is no longer anything this epic names. */
    expect(scope).not.toContain('gh#1')
    /* And the scope's ref set is what it has always been: `watch` and what
       blocks what are not read, for the journey's record any more than they
       were for this host's file. Widening it is somebody's decision. */
    expect(scope).not.toContain('gh#8')
    expect(scope.sort()).toEqual(['gh#100', 'gh#2', 'gh#3', 'gh#4', 'gh#5', 'gh#6', 'gh#7'])
    expect(allEpicRefs(root)).not.toContain('gh#8')
  })

  test('an epic the project keeps no journey for is answered from this host’s own file', () => {
    const root = disagreeing()
    expect(asked(root, 'epic.get', { epic: 'plain' })).toEqual(plain)
    expect(asked(root, 'steps.list', { epic: 'plain' }).steps).toEqual(plain.steps)
  })

  test('whether an epic exists is this host’s alone', () => {
    const root = disagreeing()
    /* A journey with no epic file is not an epic… */
    expect(readEpic(root, 'nobody-points-here')).toBeNull()
    expect(answer(ME, 'steps.list', { epic: 'nobody-points-here' }, registered, () => {}, root).ok).toBe(false)
    expect(listEpics(root).map((one) => one.slug).sort()).toEqual(['a-paper', 'plain', 'the-posting-seam'])
    expect(allEpicRefs(root)).not.toContain('gh#99')
    /* …and an epic deleted here is gone, whatever the journeys still hold. */
    expect(deleteEpic(root, 'the-posting-seam').ok).toBe(true)
    expect(readEpic(root, 'the-posting-seam')).toBeNull()
    expect(journeyIn(readJourneys(root), 'the-posting-seam')).not.toBeNull()
  })

  test('a journeys file that will not read falls back, for every epic, and nothing throws', () => {
    for (const broken of ['{ "version": 1, "journeys": {', '[]', '"text"', '']) {
      const root = disagreeing()
      writeFileSync(moduleFile(root, JOURNEYS_MODULE, JOURNEYS_FILE)!, broken)
      expect(asked(root, 'epic.get', { epic: 'the-posting-seam' })).toEqual(snapshot)
      expect(asked(root, 'steps.list', { epic: 'the-posting-seam' }).steps).toEqual(snapshot.steps)
      expect(listEpics(root)).toHaveLength(3)
    }
  })

  test('one record that will not read costs that epic its record and no other', () => {
    const root = disagreeing()
    /* A step nobody titled, in one journey. */
    journeys(root, { 'the-posting-seam': { ...record, steps: [{ refs: ['gh#2'] }] }, 'a-paper': paper })
    expect(asked(root, 'epic.get', { epic: 'the-posting-seam' })).toEqual(snapshot)
    expect(readStepsSaid(root, 'a-paper')?.kind).toBe('elsewhere')
  })

  test('a record filed under one slug and calling itself another is not preferred', () => {
    const root = disagreeing()
    journeys(root, { 'the-posting-seam': { ...record, slug: 'something-else' } })
    expect(asked(root, 'epic.get', { epic: 'the-posting-seam' })).toEqual(snapshot)
  })

  describe('an epic whose steps are kept elsewhere', () => {
    test('`steps.list` never answers "no steps": it has no `steps` at all, and says where they are', () => {
      const root = disagreeing()
      const said = asked(root, 'steps.list', { epic: 'a-paper' })
      expect('steps' in said).toBe(false)
      expect(said).toEqual({ stepsFrom: { projector: 'paper', where: 'chapters/seam.tex', why: 'The steps are its sections.' } })
      /* The same three-way answer the protocol gives for the record. */
      expect(readStepsSaid(root, 'a-paper')).toEqual({ kind: 'elsewhere', from: paper.stepsFrom })
      expect(stepsOf(journeyIn(readJourneys(root), 'a-paper')!).kind).toBe('elsewhere')
    })

    test('the row gives no size rather than a count with the steps left out, and says where', () => {
      const root = disagreeing()
      const row = listEpics(root).find((one) => one.slug === 'a-paper')!
      /* `exists` and `open` are one each. Two would be a number about the
         epic without its steps. */
      expect('size' in row).toBe(false)
      expect(row.stepsFrom).toEqual(paper.stepsFrom)
      expect(row.parts).toEqual([{ id: 'method', heading: 'Method', refs: ['gh#30'], steps: 0 }])
      const onWire = (asked(root, 'epics.list', {}).epics as Array<Record<string, unknown>>).find((one) => one.slug === 'a-paper')!
      expect('size' in onWire).toBe(false)
      expect(onWire.stepsFrom).toEqual(paper.stepsFrom)
    })

    test('`epic.get` hands over the record as it is kept, `stepsFrom` and all', () => {
      const root = disagreeing()
      const epic = asked(root, 'epic.get', { epic: 'a-paper' })
      expect(epic.stepsFrom).toEqual(paper.stepsFrom)
      expect(epic.steps).toEqual([])
    })

    test('an epic with none written is still an empty list, and one with steps beside a paper still has them', () => {
      const root = disagreeing()
      writeFileSync(join(epicsDir(root), 'empty.json'), `${JSON.stringify({ slug: 'empty', title: 'Empty' })}\n`)
      expect(asked(root, 'steps.list', { epic: 'empty' })).toEqual({ steps: [] })
      expect(readStepsSaid(root, 'empty')).toEqual({ kind: 'none' })
      journeys(root, { 'a-paper': { ...paper, steps: [{ title: 'A stored one', body: '', refs: [], notes: [] }] } })
      expect(asked(root, 'steps.list', { epic: 'a-paper' }).steps).toHaveLength(1)
    })

    test('and this host’s own file says so too, where there is no record to say it', () => {
      /* The fallback is read the same way: a project with no journeys and an
         epic file from the roadmap, `steps: []` beside a `stepsFrom`. */
      const root = project()
      writeFileSync(join(epicsDir(root), 'a-paper.json'), `${JSON.stringify(paper, null, 2)}\n`)
      expect(asked(root, 'steps.list', { epic: 'a-paper' })).toEqual({ stepsFrom: paper.stepsFrom })
      expect('size' in listEpics(root).find((one) => one.slug === 'a-paper')!).toBe(false)
      /* A `stepsFrom` nobody can read is not a claim that they are elsewhere. */
      writeFileSync(join(epicsDir(root), 'odd.json'), `${JSON.stringify({ slug: 'odd', steps: [], stepsFrom: 'somewhere' })}\n`)
      expect(asked(root, 'steps.list', { epic: 'odd' })).toEqual({ steps: [] })
    })
  })

  test('a journeys folder that points out of the project is not followed', () => {
    const elsewhere = disagreeing()
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-one-reader-')))
    made.push(root)
    mkdirSync(epicsDir(root), { recursive: true })
    writeFileSync(join(epicsDir(root), 'the-posting-seam.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
    symlinkSync(join(elsewhere, '.kehikot', 'journeys'), join(root, '.kehikot', 'journeys'))
    /* Another project's steps must not be answered under this one's name. */
    expect(asked(root, 'epic.get', { epic: 'the-posting-seam' })).toEqual(snapshot)
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

  test('and only the reader opens the Journeys module’s file, through the protocol', () => {
    /* `readJourneys`, `readJourney` and `journeyIn` are how that file is
       read. One file in this host calls them, and it is the one reader. A
       second would be a second answer to whose steps these are. */
    const opening = [...sources(join(HERE, 'server')), ...sources(join(HERE, 'src'))]
      .filter((path) => /\b(readJourneys?|journeyIn)\(/.test(readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
      .map((path) => relative(HERE, path))
    expect(opening).toEqual(['server/holdings.ts'])
    /* And it spells neither the folder nor the file: the protocol does. */
    const holdings = readFileSync(join(HERE, 'server/holdings.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    expect(holdings).not.toContain('journeys.json')
    expect(holdings).not.toMatch(/['"`]journeys['"`]/)
  })
})
