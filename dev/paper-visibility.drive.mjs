/*
 * Does Paper keep quiet while its page is not shown, and keep up while it is? In WebKit — the
 * desktop app's engine — and in Chromium, inside a real host page.
 *
 *     PAPER_REF=<branch|tag|sha> node dev/paper-visibility.drive.mjs   # clones and builds Paper at that ref
 *     PAPER_DIR=<a built Paper checkout> node dev/paper-visibility.drive.mjs
 *     BROWSERS=webkit IDLE_MS=70000 FOLDED_MS=30000 ... node dev/paper-visibility.drive.mjs
 *
 * `test/paper-visibility.test.ts` runs it on bee (`BEE_ENV='PAPER_REF=<ref>' dev/bee-browser-tests.sh
 * <host ref> test/paper-visibility.test.ts`); browsers never start on the Mac. Exits 0 when every
 * case passes in every browser.
 *
 * ## What Paper is meant to do (2.8.0)
 *
 * Its page asks `/api/changes` and listens on `/api/watch` (server-sent events) for pushes, with a
 * safety ask once a minute while the stream is open. And it asks nothing at all while it is not
 * shown: its container folded (the host's context), its kehikko switched away from (the host
 * draws a page on no open container at no size), scrolled out of the canvas (an
 * IntersectionObserver), or its tab hidden.
 *
 * ## The cases, in each browser, in this order
 *
 *   1. shown: a `.tex` written on disk is in the page within ARRIVE_MS, and so is a suggestion
 *      filed through Paper's `propose_edit` (its MCP door).
 *   5. no false quiet: shown and idle for IDLE_MS, the stream stays open (no second `/api/watch`,
 *      the page's EventSource still open), the safety ask comes about once a minute, and an edit
 *      after the idle still arrives within ARRIVE_MS.
 *   2. folded: from the fold, the stream is closed and the page makes no request at all for
 *      FOLDED_MS; an edit made while folded is in the page within ARRIVE_MS of the unfold.
 *   3. another kehikko: switched to one Paper is not on, the same; and switched back.
 *   4. scrolled off: the window made short enough that the canvas scrolls (`host/fit.ts`), Paper
 *      at the bottom of it and the canvas scrolled to the top: the same for OFF_MS; and scrolled
 *      back into view.
 *
 * A hidden tab is not driven: a headless browser has no way to hide one of its pages.
 *
 * ## How it is read
 *
 * Every request is read from the browser's own network log (`request` on the browser context):
 * one whose frame or address is Paper's counts. The page's EventSource is watched from inside
 * Paper's frame by an init script that records its opens, its events and its closes — read from
 * the driver (`inPage`), since WebKit holds back a cross-origin frame's own timers. What the page
 * SHOWS is its document's text: the marker an edit wrote, the reason a suggestion gave.
 *
 * ## The scratch host and Paper
 *
 * The host is `dev/scratch-host.mjs` (scratch HOME and every `KEHIKOT_*` location, the official
 * list off), with Paper beside its three stand-ins, started by the drive from a checkout with a
 * stamped build (`bun run build`, `serve.ts`): what the app runs. Paper's own state is scratch
 * too (`PAPER_STATE_DIR`). The paper is `project-a/.kehikot/paper/methods/main.tex`, committed in
 * a git repository made of project-a. Paper is on the project's "Wide" kehikko, under the three
 * stand-ins; "Tall" does not have it.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bootHost, freePort, scratch, stop } from './scratch-host.mjs'

const pw = await import('playwright-core')

const BROWSERS = (process.env.BROWSERS ?? 'webkit,chromium').split(',').filter(Boolean)
const IDLE_MS = Number(process.env.IDLE_MS ?? 150_000)
const FOLDED_MS = Number(process.env.FOLDED_MS ?? 120_000)
const AWAY_MS = Number(process.env.AWAY_MS ?? 60_000)
const OFF_MS = Number(process.env.OFF_MS ?? 60_000)
/* "Within about two seconds": the line a push must arrive by, with a little for a loaded machine. */
const ARRIVE_MS = Number(process.env.ARRIVE_MS ?? 3_000)
/* How long the page may take to close its stream once it is not shown. */
const CLOSE_MS = Number(process.env.CLOSE_MS ?? 5_000)
const BUN = process.env.BUN ?? 'bun'
const KEEP = process.env.KEEP === '1'
const ID = 'kehikot.paper'
const VIEW = { width: 1400, height: 900 }
/* Short enough that the canvas rows are at their floor and the canvas scrolls (`host/fit.ts`). */
const SHORT = { width: 1400, height: 320 }
const CEILING = 30_000

const say = (line) => console.log(line)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const failures = []
const results = []
/** One case's verdict, for the table at the end. */
function verdict(kind, name, ok, said) {
  results.push({ kind, name, ok, said })
  say(`    ${ok ? 'ok  ' : 'FAIL'} ${name}: ${said}`)
  if (!ok) failures.push(`${kind}, ${name}: ${said}`)
}

/* ------------------------------------------------------------------ Paper, built */

/** A Paper checkout with a build stamped with its own commit: PAPER_DIR as given, or PAPER_REF cloned and built. */
function paperCheckout() {
  if (process.env.PAPER_DIR) return { dir: realpathSync(process.env.PAPER_DIR), made: false }
  const ref = process.env.PAPER_REF ?? 'main'
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw new Error(`not a ref: ${ref}`)
  const repo = process.env.PAPER_REPO ?? 'https://github.com/Jalez/kehikko-paper.git'
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'paper-checkout-')))
  const log = join(dir, 'paper-build.log')
  const step = (cmd, args) => {
    appendFileSync(log, `$ ${cmd} ${args.join(' ')}\n`)
    try {
      appendFileSync(log, execFileSync(cmd, args, { cwd: join(dir, 'src'), stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 << 20 }))
    } catch (error) {
      appendFileSync(log, `${error.stdout ?? ''}${error.stderr ?? ''}`)
      throw new Error(`${cmd} ${args.join(' ')} failed in the Paper checkout:\n${String(error.stderr ?? error.message).trim().split('\n').slice(-12).join('\n')}`)
    }
  }
  mkdirSync(join(dir, 'src'))
  step('git', ['init', '-q'])
  step('git', ['fetch', '-q', '--depth', '1', repo, ref])
  step('git', ['checkout', '-q', 'FETCH_HEAD'])
  step(BUN, ['install', '--frozen-lockfile'])
  step(BUN, ['run', 'build'])
  return { dir: join(dir, 'src'), made: dir }
}

/* ------------------------------------------------------------------ the page's side */

/*
 * Inside Paper's frame only: every EventSource the page opens, what it hears and when it is
 * closed. The page's own code is not changed: the class it constructs is the browser's, with a
 * note taken.
 */
const WATCH_STREAMS = ({ origin }) => {
  if (location.origin !== origin || typeof window.EventSource !== 'function') return
  const log = []
  const streams = []
  const Real = window.EventSource
  class Noted extends Real {
    constructor(url, init) {
      super(url, init)
      streams.push(this)
      log.push({ at: Date.now(), what: 'open' })
      for (const what of ['ready', 'changed']) this.addEventListener(what, () => log.push({ at: Date.now(), what }))
      this.addEventListener('error', () => log.push({ at: Date.now(), what: 'error', state: this.readyState }))
    }
    close() {
      log.push({ at: Date.now(), what: 'close' })
      super.close()
    }
  }
  window.EventSource = Noted
  window.__paperStreams = { log, open: () => streams.filter((one) => one.readyState !== 2).length }
}

/** Two painted frames of the host page. */
const painted = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))

/** Until `test` holds in Paper's page, read from here a painted host frame apart; false at the ceiling. */
async function inPage(page, frame, test, arg, ceiling = CEILING) {
  const deadline = Date.now() + ceiling
  for (;;) {
    if (await frame.evaluate(test, arg).catch(() => false)) return true
    if (Date.now() > deadline) return false
    await painted(page).catch(() => sleep(16))
  }
}

/** How long until Paper's page holds `text` (ms from `from`), or null within the ceiling. */
async function shows(page, frame, text, from, ceiling = 15_000) {
  const ok = await inPage(page, frame, (text) => document.body?.textContent?.includes(text) ?? false, text, ceiling)
  return ok ? Date.now() - from : null
}

const openStreams = (frame) => frame.evaluate(() => window.__paperStreams?.open() ?? -1).catch(() => -1)
const streamLog = (frame) => frame.evaluate(() => window.__paperStreams?.log ?? []).catch(() => [])

/* ------------------------------------------------------------------ the host's side */

async function steadyBox(page, locator) {
  const deadline = Date.now() + CEILING
  let last = null
  for (;;) {
    const box = await locator.boundingBox()
    if (box && last && ['x', 'y', 'width', 'height'].every((key) => Math.abs(box[key] - last[key]) < 0.5)) return box
    last = box
    if (Date.now() > deadline) return box
    await painted(page)
  }
}

async function pressHost(page, locator) {
  await locator.waitFor({ state: 'visible', timeout: CEILING })
  const box = await steadyBox(page, locator)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

const FOLD = (id) => `[data-module="${id}"] button[aria-label^="fold this container"], [data-module="${id}"] button[aria-label^="unfold this container"]`

/** Press Paper's fold control, as a hand does (it shows on hovering the header), and wait for the other word. */
async function fold(page) {
  const container = page.locator(`[data-module="${ID}"]`).first()
  const grip = container.locator('.container-grip').first()
  await grip.waitFor({ state: 'visible', timeout: CEILING })
  const box = await steadyBox(page, grip)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await painted(page)
  const button = page.locator(FOLD(ID)).first()
  const was = await button.getAttribute('aria-label')
  await pressHost(page, button)
  await page.waitForFunction(([selector, was]) => document.querySelector(selector)?.getAttribute('aria-label') !== was, [FOLD(ID), was], { timeout: CEILING })
  await steadyBox(page, container)
  return was.startsWith('fold') ? 'folded' : 'unfolded'
}

async function chooseKehikko(page, name) {
  await pressHost(page, page.locator('button[aria-label="switch kehikko"]'))
  const item = page.locator('[role="menuitem"]', { hasText: name }).first()
  await item.waitFor({ state: 'visible', timeout: CEILING })
  await page.waitForFunction(() => document.querySelector('[data-menu-content], [role="menu"]')?.contains(document.activeElement), null, { timeout: CEILING }).catch(() => {})
  await painted(page)
  await pressHost(page, item)
  await page.waitForFunction(() => (document.querySelector('[data-switch]')?.getAttribute('data-switch') ?? 'shown') === 'shown', null, { timeout: CEILING })
}

/** Paper's frame holder as the host draws it, and the canvas it is in. */
const where = (page) =>
  page.evaluate((id) => {
    const holder = document.querySelector(`[data-frame="${id}"]`)
    const main = document.querySelector('main')
    const box = holder?.getBoundingClientRect()
    const room = main?.getBoundingClientRect()
    return {
      width: Math.round(box?.width ?? -1),
      height: Math.round(box?.height ?? -1),
      top: Math.round(box?.top ?? 0),
      bottom: Math.round(box?.bottom ?? 0),
      mainTop: Math.round(room?.top ?? 0),
      mainBottom: Math.round(room?.bottom ?? 0),
      scrollTop: Math.round(main?.scrollTop ?? 0),
      scrollable: Math.round((main?.scrollHeight ?? 0) - (main?.clientHeight ?? 0)),
    }
  }, ID)

const scrollCanvas = (page, to) => page.evaluate((to) => {
  const main = document.querySelector('main')
  main.scrollTop = to === 'bottom' ? main.scrollHeight : 0
}, to)

/* ------------------------------------------------------------------ one browser */

async function drive(kind, browserType, url, paper) {
  say(`\n[${kind}]`)
  const browser = await browserType.launch()
  try {
    const context = await browser.newContext({ viewport: VIEW, colorScheme: 'light' })
    await context.addCookies([{ name: 'kehikko.theme', value: 'light', url }])
    await context.addInitScript(WATCH_STREAMS, { origin: paper.origin })
    /* Nothing is asked of GitHub's release list for the What's new notice. */
    await context.route((address) => address.pathname === '/host/releases', (route) => route.fulfill({ status: 503, body: '{}' }))

    /* The browser's network log: every request Paper's page makes, or anything makes of Paper. */
    const asked = []
    context.on('request', (request) => {
      let fromPaper = false
      try {
        fromPaper = request.frame().url().startsWith(paper.origin)
      } catch {}
      if (!fromPaper && !request.url().startsWith(paper.origin)) return
      const address = new URL(request.url())
      asked.push({ at: Date.now(), path: address.pathname, since: address.searchParams.get('since') ?? null, type: request.resourceType() })
    })
    const between = (from, to = Date.now()) => asked.filter((one) => one.at >= from && one.at <= to)
    const named = (list) => {
      const counts = new Map()
      for (const one of list) counts.set(one.path, (counts.get(one.path) ?? 0) + 1)
      return [...counts].map(([path, n]) => `${path} ×${n}`).join(', ') || 'none'
    }
    const firstAsk = (from) => asked.find((one) => one.at >= from && one.path === '/api/changes')

    const page = await context.newPage()
    page.on('pageerror', (error) => failures.push(`${kind}: the host page threw: ${error.message}`))
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForSelector('[data-frame]', { state: 'attached', timeout: 60_000 })
    /* A fresh browser is welcomed, and a fresh host asks once whether to keep the agent set up. */
    const dialogs = page.locator('[role="dialog"]')
    await dialogs.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    for (let tries = 0; tries < 6 && (await dialogs.count()); tries += 1) {
      const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
      if (await myself.count()) await pressHost(page, myself.first())
      else await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('[role="dialog"], [data-state].fixed.inset-0').length === 0, null, { timeout: 5_000 }).catch(() => {})
      await dialogs.first().waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {})
    }
    /* Shown, unfolded, on "Wide": a browser before this one may have been stopped anywhere. */
    if ((await page.locator(FOLD(ID)).first().getAttribute('aria-label').catch(() => ''))?.startsWith('unfold')) await fold(page)

    const frame = await (async () => {
      const deadline = Date.now() + 60_000
      for (;;) {
        const found = page.frames().find((one) => one.url().startsWith(paper.origin))
        if (found) return found
        if (Date.now() > deadline) throw new Error(`${kind}: Paper's page never loaded in the host page`)
        await sleep(200)
      }
    })()
    if (!(await inPage(page, frame, (text) => document.body?.textContent?.includes(text), 'The first claim', 60_000))) {
      const text = await frame.evaluate(() => document.body?.innerText?.slice(0, 400)).catch(() => '?')
      throw new Error(`${kind}: Paper's page never showed the paper; it says: ${text}`)
    }
    if (!(await inPage(page, frame, () => window.__paperStreams?.log.some((one) => one.what === 'ready') && window.__paperStreams.open() === 1, null))) {
      throw new Error(`${kind}: Paper's page never opened its stream (${JSON.stringify(await streamLog(frame))})`)
    }
    await sleep(1_500)
    const at = await where(page)
    say(`  Paper shown at ${at.width}×${at.height}, its stream open; ${named(asked)} asked on the load`)

    /** An edit to the .tex on disk, as an editor or an agent makes it. */
    const edit = (marker) => appendFileSync(paper.main, `% ${marker}\n`)
    const mark = (what) => `${kind}${what}${Math.random().toString(36).slice(2, 7)}`

    /* --------------------------------------------------------------- 1. shown */
    say('  1. shown')
    {
      const marker = mark('shown')
      const from = Date.now()
      edit(marker)
      const took = await shows(page, frame, marker, from)
      const heard = (await streamLog(frame)).some((one) => one.what === 'changed' && one.at >= from)
      const ask = firstAsk(from)
      verdict(kind, '1. shown: an edit on disk', took !== null && took <= ARRIVE_MS && heard, took === null ? 'never shown within 15 s' : `in the page after ${took} ms (pushed: ${heard ? '`changed` heard on the stream' : 'NOT heard on the stream'}; asked ${ask ? `${ask.at - from} ms after the edit` : 'never'})`)

      const reason = mark('why')
      const asked0 = Date.now()
      const reply = await fetch(`${paper.origin}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'propose_edit', arguments: { project: paper.project, epic: paper.epic, file: 'main.tex', find: `The ${kind} claim.`, replace: `The ${kind} claim, ${reason}.`, why: `Sharper (${reason}).` } },
        }),
      })
      const said = await reply.json().catch(() => null)
      const text = String(said?.result?.content?.[0]?.text ?? JSON.stringify(said))
      const proposed = await shows(page, frame, reason, asked0)
      const heardToo = (await streamLog(frame)).some((one) => one.what === 'changed' && one.at >= asked0)
      verdict(kind, '1. shown: a propose_edit suggestion', proposed !== null && proposed <= ARRIVE_MS, proposed === null ? `never shown within 15 s (propose_edit said: ${text.slice(0, 160)})` : `in the page after ${proposed} ms (pushed: ${heardToo ? 'yes' : 'NO'})`)
    }

    /* --------------------------------------------------------------- 5. no false quiet */
    say(`  5. shown and idle for ${Math.round(IDLE_MS / 1000)} s`)
    {
      await sleep(1_000)
      const from = Date.now()
      const streamsBefore = (await streamLog(frame)).filter((one) => one.what === 'open').length
      await sleep(IDLE_MS)
      const idle = between(from)
      const asks = idle.filter((one) => one.path === '/api/changes')
      const watches = idle.filter((one) => one.path === '/api/watch').length
      const others = idle.filter((one) => one.path !== '/api/changes' && one.path !== '/api/watch')
      const streamsAfter = (await streamLog(frame)).filter((one) => one.what === 'open').length
      const open = await openStreams(frame)
      const times = asks.map((one) => Math.round((one.at - from) / 1000))
      const gaps = asks.slice(1).map((one, n) => one.at - asks[n].at)
      /* About once a minute: as many as the minutes, give or take one, and never two close together. */
      const expected = Math.floor(IDLE_MS / 60_000)
      const paced = asks.length >= Math.max(1, expected - 1) && asks.length <= expected + 1 && gaps.every((gap) => gap >= 45_000)
      verdict(kind, '5. idle: the stream stays open', open === 1 && watches === 0 && streamsAfter === streamsBefore, `${open} open in the page, ${watches} new /api/watch requests, ${streamsAfter - streamsBefore} new EventSource`)
      verdict(kind, '5. idle: a safety ask about once a minute', paced, `${asks.length} /api/changes in ${Math.round(IDLE_MS / 1000)} s, at +${times.join(' s, +')} s${others.length ? `; besides: ${named(others)}` : ''}`)
      const marker = mark('idle')
      const editedAt = Date.now()
      edit(marker)
      const took = await shows(page, frame, marker, editedAt)
      verdict(kind, '5. idle: an edit still pushed', took !== null && took <= ARRIVE_MS, took === null ? 'never shown within 15 s' : `in the page after ${took} ms`)
    }

    /* A not-shown spell: stream closed, nothing asked for `quiet` ms with an edit made in it; then shown again. */
    const notShown = async (name, hide, show, quiet) => {
      const pressed = Date.now()
      await hide()
      const closed = await inPage(page, frame, () => window.__paperStreams?.open() === 0, null, CLOSE_MS)
      const closedIn = Date.now() - pressed
      const box = await where(page)
      /* In flight at the press is the page's last word as it was shown: counted from the closing. */
      const from = Date.now()
      await sleep(Math.min(10_000, quiet / 3))
      const marker = mark(name.replace(/\W/g, ''))
      edit(marker)
      await sleep(Math.max(0, quiet - (Date.now() - from)))
      const during = between(from)
      const quietFor = Math.round((Date.now() - from) / 1000)
      verdict(kind, `${name}: quiet`, closed && during.length === 0, `${closed ? `stream closed ${closedIn} ms after the press` : `stream STILL OPEN ${CLOSE_MS} ms after the press`}; frame drawn ${box.width}×${box.height}; ${during.length} requests in ${quietFor} s${during.length ? ` (${named(during)})` : ''}`)
      const back = Date.now()
      await show()
      const took = await shows(page, frame, marker, back)
      const ask = firstAsk(back)
      const reopened = await inPage(page, frame, () => window.__paperStreams?.open() === 1, null, 10_000)
      verdict(kind, `${name}: shown again`, took !== null && took <= ARRIVE_MS && reopened, `${ask ? `asked ${ask.at - back} ms after` : 'never asked'}${ask?.since ? ' (naming its tag)' : ''}; the edit made meanwhile in the page after ${took ?? 'never (15 s)'} ms; stream ${reopened ? 'open again' : 'NOT open again'}`)
    }

    /* --------------------------------------------------------------- 2. folded */
    say(`  2. folded for ${Math.round(FOLDED_MS / 1000)} s`)
    await notShown('2. folded', async () => {
      if ((await fold(page)) !== 'folded') throw new Error('the fold control unfolded Paper')
    }, async () => {
      if ((await fold(page)) !== 'unfolded') throw new Error('the fold control folded Paper')
    }, FOLDED_MS)

    /* --------------------------------------------------------------- 3. another kehikko */
    say(`  3. on another kehikko for ${Math.round(AWAY_MS / 1000)} s`)
    await notShown('3. another kehikko', () => chooseKehikko(page, 'Tall'), () => chooseKehikko(page, 'Wide'), AWAY_MS)

    /* --------------------------------------------------------------- 4. scrolled off */
    say(`  4. scrolled out of view for ${Math.round(OFF_MS / 1000)} s`)
    {
      await page.setViewportSize(SHORT)
      await painted(page)
      await sleep(500)
      await scrollCanvas(page, 'bottom')
      await sleep(500)
      const inView = await where(page)
      const shownAgain = await inPage(page, frame, () => window.__paperStreams?.open() === 1, null, 10_000)
      if (!(inView.scrollable > 0) || inView.top < inView.mainTop - 1 || inView.bottom > inView.mainBottom + 1 || !shownAgain) {
        verdict(kind, '4. scrolled off: the setup', false, `at ${SHORT.width}×${SHORT.height} the canvas scrolls ${inView.scrollable} px; scrolled to the bottom Paper is at ${inView.top}–${inView.bottom} in a canvas ${inView.mainTop}–${inView.mainBottom}; its stream ${shownAgain ? 'open' : 'not open'}`)
      } else {
        await sleep(1_500)
        await notShown('4. scrolled off', async () => {
          await scrollCanvas(page, 'top')
          const off = await where(page)
          if (off.top < off.mainBottom) throw new Error(`scrolled to the top, Paper still starts at ${off.top}, above the canvas's bottom at ${off.mainBottom}`)
        }, () => scrollCanvas(page, 'bottom'), OFF_MS)
      }
      await page.setViewportSize(VIEW)
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

/* ------------------------------------------------------------------ run */

let checkout = null
try {
  checkout = paperCheckout()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout.dir, encoding: 'utf8' }).trim()
  const stamp = existsSync(join(checkout.dir, 'dist/.kehikot-built')) ? readFileSync(join(checkout.dir, 'dist/.kehikot-built'), 'utf8').split('\n')[0].trim() : ''
  if (stamp !== head) throw new Error(`Paper at ${checkout.dir} has no build of its own commit ${head.slice(0, 7)} (dist/.kehikot-built: ${stamp || 'none'}); \`bun run build\` there`)
  const version = JSON.parse(readFileSync(join(checkout.dir, 'package.json'), 'utf8')).version
  say(`Paper ${version} at ${head.slice(0, 12)}${process.env.PAPER_REF ? ` (${process.env.PAPER_REF})` : ''}, ready-built`)

  let paperPort = 0
  const url = await bootHost('paper-visibility', {
    modules: async ({ root, env, start }) => {
      paperPort = await freePort()
      const own = { PORT: String(paperPort), PAPER_STATE_DIR: join(root, 'paper-state') }
      delete env.HOST_PORT
      start(BUN, ['run', 'serve.ts'], 'paper.log', { cwd: checkout.dir, env: own })
      return [{ id: ID, name: 'Paper', port: paperPort }]
    },
  })
  const project = join(scratch.root, 'project-a')
  const epic = 'methods'
  const dir = join(project, '.kehikot', 'paper', epic)
  mkdirSync(dir, { recursive: true })
  const main = join(dir, 'main.tex')
  writeFileSync(main, [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{One}',
    'The first claim, said plainly.',
    '',
    '\\section{Two}',
    ...BROWSERS.flatMap((kind) => [`The ${kind} claim.`, '']),
    '\\end{document}',
    '',
  ].join('\n'))
  /* The paper in git, as a real one is; the host's own files in the project are not part of it. */
  writeFileSync(join(project, '.gitignore'), '.kehikot/*\n!.kehikot/paper/\n')
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe', env: { ...process.env, HOME: join(scratch.root, 'home'), GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@example.invalid', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@example.invalid' } })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'the paper')

  /* Paper on "Wide", full width under the three stand-ins: low enough that a short window's canvas scrolls it out of view. */
  const host = `http://127.0.0.1:${scratch.api}`
  const send = async (method, path, body) => {
    const response = await fetch(`${host}${path}`, { method, headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${scratch.page}` }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
    return response.json()
  }
  const canvases = await (await fetch(`${host}/host/canvases`)).json()
  const a = canvases.projects.find((one) => one.path === project)?.id ?? canvases.projects[0].id
  const wide = canvases.canvases.find((one) => one.project === a && one.name === 'Wide')
  if (!wide) throw new Error('the scratch host has no "Wide" kehikko in project-a')
  await send('PATCH', `/host/canvases/${wide.id}`, {
    placements: [
      { i: 'kehikot.alpha', x: 0, y: 0, w: 4, h: 16 },
      { i: 'kehikot.beta', x: 4, y: 0, w: 4, h: 16 },
      { i: 'kehikot.gamma', x: 8, y: 0, w: 4, h: 16 },
      { i: ID, x: 0, y: 16, w: 12, h: 12 },
    ],
  })
  const paper = { origin: `http://127.0.0.1:${paperPort}`, project, epic, main }
  say(`a scratch host at ${url}, Paper at ${paper.origin}, the paper at ${main.slice(scratch.root.length + 1)}`)

  for (const kind of BROWSERS) {
    if (!pw[kind]) throw new Error(`no browser called ${kind}`)
    try {
      await drive(kind, pw[kind], url, paper)
    } catch (error) {
      failures.push(`${kind}: the drive stopped: ${error?.stack ?? error}`)
      say(`  the drive stopped: ${error?.message ?? error}`)
    }
  }
} catch (error) {
  failures.push(`the drive failed: ${error?.stack ?? error}`)
} finally {
  stop()
  if (checkout?.made && !KEEP) rmSync(checkout.made, { recursive: true, force: true })
}

say('\nResults')
for (const kind of BROWSERS) {
  for (const one of results.filter((row) => row.kind === kind)) say(`  ${kind.padEnd(9)} ${one.ok ? 'ok  ' : 'FAIL'} ${one.name}`)
}
if (failures.length) {
  say(`\n${failures.length} failure(s):`)
  for (const line of failures) say(`  - ${line}`)
  process.exit(1)
}
say('\nPaper kept quiet while not shown and kept up while shown')
process.exit(0)
