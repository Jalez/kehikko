/*
 * Uninstall is a real uninstall, on a scratch host running the REAL host code (`server/server.ts`),
 * with REAL bundles installed through the host's own Install from a fake GitHub:
 *
 *   1. A running module (a bundle installed from the person's own list, on a kehikko, answering) is
 *      uninstalled: stopped, its copy, its rollback copy, its log and its registration gone, its Inbox
 *      items gone, its project data kept (the checkbox was not ticked), its container left on the
 *      kehikko as "Module removed", and a summary in words with the space freed.
 *   2. The REAL Claude module, installed from its real release bundle (`CLAUDE_BUNDLE`, built by
 *      `kehikot-bundle` from the module's repository) through the official Install, is uninstalled with
 *      "Also remove its saved data" ticked: its own `uninstall.ts` (protocol 2.108.0) runs from the
 *      installed bundle and takes its SessionStart hook out of the agent's settings — the person's own
 *      hook beside it stays — its setup file and its temporary folder; its saved data in the project
 *      goes; the summary says each.
 *   3. Two retired modules still installed (one a copy Kehikot installed, one the person's own checkout)
 *      are ONE Inbox item; one press on "Uninstall them" uninstalls both, fully, and the checkout is
 *      untouched and said to be the person's.
 *
 * Nothing leaves this machine: every `KEHIKOT_*` location, `HOME`, `TMPDIR` and the agent's config
 * folder are scratch directories, every `https://` request goes to the fake GitHub below
 * (`dev/fixtures/https-shim.ts`), and `git` is pointed at local repositories for the modules' tags.
 * `TMPDIR` matters: the Claude module's clean-up removes its folder in the temporary directory, and
 * must only ever see the scratch one.
 *
 *     CLAUDE_BUNDLE=<kehikot.claude-x.y.z.tar.gz> node dev/uninstall.drive.mjs
 *     CHECK=1 …                                   # fails when Uninstall left anything it should not
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { MANIFEST_KIND, PROTOCOL, UNINSTALL_MARK, WELL_KNOWN, manifestSchema } from 'kehikot-module-protocol'
import { bundleArchiveName, bundleRunScript, checksumLine, sha256, writeTarGz } from 'kehikot-module-protocol/bundle'

import { bootHost, freePort, HOST, scratch, stop } from './scratch-host.mjs'

const SAMPLE = 'kehikot.sample'
const SAMPLE_REPO = 'Jalez/kehikko-sample'
const CLAUDE = 'kehikot.claude'
const CLAUDE_REPO = 'Jalez/kehikko-claude'
const text = (value) => new TextEncoder().encode(value)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const manifest = (version) =>
  manifestSchema.parse({
    kind: MANIFEST_KIND, protocol: PROTOCOL, id: SAMPLE, name: 'Sample', version, dataVersion: 1, summary: 'A sample module.', tags: [],
    guidance: 'A sample.', entry: '/app', modes: [{ id: 'sample', label: 'Sample', scope: 'epic' }],
    extensions: { emits: [], consumes: [] }, reacts: [], partless: 'A sample: it holds nothing of a part.',
    declares: { protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`, uses: [], storage: true, prompt: false }, health: '/healthz',
  })

const serve = (version) => `
const manifest = ${JSON.stringify(manifest(version))}
const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json' }
Bun.serve({ port: Number(process.env.PORT), hostname: '127.0.0.1', fetch(request) {
  const path = new URL(request.url).pathname
  if (path === ${JSON.stringify(WELL_KNOWN)}) return new Response(JSON.stringify(manifest), { headers })
  if (path === '/healthz') return new Response('ok')
  return new Response('<!doctype html><title>Sample</title>', { headers: { 'content-type': 'text/html' } })
} })
`

/** Its own clean-up (protocol 2.108.0): takes out the entry it wrote into a (scratch) agent's folder. */
const cleanUp = `
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const entry = join(process.env.HOME, '.sample-agent', 'entry.json')
const had = existsSync(entry)
rmSync(entry, { force: true })
console.log(${JSON.stringify(UNINSTALL_MARK)} + JSON.stringify({ removed: had ? [{ what: 'Its entry in the agent', path: entry }] : [], left: [] }))
`

/** A bundle as `kehikot-bundle` writes one: `serve.ts`, `run.sh`, `uninstall.ts`, `bundle.json` listing them. */
function sampleBundle(version) {
  const base = { id: SAMPLE, version, commit: version.replaceAll('.', '').padEnd(40, 'a'), entry: 'serve.ts' }
  const files = [
    { path: 'serve.ts', data: text(serve(version)) },
    { path: 'run.sh', data: text(bundleRunScript(base)), executable: true },
    { path: 'uninstall.ts', data: text(cleanUp) },
  ]
  const info = {
    format: 'kehikot.bundle', formatVersion: 1, ...base, protocol: '2.108.0', builtAt: '2026-11-18T00:00:00.000Z', bun: '1.4.0', platforms: null, native: [],
    files: Object.fromEntries(files.map((file) => [file.path, { sha256: sha256(file.data), size: file.data.length, ...(file.executable ? { executable: true } : {}) }])),
  }
  return writeTarGz([...files, { path: 'bundle.json', data: text(JSON.stringify(info)) }])
}

/** A local repository for a module's tags, which `git` is told is github.com/<repo>. */
function tagsRepo(dir, name, tags) {
  const origin = join(dir, `${name}.git`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  const work = join(dir, `${name}-work`)
  execFileSync('git', ['init', '-q', '-b', 'main', work])
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.invalid', ...args], { stdio: 'pipe' })
  writeFileSync(join(work, 'README.md'), `${name}\n`)
  git('add', '.')
  git('commit', '-q', '-m', 'release')
  for (const tag of tags) git('tag', '-a', tag, '-m', tag)
  git('push', '-q', origin, 'main', '--tags')
  return origin
}

export async function uninstallDrive({ check = false, claudeBundle = process.env.CLAUDE_BUNDLE } = {}) {
  const failures = []
  const expect = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
    if (!ok) failures.push(what)
  }
  /* Part 2 runs when the Claude module's real bundle is given; without it, parts 1 and 3. */
  const withClaude = Boolean(claudeBundle && existsSync(claudeBundle))
  if (!withClaude) console.log('(no CLAUDE_BUNDLE: the real Claude module’s part is left out)')
  const claudeArchive = withClaude ? readFileSync(claudeBundle) : new Uint8Array()
  const claudeVersion = withClaude ? /kehikot\.claude-(\d+\.\d+\.\d+)\.tar\.gz$/.exec(basename(claudeBundle))?.[1] : '0.0.0'
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'uninstall-')))
  try {
    /* The fake GitHub: release files and the raw package.json, for whatever `https://` the host asks. */
    const releases = {
      [SAMPLE_REPO]: { version: '1.0.0', id: SAMPLE, archive: sampleBundle('1.0.0') },
      [CLAUDE_REPO]: { version: claudeVersion, id: CLAUDE, archive: claudeArchive },
    }
    const github = createServer((request, response) => {
      for (const [repo, release] of Object.entries(releases)) {
        const name = bundleArchiveName(release.id, release.version)
        if (request.url === `/github.com/${repo}/releases/download/v${release.version}/${name}`) return void response.end(Buffer.from(release.archive))
        if (request.url === `/github.com/${repo}/releases/download/v${release.version}/${name}.sha256`) return void response.end(checksumLine(release.archive, name))
        if (request.url === `/raw.githubusercontent.com/${repo}/v${release.version}/package.json`) {
          return void response.end(JSON.stringify({ name: release.id, version: release.version, dependencies: { 'kehikot-module-protocol': 'git+https://x#v2.108.0' } }))
        }
      }
      response.statusCode = 404
      response.end('not found')
    })
    const githubPort = await freePort()
    await new Promise((done) => github.listen(githubPort, '127.0.0.1', done))
    const gitconfig = join(dir, 'gitconfig')
    writeFileSync(
      gitconfig,
      [SAMPLE_REPO, CLAUDE_REPO].map((repo) => `[url "${tagsRepo(dir, basename(repo), [`v${releases[repo].version}`])}"]\n\tinsteadOf = https://github.com/${repo}.git\n`).join(''),
    )
    const samplePort = await freePort()
    const myModules = join(dir, 'my-modules.json')
    writeFileSync(myModules, JSON.stringify({ modules: [{ id: SAMPLE, name: 'Sample', repo: SAMPLE_REPO, host: 'github.com', port: samplePort, summary: 'A sample.', tags: [], added: '2026-11-18' }] }))

    let checkout = ''
    const pageUrl = await bootHost('uninstall', {
      env: {
        KEHIKOT_ONBOARDING: 'off',
        KEHIKOT_MY_MODULES: myModules,
        KEHIKOT_SHIM_HTTPS: `http://127.0.0.1:${githubPort}`,
        BUN_OPTIONS: `--preload=${join(HOST, 'dev/fixtures/https-shim.ts')}`,
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_CONFIG_NOSYSTEM: '1',
        TMPDIR: join(dir, 'tmp'),
      },
      before: async ({ root, env }) => {
        /* Every place a clean-up could reach is this scratch directory's, before anything starts. */
        for (const name of ['HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'KEHIKOT_MODULES_DIR', 'KEHIKOT_INSTALLS_DIR', 'KEHIKOT_LOGS_DIR', 'KEHIKOT_FRAME_DB']) {
          if (!env[name]?.startsWith(dir) && !env[name]?.startsWith(root)) throw new Error(`${name} is not scratch: ${env[name]}`)
        }
        mkdirSync(env.TMPDIR, { recursive: true })
        /* Two retired modules, as they were left on the person's machine: one a copy Kehikot installed
           (with a log), one the person's own checkout. */
        const tests = join(root, 'installed', 'kehikot.tests')
        mkdirSync(tests, { recursive: true })
        writeFileSync(join(tests, 'run.sh'), '#!/bin/sh\nexit 1\n')
        mkdirSync(join(root, 'logs', 'modules'), { recursive: true })
        writeFileSync(join(root, 'logs', 'modules', 'kehikot.tests.log'), 'it ran once\n')
        writeFileSync(join(root, 'modules', 'kehikot.tests.json'), JSON.stringify({ url: `http://127.0.0.1:${await freePort()}`, dir: tests }))
        checkout = join(root, 'projects', 'kehikko-atlas')
        mkdirSync(join(checkout, '.git'), { recursive: true })
        writeFileSync(join(checkout, 'run.sh'), '#!/bin/sh\nexit 1\n')
        writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
        writeFileSync(join(root, 'modules', 'kehikot.atlas.json'), JSON.stringify({ url: `http://127.0.0.1:${await freePort()}`, dir: checkout }))
      },
    })
    const root = scratch.root
    const api = `http://127.0.0.1:${scratch.api}`
    const headers = { origin: new URL(pageUrl).origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
    const post = (path, body) => fetch(`${api}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const get = async (path) => (await fetch(`${api}${path}`, { headers })).json()
    const until = async (what, test, ms = 60_000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const got = await test().catch(() => null)
        if (got) return got
        await sleep(300)
      }
      console.log(`(waited for ${what})`)
      return null
    }
    const answers = async (port) => {
      try {
        return (await fetch(`http://127.0.0.1:${port}${WELL_KNOWN}`)).ok
      } catch {
        return false
      }
    }
    const projectA = (await get('/host/canvases')).projects.find((one) => one.path === join(root, 'project-a'))
    const inboxOf = async () => (await get(`/host/inbox?project=${projectA.id}`)).open ?? []

    /* ---- 3 first, as the person meets it at start: ONE Inbox item for the retired modules ---------- */
    const offer = await until('the retired modules are offered', async () => (await inboxOf()).find((one) => one.module === 'kehikko.modules'), 30_000)
    expect(offer?.label === 'Atlas and Tests are retired and still installed. Uninstall them?', `one Inbox item asks to uninstall the retired modules ("${offer?.label}")`)
    expect(JSON.stringify(offer?.question?.choices) === JSON.stringify(['Uninstall them', 'Not now']), 'with one press to uninstall them all')
    expect((await inboxOf()).filter((one) => one.module === 'kehikko.modules').length === 1, 'and only one')
    const pressed = await post('/host/inbox/answer', { project: projectA.id, module: 'kehikko.modules', item: offer?.id, choice: 0, answer: 'Uninstall them', pressed: true })
    const pressedBody = await pressed.json()
    expect(pressed.ok, `the press is taken (${pressed.status} ${String(pressedBody.said ?? pressedBody.why ?? '').slice(0, 300)})`)
    expect(!existsSync(join(root, 'modules', 'kehikot.tests.json')) && !existsSync(join(root, 'modules', 'kehikot.atlas.json')), 'both registrations are gone')
    expect(!existsSync(join(root, 'installed', 'kehikot.tests')), 'the copy Kehikot installed is deleted')
    expect(!existsSync(join(root, 'logs', 'modules', 'kehikot.tests.log')), 'and its log')
    expect(existsSync(join(checkout, 'run.sh')) && existsSync(join(checkout, '.git', 'HEAD')), 'the person’s own checkout is untouched')
    expect(String(pressedBody.said).includes(`Kehikot no longer uses ${checkout}; it's yours to keep or remove.`), 'and the summary says it is theirs to keep or remove')
    expect(!(await inboxOf()).some((one) => one.module === 'kehikko.modules' && one.state === 'attention'), 'the offer is gone once answered')

    /* ---- 1. A running module, installed from a real bundle, uninstalled ---------------------------- */
    const installed = await post('/host/mine/install', { module: SAMPLE })
    expect(installed.ok, `Install is pressed for the sample (${installed.status})`)
    expect(Boolean(await until('the sample is installed', async () => existsSync(join(root, 'modules', `${SAMPLE}.json`)), 90_000)), 'the host installs the sample bundle and registers it')
    const canvases = (await get('/host/canvases')).canvases
    const kehikko = canvases.find((one) => one.project === projectA.id)
    const placed = await fetch(`${api}/host/canvases/${kehikko.id}`, { method: 'PATCH', headers, body: JSON.stringify({ placements: [...kehikko.placements, { i: SAMPLE, x: 0, y: 56, w: 12, h: 20 }] }) })
    expect(placed.ok, 'a container of it is on a kehikko')
    await post('/host/start', { module: SAMPLE })
    expect(Boolean(await until('the sample answers', () => answers(samplePort), 60_000)), 'the host starts it and it answers')
    mkdirSync(join(root, 'installed', '.previous', SAMPLE), { recursive: true })
    writeFileSync(join(root, 'installed', '.previous', SAMPLE, 'serve.ts'), '// the version before\n')
    mkdirSync(join(root, 'project-a', '.kehikot', 'sample'), { recursive: true })
    writeFileSync(join(root, 'project-a', '.kehikot', 'sample', 'notes.json'), '{"the person’s":"work"}')
    mkdirSync(join(root, 'home', '.sample-agent'), { recursive: true })
    writeFileSync(join(root, 'home', '.sample-agent', 'entry.json'), '{"by":"sample"}')
    writeFileSync(join(root, 'home', '.sample-agent', 'theirs.json'), '{"by":"the person"}')
    const reported = await post('/host/inbox/report', { project: projectA.id, module: SAMPLE, name: 'Sample', items: [{ id: 'x', state: 'attention', label: 'Sample needs you' }] })
    expect(reported.ok && (await inboxOf()).some((one) => one.module === SAMPLE), 'it has an item in the Inbox')

    const preview = await get(`/host/uninstall?module=${SAMPLE}`)
    expect(preview.projects?.length === 1 && preview.projects[0].bytes > 0, `the confirmation lists its saved data in one project, with its size (${JSON.stringify(preview.projects)})`)
    const gone = await post('/host/uninstall', { module: SAMPLE })
    const goneBody = await gone.json()
    console.log(`  said: ${goneBody.said}`)
    expect(gone.ok, `Uninstall is pressed (${gone.status})`)
    expect(!(await answers(samplePort)), 'it no longer answers: it was stopped')
    expect(!existsSync(join(root, 'installed', SAMPLE)) && !existsSync(join(root, 'installed', '.previous', SAMPLE)), 'its copy and its rollback copy are deleted')
    expect(!existsSync(join(root, 'modules', `${SAMPLE}.json`)), 'its registration is deleted')
    expect(!readdirSync(join(root, 'logs', 'modules')).some((name) => name.startsWith(SAMPLE)), 'its log is deleted')
    expect(!(await inboxOf()).some((one) => one.module === SAMPLE), 'its Inbox items are gone')
    expect(existsSync(join(root, 'project-a', '.kehikot', 'sample', 'notes.json')), 'its saved data in the project stays: the box was not ticked')
    expect(!existsSync(join(root, 'home', '.sample-agent', 'entry.json')), 'its own clean-up ran from the installed bundle and took out its entry in the agent')
    expect(existsSync(join(root, 'home', '.sample-agent', 'theirs.json')), 'the person’s entry beside it stays')
    expect(String(goneBody.said).includes('its entry in the agent'), 'and the summary says so')
    expect(/^Sample is uninstalled\. Removed: .*the copy Kehikot installed.*\d+ kB freed\./.test(goneBody.said ?? ''), 'the summary says what went and the space freed')
    const view = await get('/host/modules')
    expect(view.removed?.some((one) => one.id === SAMPLE && one.name === 'Sample'), 'the registry says it was removed, for its container')
    const after = (await get('/host/canvases')).canvases.find((one) => one.id === kehikko.id)
    expect(after.placements.some((one) => one.i === SAMPLE), 'its container stays on the kehikko (drawn as "Module removed")')

    /* ---- 2. The real Claude module, from its real bundle: its own clean-up runs -------------------- */
    if (withClaude) {
    const official = await post('/host/official/install', { module: CLAUDE })
    expect(official.ok, `Install is pressed for Claude (${official.status} ${official.ok ? '' : await official.text()})`)
    expect(Boolean(await until('Claude is installed', async () => existsSync(join(root, 'modules', `${CLAUDE}.json`)), 120_000)), 'the host installs Claude from its release bundle and registers it')
    const claudeCopy = join(root, 'installed', CLAUDE)
    expect(existsSync(join(claudeCopy, 'uninstall.ts')) && existsSync(join(claudeCopy, 'bundle.json')), 'the installed bundle carries its uninstall.ts')
    /* What the module wrote outside its folder, as a press in it would have: its SessionStart hook beside
       the person's own, its setup choice beside the registry, its session folder in the temporary directory. */
    const settings = join(root, 'claude', 'settings.json')
    const theirs = { hooks: [{ type: 'command', command: '/usr/local/bin/their-own-hook' }] }
    const ours = { hooks: [{ type: 'command', timeout: 5, command: `/bin/sh '${join(claudeCopy, 'started.sh')}' '${join(root, 'modules', `${CLAUDE}.json`)}'` }] }
    writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { SessionStart: [theirs, ours] } }, null, 2))
    writeFileSync(join(root, 'claude', 'setup.json'), '{}')
    const sessions = join(dir, 'tmp', `kehikot-claude-${process.getuid?.() ?? 'user'}`)
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'abc.json'), '{}')
    mkdirSync(join(root, 'project-a', '.kehikot', 'claude'), { recursive: true })
    writeFileSync(join(root, 'project-a', '.kehikot', 'claude', 'sessions.json'), '{}')

    const claudeGone = await post('/host/uninstall', { module: CLAUDE, projects: true })
    const claudeBody = await claudeGone.json()
    console.log(`  said: ${claudeBody.said ?? claudeBody.error}`)
    expect(claudeGone.ok, `Uninstall is pressed for Claude, with its saved data ticked (${claudeGone.status})`)
    const left = JSON.parse(readFileSync(settings, 'utf8'))
    expect(JSON.stringify(left) === JSON.stringify({ model: 'opus', hooks: { SessionStart: [theirs] } }), `its SessionStart hook is out of the agent's settings; the person's own and the rest stay (${JSON.stringify(left)})`)
    expect(!existsSync(join(root, 'claude', 'setup.json')), 'its setup file is removed')
    expect(!existsSync(sessions), 'its folder in the (scratch) temporary directory is removed')
    expect(!existsSync(claudeCopy) && !existsSync(join(root, 'modules', `${CLAUDE}.json`)), 'its copy and registration are deleted')
    expect(!existsSync(join(root, 'project-a', '.kehikot', 'claude')), 'its saved data in the project is removed: the box was ticked')
    expect(String(claudeBody.said).includes('its SessionStart hook in Claude Code’s settings'), 'the summary says what its own clean-up removed')
    }
    github.close()
  } finally {
    stop()
  }
  if (check && failures.length) {
    console.error(`Uninstall left something behind: ${failures.join('; ')}`)
    process.exitCode = 1
  } else if (!failures.length) console.log('Uninstall held: everything Kehikot put on the computer went, the person’s folder and unticked data stayed, and the module’s own clean-up ran')
  return failures
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('uninstall.drive.mjs')) {
  await uninstallDrive({ check: process.env.CHECK === '1' })
}
