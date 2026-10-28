/*
 * The Inbox toast, drawn for real in Chromium, light and dark, on a scratch host
 * (`dev/scratch-host.mjs`): a stand-in module reports three items at once (a press of "report"),
 * and the page must show ONE toast, bottom right, saying "3 new in the Inbox", the most urgent
 * first, with the kind as an icon and a word, then let it go by itself. `PRINT_SHOTS=1` prints
 * each screenshot as base64; `TOAST_FAIL=1` ends in a failure, so bee copies the shots too.
 *
 *     node dev/inbox-toast.drive.mjs
 */
import { bootHost } from './scratch-host.mjs'

const PRINT = process.env.PRINT_SHOTS === '1'
const pw = await import('playwright-core')
const failures = []
const say = (line) => console.log(line)
const expect = (ok, what) => {
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const PAGE = await bootHost('inbox-toast', {
  standin: (id) =>
    id === 'kehikot.alpha'
      ? {
          STANDIN_ACTIVITY: JSON.stringify([
            { id: 'a', state: 'done', label: 'Reel rendered' },
            { id: 'b', state: 'attention', label: 'Approve the deploy', priority: 'urgent' },
            { id: 'c', state: 'attention', label: 'Pick a title' },
          ]),
        }
      : {},
})

for (const scheme of ['light', 'dark']) {
  const browser = await pw.chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme })
  await context.addCookies([{ name: 'kehikko.theme', value: scheme, url: PAGE }])
  const page = await context.newPage()
  page.on('pageerror', (error) => failures.push(`${scheme}: the page threw: ${error.message}`))
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-frame]', { state: 'attached', timeout: 30000 })
  for (let tries = 0; tries < 6 && (await page.locator('[role="dialog"]').count()); tries += 1) {
    const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
    if (await myself.count()) await myself.first().click()
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  const alpha = page.frameLocator('[data-frame="kehikot.alpha"] iframe, iframe[data-frame="kehikot.alpha"]').first()
  await alpha.locator('#report').waitFor({ timeout: 20000 })
  await page.waitForTimeout(1500)
  await alpha.locator('#report').click()
  const toast = page.locator('[data-inbox-toast]')
  await toast.first().waitFor({ timeout: 10000 }).catch(() => undefined)
  expect((await toast.count()) === 1, `${scheme}: a burst of three is one toast (${await toast.count()})`)
  if (await toast.count()) {
    const text = (await toast.first().innerText()).replace(/\s+/g, ' ')
    expect(text.includes('3 new in the Inbox'), `${scheme}: it says how many (${text})`)
    expect(text.includes('Urgent') && text.includes('Approve the deploy'), `${scheme}: the most urgent first, kind as a word`)
    expect((await toast.first().locator('svg').count()) > 0, `${scheme}: the kind has an icon`)
    const box = await toast.first().boundingBox()
    expect(box && box.x + box.width > 1280 - 40 && box.y + box.height > 800 - 40, `${scheme}: bottom right`)
    const shot = await page.screenshot()
    if (PRINT) say(`SHOT inbox-toast-${scheme} ${shot.toString('base64')}`)
    /* Hovering holds it past its time; leaving lets it go. */
    await toast.first().hover()
    await page.waitForTimeout(9500)
    expect((await toast.count()) === 1, `${scheme}: hover keeps it`)
    await page.mouse.move(10, 10)
    await page.waitForTimeout(9500)
    expect((await toast.count()) === 0, `${scheme}: it goes by itself`)
  }
  await context.close()
  await browser.close()
}

if (failures.length) say(`\n${failures.length} failed:\n${failures.join('\n')}`)
else say('\nall good')
process.exit(failures.length || process.env.TOAST_FAIL === '1' ? 1 : 0)
