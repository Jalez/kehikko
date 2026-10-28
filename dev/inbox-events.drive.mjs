/*
 * A module's named Inbox event (protocol 2.31.0), drawn for real in Chromium, light and dark, on a
 * scratch host (`dev/scratch-host.mjs`): a stand-in declares "Research complete" and reports a
 * finished item naming it (a press of "report"). The toast must head with "Research complete", and
 * Settings › Inbox notifications must list the event under the module with the research chime
 * chosen. `PRINT_SHOTS=1` prints each screenshot as base64; `EVENTS_FAIL=1` ends in a failure, so
 * bee copies the shots too.
 *
 *     node dev/inbox-events.drive.mjs
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

const PAGE = await bootHost('inbox-events', {
  standin: (id) =>
    id === 'kehikot.alpha'
      ? {
          STANDIN_EVENTS: JSON.stringify([{ id: 'research-complete', says: 'Research complete', state: 'done' }]),
          STANDIN_ACTIVITY: JSON.stringify([{ id: 'r', state: 'done', label: 'Protocol audit', event: 'research-complete' }]),
        }
      : {},
})

for (const scheme of ['light', 'dark']) {
  const browser = await pw.chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: scheme })
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
  expect((await toast.count()) === 1, `${scheme}: one toast (${await toast.count()})`)
  if (await toast.count()) {
    const word = (await toast.first().locator('[data-toast-kind]').innerText()).trim()
    expect(word === 'Research complete', `${scheme}: it heads with the event's words (${word})`)
    expect((await toast.first().innerText()).includes('Protocol audit'), `${scheme}: and the label`)
    const shot = await page.screenshot()
    if (PRINT) say(`SHOT inbox-events-toast-${scheme} ${shot.toString('base64')}`)
  }

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kehikot:settings', { detail: 'sounds' })))
  const events = page.locator('[data-chime-events]')
  await events.waitFor({ timeout: 10000 }).catch(() => undefined)
  expect((await events.count()) === 1, `${scheme}: Settings lists the events`)
  if (await events.count()) {
    const row = events.locator('[data-chime-event="research-complete"]')
    expect((await row.locator('label').innerText()).trim() === 'Research complete', `${scheme}: by the event's words`)
    expect((await row.locator('select').inputValue()) === 'preset:research', `${scheme}: the research chime by default`)
    await events.scrollIntoViewIfNeeded()
    const shot = await page.screenshot()
    if (PRINT) say(`SHOT inbox-events-settings-${scheme} ${shot.toString('base64')}`)
    const near = await events.screenshot()
    if (PRINT) say(`SHOT inbox-events-section-${scheme} ${near.toString('base64')}`)
  }
  await context.close()
  await browser.close()
}

if (failures.length) say(`\n${failures.length} failed:\n${failures.join('\n')}`)
else say('\nall good')
process.exit(failures.length || process.env.EVENTS_FAIL === '1' ? 1 : 0)
