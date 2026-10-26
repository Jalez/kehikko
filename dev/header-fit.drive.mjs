/*
 * Does the left side of a container's header — the module's name, its version
 * and its branch mark — ever overlap, at the widths a container is?
 *
 * In WebKit (the desktop app's engine) and Chromium, light and dark, a stand-in module
 * with a long name, a long version and a long branch, in a container made 380, 340, 300, 280,
 * 220 and 200 pixels wide, unfolded and folded:
 *
 *   - no two of the header's drawn children (name, version, branch mark, and the controls
 *     beside them) intersect;
 *   - nothing is cut off mid-glyph: a label wider than its box ends in an ellipsis
 *     (`text-overflow: ellipsis`), and a chip does not clip its icon;
 *   - the header is one row, and does not scroll sideways.
 *
 *     node dev/header-fit.drive.mjs            # BROWSERS=webkit to pick one
 *
 * A screenshot of the header at each width and scheme is saved and its path printed:
 * `HEADER_FIT_SHOTS=<dir>`, else beside the shared port claims (bee: `~/kehikko-ci/header-fit-shots`),
 * else `SHOTS`, else `/tmp/kehikko-header-fit`. Runs on a scratch host (`dev/scratch-host.mjs`).
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { bootHost, stop } from './scratch-host.mjs'

const BROWSERS = (process.env.BROWSERS ?? 'webkit,chromium').split(',').filter(Boolean)
const WIDTHS = [380, 340, 300, 280, 220, 200]
const SHOTS =
  process.env.HEADER_FIT_SHOTS ??
  (process.env.KEHIKOT_SCRATCH_PORTS ? join(dirname(process.env.KEHIKOT_SCRATCH_PORTS), 'header-fit-shots') : (process.env.SHOTS ?? '/tmp/kehikko-header-fit'))
const MODULE = 'kehikot.alpha'
const LONG_NAME = 'An Extraordinarily Long Module Name'
const LONG_VERSION = '12.34.56-release-candidate.7'
const LONG_BRANCH = 'feature/a-really-long-branch-name-here'

const pw = await import('playwright-core')
const failures = []
const say = (line) => console.log(line)
mkdirSync(SHOTS, { recursive: true })

/** The long name, version and branch, whatever the host says. */
function lengthen(body) {
  for (const presence of body.presences ?? []) {
    if (presence.id !== MODULE) continue
    presence.name = LONG_NAME
    if (presence.module) {
      presence.module.name = LONG_NAME
      presence.module.version = LONG_VERSION
    }
    presence.source = { dir: '/somewhere/alpha', registered: true, branch: LONG_BRANCH, upstream: 'origin/main', behind: 0, ahead: 0, dirty: false }
  }
  return body
}

/** Measured in the page: what overlaps, what is cut mid-glyph, whether it is one row. */
const MEASURE = (id) => {
  const box = document.querySelector(`[data-module="${id}"]`)
  const header = box.querySelector('header.container-grip')
  const bad = []
  const rect = (el) => el.getBoundingClientRect()
  const label = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''}${el.getAttribute('aria-label') ? ` "${el.getAttribute('aria-label').slice(0, 24)}"` : ''}`
  const drawn = (el) => {
    const style = getComputedStyle(el)
    const r = rect(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0.5 && r.height > 0.5
  }
  /* The header's own children and the name, version and branch inside their wrappers. */
  const items = [...header.children].filter(drawn)
  const named = ['header-name', 'version-control', 'branch-mark'].map((t) => header.querySelector(`[data-testid="${t}"]`)).filter((el) => el && drawn(el))
  const all = [...new Set([...items, ...named])]
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = rect(all[i])
      const b = rect(all[j])
      if (all[i].contains(all[j]) || all[j].contains(all[i])) continue
      const across = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (across > 0.5 && down > 0.5) bad.push(`overlap: ${label(all[i])} and ${label(all[j])} by ${across.toFixed(1)}px`)
    }
  }
  /* Cut: a label wider than its box must end in an ellipsis; a chip must not clip its icon. */
  for (const test of ['header-name', 'version-label', 'branch-label']) {
    const el = header.querySelector(`[data-testid="${test}"]`)
    if (!el || !drawn(el)) continue
    const style = getComputedStyle(el)
    if (el.scrollWidth > el.clientWidth + 1 && !(style.textOverflow === 'ellipsis' && style.overflow !== 'visible')) bad.push(`${test} is cut without an ellipsis (${el.scrollWidth} > ${el.clientWidth})`)
  }
  for (const test of ['version-control', 'branch-mark']) {
    const el = header.querySelector(`[data-testid="${test}"]`)
    if (el && drawn(el) && el.scrollWidth > el.clientWidth + 1) bad.push(`${test} clips its icon (${el.scrollWidth} > ${el.clientWidth})`)
  }
  /* Everything inside the header, and the header itself, on one row. */
  const h = rect(header)
  if (!header.dataset.dense && h.height > 34) bad.push(`the header is ${h.height}px tall`)
  const centres = items.map((el) => rect(el).top + rect(el).height / 2)
  if (centres.length && Math.max(...centres) - Math.min(...centres) > 4) bad.push(`not one row: centres span ${(Math.max(...centres) - Math.min(...centres)).toFixed(1)}px`)
  for (const el of items) {
    const r = rect(el)
    if (r.right > h.right + 0.5 || r.left < h.left - 0.5) bad.push(`${label(el)} is drawn outside the header horizontally`)
  }
  if (header.scrollWidth > header.clientWidth + 1) bad.push(`the header scrolls sideways (${header.scrollWidth} > ${header.clientWidth})`)
  const state = {
    width: Math.round(h.width),
    name: header.querySelector('[data-testid="header-name"]')?.getBoundingClientRect().width ?? 0,
    version: named.find((el) => el.dataset.testid === 'version-control') ? 'drawn' : 'gone',
    badge: header.querySelector('[data-testid="branch-label"]') ? 'text' : header.querySelector('[data-testid="branch-mark"]') ? 'icon' : 'gone',
  }
  return { bad, state }
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
    const context = await browser.newContext({ viewport: { width: 1400, height: 700 }, colorScheme: scheme })
    await context.addCookies([{ name: 'kehikko.theme', value: scheme, url: PAGE }])
    const page = await context.newPage()
    page.on('pageerror', (error) => failures.push(`${kind} ${scheme}: the page threw: ${error.message}`))
    await page.route(/\/host\/modules(\?|$)/, async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: lengthen(await response.json()) })
    })
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-module="${MODULE}"] header.container-grip`, { timeout: 30000 })
    for (let tries = 0; tries < 6 && (await page.locator('[role="dialog"]').count()); tries += 1) {
      const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
      if (await myself.count()) await myself.first().click()
      else await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
    await page.waitForFunction((id) => document.querySelector(`[data-module="${id}"] [data-testid="header-name"]`)?.textContent?.startsWith('An Extra'), MODULE, { timeout: 30000 })
    for (const folded of [false, true]) {
      const fold = page.locator(`[data-module="${MODULE}"] button[data-tour="fold"]`)
      if ((await fold.getAttribute('aria-expanded')) === (folded ? 'true' : 'false')) await fold.click()
      for (const width of WIDTHS) {
        const run = `${kind} ${scheme} ${folded ? 'folded' : 'open'} ${width}px`
        /* The container itself is made this wide (it is the container the header's queries ask), raised above its neighbours. */
        await page.evaluate(([id, w]) => {
          const box = document.querySelector(`[data-module="${id}"]`)
          box.style.setProperty('width', `${w}px`, 'important')
          box.style.setProperty('max-width', `${w}px`, 'important')
          box.style.setProperty('z-index', '50', 'important')
          box.style.setProperty('position', 'relative', 'important')
        }, [MODULE, width])
        await page.waitForTimeout(250)
        const { bad, state } = await page.evaluate(MEASURE, MODULE)
        const header = page.locator(`[data-module="${MODULE}"] header.container-grip`)
        await header.screenshot({ path: join(SHOTS, `${kind}-${scheme}-${folded ? 'folded' : 'open'}-${width}.png`) })
        say(`${bad.length ? 'FAIL' : 'ok  '} ${run}: header ${state.width}px, name ${Math.round(state.name)}px, version ${state.version}, branch ${state.badge}${bad.length ? `\n      ${bad.slice(0, 6).join('\n      ')}` : ''}`)
        if (bad.length) failures.push(`${run}: ${bad[0]}`)
      }
    }
    await context.close()
  }
  await browser.close()
}

let PAGE
try {
  PAGE = process.env.PAGE ?? (await bootHost('kehikko-header-fit'))
  for (const kind of BROWSERS) await drive(kind, pw[kind])
} catch (error) {
  failures.push(`the drive itself failed: ${error.stack ?? error}`)
}
say(`screenshots: ${SHOTS}`)
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.log(`  - ${failure}`)
} else console.log('\nthe header\'s name, version and branch never overlap, in WebKit and Chromium, light and dark, at every width')
stop()
process.exit(failures.length ? 1 : 0)
