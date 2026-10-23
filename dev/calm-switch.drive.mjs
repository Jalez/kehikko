/*
 * Switch kehikko and project with a real pointer, and record where every
 * container and every module page is drawn on every painted frame.
 *
 *     PLAYWRIGHT=…/playwright-core/index.mjs CHROME=…/chrome-headless-shell \
 *       node dev/calm-switch.drive.mjs [page url] [out dir]
 *
 * ## What it establishes
 *
 * The person's words: "the app fidgeting every time we change to a new
 * kehikko/project … I'd rather not see that." A fidget is a thing that is
 * VISIBLE and MOVES: a container or a page whose rectangle changes between two
 * painted frames while it can be seen. So this samples, on every animation
 * frame from the press until well after things have stopped, each container
 * (`[data-module]`) and each page (`[data-frame]`), with its rectangle and
 * whether it can be seen (its own `visibility`, and the product of its
 * ancestors' `opacity`). A move of something that cannot be seen is not a
 * fidget — that is what preparing a kehikko out of sight is for.
 *
 * `moves` is the count of those visible moves after the press, per switch.
 * `afterShown` is the same count from the moment the incoming kehikko started
 * to be shown (the canvas's `data-switch` leaves `preparing`); the fix holds it
 * at zero. Exits 0 when `afterShown` is 0 for every switch back to a kehikko
 * or project already visited in the run. A first visit is printed and not
 * judged: its pages load for the first time, and a module that asks to grow
 * when it is first greeted moves its column, which is the module's to do.
 *
 * ## Run it against a scratch host, never the real one
 *
 * It switches kehikot and projects; it writes nothing, but a person's own host
 * is a person's own afternoon. A scratch host with stand-in modules and two
 * projects of two kehikot each is what the PR that added this was measured on
 * (see its description). `SHOTS=1` also records a video of the run in the out
 * directory, for turning into a frame sequence.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT ?? '/private/tmp/pw/node_modules/playwright-core/index.mjs')

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4691/'
const OUT = process.argv[3] ?? '/tmp/calm-switch'
const VIDEO = process.env.SHOTS === '1'
/* Each switch, in order: [what to press, which row]. The first visit to a
   kehikko loads its pages; the second is the one the kept frames make free. */
const STEPS = JSON.parse(
  process.env.STEPS ??
    JSON.stringify([
      ['kehikko', 'Tall'],
      ['kehikko', 'Wide'],
      ['kehikko', 'Tall'],
      ['project', 'project-b'],
      ['project', 'project-a'],
      ['project', 'project-b'],
    ]),
)
const WATCH_MS = Number(process.env.WATCH_MS ?? 1600)
/* For measuring one cause at a time: CSS put on the page before each press. */
const INJECT = process.env.INJECT ?? ''

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME })
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  ...(VIDEO ? { recordVideo: { dir: OUT, size: { width: 1400, height: 900 } } } : {}),
  reducedMotion: process.env.REDUCED === '1' ? 'reduce' : 'no-preference',
})
const page = await context.newPage()
const problems = []
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

/* The sampler, in the page: one row per painted frame. */
const SAMPLER = () => {
  const seen = (element) => {
    let opacity = 1
    for (let at = element; at && at !== document.documentElement; at = at.parentElement) {
      const style = getComputedStyle(at)
      if (style.display === 'none') return 0
      opacity *= Number(style.opacity)
    }
    if (getComputedStyle(element).visibility === 'hidden') return 0
    return opacity
  }
  const read = () => {
    const rows = []
    for (const element of document.querySelectorAll('[data-module], [data-frame]')) {
      const box = element.getBoundingClientRect()
      const id = element.getAttribute('data-module') ?? element.getAttribute('data-frame')
      rows.push({
        what: element.hasAttribute('data-frame') ? `page ${id}` : `container ${id}`,
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.width),
        h: Math.round(box.height),
        seen: Math.round(seen(element) * 100) / 100,
      })
    }
    /* The bar's own controls, and the canvas itself: a header row that
       reflows when a name changes moves everything after it. */
    for (const element of document.querySelectorAll('[data-tour]')) {
      if (element.closest('.react-grid-layout')) continue
      const box = element.getBoundingClientRect()
      rows.push({ what: `bar ${element.getAttribute('data-tour')}`, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), seen: seen(element) })
    }
    /* The still copy of the kehikko being left: it must fade, never move. */
    for (const element of document.querySelectorAll('[data-outgoing]')) {
      const box = element.getBoundingClientRect()
      rows.push({ what: 'outgoing', x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), seen: seen(element) })
    }
    const main = document.querySelector('main')
    if (main) {
      const box = main.getBoundingClientRect()
      rows.push({ what: 'canvas', x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), seen: 1 })
    }
    return rows
  }
  window.__samples = []
  window.__sampling = true
  const t0 = performance.now()
  const tick = () => {
    if (!window.__sampling) return
    const surface = document.querySelector('[data-switch]')
    window.__samples.push({
      t: Math.round(performance.now() - t0),
      phase: surface?.getAttribute('data-switch') ?? null,
      settling: !!document.querySelector('.react-grid-layout.settling'),
      rows: read(),
    })
    requestAnimationFrame(tick)
  }
  tick()
  return true
}

/** Visible moves: a thing seen in two consecutive frames at two places. */
function movesIn(samples, from = 0) {
  const moves = []
  for (let i = Math.max(1, from); i < samples.length; i += 1) {
    const before = new Map(samples[i - 1].rows.map((row) => [row.what, row]))
    for (const row of samples[i].rows) {
      const was = before.get(row.what)
      if (!was || was.seen <= 0.02 || row.seen <= 0.02) continue
      if (was.x !== row.x || was.y !== row.y || was.w !== row.w || was.h !== row.h) {
        moves.push({ t: samples[i].t, what: row.what, from: [was.x, was.y, was.w, was.h], to: [row.x, row.y, row.w, row.h], seen: row.seen })
      }
    }
  }
  return moves
}

async function press(kind, row) {
  const trigger = page.locator(`button[aria-label="switch ${kind}"]`)
  await trigger.click()
  const item = page.locator('[role="menuitem"]', { hasText: row }).first()
  await item.waitFor()
  await page.evaluate(SAMPLER)
  if (INJECT) await page.addStyleTag({ content: INJECT })
  await item.click()
  await page.waitForTimeout(WATCH_MS)
  return page.evaluate(() => {
    window.__sampling = false
    return window.__samples
  })
}

await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-module]')
await page.waitForTimeout(2500)
/* A fresh scratch host asks, once, whether to keep the agent set up. */
for (let tries = 0; tries < 6 && (await page.locator('[role="dialog"]').count()); tries += 1) {
  const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
  if (await myself.count()) await myself.first().click()
  else await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
}

const report = []
let failed = false
/* Where the page opened: the first kehikko of the first project. A switch to
   somewhere already visited in this run is held to zero; a first visit is
   reported, not judged — its pages load for the first time, and a module that
   asks to grow when it is first greeted is making a change of its own. */
const visited = new Set([`kehikko ${await page.locator('button[aria-label="switch kehikko"]').innerText()}`, `project ${await page.locator('button[aria-label="switch project"]').innerText()}`])
for (const [kind, row] of STEPS) {
  const again = visited.has(`${kind} ${row}`)
  visited.add(`${kind} ${row}`)
  const samples = await press(kind, row)
  const moves = movesIn(samples)
  const shownAt = samples.findIndex((s, i) => i > 0 && s.phase !== 'preparing' && samples.slice(0, i).some((p) => p.phase === 'preparing'))
  /* From the frame after the one the switch was shown on: that frame IS the
     swap — under reduced motion an instant one, in which a page on both
     kehikot is drawn at its new place along with everything else. */
  const after = shownAt < 0 ? moves : movesIn(samples, shownAt + 1)
  const shownT = shownAt < 0 ? null : samples[shownAt].t
  const settledT = samples.findLast((s, i) => i > 0 && JSON.stringify(s.rows) !== JSON.stringify(samples[i - 1].rows))?.t ?? 0
  const one = { switch: `${kind} → ${row}`, again, frames: samples.length, moves: moves.length, afterShown: after.length, shownAt: shownT, lastChange: settledT }
  report.push(one)
  const verdict = !again ? 'seen' : after.length === 0 ? 'ok  ' : 'FAIL'
  console.log(`${verdict} ${one.switch}${again ? '' : ' (first visit)'}: ${moves.length} visible moves, ${after.length} after shown (shown at ${shownT ?? '—'} ms, last change at ${settledT} ms)`)
  for (const move of moves.slice(0, 40)) console.log(`       ${move.t}ms ${move.what} ${move.from.join(',')} → ${move.to.join(',')} (seen ${move.seen})`)
  if (again && after.length) failed = true
  writeFileSync(join(OUT, `${report.length}-${kind}-${row}.json`), JSON.stringify(samples, null, 1))
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
await context.close()
await browser.close()
if (problems.length) console.log(problems.join('\n'))
process.exit(failed ? 1 : 0)
