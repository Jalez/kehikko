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
 *   after the first load · after a kehikko switch · after an epic switch ·
 *   after a header menu press · after a project switch · after a resize ·
 *   after a fold and an unfold, in light; and after the load, a kehikko and
 *   an epic switch in dark. Each in every browser in `BROWSERS` (default
 *   `webkit,chromium`).
 *
 * And during every switch, on every painted frame (`WATCH`): the pointer at
 * the middle of a page never lands on the still copy of the chrome being
 * left, it lands on the page itself once the pages are released, the copy is
 * gone from the DOM once the switch is shown, and nothing on the canvas keeps
 * a `filter` or a `will-change` at rest. An epic switch tells every page its
 * new epic within the cap (300 ms, plus what a message takes).
 *
 * ## The scratch host
 *
 * Its own, from `dev/scratch-host.mjs`: nothing of the person's machine is
 * read or written, and every process it starts is stopped by its pid.
 *
 * Playwright is `playwright-core`, a dev dependency with no browsers in it.
 * The browsers are Playwright's own shared cache; if they are missing this
 * says the one command that installs them.
 */
import { bootHost, stop } from './scratch-host.mjs'

const BROWSERS = (process.env.BROWSERS ?? 'webkit,chromium').split(',').filter(Boolean)

const pw = await import('playwright-core')

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

/*
 * The hand-over, watched on every painted frame from the press until the
 * switch is shown: at the middle of every page drawn, what does the host have
 * on top? Never anything inside the still copy of the chrome being left
 * (`data-outgoing`); and once the incoming pages are released (`arriving`,
 * `shown`), the page's own iframe. After `shown` the copy is gone from the
 * DOM, and no layer of the canvas keeps a filter or a `will-change`.
 */
const WATCH = () => {
  const seen = { frames: 0, intoCopy: [], notThePage: [], phases: [] }
  window.__handover = seen
  const tick = () => {
    const surface = document.querySelector('[data-switch]')
    const phase = surface?.getAttribute('data-switch') ?? 'shown'
    if (seen.phases.at(-1) !== phase) seen.phases.push(phase)
    seen.frames += 1
    for (const holder of document.querySelectorAll('[data-frame]')) {
      if (getComputedStyle(holder).visibility !== 'visible') continue
      const box = holder.getBoundingClientRect()
      if (box.width < 40 || box.height < 40) continue
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      const hit = document.elementFromPoint(x, y)
      const id = holder.getAttribute('data-frame')
      if (hit?.closest('[data-outgoing]')) seen.intoCopy.push(`${phase} ${id}`)
      const released = phase === 'arriving' || phase === 'shown'
      if (released && !holder.hasAttribute('inert') && hit !== holder.querySelector('iframe')) {
        seen.notThePage.push(`${phase} ${id}: ${hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).split(' ').slice(0, 4).join('.') : 'nothing'}`)
      }
    }
    if (phase === 'shown' && seen.phases.length > 1) {
      seen.copyLeft = document.querySelectorAll('[data-outgoing]').length
      seen.filtered = [...document.querySelectorAll('main [data-switch], main [data-frame], main *')]
        .filter((element) => {
          const style = getComputedStyle(element)
          return (style.filter !== 'none' || style.willChange !== 'auto') && !element.closest('[data-frame] iframe')
        })
        .slice(0, 5)
        .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).split(' ').slice(0, 3).join('.')}: ${getComputedStyle(element).filter} / ${getComputedStyle(element).willChange}`)
      seen.done = true
      return
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

async function watched(page, label, act) {
  await page.evaluate(WATCH)
  await act()
  await page.waitForFunction(() => window.__handover?.done, null, { timeout: 5000 }).catch(() => {})
  const seen = await page.evaluate(() => window.__handover)
  const problems = []
  if (!seen.done) problems.push(`never shown (phases ${seen.phases.join(' → ')})`)
  if (seen.intoCopy.length) problems.push(`the still copy was on top of a page: ${[...new Set(seen.intoCopy)].slice(0, 3).join(', ')}`)
  if (seen.notThePage.length) problems.push(`a released page was not what the pointer would hit: ${[...new Set(seen.notThePage)].slice(0, 3).join(', ')}`)
  if (seen.copyLeft) problems.push(`the still copy was left in the DOM (${seen.copyLeft})`)
  if (seen.filtered?.length) problems.push(`a filter or will-change left at rest: ${seen.filtered.join('; ')}`)
  say(`  ${label}: the hand-over, ${seen.frames} frames, ${seen.phases.join(' → ')}`)
  say(`    ${problems.length ? 'FAIL' : 'ok  '} ${problems.length ? problems.join('; ') : 'never the copy, the pages when released, nothing left at rest'}`)
  for (const problem of problems) failures.push(`${label}, the hand-over: ${problem}`)
}

async function choose(page, kind, row, label) {
  await pressHost(page, page.locator(`button[aria-label="switch ${kind}"]`))
  const item = page.locator('[role="menuitem"]', { hasText: row }).first()
  await watched(page, label, () => pressHost(page, item))
}

/* The epic picker, and how long the pages wait to be told: never more than the cap. */
async function chooseEpic(page, label) {
  /* The other one: what a project is about is the host's to keep, so a second
     browser finds the epic the first one left it on. */
  const trigger = page.locator('button[aria-label="the epic this project is on"]')
  const [title, slug] = (await trigger.innerText()).includes('Results') ? ['Methods', 'methods'] : ['Results', 'results']
  await pressHost(page, trigger)
  const item = page.locator('[role^="menuitem"]', { hasText: title }).first()
  await item.waitFor({ state: 'visible' })
  const frames = (await shownPages(page)).map((one) => one.frame)
  const started = Date.now()
  const told = Promise.all(
    frames.map((frame) => frame.waitForFunction((slug) => document.getElementById('told')?.textContent === slug, slug, { timeout: 3000, polling: 10 }).then(() => Date.now() - started)),
  )
  await watched(page, label, () => pressHost(page, item))
  const waited = await told.catch(() => null)
  /* The cap, and what it costs to carry a message and to be polled for it. */
  const ok = waited !== null && Math.max(...waited) <= 300 + 120
  say(`    ${ok ? 'ok  ' : 'FAIL'} every page told "${slug}" ${waited ? `within ${Math.max(...waited)} ms` : 'never'}`)
  if (!ok) failures.push(`${label}: the pages were told the new epic ${waited ? `only after ${Math.max(...waited)} ms` : 'never'}`)
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

/**
 * One click into a module's page both closes an open host menu and puts the
 * keyboard in that page: typing straight after it arrives. A real pointer on
 * the page's field, no second click, then the keyboard.
 */
async function clickOutIntoPage(page, label) {
  doing = 'closing a menu with a click into a page'
  const frame = (await shownPages(page)).find((one) => one.id === 'kehikot.alpha')?.frame
  const problems = []
  if (!frame) problems.push('Alpha is not shown')
  else {
    const field = frame.locator('#field')
    await field.evaluate((input) => (input.value = ''))
    await pressHost(page, page.locator('button[aria-label^="view of Alpha"]'))
    await page.locator('[role="menuitemcheckbox"]', { hasText: 'Flag' }).first().waitFor({ state: 'visible' })
    const box = await field.boundingBox()
    await page.mouse.click(box.x + 8, box.y + box.height / 2)
    const word = `c${Math.random().toString(36).slice(2, 7)}`
    await page.keyboard.type(word)
    const typed = await field.inputValue()
    const open = await page.locator('[data-menu-content]').count()
    if (open) problems.push('the menu is still open after the click')
    if (typed !== word) {
      const hostFocus = await page.evaluate(() => `${document.hasFocus()} ${document.activeElement?.tagName} ${document.activeElement?.getAttribute('aria-label') ?? ''}`)
      problems.push(`typed "${word}" straight after the click, the field holds "${typed}" (host focus: ${hostFocus})`)
    }
  }
  say(`  ${label}`)
  say(`    ${problems.length ? 'FAIL' : 'ok  '} ${problems.length ? problems.join('; ') : 'one click closed the menu and the page took the typing'}`)
  for (const problem of problems) failures.push(`${label}: ${problem}`)
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
    /* The host's own theme is its cookie (`host/theme.ts`), dark when unset. */
    await context.addCookies([{ name: 'kehikko.theme', value: scheme, url: pageUrl }])
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
    await choose(page, 'kehikko', 'Tall', name('a kehikko switch'))
    await everyPageTakesInput(page, name('after a kehikko switch'), 3)
    await chooseEpic(page, name('an epic switch'))
    await everyPageTakesInput(page, name('after an epic switch'), 3)
    if (scheme === 'light') {
      await headerMenu(page, name('a header menu press'))
      await everyPageTakesInput(page, name('after a header menu press'), 3)
      await clickOutIntoPage(page, name('a click into a page closing a menu'))
      await choose(page, 'project', 'project-b', name('a project switch'))
      await everyPageTakesInput(page, name('after a project switch'), 3)
      await choose(page, 'project', 'project-a', name('a project switch back'))
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
  PAGE = process.env.PAGE ?? (await bootHost('kehikko-pages-take-input'))
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
} else console.log('\nevery page took the pointer, the keyboard and the wheel')
stop()
process.exit(failures.length ? 1 : 0)
