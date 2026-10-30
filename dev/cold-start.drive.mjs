/*
 * What a COLD start costs: a scratch host (`dev/scratch-host.mjs`) started fresh with six modules it
 * starts itself — installed copies, as the app's are, so "Keep modules up to date automatically"
 * holds them back while it reads their tags — some of them slow to come up (`DELAYS`, seconds before
 * each one serves), and a page arriving at the kehikko that has them. Counted from the host's own
 * record of traffic (`traffic.read`, the Monitor's door) from the moment the host started until
 * WINDOW_MS after the page arrived. The record's reader stands in for a Monitor open from the start:
 * its first read is the host's first sweep, which finds every module not running yet.
 *
 * No browser: the page's start-up requests are made here the way `src/App.tsx` makes them, in its
 * order — its first look (`GET /host/modules`) beside its other first reads, then, once the kehikot
 * are read, the watch stream and the report of what it has open (`POST /host/open`, `arrive` in
 * `src/host/looks.ts`), a second look only when the report started something, and after that a
 * look only when the stream says so: `{ registry: true }` alone is "look again", and with `modules`
 * it carries the reading itself (`src/host/registry.ts`, `registryIn`), which is taken as a look's
 * answer. Nothing polls. `dev/cold-start-page.drive.mjs` is the same count with the real page, on bee.
 *
 *     node dev/cold-start.drive.mjs            # the counts
 *     CHECK=1 node dev/cold-start.drive.mjs    # what `bun test` runs: fails on a noisy start
 *
 * `page`, for a drive with a real page: `({ url, kehikko }) => ({ close, unframed(names) })`, where
 * `unframed` answers the modules whose frames the page has not drawn.
 *
 * Monitor once showed, in the fifteen minutes after the app started (0.1.72): the page asking
 * `/host/modules` 33 times in 9.1 s; every module's manifest fetched 28 times in 9.5 s; and 578 of
 * Kehikot's own 1261 calls filed under "no reason given". With CHECK=1 this fails when a module's
 * manifest is fetched, besides the host's own wait for it, more than once before the page arrives
 * (the reader's first sweep) or more than once after (the page's first look), when the page asks
 * `/host/modules` more than twice, or when any row of the host's own (made or received) has no
 * reason.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { bootHost, freePort, HOST, scratch, stop } from './scratch-host.mjs'

const MANIFEST = '/.well-known/kehikot-module.json'
const WAITS = 'the host waits for a module it started'
const NO_REASON = 'no reason given'
/* How long each module's `run.sh` sleeps before it serves. */
export const DELAYS = (process.env.DELAYS ?? '0,0,2,3,4,5').split(',').map(Number)
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 30_000)
const BUN = process.env.BUN ?? 'bun'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** The six installed copies the host is to start: a git checkout each, with a `run.sh` that waits before serving. */
async function slowModules({ root, env }) {
  const made = []
  for (const [at, delay] of DELAYS.entries()) {
    const id = `kehikot.slow${at + 1}`
    const name = `Slow ${at + 1}`
    const port = await freePort()
    const dir = join(root, 'installed', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'run.sh'),
      `#!/bin/sh\nsleep ${delay}\nexec "${BUN}" "${join(HOST, 'test/fixtures/standin/server.ts')}" ${id} "${name}" ${port} "$KEHIKOT_ORIGINS"\n`,
    )
    chmodSync(join(dir, 'run.sh'), 0o755)
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...env, GIT_TERMINAL_PROMPT: '0' } })
    git('init', '-q', '-b', 'main')
    git('-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.invalid', 'add', '.')
    git('-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.invalid', 'commit', '-q', '-m', 'a stand-in')
    writeFileSync(join(root, `modules/${id}.json`), JSON.stringify({ url: `http://127.0.0.1:${port}`, dir }))
    made.push({ id, name, port, delay })
  }
  return made
}

/**
 * The page's start, over plain HTTP: what `src/App.tsx` asks on arriving, in its order. `look` is
 * one at a time with one more after it for whoever asked meanwhile (`oneAfterAnother`).
 */
function aPage(api, origin, kehikko) {
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  const get = (path) => fetch(`${api}${path}`, { headers }).then((response) => response.json().catch(() => null))
  let view = null
  let running = null
  let next = null
  const look = () => {
    if (!running) {
      running = get('/host/modules').then((got) => {
        view = got
      }).finally(() => {
        running = null
      })
      return running
    }
    next ??= running.catch(() => {}).then(() => {
      next = null
      return look()
    })
    return next
  }
  const stream = new AbortController()
  const watch = async () => {
    const response = await fetch(`${api}/host/watch?page=cold-start&kehikko=${kehikko}`, { headers, signal: stream.signal })
    const reader = response.body.getReader()
    const text = new TextDecoder()
    let held = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      held += text.decode(value, { stream: true })
      let end
      while ((end = held.indexOf('\n\n')) >= 0) {
        const event = held.slice(0, end)
        held = held.slice(end + 2)
        const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (!data) continue
        let said
        try {
          said = JSON.parse(data)
        } catch {
          continue
        }
        if (said?.registry !== true) continue
        /* The reading itself, when the host had one in hand: taken as a look's answer. */
        if (said.modules && Array.isArray(said.modules.presences)) view = said.modules
        else void look()
      }
    }
  }
  return {
    async arrive() {
      const first = look()
      await Promise.all(['/host/health', '/host/settings', '/host/onboarding', '/host/whats-new', '/host/canvases'].map(get))
      void watch().catch(() => {})
      const said = await fetch(`${api}/host/open`, { method: 'POST', headers, body: JSON.stringify({ page: 'cold-start', kehikko }) }).then((response) => response.json())
      await first
      if (said?.started) await look()
    },
    get view() {
      return view
    },
    close() {
      stream.abort()
    },
  }
}

/** Counted, and with `check` the failures; the scratch host is stopped either way. */
export async function coldStart({ check = false, page: drivePage = null } = {}) {
  const failures = []
  let counts = null
  try {
    let slow = []
    const pageUrl = await bootHost('cold-start', {
      traffic: true,
      /* The introduction counts as seen: what is counted is a start, not a first run. */
      env: { KEHIKOT_ONBOARDING: 'off' },
      before: async (where) => {
        slow = await slowModules(where)
      },
    })
    const origin = new URL(pageUrl).origin
    const api = `http://127.0.0.1:${scratch.api}`
    const gamma = scratch.modules.find((one) => one.id === 'kehikot.gamma').port
    const asPage = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
    /* The kehikko the page opens on holds the six as well as the stand-ins. */
    const { canvases } = await (await fetch(`${api}/host/canvases`, { headers: asPage })).json()
    const canvas = canvases.find((one) => one.name === 'Wide') ?? canvases[0]
    /* On every kehikko of the project, so whichever the page opens on holds them. */
    for (const one of canvases.filter((each) => each.project === canvas.project)) {
      const placements = [...one.placements, ...slow.map((module, at) => ({ i: module.id, x: (at % 3) * 8, y: 60 + Math.floor(at / 3) * 16, w: 8, h: 16 }))]
      const placed = await fetch(`${api}/host/canvases/${one.id}`, { method: 'PATCH', headers: asPage, body: JSON.stringify({ placements }) })
      if (!placed.ok) throw new Error(`placing the modules: ${placed.status}`)
    }

    const rows = []
    let since = 0
    const read = async () => {
      for (;;) {
        const got = await (await fetch(`http://127.0.0.1:${gamma}/traffic?since=${since}`)).json()
        if (!got.ok) throw new Error(`traffic.read: ${got.why}`)
        rows.push(...got.data.calls)
        since = got.data.calls.length ? got.data.calls.at(-1).seq : got.data.newest
        if (got.data.calls.length < 5000) return got.data
      }
    }
    const first = await read()
    const from = first.started
    const arrived = Date.now()
    let page
    if (drivePage) page = await drivePage({ url: pageUrl, kehikko: canvas.id })
    else {
      page = aPage(api, origin, canvas.id)
      await page.arrive()
    }
    await sleep(Math.max(0, arrived + WINDOW_MS - Date.now()))
    await read()
    const view = drivePage ? null : page.view
    /* The real page: every module it starts is framed by the end, nothing left saying "starting". */
    const unframed = page.unframed ? await page.unframed(slow.map((one) => one.name)) : []
    page.close?.()
    const until = arrived + WINDOW_MS

    const inWindow = rows.filter((row) => row.at >= from && row.at <= until)
    const reasonOf = (row) => row.reason ?? NO_REASON
    const perModule = slow.map((one) => {
      const asked = inWindow.filter((row) => row.side === 'out' && row.path === MANIFEST && String(row.host).endsWith(`:${one.port}`))
      const by = new Map()
      for (const row of asked) by.set(reasonOf(row), (by.get(reasonOf(row)) ?? 0) + 1)
      /* Before the page arrived, only the record's reader (the Monitor's stand-in) had asked anything:
         the host's first sweep, finding each module not running. */
      const before = asked.filter((row) => row.at < arrived && row.reason !== WAITS).length
      return { ...one, asked: asked.length, waited: by.get(WAITS) ?? 0, before, by }
    })
    const modulesAsked = inWindow.filter((row) => row.side === 'in' && row.path.split('?')[0] === '/host/modules' && row.caller?.kind === 'host')
    /* Kehikot's own: what the host made, and what its page asked of it. */
    const own = inWindow.filter((row) => (row.side === 'out' && row.by === 'kehikko') || (row.side === 'in' && row.caller?.kind === 'host'))
    const unreasoned = own.filter((row) => !row.reason)
    const unreasonedBy = new Map()
    for (const row of unreasoned) {
      const key = `${row.side} ${row.kind} ${row.host}${row.path.split('?')[0]}`
      unreasonedBy.set(key, (unreasonedBy.get(key) ?? 0) + 1)
    }
    counts = { perModule, modulesAsked: modulesAsked.length, own: own.length, unreasoned: unreasoned.length, unreasonedBy }

    console.log(`a cold start with ${slow.length} modules the host starts (${DELAYS.join(', ')} s before each serves), first ${WINDOW_MS / 1000} s after the page arrived`)
    for (const one of perModule) {
      console.log(`  ${one.id} (${one.delay} s): its manifest fetched ${one.asked} times, ${one.waited} of them by the host's wait, ${one.before} before the page arrived`)
      for (const [why, n] of [...one.by].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(3)}  ${why}`)
    }
    console.log(`  the page asked /host/modules ${modulesAsked.length} times`)
    console.log(`  Kehikot's own rows: ${own.length}, ${unreasoned.length} with no reason`)
    for (const [key, n] of [...unreasonedBy].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(3)}  ${key}`)
    if (view) {
      const silent = slow.filter((one) => view.presences.find((presence) => presence.id === one.id)?.condition === 'silent')
      console.log(`  the page's last reading: ${silent.length ? `${silent.map((one) => one.id).join(', ')} still silent` : 'every module answering'}`)
      if (check && silent.length) failures.push(`the page was left believing ${silent.map((one) => one.id).join(', ')} silent`)
    }

    if (drivePage) console.log(`  the page framed ${slow.length - unframed.length} of the ${slow.length}${unframed.length ? `; not ${unframed.join(', ')}` : ''}`)
    if (check && unframed.length) failures.push(`the page did not frame ${unframed.join(', ')}`)

    if (check) {
      for (const one of perModule) {
        if (one.waited === 0) failures.push(`${one.id}: nothing was filed under "${WAITS}"`)
        /* The page's first look may find it not started yet; after that, the wait alone asks. */
        const after = one.asked - one.waited - one.before
        if (after > 1) failures.push(`${one.id}: its manifest was fetched ${after} times after the page arrived besides the host's wait; at most once`)
        if (one.before > 1) failures.push(`${one.id}: its manifest was fetched ${one.before} times before the page arrived; at most once`)
      }
      if (modulesAsked.length > 2) failures.push(`the page asked /host/modules ${modulesAsked.length} times; at most twice`)
      if (unreasoned.length) failures.push(`${unreasoned.length} of Kehikot's own rows had no reason: ${[...unreasonedBy.keys()].join('; ')}`)
    }
  } catch (error) {
    failures.push(`the drive failed: ${error?.stack ?? error}`)
  } finally {
    stop()
  }
  return { failures, counts }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { failures } = await coldStart({ check: process.env.CHECK === '1' })
  if (failures.length) {
    console.log('\nFAILED')
    for (const line of failures) console.log(`  ${line}`)
    process.exit(1)
  }
  console.log('\nthe counts were read from the record of traffic')
}
