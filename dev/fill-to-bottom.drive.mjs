/*
 * Does a kehikko fill to its bottom? On a scratch host (`dev/scratch-host.mjs`),
 * in Chromium and WebKit, at several window heights:
 *
 *     node dev/fill-to-bottom.drive.mjs                  # SHOTS=<dir> saves screenshots
 *     BROWSERS=chromium HEIGHTS=823 node dev/fill-to-bottom.drive.mjs
 *     MODE=before SHOTS=<dir> node dev/fill-to-bottom.drive.mjs   # a host from before: measure and shoot, judge nothing
 *
 * The person's report: "often times kehikko leaves some empty space at the
 * bottom to which you can't expand to." The rows used to be floored to whole
 * pixels (up to one a row left under the last), and twenty-eight of them made a
 * resize move in steps of thirty-odd pixels (`src/host/fit.ts`).
 *
 * Each height: Beta stands the full height of the right half, Alpha over Gamma
 * on the left, with free rows under Gamma. Gamma's bottom corner is pulled down
 * past the bottom of the window with the real pointer. Then Beta and Gamma must
 * both end within a pixel of the canvas's bottom less its 8-pixel gap — the
 * same gap there is at its right edge — Gamma must be stored reaching the last
 * row, and neither the canvas nor the page may scroll.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { bootHost, scratch } from './scratch-host.mjs'

const BROWSERS = (process.env.BROWSERS ?? 'chromium,webkit').split(',').filter(Boolean)
const SHOTS = process.env.SHOTS ?? null
const BEFORE = process.env.MODE === 'before'
/* The rows the host being driven counts in: a host from before had 28. */
const ROWS = BEFORE ? 28 : 56
const HEIGHTS = (process.env.HEIGHTS ?? '700,823,900,1117').split(',').map(Number)
const WIDTH = 1280
const GAP = 8
const CEILING = 20000
const pw = await import('playwright-core')
const failures = []
const say = (line) => console.log(line)
const expect = (ok, what) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}
const rows = (old) => (old * ROWS) / 28

/* And in the columns of the host it drives: twelve before, twenty-four now. */
const cols = (old) => (BEFORE ? old : old * 2)

const PLACEMENTS = [
  { i: 'kehikot.alpha', x: 0, y: 0, w: cols(6), h: rows(10) },
  { i: 'kehikot.gamma', x: 0, y: rows(10), w: cols(6), h: rows(8) },
  { i: 'kehikot.beta', x: cols(6), y: 0, w: cols(6), h: rows(28) },
]

const send = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${scratch.api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${scratch.page}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

const painted = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))

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

/** Where each container ends against the canvas, and whether anything scrolls. */
const MEASURE = () => {
  const main = document.querySelector('main')
  const canvas = main.getBoundingClientRect()
  const out = { room: main.clientHeight, fraction: canvas.height, scrolls: {}, items: {} }
  out.scrolls = {
    canvasDown: main.scrollHeight - main.clientHeight,
    canvasAcross: main.scrollWidth - main.clientWidth,
    pageDown: document.scrollingElement.scrollHeight - window.innerHeight,
  }
  for (const id of ['kehikot.alpha', 'kehikot.beta', 'kehikot.gamma']) {
    const item = document.querySelector(`[data-module="${id}"]`)?.closest('.react-grid-item')
    if (!item) continue
    const box = item.getBoundingClientRect()
    out.items[id] = { below: canvas.top + main.clientHeight - box.bottom, right: canvas.left + main.clientWidth - box.right, height: box.height }
  }
  return out
}

async function pullToBottom(page, id) {
  const item = page.locator('.react-grid-item', { has: page.locator(`[data-module="${id}"]`) }).first()
  /* Over its header, where the corners are revealed. */
  const grip = await steadyBox(page, item.locator('.container-grip').first())
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await painted(page)
  const handle = await steadyBox(page, item.locator('.react-resizable-handle-se'))
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }
  const to = (await page.evaluate(() => window.innerHeight)) - 1
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= 12; step += 1) await page.mouse.move(from.x, from.y + ((to - from.y) * step) / 12)
  await page.mouse.up()
  await page.waitForTimeout(700)
  await steadyBox(page, item)
}

async function drive(kind, browserType, PAGE) {
  let browser
  try {
    browser = await browserType.launch()
  } catch (error) {
    failures.push(`${kind}: cannot launch (${String(error.message).split('\n')[0]})`)
    return
  }
  const canvases = (await (await fetch(`http://127.0.0.1:${scratch.api}/host/canvases`)).json()).canvases
  const target = canvases.find((one) => one.name === 'Wide' && one.project === canvases[0].project)
  for (const height of HEIGHTS) {
    const run = `${kind} ${WIDTH}x${height}`
    await send('PATCH', `/host/canvases/${target.id}`, { placements: PLACEMENTS })
    const context = await browser.newContext({ viewport: { width: WIDTH, height } })
    const page = await context.newPage()
    page.on('pageerror', (error) => failures.push(`${run}: the page threw: ${error.message}`))
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-frame]', { state: 'attached', timeout: 30000 })
    for (let tries = 0; tries < 6 && (await page.locator('[role="dialog"]').count()); tries += 1) {
      const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
      if (await myself.count()) await myself.first().click()
      else await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
    await page.waitForSelector('[data-module="kehikot.gamma"]', { timeout: 15000 })
    await page.waitForTimeout(800)

    await pullToBottom(page, 'kehikot.gamma')
    /* The pointer off the canvas, so no hover state is in the picture. */
    await page.mouse.move(WIDTH / 2, 2)
    await page.waitForTimeout(300)
    const seen = await page.evaluate(MEASURE)
    const stored = (await (await fetch(`http://127.0.0.1:${scratch.api}/host/canvases`)).json()).canvases
      .find((one) => one.id === target.id)
      .placements.find((p) => p.i === 'kehikot.gamma')
    const beta = seen.items['kehikot.beta']
    const gamma = seen.items['kehikot.gamma']
    say(
      `${run}: canvas ${seen.room}px (${seen.fraction.toFixed(2)}), below beta ${beta?.below.toFixed(2)}, below gamma ${gamma?.below.toFixed(2)}, ` +
        `right of beta ${beta?.right.toFixed(2)}, gamma stored y ${stored?.y} h ${stored?.h} of ${ROWS}, scrolls ${JSON.stringify(seen.scrolls)}`,
    )
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true })
      await page.screenshot({ path: join(SHOTS, `${BEFORE ? 'before' : 'after'}-${kind}-${WIDTH}x${height}.png`) })
    }
    if (!BEFORE) {
      expect(!!beta && Math.abs(beta.below - GAP) <= 1, `${run}: Beta, stored at the bottom, ends ${beta?.below.toFixed(2)}px above the canvas's bottom (wanted ${GAP} ± 1)`)
      expect(!!gamma && Math.abs(gamma.below - GAP) <= 1, `${run}: Gamma, resized to the bottom, ends ${gamma?.below.toFixed(2)}px above the canvas's bottom (wanted ${GAP} ± 1)`)
      expect(!!beta && Math.abs(beta.below - beta.right) <= 1, `${run}: the gap below is the gap at the right (${beta?.below.toFixed(2)} and ${beta?.right.toFixed(2)})`)
      expect(stored && stored.y + stored.h === ROWS, `${run}: Gamma is stored reaching the last row (${stored && stored.y} + ${stored && stored.h})`)
      expect(seen.scrolls.canvasDown <= 0 && seen.scrolls.canvasAcross <= 0, `${run}: the canvas does not scroll (${seen.scrolls.canvasDown}, ${seen.scrolls.canvasAcross})`)
      expect(seen.scrolls.pageDown <= 0, `${run}: the page does not scroll (${seen.scrolls.pageDown})`)
    }
    await context.close()
  }
  await browser.close()
}

try {
  const PAGE = await bootHost('kehikko-fill-to-bottom')
  for (const kind of BROWSERS) await drive(kind, pw[kind], PAGE)
} catch (error) {
  failures.push(`the drive itself failed: ${error.stack ?? error}`)
}
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('\nall good')
process.exit(0)
