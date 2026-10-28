/*
 * A module's jump into ANOTHER project (protocol 2.28.0, `view.goto { project, show }`), pressed with
 * a real pointer in the module's own page, on a scratch host (`dev/scratch-host.mjs`), in WebKit and
 * Chromium:
 *
 *     node dev/cross-project-jump.drive.mjs          # BROWSERS=chromium to run one
 *
 * Alpha has a "jump" button asking for project-b's epic `plan` and the agent session `s-1`; Gamma
 * says it shows agent sessions (`shows`); Beta says nothing. Pressing it must switch to project-b by
 * the calm switch (no visible move after the incoming kehikko is shown — project-b is visited once
 * first, so its pages are kept, as `dev/calm-switch.drive.mjs` judges a revisit), land on epic
 * `plan`, answer `moved`, and tell `context.show` to Gamma and not to Beta.
 * (A project the host does not hold is `test/navigate.test.ts`'s.)
 */
import { bootHost, scratch } from './scratch-host.mjs'

const BROWSERS = (process.env.BROWSERS ?? 'webkit,chromium').split(',').filter(Boolean)
const pw = await import('playwright-core')
const failures = []
const say = (line) => console.log(line)
const expect = (ok, what) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

let projectB = ''
const PAGE = await bootHost('cross-project-jump', {
  standin: (id, at) => {
    projectB = at('project-b')
    if (id === 'kehikot.alpha') {
      return { STANDIN_JUMP: JSON.stringify({ project: at('project-b'), epic: 'plan', show: { subject: 'agent-session', id: 's-1' } }) }
    }
    if (id === 'kehikot.gamma') return { STANDIN_SHOWS: '1' }
    return {}
  },
})

const send = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${scratch.api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${scratch.page}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}
const listed = await (await fetch(`http://127.0.0.1:${scratch.api}/host/canvases`)).json()
const b = listed.projects.find((one) => one.path === projectB)
await send('POST', '/host/epics', { project: b.id, slug: 'plan', title: 'Plan' })

/* Every container and page, with its rectangle and whether it can be seen, on every painted frame. */
const SAMPLER = () => {
  const seen = (element) => {
    let opacity = 1
    for (let at = element; at && at !== document.documentElement; at = at.parentElement) {
      const style = getComputedStyle(at)
      if (style.display === 'none') return 0
      opacity *= Number(style.opacity)
    }
    return getComputedStyle(element).visibility === 'hidden' ? 0 : opacity
  }
  window.__samples = []
  window.__sampling = true
  const tick = () => {
    if (!window.__sampling) return
    const rows = []
    for (const element of document.querySelectorAll('[data-module], [data-frame]')) {
      const box = element.getBoundingClientRect()
      const id = element.getAttribute('data-module') ?? element.getAttribute('data-frame')
      rows.push({ what: `${element.hasAttribute('data-frame') ? 'page' : 'container'} ${id}`, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), seen: seen(element) })
    }
    window.__samples.push({ phase: document.querySelector('[data-switch]')?.getAttribute('data-switch') ?? null, rows })
    requestAnimationFrame(tick)
  }
  tick()
}
const movesIn = (samples, from) => {
  let moves = 0
  for (let i = Math.max(1, from); i < samples.length; i += 1) {
    const before = new Map(samples[i - 1].rows.map((row) => [row.what, row]))
    for (const row of samples[i].rows) {
      const was = before.get(row.what)
      if (!was || was.seen <= 0.02 || row.seen <= 0.02) continue
      if (was.x !== row.x || was.y !== row.y || was.w !== row.w || was.h !== row.h) moves += 1
    }
  }
  return moves
}

async function drive(kind) {
  let browser
  try {
    browser = await pw[kind].launch()
  } catch (error) {
    failures.push(`${kind}: cannot launch (${String(error.message).split('\n')[0]})`)
    return
  }
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => failures.push(`${kind}: the page threw: ${error.message}`))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-frame]', { state: 'attached', timeout: 30000 })
  for (let tries = 0; tries < 6 && (await page.locator('[role="dialog"]').count()); tries += 1) {
    const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
    if (await myself.count()) await myself.first().click()
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  const project = () => page.locator('button[aria-label="switch project"]').innerText()
  const switchTo = async (row) => {
    await page.locator('button[aria-label="switch project"]').click()
    await page.locator('[role="menuitem"]', { hasText: row }).first().click()
    await page.waitForFunction((want) => document.querySelector('button[aria-label="switch project"]')?.textContent?.includes(want), row, { timeout: 15000 })
    await page.waitForTimeout(1500)
  }
  /* project-b once by the person's own switch, so the jump back to it is a revisit. */
  await switchTo('project-b')
  await switchTo('project-a')
  expect((await project()).includes('project-a'), `${kind}: standing in project-a before the jump`)

  const alpha = page.frameLocator('[data-frame="kehikot.alpha"] iframe, iframe[data-frame="kehikot.alpha"]').first()
  await alpha.locator('#jump').waitFor({ timeout: 20000 })
  await page.evaluate(SAMPLER)
  await alpha.locator('#jump').click()
  const arrived = await page
    .waitForFunction(() => document.querySelector('button[aria-label="switch project"]')?.textContent?.includes('project-b'), null, { timeout: 15000 })
    .then(() => true, () => false)
  expect(arrived, `${kind}: the jump switched to project-b`)
  await page.waitForTimeout(1800)
  const samples = await page.evaluate(() => ((window.__sampling = false), window.__samples))
  const shownAt = samples.findIndex((s, i) => i > 0 && s.phase !== 'preparing' && samples.slice(0, i).some((p) => p.phase === 'preparing'))
  expect(shownAt > 0, `${kind}: it went by the calm switch (prepared out of sight, then shown)`)
  const after = shownAt < 0 ? -1 : movesIn(samples, shownAt + 1)
  expect(after === 0, `${kind}: nothing visible moved after the incoming kehikko was shown (${after})`)

  const gamma = page.frameLocator('iframe[data-frame="kehikot.gamma"], [data-frame="kehikot.gamma"] iframe').first()
  const beta = page.frameLocator('iframe[data-frame="kehikot.beta"], [data-frame="kehikot.beta"] iframe').first()
  const toldGamma = await gamma.locator('#told').innerText()
  expect(toldGamma === 'plan', `${kind}: the pages are on project-b's epic plan (${toldGamma})`)
  const shown = await gamma.locator('body').getAttribute('data-shown')
  expect(shown === 'agent-session:s-1', `${kind}: Gamma, which shows agent sessions, was told the session (${shown})`)
  const notBeta = await beta.locator('body').getAttribute('data-shown')
  expect(notBeta === null, `${kind}: Beta, which says nothing of it, was not told (${notBeta})`)
  const answered = await alpha.locator('body').getAttribute('data-jumped').catch(() => null)
  expect(answered === 'moved', `${kind}: Alpha's jump was answered moved (${answered})`)

  await context.close()
  await browser.close()
}

try {
  for (const kind of BROWSERS) await drive(kind)
} finally {
  if (failures.length) say(`\n${failures.length} failed:\n${failures.join('\n')}`)
  else say('\nall good')
  process.exit(failures.length ? 1 : 0)
}
