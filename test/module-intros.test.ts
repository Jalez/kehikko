import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { moduleIntros, releaseCommit } from '../server/moduleIntros.ts'
import { PAGE_ONLY } from '../server/guard.ts'
import type { Ran } from '../server/versions.ts'

/*
 * A module's introduction read without running it (protocol 2.57.0): the running manifest, else the
 * installed copy's intro.json, else that file at the release an install would take through the
 * person's own git and gh. And the machine-wide record of which ones the person watched or dismissed.
 */

const INTRO = { slides: [{ title: 'What it is for', body: 'One list.' }] }
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

describe('the release an install would take', () => {
  test('the newest version tag, peeled when annotated; HEAD when there are none', () => {
    const tags = [`${A}\trefs/tags/v1.2.0`, `${B}\trefs/tags/v1.10.0`, `${C}\trefs/tags/v1.10.0^{}`, `${A}\trefs/tags/notes`].join('\n')
    expect(releaseCommit(tags, null)).toBe(C)
    expect(releaseCommit('', `${A}\tHEAD\n`)).toBe(A)
    expect(releaseCommit('', null)).toBeNull()
  })
})

describe('where an introduction is read from', () => {
  const runner = (answers: Record<string, Ran>) => {
    const asked: string[][] = []
    return {
      asked,
      run: async (argv: readonly string[]) => {
        asked.push([...argv])
        const key = argv.slice(0, 3).join(' ')
        return answers[key] ?? { ok: false as const, why: 'no' }
      },
    }
  }

  test('the running manifest first', async () => {
    const { run, asked } = runner({})
    const intros = moduleIntros({ running: () => ({ intro: INTRO }), dir: () => '/nowhere', repo: () => 'someone/lists', run })
    expect(await intros.introFor('kehikot.lists')).toEqual({ intro: INTRO, from: 'running' })
    expect(asked).toEqual([])
  })

  test('then the installed copy’s intro.json, read as a file; a bad one is none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intro-'))
    writeFileSync(join(dir, 'intro.json'), JSON.stringify(INTRO))
    const { run, asked } = runner({})
    const intros = moduleIntros({ running: () => null, dir: () => dir, repo: () => 'someone/lists', run })
    expect(await intros.introFor('kehikot.lists')).toEqual({ intro: INTRO, from: 'installed' })
    writeFileSync(join(dir, 'intro.json'), '{"slides": "no"}')
    expect(await intros.introFor('kehikot.lists')).toEqual({ intro: null, from: null })
    /* An installed module is never looked up on the network. */
    expect(asked).toEqual([])
  })

  test('not installed: the file at the newest release, through git ls-remote and gh api; read once per commit', async () => {
    const { run, asked } = runner({
      'git ls-remote --tags': { ok: true, out: `${A}\trefs/tags/v1.0.0\n` },
      'gh api -H': { ok: true, out: JSON.stringify(INTRO) },
    })
    const intros = moduleIntros({ running: () => null, dir: () => null, repo: () => 'someone/lists', run })
    expect(await intros.introFor('kehikot.lists')).toEqual({ intro: INTRO, from: 'release' })
    expect(asked[0]).toEqual(['git', 'ls-remote', '--tags', 'https://github.com/someone/lists.git'])
    expect(asked[1]!.at(-1)).toBe(`repos/someone/lists/contents/intro.json?ref=${A}`)
    await intros.introFor('kehikot.lists')
    expect(asked).toHaveLength(2)
  })

  test('nothing to read, or a repository that is not one: none, and nothing is run for a bad one', async () => {
    const { run, asked } = runner({})
    expect(await moduleIntros({ running: () => null, dir: () => null, repo: () => null, run }).introFor('x')).toEqual({ intro: null, from: null })
    expect(await moduleIntros({ running: () => null, dir: () => null, repo: () => '../etc; rm', run }).introFor('x')).toEqual({ intro: null, from: null })
    expect(asked).toEqual([])
  })
})

describe('no record of which were watched', () => {
  test('the offer on a container is gone, and so is the route that remembered it', () => {
    expect(PAGE_ONLY).not.toContain('/host/module-intros')
  })
})
