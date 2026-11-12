/*
 * Do the module lists on the layout picker's cards stay inside their cards?
 * In WebKit (the desktop app's engine) and Chromium, light and dark, at a
 * phone width, a small window and a typical one, for EVERY template the
 * picker offers — ours, plus two made up for the purpose: one naming fourteen
 * modules and one whose module names are very long.
 *
 *     node dev/layout-chips.drive.mjs            # SHOTS=<dir> saves a screenshot per run
 *     BROWSERS=webkit node dev/layout-chips.drive.mjs
 *
 * For each card and the dialog, no element may have `scrollWidth >
 * clientWidth` — except one that truncates on purpose (`text-overflow:
 * ellipsis`), which must itself lie inside its card — and nothing may be drawn
 * past the dialog's edge. Then the same of "From another project": a long list
 * of projects with long names, and kehikot naming many modules, some not
 * installed. Runs on a scratch host (`dev/scratch-host.mjs`).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { bootHost, stop } from './scratch-host.mjs'

const BROWSERS = (process.env.BROWSERS ?? 'webkit,chromium').split(',').filter(Boolean)
const SHOTS = process.env.SHOTS ?? null
const SIZES = [
  ['phone', 320, 640],
  ['small', 640, 700],
  ['typical', 1280, 800],
]
const pw = await import('playwright-core')
const failures = []
const say = (line) => console.log(line)

const container = (module, i) => ({ module, x: (i % 4) * 6, y: Math.floor(i / 4) * 14, w: 6, h: 14 })
const MANY = Array.from({ length: 14 }, (_, i) => `kehikot.module-${i + 1}`)
const LONG = [
  'kehikot.the-very-long-named-module-that-keeps-going',
  'kehikot.another-quite-long-module-name-for-the-chips',
  'kehikot.unbreakablemodulenamewithoutanyseparatorsatallinit',
]
const EXTRA = [
  { id: 'many', from: 'builtin', name: 'Everything at once', summary: 'A template that names a great many modules.', containers: MANY.map(container) },
  { id: 'long', from: 'builtin', name: 'A template with an extremely long name that should be cut off by its card', summary: 'Long names.', containers: LONG.map(container) },
]
const LONG_OFFICIAL = [
  ...MANY.map((id, i) => ({ id, name: `Module number ${i + 1}`, installed: false })),
  ...LONG.map((id) => ({ id, name: id.replace('kehikot.', 'Name of ').replaceAll('-', ' '), installed: false })),
  { ...{ id: LONG[2], installed: false }, name: 'Unbreakablemodulenamewithoutanyseparatorsatallinitatall' },
]

/** "From another project": many projects, long names, and kehikot naming many modules, some not here. */
const ELSEWHERE = {
  projects: Array.from({ length: 9 }, (_, p) => ({
    id: 900 + p,
    name: p === 0 ? 'A project with an extraordinarily long name that nobody would ever type out in full' : `Project ${p}`,
    path: `/Users/somebody/Projects/${'deeply/nested/'.repeat(4)}project-${p}`,
    visited: 1000 - p,
    missing: false,
    kehikot: [
      { id: 9000 + p * 10, key: `k${p}a`, name: 'Everything at once, with a very long kehikko name indeed', containers: MANY.map(container), folded: 3, skills: ['review-checklist', 'write-tests'], primary: MANY[0], connections: true },
      { id: 9001 + p * 10, key: `k${p}b`, name: 'Long', containers: LONG.map(container), folded: 0, skills: [], primary: null, connections: false },
    ],
  })),
}

/** Every element under `root` that scrolls sideways, and everything drawn past the dialog's right edge. */
const MEASURE = () => {
  const dialog = document.querySelector('[data-layout-picker]')
  const edge = dialog.getBoundingClientRect().right + 0.5
  const bad = []
  for (const el of [dialog, ...dialog.querySelectorAll('*')]) {
    if (el.closest('svg') && el.tagName !== 'svg') continue
    const style = getComputedStyle(el)
    const card = el.closest('[data-layout-card], [data-elsewhere-card]')
    const name = `${el.tagName.toLowerCase()}${el.dataset.layoutCard ? `[${el.dataset.layoutCard}]` : ''}.${String(el.getAttribute('class') ?? '').split(' ').slice(0, 3).join('.')} "${(el.textContent ?? '').slice(0, 30)}"`
    const cut = style.textOverflow === 'ellipsis'
    if (el.scrollWidth > el.clientWidth + 0 && !cut && el.clientWidth > 1) bad.push(`${name}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`)
    const box = el.getBoundingClientRect()
    if (box.width && box.right > edge) bad.push(`${name}: right ${Math.round(box.right)} past the dialog's ${Math.round(edge)}`)
    if (card && el !== card) {
      const c = card.getBoundingClientRect()
      if (box.width && (box.right > c.right + 0.5 || box.left < c.left - 0.5)) bad.push(`${name}: outside its card`)
    }
  }
  const doc = document.documentElement
  if (doc.scrollWidth > doc.clientWidth) bad.push(`document scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`)
  return bad
}

async function drive(kind, browserType) {
  let browser
  try {
    browser = await browserType.launch()
  } catch (error) {
    failures.push(`${kind}: cannot launch (${String(error.message).split('\n')[0]}). Install with: bunx playwright-core install webkit chromium-headless-shell`)
    return
  }
  for (const scheme of ['light', 'dark']) {
    for (const [label, width, height] of SIZES) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme })
      await context.addCookies([{ name: 'kehikko.theme', value: scheme, url: PAGE }])
      const page = await context.newPage()
      const run = `${kind} ${scheme} ${label} (${width}px)`
      page.on('pageerror', (error) => failures.push(`${run}: the page threw: ${error.message}`))
      await page.route(/\/host\/layouts(\?|$)/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        const body = await (await route.fetch()).json()
        await route.fulfill({ json: { ...body, builtIn: [...body.builtIn, ...EXTRA] } })
      })
      await page.route(/\/host\/kehikot\/elsewhere(\?|$)/, (route) => route.fulfill({ json: ELSEWHERE }))
      await page.route(/\/host\/official(\?|$)/, async (route) => {
        const body = await (await route.fetch()).json()
        await route.fulfill({ json: { ...body, modules: [...(body.modules ?? []), ...LONG_OFFICIAL] } })
      })
      await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-frame]', { state: 'attached', timeout: 30000 })
      for (let tries = 0; tries < 6 && (await page.locator('[role="dialog"]').count()); tries += 1) {
        const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
        if (await myself.count()) await myself.first().click()
        else await page.keyboard.press('Escape')
        await page.waitForTimeout(400)
      }
      await page.locator('button[aria-label="switch kehikko"]').click()
      await page.locator('[role="menuitem"]', { hasText: 'new kehikko' }).first().click()
      await page.waitForSelector('[data-layout-picker] [data-layout-card]', { timeout: 15000 })
      await page.waitForFunction(() => document.querySelectorAll('[data-layout-card]').length >= 10, null, { timeout: 15000 })
      await page.waitForTimeout(600)
      const cards = await page.evaluate(() => [...document.querySelectorAll('[data-layout-card]')].map((c) => c.getAttribute('data-layout-card')))
      const bad = await page.evaluate(MEASURE)
      /* A card at a time as well: the dialog scrolls, so a card is judged where it is, scrolled to. */
      for (const id of cards) {
        await page.locator(`[data-layout-card="${id}"]`).scrollIntoViewIfNeeded()
        const here = await page.evaluate(MEASURE)
        for (const line of here) if (!bad.includes(line)) bad.push(line)
      }
      /* And "From another project": the projects, the cards and the settings to take. */
      await page.locator('[data-layout-source-tab="project"]').click()
      await page.waitForSelector('[data-elsewhere-card]', { timeout: 15000 })
      await page.locator('[data-elsewhere-card]').first().click()
      await page.waitForSelector('[data-elsewhere-take]', { timeout: 15000 })
      await page.waitForTimeout(300)
      for (const line of await page.evaluate(MEASURE)) if (!bad.includes(line)) bad.push(line)
      for (const key of await page.evaluate(() => [...document.querySelectorAll('[data-elsewhere-card]')].map((c) => c.getAttribute('data-elsewhere-card')))) {
        await page.locator(`[data-elsewhere-card="${key}"]`).scrollIntoViewIfNeeded()
        for (const line of await page.evaluate(MEASURE)) if (!bad.includes(line)) bad.push(line)
      }
      say(`${bad.length ? 'FAIL' : 'ok  '} ${run}: ${cards.length} templates and From another project${bad.length ? `\n      ${bad.slice(0, 6).join('\n      ')}` : ''}`)
      if (bad.length) failures.push(`${run}: ${bad.length} overflow(s), first: ${bad[0]}`)
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true })
        await page.screenshot({ path: join(SHOTS, `${kind}-${scheme}-${label}.png`) })
      }
      await context.close()
    }
  }
  await browser.close()
}

let PAGE
try {
  PAGE = process.env.PAGE ?? (await bootHost('kehikko-layout-chips'))
  for (const kind of BROWSERS) await drive(kind, pw[kind])
} catch (error) {
  failures.push(`the drive itself failed: ${error.stack ?? error}`)
}
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.log(`  - ${failure}`)
} else console.log('\nno template overflows its card, nor does From another project, in WebKit and Chromium, light and dark, at every width')
stop()
process.exit(failures.length ? 1 : 0)
