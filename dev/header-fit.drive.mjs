/*
 * Does the left side of a container's header — the module's name, its version,
 * its branch mark and its scope (protocol 2.29.0) — ever overlap, at the widths
 * a container is?
 *
 * In WebKit (the desktop app's engine) and Chromium, light and dark, a stand-in module
 * with a long name, a long version, a long branch and the longest scope ("This computer"),
 * in a container made 480, 440, 400, 380, 340, 300, 280, 220 and 200 pixels wide, unfolded and
 * folded:
 *
 *   - no two of the header's drawn children (name, version, branch mark, and the controls
 *     beside them) intersect;
 *   - nothing is cut off mid-glyph: a label wider than its box ends in an ellipsis
 *     (`text-overflow: ellipsis`), and a chip does not clip its icon;
 *   - the header is one row, and does not scroll sideways;
 *   - the scope is a label with its name at 440 and wider and its icon alone under it, its
 *     accessible name and tooltip saying the scope at every width, and a row in the Frame menu;
 *   - and the window's own bar, from 1400 down to 360 pixels: one row, the pinned places and the
 *     Pin button whole and overlapping nothing, "Pinned" a word only wider than 900, and pinning,
 *     listing and unpinning from the menu at 400.
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
const WIDTHS = [480, 440, 400, 380, 340, 300, 280, 220, 200]
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
      /* The longest scope name there is, and a line for its tooltip. */
      presence.module.modes = [
        { id: 'alpha', label: 'Alpha', scope: 'machine', scopeSays: 'every project’s runs on this computer, whatever is open here' },
        { id: 'here', label: 'Alpha here', scope: 'project', scopeSays: 'this project’s runs' },
      ]
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
  const named = ['header-name', 'version-control', 'branch-mark', 'header-scope'].map((t) => header.querySelector(`[data-testid="${t}"]`)).filter((el) => el && drawn(el))
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
  for (const test of ['version-control', 'branch-mark', 'header-scope']) {
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
    scope: (() => {
      const el = header.querySelector('[data-testid="header-scope"]')
      if (!el || !drawn(el)) return 'gone'
      return el.textContent ? 'text' : 'icon'
    })(),
    scopeSaid: header.querySelector('[data-testid="header-scope"]')?.getAttribute('aria-label') ?? '',
  }
  /* The scope is always there, says itself in words, and keeps its name only where it has room. */
  if (state.scope === 'gone') bad.push('the scope is not drawn')
  if (!state.scopeSaid.startsWith('Scope: This computer (default).')) bad.push(`the scope says "${state.scopeSaid}"`)
  if (state.width < 440 && state.scope === 'text') bad.push('the scope kept its name under 440px')
  return { bad, state }
}

/*
 * The bar at the top of the window, with the pinned places and the Pin button right after the
 * breadcrumb: at each window width it stays one row 32 pixels tall, both controls are drawn whole
 * inside it and overlap nothing, the word "Pinned" is there only wider than 900 pixels, and the Pin
 * button is there at every width.
 */
const BAR_WIDTHS = [1400, 1100, 901, 900, 800, 640, 480, 400, 360]
const MEASURE_BAR = () => {
  const bar = document.querySelector('header[data-testid="bar"]')
  const bad = []
  if (!bar) return { bad: ['no bar'], state: {} }
  const rect = (el) => el.getBoundingClientRect()
  const drawn = (el) => {
    if (!el) return false
    const style = getComputedStyle(el)
    const r = rect(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0.5 && r.height > 0.5
  }
  const b = rect(bar)
  if (b.height > 33) bad.push(`the bar is ${b.height}px tall`)
  const menu = bar.querySelector('[data-testid="pinned-menu"]')
  const pin = bar.querySelector('[data-testid="pin-here"]')
  const word = bar.querySelector('[data-testid="pinned-label"]')
  for (const [name, el] of [['the Pinned menu', menu], ['the Pin button', pin]]) {
    if (!drawn(el)) {
      bad.push(`${name} is not drawn`)
      continue
    }
    const r = rect(el)
    if (r.left < b.left - 0.5 || r.right > b.right + 0.5) bad.push(`${name} is outside the bar`)
    if (Math.abs(r.top + r.height / 2 - (b.top + b.height / 2)) > 4) bad.push(`${name} is not on the bar's row`)
    if (el.scrollWidth > el.clientWidth + 1) bad.push(`${name} clips what is in it (${el.scrollWidth} > ${el.clientWidth})`)
    /* Nothing else in the bar under it. */
    for (const other of bar.querySelectorAll('button, [data-testid="pinned-label"]')) {
      if (other === el || el.contains(other) || other.contains(el) || !drawn(other)) continue
      const o = rect(other)
      const across = Math.min(r.right, o.right) - Math.max(r.left, o.left)
      const down = Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top)
      if (across > 0.5 && down > 0.5) bad.push(`${name} overlaps "${other.getAttribute('aria-label') ?? other.textContent}" by ${across.toFixed(1)}px`)
    }
  }
  const wide = window.innerWidth > 900
  if (wide && !drawn(word)) bad.push('the word "Pinned" is gone wider than 900px')
  if (!wide && drawn(word)) bad.push('the word "Pinned" is still drawn at 900px or narrower')
  return { bad, state: { width: Math.round(b.width), height: Math.round(b.height), word: drawn(word) ? 'word' : 'icon', pin: drawn(pin) ? 'drawn' : 'gone' } }
}

async function driveBar(page, kind, scheme) {
  for (const width of BAR_WIDTHS) {
    const run = `${kind} ${scheme} bar ${width}px`
    await page.setViewportSize({ width, height: 700 })
    await page.waitForTimeout(250)
    const { bad, state } = await page.evaluate(MEASURE_BAR)
    await page.locator('header[data-testid="bar"]').screenshot({ path: join(SHOTS, `${kind}-${scheme}-bar-${width}.png`) })
    say(`${bad.length ? 'FAIL' : 'ok  '} ${run}: bar ${state.width}x${state.height}px, pinned ${state.word}, pin button ${state.pin}${bad.length ? `\n      ${bad.slice(0, 6).join('\n      ')}` : ''}`)
    if (bad.length) failures.push(`${run}: ${bad[0]}`)
  }
  /* Narrow: the Pin button pins the place on screen (filled), and the menu lists it with its unpin. */
  try {
    await page.setViewportSize({ width: 400, height: 700 })
    const pin = page.locator('[data-testid="pin-here"]')
    if ((await pin.getAttribute('aria-pressed')) !== 'true') await pin.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="pin-here"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 6000 })
    await page.locator('[data-testid="pinned-menu"]').click()
    const unpin = page.locator('[data-testid="pinned-unpin"]').first()
    await unpin.waitFor({ timeout: 6000 })
    const said = await unpin.getAttribute('aria-label')
    if (!said?.startsWith('Unpin ')) throw new Error(`the unpin says "${said}"`)
    await page.screenshot({ path: join(SHOTS, `${kind}-${scheme}-pinned-menu-400.png`), clip: { x: 0, y: 0, width: 400, height: 260 } })
    await unpin.click()
    await page.locator('[data-testid="pinned-empty"]').waitFor({ timeout: 6000 })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('[data-testid="pin-here"]')?.getAttribute('aria-pressed') === 'false', null, { timeout: 6000 })
    say(`ok   ${kind} ${scheme} bar 400px: pinned the place, listed it ("${said}"), unpinned it from the menu`)
  } catch (error) {
    failures.push(`${kind} ${scheme} bar 400px: pin, list and unpin failed (${error.message})`)
    say(`FAIL ${kind} ${scheme} bar 400px: pin, list and unpin failed (${error.message})`)
  }
  await page.setViewportSize({ width: 1400, height: 700 })
}

/** A clip of the container's header and what opens below it, for a screenshot of a tooltip or a menu. */
async function clipAround(page, id, below = 90) {
  const box = await page.locator(`[data-module="${id}"] header.container-grip`).boundingBox()
  return { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: Math.max(box.width + 60, 320), height: box.height + below }
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
        say(`${bad.length ? 'FAIL' : 'ok  '} ${run}: header ${state.width}px, name ${Math.round(state.name)}px, version ${state.version}, branch ${state.badge}, scope ${state.scope}${bad.length ? `\n      ${bad.slice(0, 6).join('\n      ')}` : ''}`)
        if (bad.length) failures.push(`${run}: ${bad[0]}`)
      }
    }
    /* Narrow and open: the scope's icon raises its tooltip, and the Frame menu has the scope as a row. */
    {
      const fold = page.locator(`[data-module="${MODULE}"] button[data-tour="fold"]`)
      if ((await fold.getAttribute('aria-expanded')) === 'false') await fold.click()
      await page.evaluate(([id, w]) => {
        const box = document.querySelector(`[data-module="${id}"]`)
        box.style.setProperty('width', `${w}px`, 'important')
        box.style.setProperty('max-width', `${w}px`, 'important')
      }, [MODULE, 220])
      await page.waitForTimeout(250)
      const run = `${kind} ${scheme} 220px scope`
      await page.locator(`[data-module="${MODULE}"] [data-testid="header-scope"]`).hover()
      const tip = page.locator('[role="tooltip"]', { hasText: 'Scope: This computer' })
      try {
        await tip.first().waitFor({ timeout: 4000 })
        await page.screenshot({ path: join(SHOTS, `${kind}-${scheme}-scope-tooltip-220.png`), clip: await clipAround(page, MODULE) })
        say(`ok   ${run}: the icon's tooltip says the scope`)
      } catch {
        failures.push(`${run}: no tooltip on the scope's icon`)
        say(`FAIL ${run}: no tooltip on the scope's icon`)
      }
      await page.mouse.move(5, 5)
      await page.locator(`[data-module="${MODULE}"] [data-menu="frame"]`).click()
      const row = page.locator('[data-frame="scope"]')
      try {
        await row.waitFor({ timeout: 4000 })
        const text = await row.textContent()
        if (!text?.includes('Scope: This computer')) throw new Error(text ?? '')
        await page.screenshot({ path: join(SHOTS, `${kind}-${scheme}-scope-frame-menu-220.png`), clip: await clipAround(page, MODULE, 260) })
        say(`ok   ${kind} ${scheme} 220px frame menu: "${text}"`)
        /* The row opens the settings window: the Scope control at its top, the default marked. */
        await row.click()
        const control = page.locator('[data-testid="scope-control"]')
        await control.waitFor({ timeout: 6000 })
        const options = await control.locator('[data-scope-option]').allTextContents()
        if (!options.some((one) => one.includes('This computer') && one.includes('(default)'))) throw new Error(`options: ${options.join(' | ')}`)
        await page.locator('[data-module-settings-dialog]').screenshot({ path: join(SHOTS, `${kind}-${scheme}-scope-settings.png`) })
        say(`ok   ${kind} ${scheme} settings window: ${options.length} scopes, the default marked`)
      } catch (error) {
        failures.push(`${kind} ${scheme} 220px: the Frame menu's scope row or the settings window failed (${error.message})`)
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      /* The modules menu: every registered module's row has its scope. */
      try {
        await page.locator('button[aria-label="Kehikko modules"]').first().click()
        const chip = page.locator('[data-testid="module-scope"]').first()
        await chip.waitFor({ timeout: 6000 })
        const popover = page.locator('[data-slot="popover-content"], [data-radix-popper-content-wrapper]').first()
        await popover.screenshot({ path: join(SHOTS, `${kind}-${scheme}-scope-modules-menu.png`) })
        say(`ok   ${kind} ${scheme} modules menu: ${await page.locator('[data-testid="module-scope"]').count()} rows say their scope`)
      } catch (error) {
        failures.push(`${kind} ${scheme}: the modules menu shows no scope (${error.message})`)
      }
      await page.keyboard.press('Escape')
    }
    await driveBar(page, kind, scheme)
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
} else console.log('\nthe header\'s name, version, branch and scope never overlap, and the bar keeps the pinned places and the Pin button on one row, in WebKit and Chromium, light and dark, at every width')
stop()
process.exit(failures.length ? 1 : 0)
