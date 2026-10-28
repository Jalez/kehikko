/*
 * A module's settings window, its "Providers & Consumers" tab, drawn for real: in WebKit (the
 * desktop app's engine) and Chromium, light and dark, at a typical window and a narrow one. The
 * three stand-ins are given what Paper, Notes and the Browser say in their manifests (the page reads
 * them from `/host/modules`), one connection is switched off through `POST /host/connections`, and
 * the window is opened from the gear in Beta's header.
 *
 *     node dev/connections.drive.mjs          # SHOTS=<dir> saves a screenshot per run
 *     PRINT_SHOTS=1 node dev/connections.drive.mjs   # also prints each as base64, for bee
 *
 * Fails when the tab is missing, an off connection does not say "off", or anything in the window
 * scrolls sideways. Runs on a scratch host (`dev/scratch-host.mjs`).
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { bootHost, scratch, stop } from './scratch-host.mjs'

const BROWSERS = (process.env.BROWSERS ?? 'chromium,webkit').split(',').filter(Boolean)
const SHOTS = process.env.SHOTS ?? null
const PRINT = process.env.PRINT_SHOTS === '1'
const SIZES = [
  ['typical', 1280, 860],
  ['narrow', 380, 760],
]
const pw = await import('playwright-core')
const failures = []
const say = (line) => console.log(line)

const fixture = (name) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'test/fixtures/manifests', `${name}.json`), 'utf8'))
/* What each stand-in says it does, taken from a real module's manifest. */
const AS = { 'kehikot.alpha': fixture('paper'), 'kehikot.beta': fixture('notes'), 'kehikot.gamma': fixture('browser') }
AS['kehikot.beta'].declares.uses = [...AS['kehikot.beta'].declares.uses, 'address:open']
AS['kehikot.alpha'].declares.uses = [...AS['kehikot.alpha'].declares.uses, 'address:open']

const MEASURE = () => {
  const dialog = document.querySelector('[data-module-settings-dialog]')
  if (!dialog) return ['no settings window']
  const bad = []
  for (const el of [dialog, ...dialog.querySelectorAll('*')]) {
    if (el.closest('svg') && el.tagName !== 'svg') continue
    const style = getComputedStyle(el)
    if (style.textOverflow === 'ellipsis' || style.overflowX === 'hidden' && el.scrollWidth > el.clientWidth) continue
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 1 && style.overflowX !== 'visible') bad.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').slice(0, 30)}" scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`)
  }
  const box = dialog.getBoundingClientRect()
  if (box.right > window.innerWidth + 0.5 || box.left < -0.5) bad.push(`the window is past the edge (${Math.round(box.left)}–${Math.round(box.right)} of ${window.innerWidth})`)
  return bad
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
    for (const [label, width, height] of SIZES) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme })
      await context.addCookies([{ name: 'kehikko.theme', value: scheme, url: PAGE }])
      const page = await context.newPage()
      const run = `${kind} ${scheme} ${label} (${width}px)`
      page.on('pageerror', (error) => failures.push(`${run}: the page threw: ${error.message}`))
      await page.route(/\/host\/modules(\?|$)/, async (route) => {
        const body = await (await route.fetch()).json()
        for (const presence of body.presences ?? []) {
          const as = AS[presence.id]
          if (!presence.module || !as) continue
          Object.assign(presence.module, { reacts: as.reacts, extensions: as.extensions, declares: { ...presence.module.declares, uses: as.declares.uses, provides: as.declares.provides } })
        }
        await route.fulfill({ json: body })
      })
      await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-frame]', { state: 'attached', timeout: 30000 })
      for (let tries = 0; tries < 6 && (await page.locator('[role="dialog"]').count()); tries += 1) {
        const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
        if (await myself.count()) await myself.first().click()
        else await page.keyboard.press('Escape')
        await page.waitForTimeout(400)
      }
      const gear = page.locator('[data-module="kehikot.beta"] [data-settings-button]').first()
      if (await gear.count()) await gear.click()
      else {
        /* Narrow: the gear is in the Frame menu. */
        const frame = page.locator('[data-module="kehikot.beta"] [data-menu="frame"]').first()
        await frame.click()
        await page.locator('[data-frame="settings"]').first().click()
      }
      await page.waitForSelector('[data-connections-tab]', { timeout: 15000 })
      await page.waitForTimeout(400)
      const off = await page.locator('[data-connection][data-on="off"]').count()
      const offWords = await page.locator('[data-connection][data-on="off"]').first().textContent().catch(() => '')
      const bad = await page.evaluate(MEASURE)
      if (!off) bad.push('no connection is drawn off, though one was switched off')
      else if (!/\boff\b/.test(offWords ?? '')) bad.push(`an off connection does not say "off": ${offWords}`)
      say(`${bad.length ? 'FAIL' : 'ok  '} ${run}: ${await page.locator('[data-connection]').count()} connections, ${off} off${bad.length ? `\n      ${bad.slice(0, 6).join('\n      ')}` : ''}`)
      if (bad.length) failures.push(`${run}: ${bad[0]}`)
      const shoot = async (name) => {
        const dialog = page.locator('[data-module-settings-dialog]')
        const buffer = await page.screenshot({ fullPage: false })
        if (SHOTS) {
          mkdirSync(SHOTS, { recursive: true })
          await page.screenshot({ path: join(SHOTS, `${name}.png`) })
        }
        if (PRINT) console.log(`SHOT ${name} ${buffer.toString('base64')}`)
        void dialog
      }
      if (kind === 'chromium') await shoot(`connections-${scheme}-${label}`)
      /* And every module at once. */
      if (kind === 'chromium' && scheme === 'light' && label === 'typical') {
        await page.locator('[data-see-all]').click()
        await page.waitForSelector('[data-kehikko-connections]')
        await shoot('connections-all-light-typical')
      }
      await context.close()
    }
  }
  await browser.close()
}

let PAGE
try {
  PAGE = process.env.PAGE ?? (await bootHost('kehikko-connections'))
  const api = `http://127.0.0.1:${scratch.api}`
  const page = `http://127.0.0.1:${scratch.page}`
  const canvases = await (await fetch(`${api}/host/canvases`)).json()
  const wide = canvases.canvases.find((one) => one.name === 'Wide' && one.project === canvases.projects[0].id)
  const response = await fetch(`${api}/host/connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: page },
    body: JSON.stringify({ kehikko: wide.id, connections: { off: [{ kind: 'passage', from: 'kehikot.alpha', to: 'kehikot.beta' }], only: [] } }),
  })
  if (!response.ok) throw new Error(`POST /host/connections: ${response.status} ${await response.text()}`)
  for (const kind of BROWSERS) await drive(kind, pw[kind])
} catch (error) {
  failures.push(`the drive itself failed: ${error.stack ?? error}`)
}
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.log(`  - ${failure}`)
} else console.log('\nProviders & Consumers is drawn, says what is off, and fits, in WebKit and Chromium, light and dark, typical and narrow')
stop()
process.exit(failures.length ? 1 : 0)
