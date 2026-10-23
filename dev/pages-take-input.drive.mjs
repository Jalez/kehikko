/*
 * Does a module's page take a person's clicks, typing and scrolling? In
 * WebKit — the app's own engine, the desktop shell is a WKWebView — and in
 * Chromium, with a REAL pointer and keyboard.
 *
 *     node dev/pages-take-input.drive.mjs            # boots its own scratch host
 *     BROWSERS=webkit node dev/pages-take-input.drive.mjs
 *
 * `bun test` runs it (`test/pages-take-input.test.ts`), so it cannot be
 * skipped by forgetting it. Exits 0 when every check passes.
 *
 * ## Why it exists
 *
 * 0.1.54 and 0.1.55 shipped a canvas where no module page took a click: the
 * calm switch wrapped the grid in a full-canvas element stacked above the
 * pages and left it a pointer target. Container headers worked, so did every
 * test, because no test pressed INSIDE a page the way a hand does. A
 * `locator.click()` or a dispatched event goes to the element it names, not
 * to whatever is on top at that point, and so cannot see a layer in the way.
 *
 * So everything here is real input, at coordinates: `page.mouse` clicks at
 * where the page's field and button are drawn, `page.keyboard` typing,
 * `page.mouse.wheel` over its list. Before the first click, the host's
 * `document.elementFromPoint` at that spot must be the page's own iframe — a
 * layer in the way is named, rather than only seen as a click that went
 * nowhere.
 *
 * ## What is checked, on every page shown
 *
 *   after the first load · after a header menu press · after a kehikko switch
 *   · after a project switch · after a resize · after a fold and an unfold,
 *   in light; and after the load and a kehikko switch in dark. Each in every
 *   browser in `BROWSERS` (default `webkit,chromium`).
 *
 * ## The scratch host
 *
 * Its own: the host's API and Vite on free ports, every `KEHIKOT_*` location
 * and `HOME` in a temporary directory, two projects with two kehikot each,
 * and three stand-in modules (`test/fixtures/standin/`). Nothing of the
 * person's machine is read or written, and every process it starts is
 * stopped by its pid when it ends.
 *
 * Playwright is `playwright-core`, a dev dependency with no browsers in it.
 * The browsers are Playwright's own shared cache; if they are missing this
 * says the one command that installs them.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..')
const BROWSERS = (process.env.BROWSERS ?? 'webkit,chromium').split(',').filter(Boolean)
const KEEP = process.env.KEEP === '1'
const BUN = process.env.BUN ?? 'bun'

const pw = await import('playwright-core')

/* ------------------------------------------------------------ scratch host */

/* Every port handed out, so the next one asked for is a different one: a port
   is free until something listens on it, and nothing has yet. */
const taken = new Set()
const freePort = async () => {
  for (;;) {
    const port = await anyPort()
    if (!taken.has(port) && !taken.has(port - 1)) return taken.add(port), port
  }
}
const anyPort = () =>
  new Promise((done, fail) => {
    const server = createServer()
    server.unref()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
const portFree = (port) =>
  new Promise((done) => {
    const server = createServer()
    server.unref()
    server.on('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
/* The page is the API's port plus one (`server.ts`), so both must be free. */
async function pairOfPorts() {
  for (let tries = 0; tries < 50; tries += 1) {
    const api = await freePort()
    if (!taken.has(api + 1) && (await portFree(api + 1))) return taken.add(api + 1), api
  }
  throw new Error('no two free ports in a row')
}

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-pages-take-input-')))
const at = (path) => join(ROOT, path)
const children = []
function stop() {
  for (const child of children) {
    try {
      process.kill(child.pid, 'SIGTERM')
    } catch {}
  }
  children.length = 0
  if (!KEEP) rmSync(ROOT, { recursive: true, force: true })
}
process.on('exit', stop)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130))

async function bootHost() {
  for (const dir of ['home', 'project-a', 'project-b', 'modules', 'versions', 'installed', 'logs', 'claude']) mkdirSync(at(dir), { recursive: true })
  writeFileSync(at('project-a/README.md'), 'a\n')
  writeFileSync(at('project-b/README.md'), 'b\n')
  const api = await pairOfPorts()
  const page = api + 1
  const origins = [`http://127.0.0.1:${page}`, `http://localhost:${page}`, `http://127.0.0.1:${api}`, `http://localhost:${api}`]
  const env = {
    ...process.env,
    HOME: at('home'),
    PORT: String(api),
    HOST_PORT: String(api),
    CLAUDE_CONFIG: at('home/.claude.json'),
    CLAUDE_CONFIG_DIR: at('claude'),
    KEHIKOT_FRAME_DB: at('frame.sqlite'),
    KEHIKOT_MODULES_DIR: at('modules'),
    KEHIKOT_VERSIONS_DIR: at('versions'),
    KEHIKOT_INSTALLS_DIR: at('installed'),
    KEHIKOT_OFFICIAL_CACHE: at('official-modules.json'),
    KEHIKOT_LOGS_DIR: at('logs'),
    KEHIKOT_OFFICIAL_LIST: 'off',
    KEHIKOT_SEED_PROJECT: at('project-a'),
    KEHIKKO_RESTART_FILE: at('restart'),
  }
  const run = (cmd, args, log) => {
    const out = openSync(at(log), 'a')
    const child = spawn(cmd, args, { cwd: HOST, env, stdio: ['ignore', out, out] })
    children.push(child)
    return child
  }
  const modules = []
  for (const [id, name] of [
    ['kehikot.alpha', 'Alpha'],
    ['kehikot.beta', 'Beta'],
    ['kehikot.gamma', 'Gamma'],
  ]) {
    const port = await freePort()
    modules.push({ id, name, port })
    writeFileSync(at(`modules/${id}.json`), JSON.stringify({ url: `http://127.0.0.1:${port}`, keep: true }))
    run(BUN, [join(HOST, 'test/fixtures/standin/server.ts'), id, name, String(port), origins.join(' ')], `${name}.log`)
  }
  run(BUN, ['run', 'server/server.ts'], 'api.log')
  run(join(HOST, 'node_modules/.bin/vite'), ['--port', String(page), '--strictPort', '--host', '127.0.0.1'], 'vite.log')

  const answers = async (url) => {
    for (let tries = 0; tries < 300; tries += 1) {
      try {
        if ((await fetch(url)).ok) return
      } catch {}
      await new Promise((done) => setTimeout(done, 100))
    }
    throw new Error(`nothing answered at ${url}; logs in ${ROOT} (KEEP=1 keeps them)`)
  }
  await answers(`http://127.0.0.1:${api}/host/health`)
  for (const { port } of modules) await answers(`http://127.0.0.1:${port}/healthz`)
  await answers(`http://127.0.0.1:${page}/`)

  const send = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${api}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${page}` },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
    return response.json()
  }
  const first = await (await fetch(`http://127.0.0.1:${api}/host/canvases`)).json()
  const a = first.projects[0].id
  const b = (await send('POST', '/host/projects', { path: at('project-b') })).project.id
  const wide = [
    { i: 'kehikot.alpha', x: 0, y: 0, w: 6, h: 14 },
    { i: 'kehikot.beta', x: 6, y: 0, w: 6, h: 14 },
    { i: 'kehikot.gamma', x: 0, y: 14, w: 12, h: 14 },
  ]
  const tall = [
    { i: 'kehikot.alpha', x: 0, y: 0, w: 4, h: 28 },
    { i: 'kehikot.beta', x: 4, y: 0, w: 4, h: 28 },
    { i: 'kehikot.gamma', x: 8, y: 0, w: 4, h: 28 },
  ]
  /* The kehikko a fresh project opens on holds the three as well, so the
     first load is a canvas of pages and not an empty one. */
  for (const canvas of first.canvases.filter((one) => one.project === a)) await send('PATCH', `/host/canvases/${canvas.id}`, { placements: wide })
  await send('POST', '/host/canvases', { name: 'Tall', project: a, placements: tall })
  await send('POST', '/host/canvases', { name: 'Tall', project: b, placements: wide })
  /* And the one project-b was given when it was added, if it was given one. */
  const again = await (await fetch(`http://127.0.0.1:${api}/host/canvases`)).json()
  const own = again.canvases.filter((one) => one.project === b && one.name !== 'Tall')
  for (const canvas of own) await send('PATCH', `/host/canvases/${canvas.id}`, { name: 'Wide', placements: tall })
  if (own.length === 0) await send('POST', '/host/canvases', { name: 'Wide', project: b, placements: tall })
  return `http://127.0.0.1:${page}/`
}

/* ------------------------------------------------------------------ checks */

const failures = []
/* What the driver was doing, so a page that throws says during what. */
let doing = 'loading'
const say = (line) => console.log(line)

/** Click the middle of a box with the real pointer. */
async function press(page, box) {
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/** Press an element of the HOST page where it is drawn: the pointer goes wherever it lands. */
async function pressHost(page, locator) {
  await locator.waitFor({ state: 'visible' })
  const box = await locator.boundingBox()
  if (!box) throw new Error(`nothing drawn for ${locator}`)
  await press(page, box)
}

async function pointAt(page, locator) {
  const box = await locator.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(150)
}

/**
 * Every module page shown now: its frame, and its module's id. Matched by
 * address — each stand-in answers on its own origin — and not with
 * `frame.frameElement()`, which in WebKit reaches into the cross-origin
 * frame from the host and makes the host log a SecurityError of its own.
 */
async function shownPages(page) {
  const drawn = await page.evaluate(() =>
    [...document.querySelectorAll('[data-frame]')]
      .filter((holder) => {
        const box = holder.getBoundingClientRect()
        return getComputedStyle(holder).visibility === 'visible' && box.width > 40 && box.height > 40
      })
      .map((holder) => ({ id: holder.getAttribute('data-frame'), src: holder.querySelector('iframe')?.src ?? '' })),
  )
  const shown = []
  for (const { id, src } of drawn) {
    const frame = page.frames().find((one) => one !== page.mainFrame() && src && new URL(one.url() || 'about:blank').origin === new URL(src).origin)
    if (frame) shown.push({ id, frame })
  }
  return shown.sort((x, y) => x.id.localeCompare(y.id))
}

/* A host without the calm switch (before 0.1.54) has no `data-switch`: shown at once. */
const SHOWN = () => (document.querySelector('[data-switch]')?.getAttribute('data-switch') ?? 'shown') === 'shown'

async function settle(page) {
  /* Shown, and taking input: the switch's own word for it, with its ceiling. */
  await page.waitForFunction(SHOWN, null, { timeout: 5000 })
  await page.waitForTimeout(250)
}

/** Click, type and scroll in every page shown, as a hand would. */
async function everyPageTakesInput(page, label, expected) {
  await settle(page)
  const pages = await shownPages(page)
  const lines = []
  if (pages.length < expected) lines.push(`FAIL only ${pages.length} of ${expected} pages shown`)
  for (const { id, frame } of pages) {
    const problems = []
    const field = frame.locator('#field')
    await field.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    const fieldBox = await field.boundingBox()
    if (!fieldBox) {
      lines.push(`FAIL ${id}: its field is not drawn`)
      continue
    }
    /* The spot the pointer will press: what is on top there, in the host? */
    const x = fieldBox.x + 8
    const y = fieldBox.y + fieldBox.height / 2
    doing = `reading what is on top of ${id}`
    const onTop = await page.evaluate(
      ([x, y, id]) => {
        const hit = document.elementFromPoint(x, y)
        if (!hit) return 'nothing'
        if (hit.tagName === 'IFRAME' && hit.closest('[data-frame]')?.getAttribute('data-frame') === id) return null
        const classes = typeof hit.className === 'string' ? hit.className.trim().split(/\s+/).slice(0, 6).join('.') : ''
        return `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}${classes ? `.${classes}` : ''}`
      },
      [x, y, id],
    )
    if (onTop) problems.push(`the host has ${onTop} on top of it`)
    /* Typing: into an emptied field, so the word is all of it. */
    doing = `emptying ${id}'s field`
    await field.evaluate((input) => (input.value = ''))
    doing = `clicking ${id}'s field`
    await page.mouse.click(x, y)
    doing = `typing in ${id}`
    const word = `w${Math.random().toString(36).slice(2, 7)}`
    await page.keyboard.type(word)
    const typed = await field.inputValue()
    if (typed !== word) {
      const focus = await frame.evaluate(() => `${document.hasFocus()} ${document.activeElement?.tagName}`)
      const hostFocus = await page.evaluate(() => `${document.hasFocus()} ${document.activeElement?.tagName} ${document.activeElement?.getAttribute('aria-label') ?? ''}`)
      problems.push(`typed "${word}", the field holds "${typed}" (page focus: ${focus}; host focus: ${hostFocus})`)
    }
    /* A button. */
    doing = `pressing ${id}'s button`
    const count = frame.locator('#pressed')
    const before = Number(await count.innerText())
    await press(page, await frame.locator('#press').boundingBox())
    const after = Number(await count.innerText())
    if (after !== before + 1) problems.push(`button pressed, its count went ${before} → ${after}`)
    /* The wheel, over its list. */
    doing = `scrolling ${id}'s list`
    const list = frame.locator('#list')
    await list.evaluate((element) => (element.scrollTop = 0))
    const listBox = await list.boundingBox()
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2)
    await page.mouse.wheel(0, 120)
    await frame.waitForFunction(() => document.getElementById('list').scrollTop > 0, null, { timeout: 1500 }).catch(() => {})
    const scrolled = await list.evaluate((element) => element.scrollTop)
    if (!(scrolled > 0)) problems.push('the wheel over its list scrolled nothing')
    lines.push(problems.length ? `FAIL ${id}: ${problems.join('; ')}` : `ok   ${id}`)
    doing = 'between checks'
  }
  say(`  ${label}`)
  for (const line of lines) say(`    ${line}`)
  for (const line of lines) if (line.startsWith('FAIL')) failures.push(`${label}: ${line.slice(5)}`)
}

async function choose(page, kind, row) {
  await pressHost(page, page.locator(`button[aria-label="switch ${kind}"]`))
  await pressHost(page, page.locator('[role="menuitem"]', { hasText: row }).first())
}

async function headerMenu(page, label) {
  /* Alpha's toggle, pressed in the host's own menu for it. */
  const frame = (await shownPages(page)).find((one) => one.id === 'kehikot.alpha')?.frame
  const was = await frame?.evaluate(() => document.body.dataset.flag ?? 'false')
  await pressHost(page, page.locator('button[aria-label^="view of Alpha"]'))
  await pressHost(page, page.locator('[role="menuitemcheckbox"]', { hasText: 'Flag' }).first())
  const now = await frame
    ?.waitForFunction((was) => (document.body.dataset.flag ?? 'false') !== was, was, { timeout: 3000 })
    .then(() => frame.evaluate(() => document.body.dataset.flag))
    .catch(() => was)
  const ok = now !== was
  /* A toggle keeps its menu open (`staysOpen` in `host/header.ts`); Escape
     closes it, as a person would. Not a click into the page: measured in
     WebKit, before the calm switch as after it, the click that dismisses an
     open host menu is not one that focuses the page under it. */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  say(`  ${label}`)
  say(`    ${ok ? 'ok  ' : 'FAIL'} the header toggle reached Alpha (${was} → ${now})`)
  if (!ok) failures.push(`${label}: the header toggle did not reach Alpha`)
}

async function resize(page) {
  const item = page.locator('.react-grid-item', { has: page.locator('[data-module="kehikot.beta"]') }).first()
  /* Over its header, where the corners are revealed; `hover()` would refuse,
     rightly, because the page is what is under the middle of the item. */
  await pointAt(page, item.locator('.container-grip').first())
  const handle = item.locator('.react-resizable-handle-se')
  const box = await handle.boundingBox()
  const before = await item.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(box.x + box.width / 2 - step * 15, box.y + box.height / 2 - step * 10)
  await page.mouse.up()
  await page.waitForTimeout(400)
  const after = await item.boundingBox()
  if (Math.abs(after.width - before.width) < 20 && Math.abs(after.height - before.height) < 20) {
    failures.push('resize: the corner did not resize Beta')
    say('    FAIL the corner did not resize Beta')
  }
}

async function fold(page, id) {
  const container = page.locator(`[data-module="${id}"]`).first()
  await pointAt(page, container.locator('.container-grip').first())
  await pressHost(page, container.locator('button[aria-label^="fold this container"], button[aria-label^="unfold this container"]').first())
  await page.waitForTimeout(400)
}

async function drive(kind, browserType) {
  const pageUrl = PAGE
  for (const scheme of ['light', 'dark']) {
    let browser
    try {
      browser = await browserType.launch()
    } catch (error) {
      const first = String(error.message).split('\n')[0]
      failures.push(`${kind}: cannot launch (${first}). Install the browsers with: bunx playwright-core install webkit chromium-headless-shell`)
      say(`${kind}: cannot launch — bunx playwright-core install webkit chromium-headless-shell`)
      return
    }
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme })
    const page = await context.newPage()
    page.on('pageerror', (error) => {
      failures.push(`${kind} ${scheme}: the page threw while ${doing}: ${error.message}`)
      if (process.env.STACKS === '1') console.log(error.stack)
    })
    say(`[${kind}, ${scheme}]`)
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-frame]', { state: 'attached', timeout: 30000 })
    await page.waitForFunction(SHOWN, null, { timeout: 30000 })
    /* A fresh host asks, once, whether to keep the agent set up. */
    for (let tries = 0; tries < 6 && (await page.locator('[role="dialog"]').count()); tries += 1) {
      const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
      if (await myself.count()) await pressHost(page, myself.first())
      else await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
    await page.waitForFunction(() => document.querySelectorAll('[data-frame]').length >= 3, null, { timeout: 30000 })
    /* Every page greeted: a page is drawn only once it has been. */
    await page.waitForTimeout(1500)
    const name = (label) => `${kind} ${scheme}, ${label}`

    await everyPageTakesInput(page, name('after the first load'), 3)
    await choose(page, 'kehikko', 'Tall')
    await everyPageTakesInput(page, name('after a kehikko switch'), 3)
    if (scheme === 'light') {
      await headerMenu(page, name('a header menu press'))
      await everyPageTakesInput(page, name('after a header menu press'), 3)
      await choose(page, 'project', 'project-b')
      await everyPageTakesInput(page, name('after a project switch'), 3)
      await choose(page, 'project', 'project-a')
      await everyPageTakesInput(page, name('after switching back'), 3)
      say(`  ${name('resizing Beta by its corner')}`)
      await resize(page)
      await everyPageTakesInput(page, name('after a resize'), 3)
      await fold(page, 'kehikot.gamma')
      await everyPageTakesInput(page, name('after folding Gamma'), 2)
      await fold(page, 'kehikot.gamma')
      await everyPageTakesInput(page, name('after unfolding Gamma'), 3)
    }
    await browser.close()
  }
}

/* ------------------------------------------------------------------- run */

let PAGE
try {
  PAGE = process.env.PAGE ?? (await bootHost())
  for (const kind of BROWSERS) {
    if (!pw[kind]) throw new Error(`no browser called ${kind}`)
    await drive(kind, pw[kind])
  }
} catch (error) {
  failures.push(`the drive itself failed: ${error.stack ?? error}`)
  console.log(failures.at(-1))
}
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.log(`  - ${failure}`)
  if (KEEP) console.log(`scratch host kept at ${ROOT}`)
} else console.log('\nevery page took the pointer, the keyboard and the wheel')
stop()
process.exit(failures.length ? 1 : 0)
