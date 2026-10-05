import { describe, expect, test } from 'bun:test'

import {
  composeBody,
  feedbackDesk,
  footer,
  ghTrouble,
  githubRepo,
  readSent,
  spawnRunner,
  statusOf,
  type Ran,
  type Runner,
} from '../server/feedback.ts'

/*
 * Feedback as GitHub issues — against a fake runner, because the real one
 * would file real issues. What matters is which argv reaches `gh`, that a
 * person's text only ever travels as one argument or on stdin, and that every
 * way of not having a repository is a sentence.
 */

interface Call {
  argv: string[]
  stdin?: string
}

const ok = (out: string): Ran => ({ code: 0, out, err: '' })

function fake(answers: (argv: string[]) => Ran) {
  const calls: Call[] = []
  const run: Runner = async (argv, options) => {
    calls.push({ argv, stdin: options?.stdin })
    return answers(argv)
  }
  return { run, calls }
}

const rows = [
  { number: 3, title: 'three', state: 'OPEN', stateReason: '', url: 'https://github.com/o/r/issues/3', createdAt: 'a', updatedAt: '2026-01-03T00:00:00Z' },
  { number: 2, title: 'two', state: 'CLOSED', stateReason: 'COMPLETED', url: 'https://github.com/o/r/issues/2', createdAt: 'a', updatedAt: '2026-01-02T00:00:00Z' },
  { number: 1, title: 'one', state: 'CLOSED', stateReason: 'NOT_PLANNED', url: 'https://github.com/o/r/issues/1', createdAt: 'a', updatedAt: '2026-01-01T00:00:00Z' },
]

function world(overrides: Partial<{ dir: string | undefined; remote: Ran; gh: (argv: string[]) => Ran }> = {}) {
  let clock = 1_000_000
  const dir = 'dir' in overrides ? overrides.dir : '/m/notes'
  const { run, calls } = fake((argv) => {
    if (argv[0] === 'git' && argv.includes('remote')) return overrides.remote ?? ok('git@github.com:o/r.git')
    if (argv[0] === 'git' && argv.includes('rev-parse')) return ok('abc1234')
    if (overrides.gh) return overrides.gh(argv)
    if (argv[2] === 'list') return ok(JSON.stringify(rows))
    if (argv[2] === 'create') return ok('Creating issue in o/r\n\nhttps://github.com/o/r/issues/9')
    return { code: 1, out: '', err: 'unexpected' }
  })
  const desk = feedbackDesk({
    run,
    registration: (id) => (id === 'notes' ? { id, dir } : null),
    version: async () => '1.2.0',
    now: () => clock,
  })
  return { desk, calls, tick: (ms: number) => (clock += ms) }
}

describe('githubRepo', () => {
  test('reads ssh, ssh://, https, with and without .git', () => {
    expect(githubRepo('git@github.com:Jalez/kehikko.git')).toBe('Jalez/kehikko')
    expect(githubRepo('git@github.com:Jalez/kehikko')).toBe('Jalez/kehikko')
    expect(githubRepo('ssh://git@github.com/Jalez/kehikko-protocol.git')).toBe('Jalez/kehikko-protocol')
    expect(githubRepo('https://github.com/Jalez/kehikko')).toBe('Jalez/kehikko')
    expect(githubRepo('https://github.com/Jalez/kehikko.git\n')).toBe('Jalez/kehikko')
    expect(githubRepo('https://user@github.com/o/r.js.git')).toBe('o/r.js')
  })

  test('refuses anything that is not GitHub', () => {
    expect(githubRepo('git@gitlab.com:o/r.git')).toBeNull()
    expect(githubRepo('https://github.com.evil.com/o/r')).toBeNull()
    expect(githubRepo('https://github.com/o')).toBeNull()
    expect(githubRepo('/some/local/path')).toBeNull()
  })
})

test('statusOf maps state and reason to one word', () => {
  expect(statusOf('OPEN', '')).toBe('open')
  expect(statusOf('OPEN', 'REOPENED')).toBe('open')
  expect(statusOf('CLOSED', 'COMPLETED')).toBe('completed')
  expect(statusOf('CLOSED', 'NOT_PLANNED')).toBe('not planned')
  expect(statusOf('CLOSED', null)).toBe('closed')
  expect(statusOf('CLOSED', 'DUPLICATE')).toBe('closed')
})

describe('footer', () => {
  test('names the module, version, commit, kehikko and epic', () => {
    expect(footer({ module: 'notes', version: '1.2.0', commit: 'abc1234', kehikko: 'Daily', epic: 'feedback' })).toBe(
      '— Sent from Kehikot · module notes 1.2.0 (abc1234) · kehikko “Daily” · epic feedback',
    )
  })
  test('says what it does not know', () => {
    expect(footer({ module: 'notes', version: null, commit: null, kehikko: null, epic: null })).toBe(
      '— Sent from Kehikot · module notes version unknown · no kehikko · epic none',
    )
  })
  test('goes under the text, or alone', () => {
    expect(composeBody('  hello \n', 'F')).toBe('hello\n\nF')
    expect(composeBody('', 'F')).toBe('F')
  })
})

test('ghTrouble turns failures into sentences', () => {
  expect(ghTrouble({ code: 4, out: '', err: 'To get started with GitHub CLI, please run:  gh auth login' })).toBe(
    'GitHub CLI is not logged in: run `gh auth login`.',
  )
  expect(ghTrouble({ code: 1, out: '', err: 'You are not logged into any GitHub hosts.' })).toBe(
    'GitHub CLI is not logged in: run `gh auth login`.',
  )
  expect(ghTrouble({ code: null, out: '', err: '', missing: true })).toContain('not installed')
  expect(ghTrouble({ code: null, out: '', err: '', timedOut: true })).toContain('did not answer')
  expect(ghTrouble({ code: 1, out: '', err: 'GraphQL: Could not resolve to a Repository' })).toBe(
    'GraphQL: Could not resolve to a Repository',
  )
})

describe('list', () => {
  test('asks gh for my issues in the repo derived from the checkout', async () => {
    const { desk, calls } = world()
    const listed = await desk.list('notes')
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.repo).toBe('o/r')
    expect(listed.value.items.map((item) => item.status)).toEqual(['open', 'completed', 'not planned'])
    expect(listed.value.items[0]).toEqual({
      number: 3,
      title: 'three',
      status: 'open',
      url: 'https://github.com/o/r/issues/3',
      updatedAt: '2026-01-03T00:00:00Z',
    })
    expect(calls[0]!.argv).toEqual(['git', '-C', '/m/notes', 'remote', 'get-url', 'origin'])
    expect(calls[1]!.argv).toEqual([
      'gh', 'issue', 'list', '--repo', 'o/r', '--author', '@me', '--state', 'all', '--limit', '50',
      '--json', 'number,title,state,stateReason,url,createdAt,updatedAt',
    ])
  })

  test('is cached for a minute per repo', async () => {
    const { desk, calls, tick } = world()
    await desk.list('notes')
    await desk.list('notes')
    expect(calls.filter((call) => call.argv[0] === 'gh')).toHaveLength(1)
    tick(61_000)
    await desk.list('notes')
    expect(calls.filter((call) => call.argv[0] === 'gh')).toHaveLength(2)
  })

  test('refuses an unknown module, no dir, no remote, a non-GitHub remote', async () => {
    const unknown = await world().desk.list('nobody')
    expect(unknown).toMatchObject({ ok: false, status: 404 })

    const noDir = await world({ dir: undefined }).desk.list('notes')
    expect(noDir.ok).toBe(false)
    if (!noDir.ok) expect(noDir.why).toContain('names no directory')

    const noRemote = await world({ remote: { code: 2, out: '', err: "error: No such remote 'origin'" } }).desk.list('notes')
    expect(noRemote.ok).toBe(false)
    if (!noRemote.ok) expect(noRemote.why).toContain('no origin remote')

    const gitlab = await world({ remote: ok('git@gitlab.com:o/r.git') }).desk.list('notes')
    expect(gitlab.ok).toBe(false)
    if (!gitlab.ok) expect(gitlab.why).toContain('not on GitHub')
  })

  test('says to log in when gh is not', async () => {
    const { desk } = world({ gh: () => ({ code: 4, out: '', err: 'run gh auth login' }) })
    const listed = await desk.list('notes')
    expect(listed).toEqual({ ok: false, why: 'GitHub CLI is not logged in: run `gh auth login`.', status: 502 })
  })
})

describe('create', () => {
  const hostile = '$(rm -rf ~); `whoami` "quoted" \'single\''

  test('passes the title as one argument and the body on stdin', async () => {
    const { desk, calls } = world()
    const made = await desk.create({ module: 'notes', title: `-x ${hostile}`, body: hostile, kehikko: 'Daily', epic: 'e1' })
    expect(made.ok).toBe(true)
    const call = calls.find((one) => one.argv[2] === 'create')!
    expect(call.argv).toEqual(['gh', 'issue', 'create', '--repo', 'o/r', `--title=-x ${hostile}`, '--body-file', '-'])
    expect(call.argv.some((arg) => arg.includes('whoami') && arg !== `--title=-x ${hostile}`)).toBe(false)
    expect(call.stdin).toBe(`${hostile}\n\n— Sent from Kehikot · module notes 1.2.0 (abc1234) · kehikko “Daily” · epic e1`)
    if (made.ok) {
      expect(made.value.item).toMatchObject({ number: 9, status: 'open', url: 'https://github.com/o/r/issues/9' })
      expect(made.value.repo).toBe('o/r')
    }
  })

  test('invalidates the list cache', async () => {
    const { desk, calls } = world()
    await desk.list('notes')
    await desk.create({ module: 'notes', title: 't', body: '', kehikko: null, epic: null })
    await desk.list('notes')
    expect(calls.filter((call) => call.argv[2] === 'list')).toHaveLength(2)
  })

  test('a gh failure is the sentence and nothing is cached away', async () => {
    const { desk } = world({ gh: () => ({ code: 1, out: '', err: 'HTTP 410: Issues are disabled' }) })
    const made = await desk.create({ module: 'notes', title: 't', body: 'b', kehikko: null, epic: null })
    expect(made).toEqual({ ok: false, why: 'HTTP 410: Issues are disabled', status: 502 })
  })
})

describe('readSent', () => {
  test('requires a module and a 1..200 character title', () => {
    expect(readSent(null).ok).toBe(false)
    expect(readSent({ title: 't' }).ok).toBe(false)
    expect(readSent({ module: 'notes', title: '   ' }).ok).toBe(false)
    expect(readSent({ module: 'notes', title: 'x'.repeat(201) }).ok).toBe(false)
    expect(readSent({ module: 'notes', title: 'x'.repeat(200) }).ok).toBe(true)
  })
  test('bounds the body and folds the title to one line', () => {
    expect(readSent({ module: 'notes', title: 't', body: 'x'.repeat(20_001) }).ok).toBe(false)
    const sent = readSent({ module: 'notes', title: ' a\nb ', body: 'x'.repeat(20_000), kehikko: 'K', epic: '../bad' })
    expect(sent).toMatchObject({ ok: true, value: { title: 'a b', kehikko: 'K', epic: null } })
  })
})

describe('route', () => {
  const at = (path: string) => new URL(`http://127.0.0.1${path}`)

  test('GET lists, and refuses a request with no module', async () => {
    const { desk } = world()
    const good = await desk.route(new Request(at('/host/feedback?module=notes')), at('/host/feedback?module=notes'))
    expect(good!.status).toBe(200)
    expect(((await good!.json()) as { repo: string }).repo).toBe('o/r')
    const bad = await desk.route(new Request(at('/host/feedback')), at('/host/feedback'))
    expect(bad!.status).toBe(400)
  })

  test('POST validates before anything runs', async () => {
    const { desk, calls } = world()
    const post = (body: unknown) =>
      desk.route(
        new Request(at('/host/feedback'), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        at('/host/feedback'),
      )
    const empty = await post({ module: 'notes', title: '' })
    expect(empty!.status).toBe(400)
    expect(((await empty!.json()) as { error: string }).error).toBe('Feedback needs a title.')
    expect(calls).toHaveLength(0)

    const made = await post({ module: 'notes', title: 'works', body: 'yes', repo: 'evil/elsewhere' })
    expect(made!.status).toBe(201)
    expect(calls.find((one) => one.argv[2] === 'create')!.argv).toContain('o/r')
  })

  test('answers nothing for other paths', async () => {
    const { desk } = world()
    expect(await desk.route(new Request(at('/host/other')), at('/host/other'))).toBeNull()
  })
})

describe('spawnRunner', () => {
  test('hands stdin over and reads stdout, with no shell between', async () => {
    const ran = await spawnRunner(['cat'], { stdin: '$(echo no) `x`' })
    expect(ran).toMatchObject({ code: 0, out: '$(echo no) `x`' })
  })
  test('a program that is not there is missing, not a crash', async () => {
    const ran = await spawnRunner(['kehikko-no-such-program-here'])
    expect(ran.missing).toBe(true)
  })
  test('a program that runs too long is stopped', async () => {
    const ran = await spawnRunner(['sleep', '5'], { timeout: 50 })
    expect(ran.timedOut).toBe(true)
  })
})

describe('a host compiled into the desktop app', () => {
  /* No checkout to ask: the repository is named, nothing runs in a directory,
     and the stamp carries the version without a commit. */
  test('files on the named repository with no commit in the stamp', async () => {
    const { run, calls } = fake((argv) =>
      argv[2] === 'create' ? ok('https://github.com/Jalez/kehikko/issues/4') : { code: 1, out: '', err: 'unexpected' },
    )
    const desk = feedbackDesk({
      run,
      registration: (id) => (id === 'host' ? { id, repo: 'Jalez/kehikko' } : null),
      version: async () => '0.1.0',
    })
    const made = await desk.route(
      new Request('http://x/host/feedback', {
        method: 'POST',
        body: JSON.stringify({ module: 'host', title: 'hi', body: 'there' }),
      }),
      new URL('http://x/host/feedback'),
    )
    expect(made!.status).toBe(201)
    expect(calls.every((call) => call.argv[0] !== 'git')).toBe(true)
    const create = calls.find((call) => call.argv[2] === 'create')!
    expect(create.argv).toContain('Jalez/kehikko')
    expect(create.stdin).toContain('module host 0.1.0 ·')
  })
})
