/*
 * Does a new module take the first free space that fits, and is it shown where
 * it landed? On a scratch host (`dev/scratch-host.mjs`), in WebKit and Chromium:
 *
 *     node dev/place-in-gaps.drive.mjs               # SHOTS=<dir> saves screenshots
 *     BROWSERS=webkit node dev/place-in-gaps.drive.mjs
 *     MODE=before SHOTS=<dir> node dev/place-in-gaps.drive.mjs   # screenshots only (for the old rule)
 *
 * Two arrangements with a hole: one at the top (a full-size hole beside the
 * first container) and one low down on a short window (the hole is below the
 * fold, so the canvas must scroll to it). Adding Gamma from the modules list
 * must put it in the hole, ring it (`data-landed`, fading over about 1.2 s; a
 * static outline cleared by the next press under reduced motion), scroll it into
 * view, and leave keyboard focus exactly where it was.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { bootHost, scratch } from './scratch-host.mjs'

const BROWSERS = (process.env.BROWSERS ?? 'webkit,chromium').split(',').filter(Boolean)
const SHOTS = process.env.SHOTS ?? null
const BEFORE = process.env.MODE === 'before'
const pw = await import('playwright-core')
const failures = []
const say = (line) => console.log(line)
const expect = (ok, what) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const SCENES = {
  top: {
    size: { width: 1280, height: 900 },
    placements: [
      { i: 'kehikot.alpha', x: 0, y: 0, w: 6, h: 10 },
      { i: 'kehikot.beta', x: 0, y: 10, w: 12, h: 18 },
    ],
    lands: { x: 6, y: 0, w: 6, h: 10 },
  },
  low: {
    size: { width: 1100, height: 520 },
    placements: [
      { i: 'kehikot.alpha', x: 0, y: 0, w: 12, h: 18 },
      { i: 'kehikot.beta', x: 0, y: 18, w: 6, h: 10 },
    ],
    lands: { x: 6, y: 18, w: 6, h: 10 },
  },
}

const send = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${scratch.api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${scratch.page}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.json()
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
  for (const [name, scene] of Object.entries(SCENES)) {
    for (const reduced of BEFORE ? [false] : [false, true]) {
      const run = `${kind} ${name}${reduced ? ' (reduced motion)' : ''}`
      await send('PATCH', `/host/canvases/${target.id}`, { placements: scene.placements })
      const context = await browser.newContext({
        viewport: scene.size,
        reducedMotion: reduced ? 'reduce' : 'no-preference',
      })
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
      await page.waitForSelector('[data-module="kehikot.beta"]', { timeout: 15000 })
      await page.waitForTimeout(800)
      if (SHOTS && !reduced) {
        mkdirSync(SHOTS, { recursive: true })
        await page.screenshot({ path: join(SHOTS, `${BEFORE ? 'before' : 'after'}-${kind}-${name}-0-hole.png`) })
      }
      await page.locator('button[aria-label="Kehikko modules"]').click()
      const row = page.locator('li', { hasText: 'Gamma' }).first()
      const add = row.locator('button', { hasText: /^add$/ })
      await add.focus()
      await add.click()
      const focused = () => page.evaluate(() => document.activeElement?.tagName + '|' + (document.activeElement?.getAttribute('aria-label') ?? ''))
      const focusAfterClick = await focused()
      if (BEFORE) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(1800)
        await page.screenshot({ path: join(SHOTS, `before-${kind}-${name}-1-added.png`) })
        await context.close()
        continue
      }
      await page.waitForSelector('[data-module="kehikot.gamma"]', { timeout: 10000 })
      await page.waitForFunction(() => document.querySelector('[data-module="kehikot.gamma"]')?.hasAttribute('data-landed'), null, { timeout: 5000 })
      expect(true, `${run}: the container is ringed when it lands`)
      const ring = await page.evaluate(() => {
        const el = document.querySelector('[data-module="kehikot.gamma"]')
        const s = getComputedStyle(el)
        return { outline: s.outlineStyle, width: s.outlineWidth, animation: s.animationName }
      })
      expect(ring.outline === 'solid' && parseFloat(ring.width) >= 2, `${run}: the ring is an outline (${ring.outline} ${ring.width})`)
      expect(reduced ? ring.animation === 'none' : ring.animation === 'landed-fade', `${run}: ${reduced ? 'no animation under reduced motion' : 'the ring fades'} (${ring.animation})`)
      if (SHOTS && !reduced) await page.screenshot({ path: join(SHOTS, `after-${kind}-${name}-1-ringed.png`) })
      // In view: wholly inside the scrolling canvas.
      const view = await page.evaluate(() => {
        const el = document.querySelector('[data-module="kehikot.gamma"]').getBoundingClientRect()
        const main = document.querySelector('main').getBoundingClientRect()
        return { top: el.top - main.top, bottom: main.bottom - el.bottom, left: el.left, scrolled: document.querySelector('main').scrollTop }
      })
      expect(view.top >= -1 && view.bottom >= -1, `${run}: it is in view (top ${Math.round(view.top)}, bottom margin ${Math.round(view.bottom)}, scrolled ${Math.round(view.scrolled)})`)
      if (name === 'low') expect(view.scrolled > 0, `${run}: the canvas scrolled to it`)
      expect(await focused() === focusAfterClick, `${run}: the ring and the scroll left keyboard focus alone (${focusAfterClick})`)
      await page.waitForTimeout(2000)
      const still = await page.evaluate(() => document.querySelector('[data-module="kehikot.gamma"]').hasAttribute('data-landed'))
      if (reduced) {
        expect(still, `${run}: the static outline stays until the next interaction`)
        await page.mouse.click(5, 5)
        await page.waitForTimeout(100)
        const cleared = await page.evaluate(() => !document.querySelector('[data-module="kehikot.gamma"]').hasAttribute('data-landed'))
        expect(cleared, `${run}: it clears on the next press`)
      } else {
        expect(!still, `${run}: the ring is gone after the fade`)
      }
      // Where it was stored.
      const stored = (await (await fetch(`http://127.0.0.1:${scratch.api}/host/canvases`)).json()).canvases.find((one) => one.id === target.id).placements.find((p) => p.i === 'kehikot.gamma')
      const l = scene.lands
      expect(stored && stored.x === l.x && stored.y === l.y && stored.w === l.w && stored.h === l.h, `${run}: stored at ${JSON.stringify(stored && { x: stored.x, y: stored.y, w: stored.w, h: stored.h })}, wanted ${JSON.stringify(l)}`)
      if (SHOTS && !reduced) {
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(SHOTS, `after-${kind}-${name}-2-settled.png`) })
      }
      await context.close()
    }
  }
  await browser.close()
}

try {
  const PAGE = await bootHost('kehikko-place-in-gaps')
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
