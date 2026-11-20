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
 *   4. (idle) the module is stopped, v1.2.0 (also broken) is put in place by the check while nothing runs,
 *      and the first start after it does not answer: `bringUp`'s rollback puts v1.0.0 back and says so;
 *   5. (pinned) v1.3.0 becomes current; a container on a kehikko is pinned to v1.0.0, which runs from its
 *      release bundle on a port of its own, beside 1.3.0, both answering at once.
 *
 * Nothing leaves this machine: every `KEHIKOT_*` location and `HOME` is a scratch directory, every
 * `https://` request goes to the fake GitHub below (`dev/fixtures/https-shim.ts`), `git` is pointed at
 * a local repository for the module's tags, and the module list is a scratch file.
 *
 *     node dev/rollback.drive.mjs           # prints what happened
 *     CHECK=1 node dev/rollback.drive.mjs   # what `bun test` runs: fails when it did not roll back
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { MANIFEST_KIND, PROTOCOL, WELL_KNOWN, manifestSchema } from 'kehikot-module-protocol'
import { bundleArchiveName, bundleRunScript, checksumLine, readBundleInfo, sha256, unpackBundle, writeTarGz } from 'kehikot-module-protocol/bundle'
import { inModulePorts, portOf } from 'kehikot-module-protocol/serve'

import { bundleServe } from './fixtures/bundle-serve.mjs'
import { owns, bootHost, freePort, HOST, scratch, stop } from './scratch-host.mjs'

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

/** A server that answers its manifest and health, from one file with nothing to import, and registers where it bound. */
const working = (version) => bundleServe(manifest(version))
const broken = `throw new Error('this release was built wrong and cannot start')\n`

export async function rollbackDrive({ check = false } = {}) {
  const failures = []
  const expect = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
    if (!ok) failures.push(what)
  }
  const dir = owns(realpathSync(mkdtempSync(join(tmpdir(), 'rollback-'))))
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
    /* Where the module answers is its registration's to say: a bundle built against 2.65.0 or newer is
       started on a port the host hands, and writes where it bound there (`server/anyPort.ts`). */
    const registered = () => {
      try {
        return JSON.parse(readFileSync(join(scratch.root, 'modules', `${ID}.json`), 'utf8')).url ?? null
      } catch {
        return null
      }
    }
    const manifestNow = async () => {
      try {
        return await (await fetch(`${registered()}${WELL_KNOWN}`)).json()
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
    const handed = portOf(registered() ?? '')
    expect(handed !== port && handed !== null && inModulePorts(handed), `it was started on a port the host handed, of the module band, and registered it (${registered()}; its list port ${port})`)

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

    /* ---- A module that is idle when it is updated, and fails at its first start ---------------------
     * Stopped, then 1.2.0 (whose server throws) is published and found: it is put in place while the
     * module is stopped, and nothing has started it. The press on Start is its first start: it does not
     * answer, so the host puts 1.0.0 back, starts it, and says so in the Inbox (`bringUp`'s rollback). */
    releases['v1.2.0'] = bundleOf('1.2.0', broken)
    git('tag', '-a', 'v1.2.0', '-m', 'v1.2.0')
    git('push', '-q', origin, '--tags')
    const stopped = await post('/host/stop-module', { module: ID })
    expect(stopped.ok, `the module is stopped (${stopped.status})`)
    expect(Boolean(await until('it no longer answers', async () => (await manifestNow()) === null, 30_000).catch(() => false)), 'nothing answers while it is stopped')
    const askedBefore = asked.length
    await (await fetch(`${api}/host/updates?fetch=1`, { headers })).json()
    const placed = await until('1.2.0 is put in place while stopped', async () => readBundleInfo(installed)?.version === '1.2.0', 60_000).catch(() => false)
    expect(Boolean(placed), 'the check puts 1.2.0 in place while the module is stopped')
    expect(asked.slice(askedBefore).some((url) => url.includes('/releases/download/v1.2.0/')), 'the 1.2.0 bundle was downloaded')
    expect(await manifestNow() === null, 'and nothing has started it: it still does not answer')
    const firstStart = await post('/host/start', { module: ID })
    expect(Boolean(firstStart), `the first start is pressed (${firstStart.status})`)
    const idleRolled = await until('the first start rolls back', async () => /did not answer at its first start; rolled back/.test(apiLog()), 90_000).catch(() => false)
    expect(Boolean(idleRolled), 'the host says the first start did not answer and rolled back')
    expect(readBundleInfo(installed)?.version === '1.0.0', 'the installed copy is the 1.0.0 bundle again')
    expect(Boolean(await until('1.0.0 answers after the first start', async () => (await manifestNow())?.version === '1.0.0', 60_000).catch(() => false)), 'the module answers, as 1.0.0')
    await until('the Inbox says the first start did not start', async () => /1\.2\.0 did not start, so it was put back on 1\.0\.0/.test(await inboxNow()), 30_000).catch(() => false)
    expect(/1\.2\.0 did not start, so it was put back on 1\.0\.0/.test(await inboxNow()), 'the Inbox says 1.2.0 did not start and 1.0.0 is back')
    if (!failures.length) console.log('the idle rollback held: an update that landed while it was stopped was put back at its first start')

    /* ---- A container pinned to an older bundled version runs beside the current one ---------------------
     * 1.3.0 is published and becomes the current version (the registered module, where it registered); a
     * container on a kehikko is pinned to v1.0.0, which the host takes from the release's bundle (the
     * installed copy has no git history to check out) and runs on a port of its own, beside it. */
    releases['v1.3.0'] = bundleOf('1.3.0', working('1.3.0'))
    git('tag', '-a', 'v1.3.0', '-m', 'v1.3.0')
    git('push', '-q', origin, '--tags')
    await (await fetch(`${api}/host/updates?fetch=1`, { headers })).json()
    expect(Boolean(await until('1.3.0 is the current version', async () => (await manifestNow())?.version === '1.3.0', 90_000).catch(() => false)), 'the update to 1.3.0 is the current version, where its registration says')
    const canvasesNow = (await (await fetch(`${api}/host/canvases`, { headers })).json()).canvases
    const kehikko = canvasesNow[0]
    const placed2 = await fetch(`${api}/host/canvases/${kehikko.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ placements: [...kehikko.placements, { i: ID, x: 0, y: 56, w: 12, h: 20 }] }),
    })
    expect(placed2.ok, `a container of the module is on the kehikko (${placed2.status})`)
    const pinned = await post('/host/versions', { module: ID, kehikko: kehikko.id, version: 'v1.0.0' })
    const pinnedBody = await pinned.json()
    expect(pinned.ok, `the container is pinned to v1.0.0 (${pinned.status} ${JSON.stringify(pinnedBody).slice(0, 200)})`)
    const listing = async () => (await (await fetch(`${api}/host/versions?module=${ID}&kehikko=${kehikko.id}`, { headers })).json())
    const running = await until('the pinned version runs', async () => (await listing()).versions?.find((one) => one.tag === 'v1.0.0' && one.running), 90_000).catch(() => null)
    expect(Boolean(running), 'v1.0.0 is running for the pinned container')
    const modulesNow = async () => (await (await fetch(`${api}/host/modules`, { headers })).json())
    const view = await until('the pinned version is read, ready', async () => (await modulesNow()).pins?.find((one) => one.module === ID && one.version === 'v1.0.0' && one.state === 'ready'), 60_000).catch(() => null)
    expect(Boolean(view), 'the pinned version answers, and the host has read it')
    const pinnedAt = view?.presence?.at ?? ''
    expect(view?.presence?.module?.version === '1.0.0', `the pinned container's module says it is 1.0.0 (${view?.presence?.module?.version})`)
    const moduleAt = registered()
    expect(pinnedAt !== '' && moduleAt !== null && pinnedAt !== moduleAt, `it runs on a port of its own (${pinnedAt}), not the module's (${moduleAt}), and did not take the module's registration`)
    /* Beside, at the same moment: the current version still answers on its own port, and the pinned one on its. */
    const current = await manifestNow()
    const beside = await fetch(`${pinnedAt}${WELL_KNOWN}`).then((one) => one.json()).catch(() => null)
    expect(current?.version === '1.3.0' && beside?.version === '1.0.0', `both answer at once: current ${current?.version}, pinned ${beside?.version}`)
    expect(readBundleInfo(installed)?.version === '1.3.0', 'the installed copy is still the 1.3.0 bundle')
    /* From the bundle: the version's folder is an unpacked bundle of 1.0.0, not a git checkout. */
    const unpacked = readdirSync(join(scratch.root, 'versions'), { recursive: true }).map(String).filter((one) => one.endsWith('bundle.json'))
    const fromBundle = unpacked.some((one) => readBundleInfo(join(scratch.root, 'versions', dirname(one)))?.version === '1.0.0')
    expect(fromBundle, `the pinned version was unpacked from its release bundle (${unpacked.join(', ')})`)
    expect(asked.some((url) => url.includes('/releases/download/v1.0.0/') && url.endsWith('.tar.gz')), 'its bundle was fetched from the release')
    if (!failures.length) console.log('the pinned version ran beside the current one, from its bundle')
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
