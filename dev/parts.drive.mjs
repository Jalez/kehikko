/*
 * Pick parts of an epic with a real pointer, and say what the bar, the
 * project's file and a framed module each made of it.
 *
 *     PLAYWRIGHT=…/playwright-core/index.mjs CHROME=…/chrome \
 *       node dev/parts.drive.mjs [page url] [project folder]
 *
 * ## Why this is a driver and not a test
 *
 * For the reason `epic.drive.mjs` gives. What is being checked is a control
 * that has to be SEEN when it is narrowing — a filled pill in a bar of quiet
 * ones — a menu that has to stay open across two presses, a focus that has to
 * survive a switch of kehikko and not survive a switch of epic, and a context
 * that has to arrive inside a frame. `test/parts.test.ts` holds the arithmetic;
 * none of this is arithmetic.
 *
 * ## Run it against a scratch host, never the real one
 *
 * Its own `KEHIKOT_FRAME_DB`, `KEHIKOT_MODULES_DIR`, `KEHIKOT_INSTALLS_DIR`,
 * `KEHIKOT_VERSIONS_DIR`, and a `KEHIKOT_SEED_PROJECT` that is a COPY of a
 * project — because it writes: the project's subject, its `kehikot.json`, a
 * second kehikko, and one epic file, which it edits to check that a part added
 * by hand reaches the bar without a reload.
 *
 * The project needs an epic with groups (`EPIC`, by default the one real epic
 * that has them) and one without (`PLAIN`).
 *
 * `PROBE` is optional: the id of a module registered with that scratch host
 * whose page prints `context.parts` into `#parts` — any page that does will
 * do. When it is given, the driver places it and reads what it was told.
 *
 * Exits 0 when: the control is drawn for an epic with parts and not for one
 * without; nothing picked reads "all parts"; two presses pick two parts with
 * the menu still open, and the bar says so; the file gains `parts`; the framed
 * module is told the same two; switching kehikko changes nothing; the clear
 * button returns to the whole epic and the file loses the key; switching epic
 * clears the focus; a reload keeps it; and a group written into the epic's
 * file by hand appears in the menu on its own.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT ?? '/tmp/height-drive/node_modules/playwright-core/index.mjs')

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4391/'
const PROJECT = process.argv[3] ?? '/tmp/parts-scratch/project'
const API = process.env.API ?? 'http://127.0.0.1:4390'
const EPIC = process.env.EPIC ?? 'the-roadmap-tracks-itself'
const PLAIN = process.env.PLAIN ?? 'modes-are-modules'
const PROBE = process.env.PROBE ?? ''
const SHOTS = process.env.SHOTS ?? ''

const checks = []
const problems = []
const check = (what, ok, detail = '') => {
  checks.push({ what, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`)
}
const api = (path, method, body) =>
  fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json())
const door = (name, args) =>
  api('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
const file = () => JSON.parse(readFileSync(join(PROJECT, '.kehikot', 'kehikko', 'kehikot.json'), 'utf8'))
const stored = async () => (await api('/host/canvases', 'GET')).subjects.find((s) => s.project === projectId)

/* Where it starts: on the divided epic, with nothing picked, on the first
   kehikko, and with a second kehikko to switch to. */
const found = await api('/host/canvases', 'GET')
const projectId = found.projects.find((p) => p.path === PROJECT)?.id
if (projectId === undefined) {
  console.error(`no project at ${PROJECT} on ${API}`)
  process.exit(2)
}
await api('/host/subject', 'PATCH', { project: projectId, epic: EPIC, parts: [], selection: [] })
const mine = found.canvases.filter((c) => c.project === projectId)
const first = mine[0]
const second = mine[1] ?? (await api('/host/canvases', 'POST', { name: 'the other layout', project: projectId })).canvas
if (PROBE) {
  const said = await door('place_modules', { kehikko: first.id, modules: [PROBE] })
  console.log('door said:', said.result?.content?.[0]?.text?.split('\n')[0])
}

const browser = await chromium.launch({ executablePath: process.env.CHROME })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() !== 'error') return
  const text = message.text()
  if (text.includes('frame-ancestors') || /status of (404|409)/.test(text)) {
    console.log(`(expected) ${text.split('\n')[0]}`)
    return
  }
  problems.push(`console: ${text}`)
})
const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

const quiet = page.locator('button[aria-label="the parts of this epic — all of them are shown"]')
const loud = page.locator('button[aria-label^="focused on "]')
const clear = page.locator('button[aria-label="clear the focus and show the whole epic"]')
const row = (heading) => page.locator('[role="menuitem"]', { hasText: heading })
const epics = page.locator('button[aria-label="the epic this project is on"]')
const kehikot = page.locator('button[aria-label="switch kehikko"]')
const told = async () => {
  if (!PROBE) return null
  for (const frame of page.frames()) {
    const text = await frame.locator('#parts').textContent({ timeout: 500 }).catch(() => null)
    if (text) return text
  }
  return null
}

/* 1. The whole epic. */
check('the control is drawn beside the epic, saying all parts', (await quiet.textContent())?.trim() === 'all parts')
check('nothing is filled and there is no clear button', (await loud.count()) === 0 && (await clear.count()) === 0)
check('the file has no parts key', !('parts' in file()))
if (PROBE) {
  const text = await told()
  check('the module is told every part, none picked', /picked: \[\]/.test(text ?? ''), text?.split('\n')[0])
}
await shot('1-whole-epic')

/* 2. Two presses, one menu. */
await quiet.click()
await page.waitForTimeout(300)
const names = await page.locator('[role="menuitem"]').allTextContents()
console.log('menu:', names.map((n) => n.trim()).join(' | '))
const headings = (await api(`/host/epics?project=${projectId}`, 'GET')).epics.find((e) => e.slug === EPIC).parts
const [a, , , b] = headings
await row(a.heading).click()
await page.waitForTimeout(400)
check('the menu is still open after one press', await row(b.heading).isVisible())
check('one part picked puts its name in the bar', (await loud.textContent())?.trim() === a.heading, (await loud.textContent())?.trim())
await row(b.heading).click()
await page.waitForTimeout(500)
check('two picked says how many of how many', (await loud.textContent())?.trim() === `2 of ${headings.length} parts`, (await loud.textContent())?.trim())
await shot('2-two-picked-menu-open')
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
check('the clear button stands beside it', await clear.isVisible())
const filled = await loud.evaluate((el) => getComputedStyle(el).backgroundColor)
const plain = await epics.evaluate((el) => getComputedStyle(el).backgroundColor)
check('the narrowed control is filled, and the epic control beside it is not', filled !== plain, `${filled} vs ${plain}`)
check('the server stored both', JSON.stringify((await stored()).parts) === JSON.stringify([a.id, b.id]), JSON.stringify((await stored()).parts))
check('the file says so, at the top and on no kehikko', JSON.stringify(file().parts) === JSON.stringify([a.id, b.id]) && file().kehikot.every((k) => !('parts' in k)))
if (PROBE) {
  const text = await told()
  check('the module is told which two', text?.includes(`picked: ${JSON.stringify([a.id, b.id])}`) ?? false, text?.split('\n')[0])
  check('and still every part, with its refs', (text?.split('\n').length ?? 0) === headings.length + 1 && (text ?? '').includes(headings[1].refs.join(',')))
}
await shot('3-two-picked')

/* 3. A kehikko is a layout. */
await kehikot.click()
await page.waitForTimeout(300)
await page.locator('[role="menuitem"]', { hasText: second.name }).first().click()
await page.waitForTimeout(800)
check('switching kehikko leaves the focus where it was', (await loud.textContent())?.trim() === `2 of ${headings.length} parts`)
check('and the stored focus', JSON.stringify((await stored()).parts) === JSON.stringify([a.id, b.id]))
await shot('4-other-kehikko')
await kehikot.click()
await page.waitForTimeout(300)
await page.locator('[role="menuitem"]', { hasText: first.name }).first().click()
await page.waitForTimeout(800)

/* 4. A reload keeps it. */
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
check('a reload keeps the focus', (await loud.textContent().catch(() => ''))?.trim() === `2 of ${headings.length} parts`)
if (PROBE) {
  const text = await told()
  check('and the module is greeted with it', text?.includes(`picked: ${JSON.stringify([a.id, b.id])}`) ?? false, text?.split('\n')[0])
}

/* 5. One press out. */
await clear.click()
await page.waitForTimeout(500)
check('the clear button returns to all parts', (await quiet.textContent().catch(() => ''))?.trim() === 'all parts')
check('the file loses the key', !('parts' in file()))
if (PROBE) check('the module is told nothing is picked', /picked: \[\]/.test((await told()) ?? ''))

/* 6. The focus goes with the epic. */
await quiet.click()
await page.waitForTimeout(300)
await row(a.heading).click()
await page.waitForTimeout(400)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const plainTitle = (await api(`/host/epics?project=${projectId}`, 'GET')).epics.find((e) => e.slug === PLAIN)
await epics.click()
await page.waitForTimeout(300)
await page.locator('[role="menuitem"]', { hasText: plainTitle.title ?? PLAIN }).first().click()
await page.waitForTimeout(800)
check('an epic with no parts draws no control', (await quiet.count()) === 0 && (await loud.count()) === 0)
check('switching epic cleared the stored focus', JSON.stringify((await stored()).parts) === '[]')
if (PROBE) check('the module is told there are no parts', /parts \(0\)/.test((await told()) ?? ''), (await told())?.split('\n')[0])
await shot('5-plain-epic')
const dividedTitle = (await api(`/host/epics?project=${projectId}`, 'GET')).epics.find((e) => e.slug === EPIC)
await epics.click()
await page.waitForTimeout(300)
await page.locator('[role="menuitem"]', { hasText: dividedTitle.title ?? EPIC }).first().click()
await page.waitForTimeout(800)
check('coming back starts on the whole epic', (await quiet.textContent().catch(() => ''))?.trim() === 'all parts')

/* 7. A part written into the file by hand arrives on its own, and a step
      assigned to it is counted. */
const epicFile = join(PROJECT, '.kehikot', 'kehikko', 'epics', `${EPIC}.json`)
const before = readFileSync(epicFile, 'utf8')
const epic = JSON.parse(before)
epic.groups.push({ id: 'written-by-hand', heading: 'Written by hand', refs: ['gh#901'] })
epic.steps[0].part = 'written-by-hand'
writeFileSync(epicFile, `${JSON.stringify(epic, null, 2)}\n`)
await page.waitForTimeout(4000)
await quiet.click()
await page.waitForTimeout(300)
const added = row('Written by hand')
check('a group added to the file appears without a reload', await added.isVisible().catch(() => false))
const counted = (await added.textContent().catch(() => '')) ?? ''
check('the step assigned to it is counted, and its ref folded in', /1 step/.test(counted) && /2 refs/.test(counted), counted.trim())
await shot('6-written-by-hand')
await page.keyboard.press('Escape')
writeFileSync(epicFile, before)

await browser.close()
for (const problem of problems) console.log(`PROBLEM ${problem}`)
const failed = checks.filter((c) => !c.ok).length + problems.length
console.log(failed ? `\n${failed} failed` : `\nall ${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
