/*
 * Press the `+` beside the epic select with a real pointer, and say what
 * happened to the epic, the file, and the footer.
 *
 *     node dev/epic.drive.mjs [page url] [project folder]
 *
 * ## Why this is a driver and not a test
 *
 * For the reason `pencil.drive.mjs` gives: what is being checked is a popover
 * over a header, a field that follows another field, a refusal that has to
 * land in the footer while the form stays open, and a wake that has to reach
 * a page that is sitting still — none of which a test without a browser can
 * see, and this host has no DOM harness.
 *
 * Run it against a scratch host — its own `ROADMAP_FRAME_DB`, its own
 * `ROADMAP_MODULES_DIR`, a scratch project folder — because it WRITES: one
 * epic file into the project's `data/epics`, and one into a project that had
 * no `data/epics` at all, which it then has.
 *
 * Exits 0 when: the `+` is offered; typing a title derives a slug; create
 * writes the file and OPENS the epic; the same slug again is refused with the
 * server's sentence in the footer and the form still open; an epic made at
 * the MCP door appears in the dropdown without a reload and does NOT change
 * the open epic; and in a project with no `data/epics` the `+` says the
 * directory will be made, and makes it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT ?? '/tmp/height-drive/node_modules/playwright-core/index.mjs')

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4391/'
const PROJECT = process.argv[3] ?? '/tmp/epics-made-scratch/projects/roadmapish'
const API = process.env.API ?? 'http://127.0.0.1:4390'

const browser = await chromium.launch({ executablePath: process.env.CHROME })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const problems = []
const checks = []
const check = (what, ok, detail = '') => {
  checks.push({ what, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`)
}
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() !== 'error') return
  const text = message.text()
  /* Two kinds of console error are the point rather than a problem: a module
     on another port refusing to be framed by a scratch host it was not told
     about (its CSP names the real page's port), and the browser logging the
     409 the server answers a deliberate duplicate with. Both are printed;
     neither fails the run. */
  if (text.includes('frame-ancestors') || /status of (404|409)/.test(text)) {
    console.log(`(expected) ${text.split('\n')[0]}`)
    return
  }
  problems.push(`console: ${text}`)
})

await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

const trigger = page.locator('button[aria-label="the epic this kehikko is about"]')
const plus = page.locator('button[aria-label="new epic"]')
const footer = page.locator('footer')

console.log('epic before:', JSON.stringify((await trigger.textContent())?.trim()))
check('the + is offered beside the select', await plus.isVisible())

/* 0. Two containers placed at the door while the page watches. */
const placed = await fetch(`${API}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'tools/call',
    params: { name: 'place_modules', arguments: { kehikko: 1, modules: ['roadmap.notes', 'roadmap.paper'] } },
  }),
}).then((r) => r.json())
console.log('door said:', placed.result?.content?.[0]?.text?.split('\n')[0])
await page.waitForTimeout(1500)
const containers = await page.locator('.react-grid-item').count()
check('the containers arrived on the page without a reload', containers === 2, `${containers} drawn`)
await page.screenshot({ path: '/tmp/epics-made-scratch/placed.png' })

/* 1. Make one by hand. */
await plus.click()
await page.waitForTimeout(400)
const title = page.locator('input[aria-label="what the new epic is called"]')
const slug = page.locator('input[aria-label="what the new epic is filed under — its slug"]')
check('a form with a title field opened', await title.isVisible())
await title.type('Made by hand!')
await page.waitForTimeout(150)
check('the slug follows the title', (await slug.inputValue()) === 'made-by-hand', await slug.inputValue())
await page.screenshot({ path: '/tmp/epics-made-scratch/form.png' })
await page.locator('button:has-text("create and open")').click()
await page.waitForTimeout(1200)

const after = (await trigger.textContent())?.trim()
check('the kehikko opened the epic it made', after === 'made-by-hand', JSON.stringify(after))
const file = join(PROJECT, 'data', 'epics', 'made-by-hand.json')
check('the file exists', existsSync(file), file)
if (existsSync(file)) console.log(readFileSync(file, 'utf8'))
check('the form closed', !(await title.isVisible().catch(() => false)))

/* 2. The same slug again: refused, in the footer, form still open. */
await plus.click()
await page.waitForTimeout(400)
await title.type('Made by hand')
await page.locator('button:has-text("create and open")').click()
await page.waitForTimeout(1000)
const said = (await footer.textContent()) ?? ''
check('the refusal is the server’s sentence, in the footer', said.includes('already an epic called made-by-hand'), said.slice(0, 160))
check('the form stayed open with the title in it', (await title.isVisible()) && (await title.inputValue()) === 'Made by hand')
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

/* 3. An epic made at the door appears without a reload, and the open epic stays. */
const rpc = await fetch(`${API}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'create_epic', arguments: { kehikko: 1, title: 'Made at the door while watching' } },
  }),
}).then((r) => r.json())
console.log('door said:', rpc.result?.content?.[0]?.text?.split('\n')[0])
await page.waitForTimeout(1200)
check('the open epic did not change', (await trigger.textContent())?.trim() === 'made-by-hand')
await trigger.click()
await page.waitForTimeout(400)
const rows = await page.locator('[role="menu"] [role="menuitem"]').allTextContents()
check('the door’s epic is in the dropdown without a reload', rows.some((r) => r.includes('Made at the door while watching')), JSON.stringify(rows))
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

/* 4. A project with no data/epics: the + says so, and makes it. */
const thesis = join(PROJECT, '..', 'thesis')
const added = await fetch(`${API}/host/projects`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: thesis }),
}).then((r) => r.json())
const thesisId = added.project?.id
console.log('thesis project id:', thesisId)
await page.evaluate((id) => window.localStorage.setItem('roadmap.frame.project.v1', String(id)), thesisId)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
console.log('epic control in thesis:', JSON.stringify((await trigger.textContent())?.trim()))
check('the select is disabled in a project with no data/epics', await trigger.isDisabled())
check('the + is still offered there', await plus.isVisible())
await plus.hover()
await page.waitForTimeout(600)
const hint = (await page.locator('[role="tooltip"]').allTextContents()).join(' ')
check('the hint says the directory will be made', hint.includes('makes that directory'), hint)
await plus.click()
await page.waitForTimeout(400)
await title.type('Chapter one')
await page.locator('button:has-text("create and open")').click()
await page.waitForTimeout(1200)
check('data/epics was made in the thesis folder', existsSync(join(thesis, 'data', 'epics', 'chapter-one.json')))
check('and the thesis kehikko opened it', (await trigger.textContent())?.trim() === 'chapter-one', JSON.stringify((await trigger.textContent())?.trim()))

/* 5. No project at all: the + is not offered. Every project forgotten. */
for (const id of [thesisId, 1]) {
  await fetch(`${API}/host/projects`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
console.log('epic control with no project:', JSON.stringify((await trigger.textContent())?.trim()))
check('with no project the + is not offered', (await plus.count()) === 0)

await page.screenshot({ path: '/tmp/epics-made-scratch/after.png' })
console.log('')
console.log('problems:', problems.length ? problems : 'none')
const verdict = checks.every((c) => c.ok) && problems.length === 0
console.log(verdict ? 'PASS' : `FAIL: ${checks.filter((c) => !c.ok).map((c) => c.what).join('; ')}`)
await browser.close()
process.exit(verdict ? 0 : 1)
