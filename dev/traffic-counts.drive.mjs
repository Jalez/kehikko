/*
 * How many calls the host makes and receives while pages are open, read from its own record of
 * traffic (`traffic.read`, the Monitor's door) on a scratch host (`dev/scratch-host.mjs`): three
 * stand-in modules, each a checkout with a scratch remote, and PAGES pages in Chromium for
 * DURATION_MS. Nothing of the person's machine is touched: HOME and every `KEHIKOT_*` location are
 * scratch, the official list is off, every GitHub remote is rewritten to a local bare repository
 * (`url.<scratch>.insteadOf` in the scratch HOME's git config) and https goes to a proxy that is
 * not there, so nothing leaves this computer.
 *
 *     node dev/traffic-counts.drive.mjs                       # 2 pages, 2 minutes, the tables
 *     PAGES=1 DURATION_MS=20000 CHECK=1 node dev/traffic-counts.drive.mjs   # what `bun test` runs
 *     MARKDOWN=1 node dev/traffic-counts.drive.mjs            # the tables as Markdown
 *
 * Before the count, one page is opened and closed so a fresh host's first-run questions are
 * answered; what is counted is pages loading on a host that has been used.
 *
 * With CHECK=1 it fails when a page load asks one of the host's page endpoints more than once (or
 * more than the `LOAD_ONCE` allowance, with its reason), when a module's manifest is fetched for the
 * page's own reports, or when the automatic update check runs `git fetch`.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { bootHost, HOST, scratch, stop } from './scratch-host.mjs'

const pw = await import('playwright-core')
const PAGES = Number(process.env.PAGES ?? 2)
const DURATION_MS = Number(process.env.DURATION_MS ?? 120_000)
const CHECK = process.env.CHECK === '1'
const MARKDOWN = process.env.MARKDOWN === '1'
/* What a page load is: the first this many ms after a page is opened. */
const LOAD_MS = Number(process.env.LOAD_MS ?? 15_000)
const MANIFEST = '/.well-known/kehikot-module.json'

/* What a load may ask, per page: once each, or `most` with the reason. */
const LOAD_ONCE = [
  ['GET', '/host/health'],
  ['GET', '/host/modules'],
  ['GET', '/host/settings'],
  ['GET', '/host/onboarding'],
  ['GET', '/host/whats-new'],
  ['GET', '/host/canvases'],
  ['GET', '/host/watch'],
  ['POST', '/host/open'],
  ['POST', '/host/headers'],
  ['GET', '/host/inbox', 2, 'one per project, and the scratch host has two'],
]

const failures = []
const say = (line) => console.log(line)

/* ------------------------------------------------------------------ scratch git */

/** A checkout for each stand-in, with a bare `origin`, so an update check has repositories to ask. */
function scratchGit(root, names) {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, HOME: join(root, 'home'), GIT_TERMINAL_PROMPT: '0' } })
  const remotes = join(root, 'remotes')
  mkdirSync(remotes, { recursive: true })
  /* The host's own checkout's remote (GitHub) points at a bare copy of it here, by its own objects. */
  mkdirSync(join(remotes, 'Jalez'), { recursive: true })
  execFileSync('git', ['clone', '--quiet', '--bare', '--shared', HOST, join(remotes, 'Jalez/kehikko.git')], { stdio: 'pipe' })
  writeFileSync(
    join(root, 'home/.gitconfig'),
    [
      '[user]', '\tname = Scratch', '\temail = scratch@example.invalid',
      `[url "file://${remotes}/"]`, '\tinsteadOf = git@github.com:', '\tinsteadOf = https://github.com/', '\tinsteadOf = ssh://git@github.com/',
      '',
    ].join('\n'),
  )
  const dirs = {}
  for (const name of names) {
    const bare = join(remotes, `${name}.git`)
    const dir = join(root, 'checkouts', name)
    mkdirSync(dir, { recursive: true })
    git(remotes, 'init', '--quiet', '--bare', '-b', 'main', bare)
    git(dir, 'init', '--quiet', '-b', 'main')
    writeFileSync(join(dir, 'README.md'), `${name}\n`)
    git(dir, 'add', '.')
    git(dir, 'commit', '--quiet', '-m', 'first')
    git(dir, 'remote', 'add', 'origin', bare)
    git(dir, 'push', '--quiet', '-u', 'origin', 'main')
    dirs[name] = dir
  }
  return dirs
}

/* ------------------------------------------------------------------ reading the record */

let since = 0
const rows = []
async function readRecord(gammaPort) {
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${gammaPort}/traffic?since=${since}`)
    const read = await response.json()
    if (!read.ok) throw new Error(`traffic.read: ${read.why}`)
    if (read.data.gap) failures.push(`the record dropped rows between ${since} and ${read.data.oldest}`)
    rows.push(...read.data.calls)
    since = read.data.calls.length ? read.data.calls[read.data.calls.length - 1].seq : read.data.newest
    if (read.data.calls.length < 5000) return
  }
}

/* ------------------------------------------------------------------ tables */

const count = (list, key) => {
  const out = new Map()
  for (const one of list) out.set(key(one), (out.get(key(one)) ?? 0) + 1)
  return [...out.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
}
function table(title, head, body) {
  say('')
  if (MARKDOWN) {
    say(`**${title}**`)
    say('')
    say(`| ${head.join(' | ')} |`)
    say(`|${head.map((_, i) => (i === 0 ? ' --- ' : ' ---: ')).join('|')}|`)
    for (const row of body) say(`| ${row.join(' | ')} |`)
  } else {
    say(title)
    const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => String(row[i]).length)))
    say(`  ${head.map((h, i) => h.padEnd(widths[i])).join('  ')}`)
    for (const row of body) say(`  ${row.map((cell, i) => (i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i]))).join('  ')}`)
  }
}
const route = (row) => `${row.kind} ${row.path.split('?')[0]}${row.path.includes('fetch=1') ? '?fetch=1' : ''}`

/* ------------------------------------------------------------------ run */

let browser
try {
  /* Nothing over https leaves this computer: it goes to a proxy that is not there. */
  const page = await bootHost('traffic-counts', {
    traffic: true,
    env: { HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  })
  const dirs = scratchGit(scratch.root, scratch.modules.map((one) => one.name))
  /* The stand-ins are checkouts now: registered with their folders, kept, so nothing restarts them. */
  for (const one of scratch.modules) {
    writeFileSync(join(scratch.root, `modules/${one.id}.json`), JSON.stringify({ url: `http://127.0.0.1:${one.port}`, keep: true, dir: dirs[one.name] }))
  }
  const gamma = scratch.modules.find((one) => one.id === 'kehikot.gamma').port

  browser = await pw.chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  /* Nothing is asked of GitHub's release list for the What's new notice: it would go nowhere anyway. */
  await context.route((url) => url.pathname === '/host/releases', (r) => r.fulfill({ status: 503, body: '{}' }))
  context.on('page', (one) => one.on('pageerror', (error) => failures.push(`the page threw: ${error.message}`)))

  /* A host that has been used: the first-run questions answered on a page that is then closed. */
  {
    const first = await context.newPage()
    await first.goto(page, { waitUntil: 'domcontentloaded' })
    await first.waitForSelector('[data-frame]', { state: 'attached', timeout: 30_000 })
    for (let tries = 0; tries < 8; tries += 1) {
      await first.waitForTimeout(400)
      if (!(await first.locator('[role="dialog"]').count())) break
      const myself = first.locator('[role="dialog"] button', { hasText: 'do it myself' })
      if (await myself.count()) await myself.first().click()
      else await first.keyboard.press('Escape')
    }
    await first.close()
    await new Promise((done) => setTimeout(done, 2_000))
  }

  await readRecord(gamma)
  rows.length = 0
  const opened = []
  const startAt = Date.now()
  for (let n = 0; n < PAGES; n += 1) {
    const one = await context.newPage()
    opened.push(Date.now())
    await one.goto(page, { waitUntil: 'domcontentloaded' })
    if (n + 1 < PAGES) await one.waitForTimeout(3_000)
  }
  say(`${PAGES} page(s) open on a scratch host with 3 stand-in modules; counting for ${Math.round(DURATION_MS / 1000)} s`)
  while (Date.now() - startAt < DURATION_MS) {
    await new Promise((done) => setTimeout(done, Math.min(5_000, DURATION_MS - (Date.now() - startAt))))
    await readRecord(gamma)
  }
  await readRecord(gamma)
  const counted = rows.filter((row) => row.at >= startAt)

  const fromPage = counted.filter((row) => row.side === 'in' && row.by === 'kehikko' && row.via === 'page')
  const inLoad = (row) => opened.some((at) => row.at >= at && row.at < at + LOAD_MS)
  const loads = fromPage.filter(inLoad)
  const hostOut = counted.filter((row) => row.side === 'out' && row.by === 'kehikko')
  const manifests = hostOut.filter((row) => row.path === MANIFEST)

  say(`\n${counted.length} rows in ${Math.round(DURATION_MS / 1000)} s: ${fromPage.length} asked by the page, ${hostOut.length} made by the host (${manifests.length} manifests)`)

  table(
    `The page's requests (all ${Math.round(DURATION_MS / 1000)} s, and in the first ${LOAD_MS / 1000} s of each of the ${PAGES} loads)`,
    ['request', 'total', 'in loads'],
    count(fromPage, route).map(([key, n]) => [key, n, loads.filter((row) => route(row) === key).length]),
  )
  table(
    'Manifests fetched by the host, by reason',
    ['reason', 'fetches'],
    count(manifests, (row) => row.reason ?? 'no reason given'),
  )
  table(
    "The host's other calls out",
    ['call', 'reason', 'n'],
    count(hostOut.filter((row) => row.path !== MANIFEST), (row) => `${row.kind} ${row.host}${row.path.split('?')[0]}\u0000${row.reason ?? 'no reason given'}`).map(([key, n]) => [...key.split('\u0000'), n]),
  )
  table('Every row, by reason', ['reason', 'rows'], count(counted, (row) => `${row.side} · ${row.reason ?? 'no reason given'}`))
  const repeats = count(loads, route).filter(([, n]) => n > PAGES)
  table(`Repeats within the loads (more than once per page)`, ['request', 'in loads', 'per page'], repeats.map(([key, n]) => [key, n, (n / PAGES).toFixed(1)]))

  if (CHECK) {
    for (const [kind, path, most = 1, why] of LOAD_ONCE) {
      const n = loads.filter((row) => row.kind === kind && row.path.split('?')[0] === path).length
      const allowed = most * PAGES
      if (n > allowed) failures.push(`${kind} ${path} was asked ${n} times in ${PAGES} page load(s); at most ${allowed}${why ? ` (${why})` : ''}`)
      else say(`  ok   ${kind} ${path}: ${n} in ${PAGES} load(s)${why ? ` — at most ${most} each: ${why}` : ''}`)
    }
    const forReports = manifests.filter((row) => row.reason === 'the page says what it has open' || row.reason === 'the page waits for news')
    if (forReports.length > 0) failures.push(`${forReports.length} manifest fetches were made for the page's own reports (/host/open, /host/watch); they read the cache`)
    else say('  ok   no manifest fetched for /host/open or /host/watch')
    const fetched = hostOut.filter((row) => row.kind === 'git fetch')
    if (fetched.length > 0) failures.push(`the automatic update check ran git fetch ${fetched.length} time(s); it compares with ls-remote`)
    else say('  ok   no git fetch on the automatic update check')
  }
} catch (error) {
  failures.push(`the drive failed: ${error?.stack ?? error}`)
} finally {
  await browser?.close().catch(() => {})
  stop()
}

if (failures.length) {
  say('\nFAILED')
  for (const line of failures) say(`  ${line}`)
  process.exit(1)
}
say('\nthe counts were read from the record of traffic')
