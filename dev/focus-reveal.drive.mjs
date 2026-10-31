/*
 * Focus mode's reveal, for real (`src/host/reveal.ts`, the `.focus-mode` rules in `src/index.css`).
 *
 * In WebKit and Chromium, light and dark, with the stand-in Alpha declaring a footer:
 *
 *   - at rest in focus mode the header and footer rows are 0 px tall and the module's page fills
 *     the container's body;
 *   - the pointer over the MIDDLE of the page (not an edge) reveals both, and they PUSH: the page's
 *     box shrinks by the two rows, its top is at the header's bottom and its bottom at the footer's
 *     top, and nothing of the header or footer overlaps the page;
 *   - no flicker: sampled every 40 ms for 1.5 s with the pointer held still, the reveal never drops;
 *   - the pointer leaving the container hides both again and the page has its full height back;
 *   - with reduced motion asked for, the rows have no transition.
 *
 * And with the stand-in Beta saying `reveal: 'over'` (protocol 2.42.0), a terminal-like page:
 *
 *   - the pointer over it reveals both rows OVER the page: the page's box, its body and the page's
 *     own screen keep their size exactly, and the page sees NO resize (what a pty would be told);
 *   - the page's last line is moved above the footer (`kehikot.covered`, `keepInView`) and nothing
 *     of the header or footer overlaps it; leaving puts it back, still without a resize.
 *
 *     node dev/focus-reveal.drive.mjs            # BROWSERS=webkit to pick one
 *
 * Screenshots go to `FOCUS_REVEAL_SHOTS`, else beside the shared port claims, else `/tmp/kehikko-focus-reveal`.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { bootHost, stop } from './scratch-host.mjs'

const BROWSERS = (process.env.BROWSERS ?? 'webkit,chromium').split(',').filter(Boolean)
const SHOTS =
  process.env.FOCUS_REVEAL_SHOTS ??
  (process.env.KEHIKOT_SCRATCH_PORTS ? join(dirname(process.env.KEHIKOT_SCRATCH_PORTS), 'focus-reveal-shots') : (process.env.SHOTS ?? '/tmp/kehikko-focus-reveal'))
const MODULE = 'kehikot.alpha'
const OVER = 'kehikot.beta'
const FOOTER = [
  { kind: 'text', id: 'status', text: 'Ready' },
  { kind: 'meter', id: 'context', label: 'Context', value: 0.5 },
  { kind: 'run', id: 'compact', label: 'Compact', icon: 'refresh', align: 'end' },
]

const pw = await import('playwright-core')
const failures = []
const say = (line) => console.log(line)
mkdirSync(SHOTS, { recursive: true })

/** The boxes that matter, measured in the page. */
const BOXES = (id) => {
  const box = document.querySelector(`[data-module="${id}"]`)
  const r = (el) => (el ? el.getBoundingClientRect() : null)
  const plain = (b) => (b ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height } : null)
  const frame = document.querySelector(`[data-frame="${id}"]`)
  return {
    container: plain(r(box)),
    header: plain(r(box.querySelector('.container-reveal'))),
    footer: plain(r(box.querySelector('.container-footer-reveal'))),
    body: plain(r(box.querySelector('[data-body]'))),
    frame: plain(r(frame)),
    revealed: box.querySelector('.container-reveal')?.hasAttribute('data-revealed') ?? false,
    transition: getComputedStyle(box.querySelector('.container-footer-reveal') ?? box).transitionDuration,
  }
}

const overlaps = (a, b) => a && b && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5

/** The over page's own frame: the one whose stand-in is Beta. */
async function overFrame(page) {
  for (const frame of page.frames()) {
    if ((await frame.evaluate(() => window.__standin?.id).catch(() => null)) === OVER) return frame
  }
  throw new Error('the over page is not framed')
}

/** In the over page: its resizes so far, its screen's size, and its last line's box. */
const INSIDE = () => {
  const r = document.getElementById('last').getBoundingClientRect()
  const s = document.getElementById('screen').getBoundingClientRect()
  return { resizes: window.__standinResizes, covered: window.__standinCovered.slice(-1)[0] ?? null, screen: { width: s.width, height: s.height }, last: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
}

/*
 * A module that says `reveal: 'over'`: hovering reveals the rows over it, and nothing about it is resized.
 */
async function over(page, run, bad) {
  await page.mouse.move(2, 790, { steps: 4 })
  await page.waitForTimeout(700)
  await page.waitForSelector(`[data-module="${OVER}"] .container-footer-reveal`, { state: 'attached', timeout: 30000 })
  const frame = await overFrame(page)
  await frame.waitForFunction(() => window.__standinResizes !== undefined, null, { timeout: 15000 })
  const rest = await page.evaluate(BOXES, OVER)
  const inRest = await frame.evaluate(INSIDE)
  if (rest.header.height > 0.5 || rest.footer.height > 0.5) bad.push(`over: at rest the rows are ${rest.header.height}/${rest.footer.height}px`)
  if (Math.abs(rest.frame.bottom - (rest.frame.top + inRest.last.bottom)) > 2) bad.push(`over: at rest the last line is not on the page's bottom edge (${inRest.last.bottom} in ${rest.frame.height})`)

  await page.mouse.move((rest.frame.left + rest.frame.right) / 2, (rest.frame.top + rest.frame.bottom) / 2, { steps: 4 })
  await page.waitForTimeout(700)
  const shown = await page.evaluate(BOXES, OVER)
  const inShown = await frame.evaluate(INSIDE)
  if (!shown.revealed) bad.push('over: the pointer over the page did not reveal')
  if (Math.abs(shown.header.height - 32) > 1.5 || Math.abs(shown.footer.height - 32) > 1.5) bad.push(`over: revealed rows are ${shown.header.height}/${shown.footer.height}px`)
  for (const side of ['top', 'bottom', 'height']) {
    if (Math.abs(shown.frame[side] - rest.frame[side]) > 0.5) bad.push(`over: the page's ${side} moved from ${rest.frame[side]} to ${shown.frame[side]}`)
    if (Math.abs(shown.body[side] - rest.body[side]) > 0.5) bad.push(`over: the body's ${side} moved from ${rest.body[side]} to ${shown.body[side]}`)
  }
  if (inShown.screen.height !== inRest.screen.height || inShown.screen.width !== inRest.screen.width) bad.push(`over: the page's screen went from ${inRest.screen.width}x${inRest.screen.height} to ${inShown.screen.width}x${inShown.screen.height}`)
  if (inShown.resizes !== inRest.resizes) bad.push(`over: the page saw ${inShown.resizes - inRest.resizes} resize(s) on reveal`)
  if (!inShown.covered || inShown.covered.top !== 32 || inShown.covered.bottom !== 32) bad.push(`over: the page was told ${JSON.stringify(inShown.covered)}, not 32/32`)
  const last = { top: shown.frame.top + inShown.last.top, bottom: shown.frame.top + inShown.last.bottom, left: shown.frame.left + inShown.last.left, right: shown.frame.left + inShown.last.right }
  if (last.bottom > shown.footer.top + 0.5) bad.push(`over: the last line ends at ${last.bottom}, under the footer at ${shown.footer.top}`)
  if (overlaps(shown.footer, last) || overlaps(shown.header, last)) bad.push('over: a row overlaps the last line')
  await page.screenshot({ path: join(SHOTS, `${run.replace(/ /g, '-')}-over-revealed.png`), clip: { x: shown.container.left, y: shown.container.top, width: shown.container.right - shown.container.left, height: shown.container.bottom - shown.container.top } })

  await page.mouse.move(2, 790, { steps: 6 })
  await page.waitForTimeout(800)
  const after = await page.evaluate(BOXES, OVER)
  const inAfter = await frame.evaluate(INSIDE)
  if (after.revealed) bad.push('over: leaving did not hide the rows')
  if (Math.abs(after.frame.height - rest.frame.height) > 0.5) bad.push(`over: the page's height changed (${after.frame.height} vs ${rest.frame.height})`)
  if (inAfter.resizes !== inRest.resizes) bad.push(`over: the page saw ${inAfter.resizes - inRest.resizes} resize(s) over the whole hover`)
  if (Math.abs(inAfter.last.bottom - inRest.last.bottom) > 0.5) bad.push(`over: the last line did not come back (${inAfter.last.bottom} vs ${inRest.last.bottom})`)
  say(`     ${run} over: page ${Math.round(rest.frame.height)}px at rest and revealed, ${inAfter.resizes - inRest.resizes} resizes, last line ${Math.round(last.bottom)} above footer ${Math.round(shown.footer.top)}`)
}

async function drive(kind, browserType) {
  let browser
  try {
    browser = await browserType.launch()
  } catch (error) {
    failures.push(`${kind}: cannot launch (${String(error.message).split('\n')[0]})`)
    return
  }
  for (const scheme of ['light', 'dark']) {
    for (const reduced of [false, true]) {
      const run = `${kind} ${scheme}${reduced ? ' reduced-motion' : ''}`
      const context = await browser.newContext({ viewport: { width: 1400, height: 800 }, colorScheme: scheme, reducedMotion: reduced ? 'reduce' : 'no-preference' })
      await context.addCookies([
        { name: 'kehikko.theme', value: scheme, url: PAGE },
        { name: 'kehikko.focus', value: 'on', url: PAGE },
      ])
      const page = await context.newPage()
      page.on('pageerror', (error) => failures.push(`${run}: the page threw: ${error.message}`))
      try {
        await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
        await page.waitForSelector(`[data-module="${MODULE}"] .container-footer-reveal`, { state: 'attached', timeout: 30000 })
        for (let tries = 0; tries < 6 && (await page.locator('[role="dialog"]').count()); tries += 1) {
          const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
          if (await myself.count()) await myself.first().click()
          else await page.keyboard.press('Escape')
          await page.waitForTimeout(400)
        }
        if (!(await page.evaluate(() => document.documentElement.classList.contains('focus-mode')))) throw new Error('focus mode is not on')
        await page.mouse.move(2, 790)
        await page.waitForTimeout(600)
        const rest = await page.evaluate(BOXES, MODULE)
        const bad = []
        if (rest.header.height > 0.5 || rest.footer.height > 0.5) bad.push(`at rest the rows are ${rest.header.height}/${rest.footer.height}px`)
        if (Math.abs(rest.frame.height - rest.body.height) > 1) bad.push(`at rest the page is ${rest.frame.height}px in a ${rest.body.height}px body`)
        await page.screenshot({ path: join(SHOTS, `${run.replace(/ /g, '-')}-rest.png`), clip: { x: rest.container.left, y: rest.container.top, width: rest.container.right - rest.container.left, height: rest.container.bottom - rest.container.top } })

        /* The middle of the page: no edge strip involved. */
        const mid = { x: (rest.frame.left + rest.frame.right) / 2, y: (rest.frame.top + rest.frame.bottom) / 2 }
        await page.mouse.move(mid.x, mid.y, { steps: 4 })
        await page.waitForTimeout(500)
        const shown = await page.evaluate(BOXES, MODULE)
        if (!shown.revealed) bad.push('the pointer over the middle of the page did not reveal')
        if (Math.abs(shown.header.height - 32) > 1.5 || Math.abs(shown.footer.height - 32) > 1.5) bad.push(`revealed rows are ${shown.header.height}/${shown.footer.height}px`)
        if (rest.frame.height - shown.frame.height < 60) bad.push(`the page shrank by ${(rest.frame.height - shown.frame.height).toFixed(1)}px, not by the two rows`)
        if (Math.abs(shown.frame.top - shown.header.bottom) > 1.5) bad.push(`the page top ${shown.frame.top} is not at the header's bottom ${shown.header.bottom}`)
        if (Math.abs(shown.frame.bottom - shown.footer.top) > 1.5) bad.push(`the page bottom ${shown.frame.bottom} is not at the footer's top ${shown.footer.top}`)
        if (overlaps(shown.header, shown.frame)) bad.push('the header overlaps the page')
        if (overlaps(shown.footer, shown.frame)) bad.push('the footer overlaps the page')
        if (shown.footer.bottom > shown.container.bottom + 1) bad.push('the footer overflows the container')
        await page.screenshot({ path: join(SHOTS, `${run.replace(/ /g, '-')}-revealed.png`), clip: { x: shown.container.left, y: shown.container.top, width: shown.container.right - shown.container.left, height: shown.container.bottom - shown.container.top } })

        /* No flicker: the pointer held still where the page was pushed from. */
        const samples = []
        for (let n = 0; n < 38; n += 1) {
          samples.push(await page.evaluate((id) => document.querySelector(`[data-module="${id}"] .container-reveal`)?.hasAttribute('data-revealed'), MODULE))
          await page.waitForTimeout(40)
        }
        if (samples.some((one) => !one)) bad.push(`the reveal dropped while the pointer held still (${samples.filter((one) => !one).length} of ${samples.length} samples)`)
        /* And the pointer moved onto the header it revealed, then the footer: still revealed. */
        await page.mouse.move(mid.x, shown.header.top + 16, { steps: 6 })
        await page.mouse.move(mid.x, shown.footer.top + 16, { steps: 12 })
        await page.waitForTimeout(400)
        if (!(await page.evaluate(BOXES, MODULE)).revealed) bad.push('moving onto the header and footer hid them')

        /* Gone: the pointer off the container. */
        await page.mouse.move(2, 790, { steps: 6 })
        await page.waitForTimeout(700)
        const after = await page.evaluate(BOXES, MODULE)
        if (after.revealed || after.header.height > 0.5 || after.footer.height > 0.5) bad.push('leaving the container did not hide the rows')
        if (Math.abs(after.frame.height - rest.frame.height) > 1) bad.push(`the page did not get its height back (${after.frame.height} vs ${rest.frame.height})`)
        if (reduced && after.transition !== '0s') bad.push(`with reduced motion the footer row still transitions (${after.transition})`)
        if (!reduced && after.transition === '0s') bad.push('the footer row has no transition')

        await over(page, run, bad)

        say(`${bad.length ? 'FAIL' : 'ok  '} ${run}: page ${Math.round(rest.frame.height)}px at rest, ${Math.round(shown.frame.height)}px revealed, rows ${Math.round(shown.header.height)}/${Math.round(shown.footer.height)}px, transition ${after.transition}${bad.length ? `\n      ${bad.join('\n      ')}` : ''}`)
        for (const one of bad) failures.push(`${run}: ${one}`)
      } catch (error) {
        failures.push(`${run}: ${error.message}`)
        say(`FAIL ${run}: ${error.message}`)
      }
      await context.close()
    }
  }
  await browser.close()
}

let PAGE
try {
  PAGE = process.env.PAGE ?? (await bootHost('kehikko-focus-reveal', { standin: (id) => (id === MODULE ? { STANDIN_FOOTER: JSON.stringify(FOOTER) } : id === OVER ? { STANDIN_FOOTER: JSON.stringify(FOOTER), STANDIN_REVEAL: 'over' } : {}) }))
  for (const kind of BROWSERS) await drive(kind, pw[kind])
} catch (error) {
  failures.push(`the drive itself failed: ${error.stack ?? error}`)
}
say(`screenshots: ${SHOTS}`)
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.log(`  - ${failure}`)
} else console.log('\nin focus mode the header and footer reveal on hover anywhere and push the page, without covering it or flickering, in WebKit and Chromium, light and dark; and over a reveal-over page without resizing it or covering its last line')
stop()
process.exit(failures.length ? 1 : 0)
