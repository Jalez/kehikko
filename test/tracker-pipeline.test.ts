import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackerRowSchema, type PipelineState } from 'kehikot-module-protocol'

import { checksUrl, pullRow, pipelineOf as githubPipeline } from '../server/trackers/github.ts'
import { mergeRow, pipelineAtOf, pipelineOf as gitlabPipeline, pipelineUrlOf, refsQuery } from '../server/trackers/gitlab.ts'
import { loadReading, readingFile } from '../server/trackers/reading.ts'
import type { Source } from '../server/trackers/sources.ts'

/**
 * A change's pipeline (Jalez/kehikko-references#38): its state from the read the host already
 * makes, and since protocol 2.34.0 where a person sees it (`pipelineUrl`) and when it last moved
 * (`pipelineAt`). Fixtures only; nothing here reaches GitHub or GitLab.
 */

const NOW = '2026-10-30T12:00:00.000Z'
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }
const gl: Source = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, listed: true }

describe('GitHub: the check rollup as one word', () => {
  test('GraphQL’s rollup state, each word', () => {
    const cases: Array<[string, PipelineState | undefined]> = [
      ['SUCCESS', 'success'],
      ['FAILURE', 'failed'],
      ['ERROR', 'failed'],
      ['PENDING', 'running'],
      ['EXPECTED', 'running'],
      ['', undefined],
    ]
    for (const [state, word] of cases) expect(githubPipeline({ state })).toBe(word)
  })

  test('a list of checks: any failure fails it, then canceled, then running, else passed', () => {
    const checks = (...words: string[]) => words.map((conclusion) => ({ conclusion }))
    expect(githubPipeline(checks('SUCCESS', 'FAILURE', 'IN_PROGRESS'))).toBe('failed')
    expect(githubPipeline(checks('SUCCESS', 'TIMED_OUT'))).toBe('failed')
    expect(githubPipeline(checks('SUCCESS', 'CANCELLED', 'IN_PROGRESS'))).toBe('canceled')
    expect(githubPipeline([{ conclusion: '', status: 'IN_PROGRESS' }, { conclusion: 'SUCCESS' }])).toBe('running')
    expect(githubPipeline(checks('SUCCESS', 'NEUTRAL', 'SKIPPED'))).toBe('success')
  })

  const pull = (rollup: unknown, url = 'https://github.com/Jalez/kehikko/pull/3') => ({
    number: 3,
    state: 'OPEN',
    title: 'Fix',
    url,
    labels: { nodes: [] },
    assignees: { nodes: [] },
    commits: { nodes: [{ commit: { committedDate: '2026-10-30T11:00:00Z', statusCheckRollup: rollup } }] },
  })

  test('the row carries the word and the pull request’s checks page, and no time', () => {
    const made = pullRow(gh, pull({ state: 'FAILURE' }), NOW)!
    expect(made.pipeline).toBe('failed')
    expect(made.pipelineUrl).toBe('https://github.com/Jalez/kehikko/pull/3/checks')
    expect(made.pipelineAt).toBeUndefined()
    expect(trackerRowSchema.parse(made).pipelineUrl).toBe('https://github.com/Jalez/kehikko/pull/3/checks')
  })

  test('no rollup, no pipeline and no link; a URL that is not a pull request’s, no link', () => {
    const none = pullRow(gh, pull(null), NOW)!
    expect(none.pipeline).toBeUndefined()
    expect(none.pipelineUrl).toBeUndefined()
    expect(checksUrl('u3', 'success')).toBeUndefined()
    expect(checksUrl('http://github.com/a/b/pull/3', 'success')).toBeUndefined()
    expect(checksUrl('https://ghe.example.org/a/b/pull/3', 'running')).toBe('https://ghe.example.org/a/b/pull/3/checks')
    expect(checksUrl('https://github.com/a/b/pull/3', undefined)).toBeUndefined()
  })
})

describe('GitLab: head_pipeline as one word', () => {
  test('each status, in either case', () => {
    const cases: Array<[string, PipelineState | undefined]> = [
      ['success', 'success'],
      ['FAILED', 'failed'],
      ['running', 'running'],
      ['canceled', 'canceled'],
      ['CANCELED', 'canceled'],
      ['skipped', 'skipped'],
      ['manual', 'manual'],
      ['created', 'pending'],
      ['WAITING_FOR_RESOURCE', 'pending'],
      ['preparing', 'pending'],
      ['pending', 'pending'],
      ['scheduled', 'pending'],
      ['', undefined],
    ]
    for (const [status, word] of cases) expect(gitlabPipeline(status)).toBe(word)
  })

  const merge = (head: unknown) => ({
    iid: '8',
    state: 'opened',
    title: 'More',
    webUrl: 'https://gitlab.example.org/group/project/-/merge_requests/8',
    description: '',
    headPipeline: head,
  })

  test('GraphQL: the word, the Pipelines tab, and when it finished', () => {
    const made = mergeRow(gl, merge({ status: 'FAILED', finishedAt: '2026-10-30T11:48:00Z', createdAt: '2026-10-30T11:30:00Z' }), NOW)!
    expect(made.pipeline).toBe('failed')
    expect(made.pipelineUrl).toBe('https://gitlab.example.org/group/project/-/merge_requests/8/pipelines')
    expect(made.pipelineAt).toBe('2026-10-30T11:48:00.000Z')
  })

  test('still running: no finish, so when it was made', () => {
    const made = mergeRow(gl, merge({ status: 'RUNNING', finishedAt: null, createdAt: '2026-10-30T11:30:00Z' }), NOW)!
    expect(made.pipeline).toBe('running')
    expect(made.pipelineAt).toBe('2026-10-30T11:30:00.000Z')
  })

  test('REST: the pipeline’s own page and times', () => {
    const head = { status: 'success', web_url: 'https://gitlab.example.org/group/project/-/pipelines/99', started_at: '2026-10-30T11:31:00Z', finished_at: null, created_at: '2026-10-30T11:30:00Z' }
    expect(pipelineUrlOf(head, 'https://gitlab.example.org/group/project/-/merge_requests/8', 'success')).toBe(
      'https://gitlab.example.org/group/project/-/pipelines/99',
    )
    expect(pipelineAtOf(head, 'success')).toBe('2026-10-30T11:31:00.000Z')
  })

  test('no pipeline: neither link nor time', () => {
    const made = mergeRow(gl, merge(null), NOW)!
    expect(made.pipeline).toBeUndefined()
    expect(made.pipelineUrl).toBeUndefined()
    expect(made.pipelineAt).toBeUndefined()
    expect(pipelineUrlOf({ status: 'success' }, 'w8', 'success')).toBeUndefined()
  })

  test('the by-iid query asks finishedAt on the head pipeline, with and without the people', () => {
    expect(refsQuery(gl, [], [8])).toContain('headPipeline { status finishedAt createdAt }')
    expect(refsQuery(gl, [], [8], false)).toContain('headPipeline { status finishedAt }')
  })
})

describe('the cache', () => {
  let folder: string
  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-pipeline-')))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  test('a stored row keeps its pipeline, link and time', () => {
    const row = mergeRow(
      gl,
      { iid: '8', state: 'opened', title: 'More', webUrl: 'https://gitlab.example.org/group/project/-/merge_requests/8', description: '', headPipeline: { status: 'FAILED', finishedAt: '2026-10-30T11:48:00Z' } },
      NOW,
    )!
    const file = readingFile(folder)!
    mkdirSync(join(file, '..'), { recursive: true })
    const empty = loadReading(folder)
    writeFileSync(file, JSON.stringify({ ...empty, rows: [row] }))
    const back = loadReading(folder).rows[0]!
    expect(back).toMatchObject({ pipeline: 'failed', pipelineUrl: row.pipelineUrl, pipelineAt: '2026-10-30T11:48:00.000Z' })
  })
})
