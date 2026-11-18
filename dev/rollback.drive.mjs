/*
 * A release that does not start rolls back, on a scratch host running the REAL host code
 * (`server/server.ts`) and a real bundle of a module installed from a fake GitHub:
 *
 *   1. v1.0.0 is installed (an unpacked bundle, registered, started by the host and answering);
 *   2. v1.1.0 is published, a bundle whose server throws at start;
 *   3. the person presses Update: the host downloads v1.1.0's bundle, checks and swaps it in, restarts
 *      the module, sees it never answers, puts v1.0.0 back at the same folder, starts it, and says so
 *      in the Inbox.
 *
 * Nothing leaves this machine: every `KEHIKOT_*` location and `HOME` is a scratch directory, every
 * `https://` request goes to the fake GitHub below (`dev/fixtures/https-shim.ts`), `git` is pointed at
 * a local repository for the module's tags, and the module list is a scratch file.
 *
 *     node dev/rollback.drive.mjs           # prints what happened
 *     CHECK=1 node dev/rollback.drive.mjs   # what `bun test` runs: fails when it did not roll back
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MANIFEST_KIND, PROTOCOL, WELL_KNOWN, manifestSchema } from 'kehikot-module-protocol'
import { bundleArchiveName, bundleRunScript, checksumLine, readBundleInfo, sha256, unpackBundle, writeTarGz } from 'kehikot-module-protocol/bundle'

import { bootHost, freePort, HOST, scratch, stop } from './scratch-host.mjs'

const ID = 'kehikot.sample'
const REPO = 'Jalez/kehikko-sample'
const text = (value) => new TextEncoder().encode(value)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** A bundle as `kehikot-bundle` writes one: `serve.ts`, `run.sh`, `bundle.json` listing both. */
function bundleOf(version, serve) {
  const base = { id: ID, version, commit: version.replaceAll('.', '').padEnd(40, 'a'), entry: 'serve.ts' }
  const files = [
    { path: 'serve.ts', data: text(serve) },
    { path: 'run.sh', data: text(bundleRunScript(base)), executable: true },
  ]
  const info = {
    format: 'kehikot.bundle', formatVersion: 1, ...base, protocol: '2.102.0', builtAt: '2026-11-18T00:00:00.000Z', bun: '1.4.0', platforms: null, native: [],
    files: Object.fromEntries(files.map((file) => [file.path, { sha256: sha256(file.data), size: file.data.length, ...(file.executable ? { executable: true } : {}) }])),
  }
  return writeTarGz([...files, { path: 'bundle.json', data: text(JSON.stringify(info)) }])
}

const manifest = (version) =>
  manifestSchema.parse({
    kind: MANIFEST_KIND, protocol: PROTOCOL, id: ID, name: 'Sample', version, dataVersion: 1, summary: 'A sample module.', tags: [],
    guidance: 'A sample.', entry: '/app', modes: [{ id: 'sample', label: 'Sample', scope: 'epic' }],
    extensions: { emits: [], consumes: [] }, reacts: [], partless: 'A sample: it holds nothing of a part.',
    declares: { protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`, uses: [], storage: true, prompt: false }, health: '/healthz',
  })

/** A server that answers its manifest and health, from one file with nothing to import. */
const working = (version) => `
const manifest = ${JSON.stringify(manifest(version))}
const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json' }
Bun.serve({ port: Number(process.env.PORT), hostname: '127.0.0.1', fetch(request) {
  const path = new URL(request.url).pathname
  if (path === ${JSON.stringify(WELL_KNOWN)}) return new Response(JSON.stringify(manifest), { headers })
  if (path === '/healthz') return new Response('ok')
  return new Response('<!doctype html><title>Sample</title>', { headers: { 'content-type': 'text/html' } })
} })
`
const broken = `throw new Error('this release was built wrong and cannot start')\n`

export async function rollbackDrive({ check = false } = {}) {
  const failures = []
  const expect = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
    if (!ok) failures.push(what)
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rollback-')))
  try {
    /* The fake GitHub: release files and the raw package.json, for whatever `https://` the host asks. */
    const releases = { 'v1.0.0': bundleOf('1.0.0', working('1.0.0')), 'v1.1.0': bundleOf('1.1.0', broken) }
    const asked = []
    const github = createServer((request, response) => {
      asked.push(request.url)
      const download = /^\/github\.com\/Jalez\/kehikko-sample\/releases\/download\/(v[\d.]+)\/(.+)$/.exec(request.url)
      if (download) {
        const archive = releases[download[1]]
        const name = bundleArchiveName(ID, download[1].slice(1))
        if (archive && download[2] === name) return void response.end(Buffer.from(archive))
        if (archive && download[2] === `${name}.sha256`) return void response.end(checksumLine(archive, name))
      }
      if (/^\/raw\.githubusercontent\.com\/Jalez\/kehikko-sample\/v[\d.]+\/package\.json$/.test(request.url)) {
        return void response.end(JSON.stringify({ dependencies: { 'kehikot-module-protocol': 'git+https://x#v2.102.0' } }))
      }
      response.statusCode = 404
      response.end('not found')
    })
    const githubPort = await freePort()
    await new Promise((done) => github.listen(githubPort, '127.0.0.1', done))

    /* The module's tags, from a local repository `git` is told is github.com/<repo>. */
    const origin = join(dir, 'sample.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    const work = join(dir, 'work')
    execFileSync('git', ['init', '-q', '-b', 'main', work])
    const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.invalid', ...args], { stdio: 'pipe' })
    writeFileSync(join(work, 'README.md'), 'sample\n')
    git('add', '.')
    git('commit', '-q', '-m', 'release')
    for (const tag of Object.keys(releases)) git('tag', '-a', tag, '-m', tag)
    git('push', '-q', origin, 'main', '--tags')
    const gitconfig = join(dir, 'gitconfig')
    writeFileSync(gitconfig, `[url "${origin}"]\n\tinsteadOf = https://github.com/${REPO}.git\n`)

    const myModules = join(dir, 'my-modules.json')
    const port = await freePort()
    writeFileSync(myModules, JSON.stringify({ modules: [{ id: ID, name: 'Sample', repo: REPO, host: 'github.com', port, summary: 'A sample.', tags: [], added: '2026-11-18' }] }))

    const pageUrl = await bootHost('rollback', {
      env: {
        KEHIKOT_ONBOARDING: 'off',
        KEHIKOT_MY_MODULES: myModules,
        KEHIKOT_SHIM_HTTPS: `http://127.0.0.1:${githubPort}`,
        BUN_OPTIONS: `--preload=${join(HOST, 'dev/fixtures/https-shim.ts')}`,
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_CONFIG_NOSYSTEM: '1',
      },
      before: async ({ root }) => {
        const target = join(root, 'installed', ID)
        const archive = releases['v1.0.0']
        const out = unpackBundle(archive, target, { sha256: sha256(archive), id: ID, version: '1.0.0' })
        if (!out.ok) throw new Error(out.why)
        writeFileSync(join(root, 'modules', `${ID}.json`), JSON.stringify({ url: `http://127.0.0.1:${port}`, dir: target }))
      },
    })
    const api = `http://127.0.0.1:${scratch.api}`
    const installed = join(scratch.root, 'installed', ID)
    const headers = { origin: new URL(pageUrl).origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
    const post = (path, body) => fetch(`${api}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const manifestNow = async () => {
      try {
        return await (await fetch(`http://127.0.0.1:${port}${WELL_KNOWN}`)).json()
      } catch {
        return null
      }
    }
    const until = async (what, test, ms = 60_000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const got = await test()
        if (got) return got
        await sleep(300)
      }
      throw new Error(`nothing: ${what}`)
    }

    const started = await post('/host/start', { module: ID })
    expect(started.ok, `the host starts the installed bundle (${started.status})`)
    expect(await until('v1.0.0 answers', async () => (await manifestNow())?.version === '1.0.0'), 'it answers as 1.0.0')
    expect(readBundleInfo(installed)?.version === '1.0.0', 'the installed copy is the 1.0.0 bundle')

    /* "Check now": the host reads the module's releases, and so knows 1.1.0 is there. */
    const checked = await (await fetch(`${api}/host/updates?fetch=1`, { headers })).json()
    const row = checked.checkouts.find((one) => one.id === ID)
    expect(row?.release?.target === 'v1.1.0', `Check now finds v1.1.0 waiting (${row?.release?.target})`)
    /* "Keep modules up to date automatically" is on by default, so Check now is also what takes the
       release: the host swaps 1.1.0 in, restarts the module, and finds it does not answer. */
    const apiLog = () => readFileSync(join(scratch.root, 'api.log'), 'utf8')
    const rolled = await until('the host rolls back', async () => /rolled back to/.test(apiLog()), 90_000).catch(() => false)
    expect(rolled, 'the host says it rolled back')
    expect(asked.some((url) => url.includes('/releases/download/v1.1.0/')), 'the 1.1.0 bundle was downloaded')
    expect(readBundleInfo(installed)?.version === '1.0.0', 'the installed copy is the 1.0.0 bundle again')
    expect(Boolean(await until('1.0.0 answers again', async () => (await manifestNow())?.version === '1.0.0').catch(() => false)), 'the module answers again, as 1.0.0')

    const project = (await (await fetch(`${api}/host/canvases`, { headers })).json()).projects[0].id
    const inboxNow = async () => (await fetch(`${api}/host/inbox/log?project=${project}&limit=20`, { headers })).text()
    await until('the Inbox is told', async () => /put back on/.test(await inboxNow()), 30_000).catch(() => false)
    const inbox = await inboxNow()
    expect(/put back on 1\.0\.0/.test(inbox), 'the Inbox says the new version did not start and the one before is back')
    console.log(inbox.slice(0, 600))
    if (failures.length) console.log(readFileSync(join(scratch.root, 'api.log'), 'utf8').split('\n').slice(-30).join('\n'))
    github.close()
  } finally {
    stop()
  }
  if (check && failures.length) {
    console.error(`a release that does not start did not roll back: ${failures.join('; ')}`)
    process.exitCode = 1
  } else if (!failures.length) console.log('the rollback held: the release that did not start was put back and the Inbox was told')
  return failures
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('rollback.drive.mjs')) {
  await rollbackDrive({ check: process.env.CHECK === '1' })
}
