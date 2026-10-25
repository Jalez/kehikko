/*
 * "What's new" after an update waits in the bar: in WebKit — the desktop
 * app's engine — with a REAL pointer and keyboard, on a scratch host of its
 * own (`dev/scratch-host.mjs`; nothing of the person's machine is touched).
 *
 *     node dev/whats-new-notice.drive.mjs
 *     SHOTS=/tmp/shots node dev/whats-new-notice.drive.mjs   # and screenshots
 *
 * `bun test` runs it (`test/whats-new-notice.test.ts`). Exits 0 when every
 * check passes.
 *
 * The update is simulated: the host's record says Kehikot 0.1.60 was the last
 * acknowledged, and the page is told by a stand-in desktop shell
 * (`__TAURI_INTERNALS__`, as `appUpdate.ts` reads it) that it runs 0.1.61.
 * GitHub's release list is held unanswered throughout, so a notice that
 * waited for it would never come.
 *
 *   1. The notice is drawn within a second of the bar, and the dialog never
 *      opens by itself.
 *   2. With the pointer clicked into a module's field and the keyboard typing,
 *      the notice arrives (its read held back until then) within a second,
 *      focus stays in the module's frame, and every key reached the field.
 *   3. Its forms: light, dark, "What's new" at 1000 pixels, the icon at 880 and 600,
 *      the bar one 32-pixel row throughout. Pressed with the pointer, the
 *      dialog opens, the notice goes, and 0.1.61 is acknowledged.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { bootHost, stop } from './scratch-host.mjs'

const pw = await import('playwright-core')
const SHOTS = process.env.SHOTS ?? null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const failures = []
const say = (line) => console.log(line)
const check = (ok, line) => {
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${line}`)
  if (!ok) failures.push(line)
}

const NOTICE = '[data-testid="whats-new-notice"]'
const WAS = '0.1.60'
const NOW = '0.1.61'

/* The desktop shell, as far as the page asks it: it runs 0.1.61 and is up to date. */
const SHELL = `
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd) =>
      cmd === 'update_status' || cmd === 'check_for_update'
        ? { enabled: true, current: '${NOW}', state: 'uptodate', version: null, progress: null, error: null, checkedAt: Date.now() }
        : null,
  }
  /* When the bar and the notice were first drawn, on the page's own clock. */
  new MutationObserver(() => {
    if (window.__barAt === undefined && document.querySelector('[data-testid="settings-gear"]')) window.__barAt = performance.now()
    if (window.__noticeAt === undefined && document.querySelector('${NOTICE}')) window.__noticeAt = performance.now()
  }).observe(document, { subtree: true, childList: true })
`

async function press(page, locator) {
  await locator.waitFor({ state: 'visible' })
  const box = await locator.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/** A fresh host asks, once, whether to keep the agent set up; the introduction may follow. */
async function clearFirstRun(page) {
  for (let tries = 0; tries < 8; tries += 1) {
    await page.waitForTimeout(400)
    if (!(await page.locator('[role="dialog"]').count())) return
    const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
    if (await myself.count()) await press(page, myself.first())
    else await page.keyboard.press('Escape')
  }
}

async function context(browser, { scheme = 'light', width = 1400, height = 900 } = {}) {
  const made = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 })
  await made.addCookies([{ name: 'kehikko.theme', value: scheme, url: PAGE }])
  await made.addInitScript(SHELL)
  /* GitHub's release list never answers: the notice must not wait for it. */
  await made.route(
    (url) => url.pathname === '/host/releases',
    () => {},
  )
  const page = await made.newPage()
  page.on('pageerror', (error) => failures.push(`the page threw: ${error.message}`))
  return { made, page }
}

async function canvasShown(page) {
  await page.waitForSelector('[data-frame]', { state: 'attached', timeout: 30000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-frame]').length >= 3, null, { timeout: 30000 })
  await page.waitForFunction(() => (document.querySelector('[data-switch]')?.getAttribute('data-switch') ?? 'shown') === 'shown', null, { timeout: 30000 })
}

async function shot(page, name, { bar = false } = {}) {
  if (!SHOTS) return
  const path = join(SHOTS, `${name}.png`)
  const size = page.viewportSize()
  await page.screenshot({ path, ...(bar ? { clip: { x: 0, y: 0, width: size.width, height: 32 } } : {}) })
  say(`  shot ${path}`)
}

const barRow = (page) => page.evaluate(() => document.querySelector('header')?.getBoundingClientRect().height ?? 0)

/* ------------------------------------------------------------------ run */

let PAGE
let API
try {
  PAGE = await bootHost('whats-new-notice')
  API = `http://127.0.0.1:${Number(new URL(PAGE).port) - 1}`
  /* What an app that has since updated would have recorded: 0.1.60 acknowledged. */
  const recorded = await fetch(`${API}/host/whats-new`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(PAGE).origin },
    body: JSON.stringify({ baseline: { app: WAS } }),
  })
  if (!recorded.ok) throw new Error(`could not record ${WAS}: ${recorded.status} ${await recorded.text()}`)

  let browser
  try {
    browser = await pw.webkit.launch()
  } catch (error) {
    failures.push(`webkit: cannot launch (${String(error.message).split('\n')[0]}). Install it with: bunx playwright-core install webkit`)
    throw error
  }

  say('[webkit] 1. the notice, at once')
  {
    const { made, page } = await context(browser)
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
    await page.locator(NOTICE).waitFor({ state: 'visible', timeout: 10000 })
    const { barAt, noticeAt } = await page.evaluate(() => ({ barAt: window.__barAt, noticeAt: window.__noticeAt }))
    const after = Math.round(noticeAt - barAt)
    check(after <= 1000, `the notice was drawn ${after} ms after the bar (${Math.round(noticeAt)} ms after navigation), with GitHub silent`)
    check((await page.locator(`${NOTICE} [data-notice-text]`).textContent()) === `What’s new in ${NOW}`, `it says “What’s new in ${NOW}”`)
    await page.waitForTimeout(1500)
    check((await page.locator('[data-whats-new]').count()) === 0, 'the dialog did not open by itself')
    await clearFirstRun(page)
    await canvasShown(page)
    await page.waitForTimeout(800)
    check((await page.locator('[data-whats-new]').count()) === 0, 'nor once the first-run windows were closed')
    await shot(page, 'light')
    await shot(page, 'light-bar', { bar: true })
    await made.close()
  }

  say('[webkit] 2. typing in a module while it arrives')
  {
    const { made, page } = await context(browser)
    /* The page's read of what is new is held until the person is typing in a module. */
    let release
    const held = new Promise((resolve) => (release = resolve))
    await made.route(
      (url) => url.pathname === '/host/whats-new',
      async (route) => {
        if (route.request().method() === 'GET') await held
        await route.continue()
      },
    )
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
    await canvasShown(page)
    await page.waitForTimeout(1500)
    const frame = page.frames().find((one) => one !== page.mainFrame() && one.url().includes('127.0.0.1') && !one.url().startsWith(PAGE))
    const field = frame.locator('#field')
    await field.waitFor({ state: 'visible', timeout: 10000 })
    const box = await field.boundingBox()
    await page.mouse.click(box.x + 10, box.y + box.height / 2)
    const first = 'typing in a module, '
    const second = 'and the notice arrives meanwhile'
    await page.keyboard.type(first, { delay: 25 })
    check((await page.locator(NOTICE).count()) === 0, 'no notice while its read was held')
    const releasedAt = await page.evaluate(() => performance.now())
    release()
    await page.keyboard.type(second, { delay: 40 })
    const noticeAt = await page.evaluate(() => window.__noticeAt)
    const after = noticeAt === undefined ? null : Math.round(noticeAt - releasedAt)
    check(after !== null && after <= 1000, `the notice was drawn ${after} ms after its read was let through, mid-typing`)
    check(await page.locator(NOTICE).isVisible(), 'the notice is visible while focus is in the module')
    check((await page.evaluate(() => document.activeElement?.tagName)) === 'IFRAME', 'focus stayed in the module’s frame')
    check((await field.inputValue()) === first + second, 'every key reached the module’s field')
    check((await page.locator('[data-whats-new]').count()) === 0, 'and no dialog opened')
    await made.close()
  }

  say('[webkit] 3. dark, narrow, and pressed')
  {
    const { made, page } = await context(browser, { scheme: 'dark' })
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
    await canvasShown(page)
    await page.locator(NOTICE).waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForTimeout(600)
    await shot(page, 'dark')
    await shot(page, 'dark-bar', { bar: true })
    await made.close()
  }
  for (const [width, form] of [
    [1000, 'short'],
    [880, 'icon'],
    [600, 'icon'],
  ]) {
    const { made, page } = await context(browser, { width, height: 700 })
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
    await canvasShown(page)
    const notice = page.locator(NOTICE)
    await notice.waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForTimeout(600)
    const shown = await page.evaluate((sel) => {
      const one = document.querySelector(sel)
      const seen = (q) => {
        const el = one.querySelector(q)
        return !!el && getComputedStyle(el).display !== 'none'
      }
      return { text: seen('[data-notice-text]'), short: seen('[data-notice-short]'), icon: seen('svg'), dot: seen('[data-notice-dot]'), label: one.getAttribute('aria-label') }
    }, NOTICE)
    if (form === 'short') check(!shown.text && shown.short && !shown.icon && shown.dot, `${width} px: a dot and “What’s new”`)
    else check(!shown.text && !shown.short && shown.icon, `${width} px: its icon alone`)
    check(shown.label === `What’s new: Kehikot ${NOW} — press to read`, `${width} px: the accessible name is the whole of it`)
    const row = await barRow(page)
    check(row === 32, `${width} px: the bar is one 32-pixel row (${row})`)
    await shot(page, `narrow-${width}`)
    await shot(page, `narrow-${width}-bar`, { bar: true })
    await made.close()
  }
  {
    const { made, page } = await context(browser)
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
    await canvasShown(page)
    await press(page, page.locator(NOTICE))
    await page.locator('[data-whats-new]').waitFor({ state: 'visible', timeout: 5000 })
    check(true, 'pressed with the pointer, the dialog opened')
    check((await page.locator(NOTICE).count()) === 0, 'and the notice went')
    await page.waitForTimeout(500)
    await shot(page, 'dialog')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    const record = await (await fetch(`${API}/host/whats-new?only=record`)).json()
    check(record.record?.app === NOW, `${NOW} is acknowledged (${record.record?.app})`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await canvasShown(page)
    await page.waitForTimeout(1200)
    check((await page.locator(NOTICE).count()) === 0, 'after a reload there is no notice')
    /* The same bar with nothing to tell, at the narrow widths, to set the notice's beside. */
    for (const width of [1000, 880, 600]) {
      await page.setViewportSize({ width, height: 700 })
      await page.waitForTimeout(400)
      await shot(page, `without-${width}-bar`, { bar: true })
    }
    await made.close()
  }
  await browser.close()
} catch (error) {
  failures.push(`the drive stopped: ${error.message}`)
} finally {
  stop()
}

if (failures.length) {
  say(`\n${failures.length} failed:`)
  for (const one of failures) say(`  ${one}`)
  process.exit(1)
}
say('\nthe notice waited in the bar, and typing in the module went on')
