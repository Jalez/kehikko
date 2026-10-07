import { describe, expect, test } from 'bun:test'

import type { FramedModule } from '../server/discover.ts'
import type { Ran, Runner } from '../server/feedback.ts'
import type { Official } from '../server/official.ts'
import { composeProposal, proposalDesk, titleFor } from '../server/proposals.ts'

/*
 * Proposing a module for the official list — against a fake runner, because
 * the real one would file real issues. What matters is who cannot be proposed
 * and is told so, that one module gets one open proposal, and that what a
 * module says about itself only ever travels on stdin.
 */

const ok = (out: string): Ran => ({ code: 0, out, err: '' })
const slides: Official = { id: 'kehikot.slides', name: 'Slides', repo: 'Jalez/kehikko-slides', port: 7990, summary: 'Decks.', tags: ['writing'] }

const scores = {
  id: 'me.scores',
  name: 'Scores',
  version: '0.3.0',
  dataVersion: 1,
  summary: 'Sheet music for an epic.',
  tags: ['music-theory'],
  guidance: '',
  entry: 'http://127.0.0.1:8010/app',
  icon: null,
  health: null,
  mcp: { url: 'http://127.0.0.1:8010/mcp', transport: 'http', about: 'Read and edit scores.' },
  modes: [{ id: 'scores', label: 'Scores', scope: 'epic' }],
  extensions: { emits: [], consumes: [] },
  dialect: 'kehikot',
  reacts: ['passage'],
  declares: { protocol: '>=2 <3', uses: ['epics:read'], storage: true, prompt: false },
} as unknown as FramedModule

function world(over: Partial<{ dir: string | undefined; remote: Ran; visibility: Ran; open: Ran; module: FramedModule | null }> = {}) {
  const calls: { argv: string[]; stdin?: string }[] = []
  const run: Runner = async (argv, options) => {
    calls.push({ argv, stdin: options?.stdin })
    if (argv[0] === 'git') return over.remote ?? ok('git@github.com:me/kehikko-scores.git')
    if (argv[1] === 'repo') return over.visibility ?? ok('{"visibility":"PUBLIC"}')
    if (argv[2] === 'list') return over.open ?? ok('[]')
    if (argv[2] === 'create') return ok('https://github.com/Jalez/kehikko/issues/77')
    return { code: 1, out: '', err: 'unexpected' }
  }
  const desk = proposalDesk({
    list: [slides],
    run,
    repo: 'Jalez/kehikko',
    registration: async (id) =>
      id === 'me.scores'
        ? { id, url: 'http://127.0.0.1:8010', ...('dir' in over ? (over.dir ? { dir: over.dir } : {}) : { dir: '/m/scores' }) }
        : id === 'kehikot.slides'
          ? { id, url: 'http://127.0.0.1:7990', dir: '/m/slides' }
          : null,
    manifest: async () => ('module' in over ? over.module! : scores),
    remembered: () => ({ name: 'Scores', summary: 'Remembered summary.', tags: ['music-theory'] }),
  })
  return { desk, calls }
}

describe('proposing a module for the official list', () => {
  test('files one issue in the host repository, filled in from the manifest and the remote', async () => {
    const { desk, calls } = world()
    expect(await desk.propose('me.scores')).toEqual({ ok: true, value: { url: 'https://github.com/Jalez/kehikko/issues/77', number: 77, existing: false } })
    const create = calls.find((call) => call.argv[2] === 'create')!
    expect(create.argv).toEqual(['gh', 'issue', 'create', '--repo', 'Jalez/kehikko', '--title=Module proposal: Scores (me.scores)', '--body-file', '-'])
    for (const said of ['`me.scores`', 'https://github.com/me/kehikko-scores', 'Sheet music for an epic.', '`music-theory`', '0.3.0', '`>=2 <3`', '`epics:read`', '`passage`', 'Read and edit scores.']) {
      expect(create.stdin).toContain(said)
    }
    /* The entry a reviewer would paste into modules.json, whole. */
    expect(create.stdin).toContain('{"id":"me.scores","name":"Scores","repo":"me/kehikko-scores","port":8010,"tags":["music-theory"],"summary":"Sheet music for an epic."}')
  })

  test('a module that is not running is proposed from what the host remembers, and says so', async () => {
    const { desk, calls } = world({ module: null })
    expect((await desk.propose('me.scores')).ok).toBe(true)
    const body = calls.find((call) => call.argv[2] === 'create')!.stdin!
    expect(body).toContain('Remembered summary.')
    expect(body).toContain('was not running when this was filed')
  })

  test('one open proposal per module: a second press is handed the first', async () => {
    const { desk, calls } = world({ open: ok(JSON.stringify([{ number: 61, title: 'Module proposal: Old name (me.scores)', url: 'https://github.com/Jalez/kehikko/issues/61' }])) })
    expect(await desk.propose('me.scores')).toEqual({ ok: true, value: { url: 'https://github.com/Jalez/kehikko/issues/61', number: 61, existing: true } })
    expect(calls.some((call) => call.argv[2] === 'create')).toBe(false)
  })

  test('an official module is never proposed', async () => {
    const { desk, calls } = world()
    expect(await desk.propose('kehikot.slides')).toMatchObject({ ok: false, status: 409 })
    expect(await desk.propose('roadmap.slides')).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })

  test.each([
    ['no directory', { dir: undefined }, 'without a directory'],
    ['no remote', { remote: { code: 1, out: '', err: 'no such remote' } }, 'no public repository on GitHub'],
    ['a remote that is not GitHub', { remote: ok('git@gitlab.com:me/scores.git') }, 'no public repository on GitHub'],
    ['a private repository', { visibility: ok('{"visibility":"PRIVATE"}') }, 'is not public'],
  ])('%s cannot be proposed, and the answer says so instead of filing an issue', async (_what, over, sentence) => {
    const { desk, calls } = world(over as Parameters<typeof world>[0])
    const answered = await desk.propose('me.scores')
    expect(answered).toMatchObject({ ok: false, status: 409 })
    expect(!answered.ok && answered.why).toContain(sentence)
    expect(calls.some((call) => call.argv[2] === 'create')).toBe(false)
  })

  test('an unregistered id is a refusal, and a request names a module and nothing else', async () => {
    const { desk } = world()
    expect(await desk.propose('me.ghost')).toMatchObject({ ok: false, status: 404 })
    const bad = await desk.route(new Request('http://h/host/official/propose', { method: 'POST', body: '{}' }), new URL('http://h/host/official/propose'))
    expect(bad?.status).toBe(400)
    expect(await desk.route(new Request('http://h/host/feedback'), new URL('http://h/host/feedback'))).toBeNull()
  })

  test('the title names the module by id, which is what a second proposal is matched on', () => {
    expect(titleFor('Scores', 'me.scores')).toBe('Module proposal: Scores (me.scores)')
    expect(composeProposal({ id: 'a.b', repo: 'o/r', port: 0, name: 'A', summary: '', tags: [], module: null })).toContain('- **Summary:** none given')
  })
})
