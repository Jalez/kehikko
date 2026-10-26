/*
 * `dev/cold-start.drive.mjs` with the REAL page: the same scratch host, the same six modules the host
 * starts (some slow to come up), and the page itself in Chromium, arriving at the kehikko that has
 * them. The same counts and, with CHECK=1, the same failures — what the plain-HTTP drive cannot
 * see is whether the page itself asks for more than it says: a timer, a retry, a look on every
 * frame that loads. Browser tests run on bee only (`dev/bee-browser-tests.sh`,
 * `test/cold-start-page.test.ts`).
 *
 *     CHECK=1 node dev/cold-start-page.drive.mjs
 */
import { coldStart } from './cold-start.drive.mjs'

const pw = await import('playwright-core')

let browser = null
const thrown = []
const { failures } = await coldStart({
  check: process.env.CHECK === '1',
  page: async ({ url }) => {
    browser = await pw.chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    /* Nothing is asked of GitHub's release list for the What's new notice: it would go nowhere anyway. */
    await context.route((address) => address.pathname === '/host/releases', (route) => route.fulfill({ status: 503, body: '{}' }))
    const page = await context.newPage()
    page.on('pageerror', (error) => thrown.push(`the page threw: ${error.message}`))
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return {
      close: () => void browser?.close().catch(() => {}),
      /* A module's frame is titled with its name (`ModuleFrame.tsx`). */
      async unframed(names) {
        const missing = []
        for (const name of names) if (!(await page.locator(`iframe[title="${name}"]`).count())) missing.push(name)
        return missing
      },
    }
  },
})
await browser?.close().catch(() => {})
failures.push(...thrown)
if (failures.length) {
  console.log('\nFAILED')
  for (const line of failures) console.log(`  ${line}`)
  process.exit(1)
}
console.log('\nthe counts were read from the record of traffic, with the page in Chromium')
