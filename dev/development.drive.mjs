/*
 * "Kehikko development", on a scratch host running the REAL host code (`server/server.ts`), with real
 * bundles of modules on the official list, released on a fake GitHub:
 *
 *   1. Two official modules are registered from the person's own folders (checkouts, as `bun run
 *      register` leaves them) and running from there. The host's first start makes development ON,
 *      so nothing moves, and says so once in the Inbox.
 *   2. The person turns development off. Sample's release bundle is downloaded and unpacked into
 *      `installed/`, its registration is pointed there, and it answers as its release. Broken's
 *      release does not start: its registration is put back word for word and it runs from the
 *      person's folder again. The summary says which folder Kehikot no longer uses.
 *   3. Development on again: Sample runs from the person's folder. "Use the release for this one":
 *      back on its release.
 *   Neither folder is changed in any way (every file's bytes, mode and time).
 *
 *   4. With `CLAUDE_BUNDLE=<kehikot.claude-x.y.z.tar.gz>` and `CLAUDE_CHECKOUT=<a clone>`: the REAL
 *      Claude module, registered from the clone, whose session hook in the scratch Claude Code
 *      settings names the clone (as a press from there wrote it). Turned off, Claude runs from its
 *      bundle, and once it has started the hook names the installed copy, and nothing in the scratch
 *      Claude Code config names the clone any more.
 *
 * Nothing leaves this machine: every `KEHIKOT_*` location, `HOME` and `CLAUDE_CONFIG_DIR` is a scratch
 * directory, every `https://` request goes to the fake GitHub below (`dev/fixtures/https-shim.ts`),
 * `git` is pointed at local repositories for the modules' tags, and the list is served by the fake.
 *
 *     node dev/development.drive.mjs           # prints what happened
 *     CHECK=1 node dev/development.drive.mjs   # what `bun test` runs: fails when anything did not hold
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'

import { MANIFEST_KIND, PROTOCOL, WELL_KNOWN, manifestSchema } from 'kehikot-module-protocol'
import { bundleArchiveName, bundleRunScript, checksumLine, readBundleInfo, sha256, writeTarGz } from 'kehikot-module-protocol/bundle'
import { inModulePorts, portOf } from 'kehikot-module-protocol/serve'

import { bundleServe } from './fixtures/bundle-serve.mjs'
import { owns, bootHost, freePort, HOST, scratch, stop } from './scratch-host.mjs'

const text = (value) => new TextEncoder().encode(value)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const manifest = (id, name, version) =>
  manifestSchema.parse({
    kind: MANIFEST_KIND, protocol: PROTOCOL, id, name, version, dataVersion: 1, summary: `${name}.`, tags: [],
    guidance: name, entry: '/app', modes: [{ id: 'main', label: name, scope: 'epic' }],
    extensions: { emits: [], consumes: [] }, reacts: [], partless: `${name}: it holds nothing of a part.`,
    declares: { protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`, uses: [], storage: true, prompt: false }, health: '/healthz',
  })

/** A server that answers its manifest and health, from one file with nothing to import, and registers where it bound. */
const working = (id, name, version) => bundleServe(manifest(id, name, version), name)
const broken = `throw new Error('this release was built wrong and cannot start')\n`

/** A bundle as `kehikot-bundle` writes one: `serve.ts`, `run.sh`, `bundle.json` listing both. */
function bundleOf(id, version, serve) {
  const base = { id, version, commit: version.replaceAll('.', '').padEnd(40, 'a'), entry: 'serve.ts' }
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

/** A person's checkout: a git repository of the module's own, a run.sh, and work they have not committed. */
function checkoutOf(dir, repo, serve) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'serve.ts'), serve)
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\nexec bun serve.ts\n', { mode: 0o755 })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: basename(repo), version: '0.0.0-dev', private: true }))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `git@github.com:${repo}.git`])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.invalid', 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.invalid', 'commit', '-q', '-m', 'mine'])
  writeFileSync(join(dir, 'unsaved-work.ts'), 'export const draft = 1\n')
  return dir
}

/** Every file under a folder with its bytes, mode and time, and every folder: what "never touched" is checked against. */
function fingerprint(dir) {
  const out = new Map()
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      const info = statSync(path)
      /* A folder by its mode alone: its time moves when a file inside appears and goes again (git's own lock while
         something reads the repository), and every file in it is compared by itself. */
      /* Installed dependencies are the start of a checkout by `run.sh`, not the person's files. */
      if (name === 'node_modules' && at === dir) continue
      if (info.isDirectory()) out.set(relative(dir, path), `${info.mode}`)
      else out.set(relative(dir, path), `${info.mode}:${info.mtimeMs}:${info.size}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
      if (info.isDirectory()) walk(path)
    }
  }
  walk(dir)
  return out
}
/** What differs between two fingerprints, by path; empty when nothing does. */
function changedIn(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path))
}

/** Every file under a folder whose text names `needle`. */
function naming(dir, needle) {
  const out = []
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      const info = statSync(path)
      if (info.isDirectory()) walk(path)
      else if (info.size < 4_000_000 && readFileSync(path, 'utf8').includes(needle)) out.push(path)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

export async function developmentDrive({ check = false } = {}) {
  const failures = []
  const expect = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
    if (!ok) failures.push(what)
  }
  const claudeBundle = process.env.CLAUDE_BUNDLE ? realpathSync(process.env.CLAUDE_BUNDLE) : null
  const claudeSource = process.env.CLAUDE_CHECKOUT ? realpathSync(process.env.CLAUDE_CHECKOUT) : null
  const withClaude = Boolean(claudeBundle && claudeSource)
  const dir = owns(realpathSync(mkdtempSync(join(tmpdir(), 'development-'))))
  try {
    const sample = { id: 'kehikot.sample', name: 'Sample', repo: 'Jalez/kehikko-sample' }
    const brokenOne = { id: 'kehikot.broken', name: 'Broken', repo: 'Jalez/kehikko-broken' }
    const releases = {
      [sample.repo]: { id: sample.id, tag: 'v1.0.0', archive: bundleOf(sample.id, '1.0.0', working(sample.id, sample.name, '1.0.0')), pkg: { dependencies: { 'kehikot-module-protocol': 'git+https://x#v2.102.0' } } },
      [brokenOne.repo]: { id: brokenOne.id, tag: 'v1.0.0', archive: bundleOf(brokenOne.id, '1.0.0', broken), pkg: { dependencies: { 'kehikot-module-protocol': 'git+https://x#v2.102.0' } } },
    }
    let claudeVersion = null
    if (withClaude) {
      const archive = readFileSync(claudeBundle)
      claudeVersion = /kehikot\.claude-(\d+\.\d+\.\d+)\.tar\.gz$/.exec(claudeBundle)?.[1]
      if (!claudeVersion) throw new Error(`${claudeBundle} is not named as a Claude bundle is`)
      releases['Jalez/kehikko-claude'] = { id: 'kehikot.claude', tag: `v${claudeVersion}`, archive, pkg: JSON.parse(readFileSync(join(claudeSource, 'package.json'), 'utf8')) }
    }

    /* The fake GitHub: the module list, release files and each release's package.json. */
    const listed = [
      { ...sample, port: 7700, summary: 'A sample.', tags: [] },
      { ...brokenOne, port: 7710, summary: 'A sample whose release does not start.', tags: [] },
    ]
    const asked = []
    const github = createServer((request, response) => {
      asked.push(request.url)
      if (request.url === '/list/modules.json') return void response.end(JSON.stringify({ modules: listed }))
      const download = /^\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/(v[\d.]+)\/(.+)$/.exec(request.url)
      const release = download ? releases[download[1]] : null
      if (release && download[2] === release.tag) {
        const name = bundleArchiveName(release.id, release.tag.slice(1))
        if (download[3] === name) return void response.end(Buffer.from(release.archive))
        if (download[3] === `${name}.sha256`) return void response.end(checksumLine(release.archive, name))
      }
      const raw = /^\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/(v[\d.]+)\/package\.json$/.exec(request.url)
      if (raw && releases[raw[1]]?.tag === raw[2]) return void response.end(JSON.stringify(releases[raw[1]].pkg))
      response.statusCode = 404
      response.end('not found')
    })
    const githubPort = await freePort()
    await new Promise((done) => github.listen(githubPort, '127.0.0.1', done))

    /* Each module's tags, from a local repository `git` is told is github.com/<repo>. */
    let gitconfig = ''
    for (const [repo, release] of Object.entries(releases)) {
      const origin = join(dir, `${basename(repo)}.git`)
      const work = join(dir, `${basename(repo)}-tags`)
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
      execFileSync('git', ['init', '-q', '-b', 'main', work])
      const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.invalid', ...args], { stdio: 'pipe' })
      writeFileSync(join(work, 'README.md'), `${repo}\n`)
      git('add', '.')
      git('commit', '-q', '-m', 'release')
      git('tag', '-a', release.tag, '-m', release.tag)
      git('push', '-q', origin, 'main', '--tags')
      gitconfig += `[url "${origin}"]\n\tinsteadOf = https://github.com/${repo}.git\n`
    }
    writeFileSync(join(dir, 'gitconfig'), gitconfig)

    /* The person's folders: checkouts that run, with work in them. */
    const folders = join(dir, 'Projects')
    const sampleFolder = checkoutOf(join(folders, 'kehikko-sample'), sample.repo, working(sample.id, sample.name, '0.0.0-dev'))
    const brokenFolder = checkoutOf(join(folders, 'kehikko-broken'), brokenOne.repo, working(brokenOne.id, brokenOne.name, '0.0.0-dev'))
    let claudeFolder = null
    if (withClaude) {
      claudeFolder = join(folders, 'kehikko-claude')
      execFileSync('git', ['clone', '-q', claudeSource, claudeFolder])
      execFileSync('git', ['-C', claudeFolder, 'remote', 'set-url', 'origin', 'git@github.com:Jalez/kehikko-claude.git'])
    }
    const ports = { sample: await freePort(), broken: await freePort(), claude: await freePort() }

    const pageUrl = await bootHost('development', {
      env: {
        KEHIKOT_ONBOARDING: 'off',
        KEHIKOT_OFFICIAL_LIST: `http://127.0.0.1:${githubPort}/list/modules.json`,
        KEHIKOT_SHIM_HTTPS: `http://127.0.0.1:${githubPort}`,
        BUN_OPTIONS: `--preload=${join(HOST, 'dev/fixtures/https-shim.ts')}`,
        GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
      },
      before: async ({ root }) => {
        writeFileSync(join(root, 'modules', `${sample.id}.json`), JSON.stringify({ url: `http://127.0.0.1:${ports.sample}`, dir: sampleFolder }))
        writeFileSync(join(root, 'modules', `${brokenOne.id}.json`), JSON.stringify({ url: `http://127.0.0.1:${ports.broken}`, dir: brokenFolder }))
        if (claudeFolder) {
          writeFileSync(join(root, 'modules', 'kehikot.claude.json'), JSON.stringify({ url: `http://127.0.0.1:${ports.claude}`, dir: claudeFolder, keep: true }))
          /* The hook a press of "Report sessions started outside Kehikot" wrote while Claude ran from the clone: the module's own command, from there. */
          const command = execFileSync(process.env.BUN ?? 'bun', ['-e', `import { hookCommand } from ${JSON.stringify(join(claudeSource, 'hook.ts'))}; console.log(hookCommand(${JSON.stringify(claudeFolder)}, ${JSON.stringify(join(root, 'modules'))}))`], { cwd: claudeSource, encoding: 'utf8' }).trim()
          writeFileSync(join(root, 'claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] } }, null, 2))
        }
      },
    })
    const api = `http://127.0.0.1:${scratch.api}`
    const headers = { origin: new URL(pageUrl).origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
    const post = (path, body) => fetch(`${api}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const state = async () => (await fetch(`${api}/host/development`, { headers })).json()
    /* Where a module answers is its registration's to say: a release bundle built against 2.65.0 or
       newer is started on a port the host hands and writes where it bound there (`server/anyPort.ts`),
       and a folder started after it keeps that address. */
    const urlOf = (id) => {
      try {
        return JSON.parse(readFileSync(join(scratch.root, 'modules', `${id}.json`), 'utf8')).url ?? null
      } catch {
        return null
      }
    }
    const versionAt = async (id) => {
      try {
        return (await (await fetch(`${urlOf(id)}${WELL_KNOWN}`)).json()).version
      } catch {
        return null
      }
    }
    /* The pid listening where a module's registration says. */
    const listenerOf = (id) => execFileSync('lsof', ['-ti', `tcp:${portOf(urlOf(id) ?? '')}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]
    const until = async (what, test, ms = 60_000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const got = await test()
        if (got) return got
        await sleep(300)
      }
      throw new Error(`nothing: ${what}`)
    }
    const registration = (id) => JSON.parse(readFileSync(join(scratch.root, 'modules', `${id}.json`), 'utf8'))
    const installed = (id) => join(scratch.root, 'installed', id)
    const settled = () => until('the move ends', async () => ((await state()).moving ? null : await state()), 240_000)
    const project = async () => (await (await fetch(`${api}/host/canvases`, { headers })).json()).projects[0].id
    const inboxNow = async () => (await fetch(`${api}/host/inbox/log?project=${await project()}&limit=40`, { headers })).text()

    /* ---- 1. The first start: modules on the person's folders, so development starts on ---------- */
    const first = await until('the setting is made', async () => {
      const read = await state()
      return read.modules.length >= 2 ? read : null
    })
    const count = withClaude ? 3 : 2
    expect(first.on === true, `development starts on, because ${count} official modules run from your folders (${first.on})`)
    expect(first.modules.every((one) => one.runs.from === 'folder' && one.wants === 'folder'), 'each runs from, and wants, its folder: nothing moves')
    await until('the Inbox is told', async () => /Kehikko development is on because/.test(await inboxNow()), 30_000).catch(() => false)
    const inboxFirst = await inboxNow()
    expect(new RegExp(`Kehikko development is on because ${count} modules run from your own folders`).test(inboxFirst), 'one Inbox line says why, and how to turn it off')
    for (const one of [sample, brokenOne]) {
      const started = await post('/host/start', { module: one.id })
      expect(started.ok, `${one.name} starts from the person's folder (${started.status})`)
    }
    expect((await until('Sample answers from the folder', async () => (await versionAt(sample.id)) === '0.0.0-dev')) === true, 'Sample answers as the folder’s version')
    expect((await until('Broken answers from the folder', async () => (await versionAt(brokenOne.id)) === '0.0.0-dev')) === true, 'Broken answers as the folder’s version')

    /* Claude, set to keep running, runs from the clone: Kehikot must not stop it to move it. */
    if (withClaude) {
      const started = await post('/host/start', { module: 'kehikot.claude' })
      expect(started.ok, `Claude (set to keep running) starts from the clone (${started.status})`)
      expect(Boolean(await until('Claude answers from the clone', async () => (await versionAt('kehikot.claude')) !== null, 240_000).catch(() => false)), 'and answers')
    }

    /* The folders as the person has them, with their modules running from them: what the switches below must leave exactly so. */
    const before = { sample: fingerprint(sampleFolder), broken: fingerprint(brokenFolder), ...(claudeFolder ? { claude: fingerprint(claudeFolder) } : {}) }

    /* ---- 2. Development off: everything to its release, one failure put back ---------------------- */
    const turned = await post('/host/development', { on: false })
    expect(turned.ok, `the switch is turned off (${turned.status})`)
    const off = await settled()
    const row = (read, id) => read.modules.find((one) => one.id === id)
    expect(registration(sample.id).dir === installed(sample.id), `Sample's registration names its installed copy (${registration(sample.id).dir})`)
    const releaseAt = portOf(registration(sample.id).url)
    expect(releaseAt !== null && releaseAt !== ports.sample && inModulePorts(releaseAt), `and names the port the host handed its release, of the module band (${registration(sample.id).url}; the folder's was ${ports.sample})`)
    expect(readBundleInfo(installed(sample.id))?.version === '1.0.0', 'the installed copy is its 1.0.0 release bundle')
    expect(asked.some((url) => url.includes('/kehikko-sample/releases/download/v1.0.0/')), 'the bundle was downloaded from the release')
    expect((await until('Sample answers as its release', async () => (await versionAt(sample.id)) === '1.0.0').catch(() => false)) === true, 'Sample answers as its release, 1.0.0')
    expect(row(off, sample.id)?.move?.step === 'done' && row(off, sample.id)?.runs?.from === 'release', 'its line says it moved, and runs from its release')
    expect(registration(brokenOne.id).dir === brokenFolder, `Broken's release did not start, so its registration names the folder again (${registration(brokenOne.id).dir})`)
    expect(row(off, brokenOne.id)?.move?.step === 'restored', `its line says it was put back (${row(off, brokenOne.id)?.move?.why})`)
    expect((await until('Broken answers from the folder again', async () => (await versionAt(brokenOne.id)) === '0.0.0-dev').catch(() => false)) === true, 'Broken runs from the folder again')
    expect(/Your folder .*kehikko-sample is no longer used by Kehikot|kehikko-sample/.test(off.summary ?? '') && !/kehikko-broken[,.]/.test((off.summary ?? '').split('no longer used')[1] ?? ''), `the summary names the folder no longer used (${off.summary})`)
    expect(/Broken did not start from/.test(off.summary ?? '') || /Broken[^.]*did not move/.test(off.summary ?? ''), 'and the one that did not move')
    if (withClaude) {
      expect(/Claude did not move yet: it is set to keep running/.test(off.summary ?? '') && /Move now/.test(off.summary ?? ''), `and Claude, which keeps running: why, and when it moves (${off.summary})`)
      expect(/ 2 did not move\./.test(` ${off.summary ?? ''}`), 'with both counted')
    }
    await until('the Inbox has the summary', async () => /now runs? from Kehikot’s releases/.test(await inboxNow()), 30_000).catch(() => false)
    expect(/now runs? from Kehikot’s releases/.test(await inboxNow()), 'the summary is in the Inbox')
    if (withClaude) {
      const told = await inboxNow()
      expect(/Claude did not move yet/.test(told) && /Move now/.test(told), 'and so is the line about Claude, whole (the Inbox once cut the end of the summary off)')
      expect(/Broken/.test(told) && /did not move/.test(told), 'and the line about Broken')
    }

    /* The folders Kehikot no longer uses are listed, each checked: Sample's has work not committed, so it is kept. Nothing is moved. */
    const unusedNow = await (await fetch(`${api}/host/unused-folders`, { headers })).json()
    const sampleListed = unusedNow.folders?.find((one) => one.dir === sampleFolder)
    expect(sampleListed?.trash === false && /uncommitted changes/.test(sampleListed?.why ?? ''), `the unused-folders list keeps Sample's folder, which has work not committed (${JSON.stringify(sampleListed)})`)
    expect(existsSync(sampleFolder), 'and moved nothing')
    const refusedTrash = await fetch(`${api}/host/unused-folders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trash: [sampleFolder] }) })
    expect(refusedTrash.status === 403 || refusedTrash.status === 400 || refusedTrash.status === 409, `a request that is not the page's is refused (${refusedTrash.status})`)

    /* ---- 4. The real Claude module, set to keep running: deferred, then "Move now", and its hook follows it --- */
    if (withClaude) {
      const claudeRow = row(off, 'kehikot.claude')
      expect(registration('kehikot.claude').dir === claudeFolder && registration('kehikot.claude').keep === true, `Claude, running and set to keep running, is not moved under itself (${registration('kehikot.claude').dir})`)
      expect(claudeRow?.move?.step === 'later' && claudeRow?.keeps === true, `its row says it moves at its next restart (${claudeRow?.move?.step}: ${claudeRow?.move?.why})`)
      expect((await versionAt('kehikot.claude')) !== null, 'and it is still running')
      const settings = join(scratch.root, 'claude', 'settings.json')
      const hookNow = () => JSON.parse(readFileSync(settings, 'utf8')).hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? ''
      expect(hookNow().includes(join(claudeFolder, 'started.sh')) || hookNow().includes(claudeFolder), 'its session hook still names the clone, which still runs')
      /* The person presses "Move now" (the page asks first). */
      const pressed = await post('/host/development', { module: 'kehikot.claude', move: true, now: true })
      expect(pressed.ok, `Move now on Claude (${pressed.status})`)
      const after4 = await settled()
      expect(registration('kehikot.claude').dir === installed('kehikot.claude') && registration('kehikot.claude').keep === true, `Claude's registration names its installed copy, and still says keep (${registration('kehikot.claude').dir}; ${row(after4, 'kehikot.claude')?.move?.why ?? ''})`)
      expect(row(after4, 'kehikot.claude')?.move?.step === 'done' && row(after4, 'kehikot.claude')?.runs?.from === 'release', 'its row says it moved, and runs from its release')
      expect(readBundleInfo(installed('kehikot.claude'))?.version === claudeVersion, `the installed copy is Claude's ${claudeVersion} bundle`)
      expect((await until('Claude answers as its release', async () => (await versionAt('kehikot.claude')) === claudeVersion, 90_000).catch(() => false)) === true, `Claude answers as ${claudeVersion}, from its bundle`)
      const followed = await until('the hook names the installed copy', async () => hookNow().includes(join(installed('kehikot.claude'), 'started.sh')), 60_000).catch(() => false)
      expect(Boolean(followed), `the session hook in Claude Code's settings is repaired, and runs the installed copy: ${hookNow()}`)
      expect(JSON.parse(readFileSync(settings, 'utf8')).model === 'opus', 'and the rest of the settings is as it was')
      const left = naming(join(scratch.root, 'claude'), claudeFolder)
      expect(left.length === 0, `nothing in the Claude Code config names the clone any more${left.length ? ` (${left.join(', ')})` : ''}`)
    } else console.log('(Claude left out: set CLAUDE_BUNDLE and CLAUDE_CHECKOUT to drive the real module)')

    /* ---- 3. On again, and "use the release for this one" ----------------------------------------- */
    /* Claude stays on its release from here ("use the release for this one", set while development is off): its clone has
       no dependencies, and running it from there would install them, which is the person's own development set-up. */
    if (withClaude) expect((await post('/host/development', { module: 'kehikot.claude', release: true })).ok, 'Claude is set to use its release even while development is on')
    await post('/host/development', { on: true })
    await settled()
    expect(registration(sample.id).dir === sampleFolder, 'development on: Sample runs from the person’s folder again')
    if (withClaude) expect(registration('kehikot.claude').dir === installed('kehikot.claude'), 'and Claude, set to use its release, stays on it')
    expect((await until('Sample answers from the folder again', async () => (await versionAt(sample.id)) === '0.0.0-dev').catch(() => false)) === true, 'and answers as the folder’s version')
    const one = await post('/host/development', { module: sample.id, release: true })
    expect(one.ok, `"Use the release for this one" (${one.status})`)
    const after = await settled()
    expect(registration(sample.id).dir === installed(sample.id) && row(after, sample.id)?.release === true, 'Sample runs from its release while development stays on')
    expect((await until('Sample answers as its release again', async () => (await versionAt(sample.id)) === '1.0.0').catch(() => false)) === true, 'and answers as 1.0.0')

    /* ---- 5. A module set to keep running moves by itself at its next restart --------------------- */
    const toFolder = await post('/host/development', { module: sample.id, release: false })
    expect(toFolder.ok, 'Sample is put back on the person’s folder')
    await settled()
    expect((await until('Sample answers from the folder', async () => (await versionAt(sample.id)) === '0.0.0-dev').catch(() => false)) === true, 'and runs from it')
    const sampleReg = registration(sample.id)
    writeFileSync(join(scratch.root, 'modules', `${sample.id}.json`), JSON.stringify({ ...sampleReg, keep: true }))
    await post('/host/development', { module: sample.id, release: true })
    const waiting = await settled()
    expect(registration(sample.id).dir === sampleFolder && row(waiting, sample.id)?.move?.step === 'later', `Sample, set to keep running, is not moved while it runs (${registration(sample.id).dir}; ${row(waiting, sample.id)?.move?.step})`)
    const listener = listenerOf(sample.id)
    process.kill(Number(listener), 'SIGTERM')
    expect((await until('Sample ends', async () => (await versionAt(sample.id)) === null, 30_000).catch(() => false)) === true, 'it ends (a restart, an update or a crash: the next start is its next restart)')
    const startedAgain = await post('/host/start', { module: sample.id })
    expect(startedAgain.ok, `Sample starts again (${startedAgain.status})`)
    await settled()
    expect(registration(sample.id).dir === installed(sample.id) && registration(sample.id).keep === true, `at that start it moved by itself, and still says keep (${registration(sample.id).dir})`)
    expect((await until('Sample answers as its release', async () => (await versionAt(sample.id)) === '1.0.0', 60_000).catch(() => false)) === true, 'and answers as its release, 1.0.0')
    expect(row(await state(), sample.id)?.move?.step === 'done', 'its row says it moved')
    expect(/Sample now runs|1 module now runs from Kehikot’s releases/.test(await inboxNow()), 'and the Inbox says so')

    /* ---- 6. A registration edited a moment before Start is read as it is -------------------------
       The host's last look at the registrations is a sweep old, and a sweep under load is later still:
       a start that judged by it owed no move to a module whose `keep` was just added (CI, once). */
    const again = listenerOf(sample.id)
    process.kill(Number(again), 'SIGTERM')
    writeFileSync(join(scratch.root, 'modules', `${sample.id}.json`), JSON.stringify({ url: `http://127.0.0.1:${ports.sample}`, dir: sampleFolder, keep: true }))
    expect((await post('/host/start', { module: sample.id })).ok, 'Sample is started the moment its registration says keep')
    await settled()
    expect(registration(sample.id).dir === installed(sample.id), `and that start moves it, from the registration as it is on disk (${registration(sample.id).dir})`)
    expect((await until('Sample answers as its release', async () => (await versionAt(sample.id)) === '1.0.0', 60_000).catch(() => false)) === true, 'and it answers as its release')

    const sampleChanged = changedIn(before.sample, fingerprint(sampleFolder))
    expect(!sampleChanged.length, `Sample’s folder is exactly as it was: every file, mode and time${sampleChanged.length ? ` (changed: ${sampleChanged.join(', ')})` : ''}`)
    const brokenChanged = changedIn(before.broken, fingerprint(brokenFolder))
    expect(!brokenChanged.length, `Broken’s folder is exactly as it was${brokenChanged.length ? ` (changed: ${brokenChanged.join(', ')})` : ''}`)
    if (claudeFolder) {
      const claudeChanged = changedIn(before.claude, fingerprint(claudeFolder))
      expect(!claudeChanged.length, `the Claude clone is exactly as it was${claudeChanged.length ? ` (changed: ${claudeChanged.join(', ')})` : ''}`)
    }
    if (failures.length) console.log(readFileSync(join(scratch.root, 'api.log'), 'utf8').split('\n').filter((line) => /development|now runs|registration was put back|not moved|kehikko:.*(sample|broken|claude)/i.test(line)).slice(-40).join('\n'))
    github.close()
  } finally {
    stop()
  }
  if (check && failures.length) {
    console.error(`Kehikko development did not hold: ${failures.join('; ')}`)
    process.exitCode = 1
  } else if (!failures.length) console.log(`Kehikko development held: modules moved between the person's folders and their releases, a failed one was put back, and no folder was touched${withClaude ? '; the real Claude module’s hook followed it to its installed copy' : ''}`)
  return failures
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('development.drive.mjs')) {
  await developmentDrive({ check: process.env.CHECK === '1' })
}
