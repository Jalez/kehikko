/*
 * An agent's `jump` into ANOTHER project and Go back (#208), on a scratch host
 * (`dev/scratch-host.mjs`), in WebKit and Chromium:
 *
 *     node dev/agent-jump.drive.mjs          # BROWSERS=chromium to run one
 *
 * The person stands in project-a on epic Methods. The host's MCP door is asked
 * `jump { project: 'project-b', epic: 'plan' }`: the page must switch to
 * project-b by the calm switch (prepared out of sight, then shown, nothing
 * visible moving after — project-b is visited once first, as
 * `dev/cross-project-jump.drive.mjs` does), land on epic Plan, and say
 * "Jumped here by an agent" with Go back. Go back must put the person in
 * project-a on Methods again, on the kehikko they had, and the mark goes.
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
const PAGE = await bootHost('agent-jump', {
  standin: (_id, at) => {
    projectB = at('project-b')
    return {}
  },
})
const api = `http://127.0.0.1:${scratch.api}`
const send = async (method, path, body) => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${scratch.page}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}
const listed = await (await fetch(`${api}/host/canvases`)).json()
const b = listed.projects.find((one) => one.path === projectB)
await send('POST', '/host/epics', { project: b.id, slug: 'plan', title: 'Plan' })

/* The host's own door, as an agent calls it. */
let rpc = 1
const tool = async (name, args) => {
  const response = await fetch(`${api}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } }),
  })
  const body = await response.json()
  return body.result?.content?.map((one) => one.text).join('\n') ?? JSON.stringify(body)
}

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
  const epic = () => page.locator('[aria-label="the epic this project is on"]').first().innerText().catch(() => '')
  const switchTo = async (row) => {
    await page.locator('button[aria-label="switch project"]').click()
    await page.locator('[role="menuitem"]', { hasText: row }).first().click()
    await page.waitForFunction((want) => document.querySelector('button[aria-label="switch project"]')?.textContent?.includes(want), row, { timeout: 15000 })
    await page.waitForTimeout(1500)
  }
  await switchTo('project-b')
  await switchTo('project-a')
  /* Past the door's pace, should an earlier browser's jump be recent. */
  await page.waitForTimeout(2600)
  const before = { project: await project(), epic: await epic(), kehikko: await page.evaluate(() => document.querySelector('button[aria-label="switch kehikko"]')?.textContent ?? '') }
  expect(before.project.includes('project-a') && before.epic.includes('Methods'), `${kind}: standing in project-a on Methods before the jump (${before.project} / ${before.epic})`)

  await page.evaluate(SAMPLER)
  const said = await tool('jump', { project: 'project-b', epic: 'plan' })
  expect(said.startsWith('Jumped the view to project project-b, epic plan.'), `${kind}: the door said where it jumped (${said.split('\n')[0].slice(0, 120)})`)
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
  expect((await epic()).includes('Plan'), `${kind}: landed on project-b's epic Plan (${await epic()})`)

  const mark = page.locator('[data-jump-mark]')
  const markText = (await mark.count()) ? await mark.innerText() : ''
  expect(markText.includes('Jumped here by an agent'), `${kind}: the kehikko says an agent jumped it (${markText.replace(/\s+/g, ' ')})`)
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/agent-jump-${kind}.png` })

  await page.locator('[data-jump-back]').click()
  const back = await page
    .waitForFunction(() => document.querySelector('button[aria-label="switch project"]')?.textContent?.includes('project-a'), null, { timeout: 15000 })
    .then(() => true, () => false)
  expect(back, `${kind}: Go back switched to project-a again`)
  await page.waitForTimeout(1500)
  expect((await epic()).includes('Methods'), `${kind}: Go back put the person on Methods again (${await epic()})`)
  const kehikko = await page.evaluate(() => document.querySelector('button[aria-label="switch kehikko"]')?.textContent ?? '')
  expect(kehikko === before.kehikko, `${kind}: on the kehikko they had (${kehikko} / ${before.kehikko})`)
  expect((await page.locator('[data-jump-mark]').count()) === 0, `${kind}: the mark is gone after Go back`)

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
