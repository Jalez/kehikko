/*
 * A tooltip must not outlive the control it belongs to.
 *
 * ## What it establishes
 *
 * In focus mode the container headers are not drawn. They are also not
 * REMOVED: `index.css` fades them with `opacity: 0` and takes them out of
 * hit-testing with `pointer-events: none`, and the essay there explains why —
 * the reveal has to be reachable again the moment the pointer comes near the
 * top of a container, and an unmounted header is not something CSS can bring
 * back.
 *
 * The consequence is what this probe measures, and this file exists because the
 * obvious diagnosis was wrong. A tooltip's content is in a portal at the
 * document root, so it is neither clipped by the container nor hidden with it,
 * and it went on being drawn over the canvas long after the header had faded:
 * a floating sentence anchored to something nobody can see. The natural
 * explanation is that the trigger never got a `pointerleave`. Instrumenting the
 * button says otherwise -- `pointerout` and `pointerleave` both arrive on the
 * way out, and the tooltip stays open anyway.
 *
 * What kept it open was Radix's hoverable content, which does not close on
 * leave but on the first later `pointermove` outside a grace-area polygon --
 * and below a container header is the module's iframe, which the host's
 * document gets no pointer events from at all. The dismissal was owed to an
 * event that never came. `Hint.tsx` has the full argument and the fix.
 *
 * Four numbers. Two are the bug, and they failed differently -- one of them
 * never failed at all, which is worth knowing before changing anything near it:
 *
 *   - `afterPointerOut`: how many tooltips are still in the document after the
 *     pointer has been moved off a container whose header it had just revealed
 *     and hovered. Must be 0.
 *   - `afterBlur`: the same count after the header was revealed by KEYBOARD —
 *     `:focus-within`, which is the other half of the reveal and the reason
 *     `Hint.tsx` exists at all — and focus was then moved away. Must be 0, and
 *     WAS already 0 before the fix. Focus and blur reach a trigger directly
 *     whatever the pointer is doing, and no grace area is involved. It is
 *     measured so that a future change to how the header hides cannot break
 *     the keyboard half quietly.
 *
 * And two that guard the fix rather than the bug, because the cheap way to
 * make the first two zero is to break the feature:
 *
 *   - `whileHovering`: a tooltip must still OPEN and stay open while the
 *     pointer is on the control. Must be 1. A fix that closes tooltips
 *     eagerly enough to pass the two above and fails this has removed the
 *     labels rather than fixed their lifetime, and every icon in a container
 *     header goes back to being unnameable.
 *   - `whileFocused`: the same for the keyboard, which is the case `title` was
 *     abandoned for — it does not appear on focus, and the people who most
 *     need the label were the ones who never saw it. Must be 1.
 *
 * ## Running it
 *
 *   PLAYWRIGHT=/path/to/playwright/index.mjs CHROME=/path/to/chrome-headless-shell \
 *     node dev/tooltips.mjs
 *
 * Playwright is not a dependency of this host and must not become one. `PORT`
 * is the PAGE's port -- the Vite one, the API's plus one -- and `./run.sh`
 * must be up. Focus mode is turned on by setting the cookie the blocking
 * script in `index.html` reads, rather than by pressing the button, so the
 * page is in the mode from its first paint and the run does not depend on
 * whichever mode the person using the host happens to have left it in. The
 * cookie is set on this browser context only and nothing on disk changes.
 *
 * ## The reading, before and after
 *
 *   before  {"whileHovering":1,"afterPointerOut":1,"whileFocused":1,"afterBlur":0}
 *   after   {"whileHovering":1,"afterPointerOut":0,"whileFocused":1,"afterBlur":0}
 */

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright')
const CHROME = process.env.CHROME
const PORT = process.env.PORT ?? '4181'

/* Radix renders tooltip content into a portal at the document root, in a
   wrapper it marks. Counting the wrapper rather than `[role="tooltip"]`
   catches the case where the content has been emptied but the positioned box
   is still there taking up a corner of the canvas. */
const COUNT = `() => document.querySelectorAll('[data-radix-popper-content-wrapper]').length`

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await context.addCookies([
  { name: 'kehikko.focus', value: 'on', url: `http://127.0.0.1:${PORT}` },
])
const page = await context.newPage()

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
await page.waitForSelector('.react-grid-item', { timeout: 20_000 })
await page.waitForTimeout(3000)

const item = page.locator('.react-grid-item').first()
const box = await item.boundingBox()

/* The reveal is eight pixels along the top edge at rest and grows to a header
   when hovered, so the pointer has to arrive in that strip before any control
   in the header is a thing that can be hovered at all. Two moves rather than
   one: the first opens the header, the second lands on a button inside it. */
await page.mouse.move(box.x + box.width / 2, box.y + 3)
await page.waitForTimeout(400)

const control = item.locator('.container-grip button').last()
const cbox = await control.boundingBox()
await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2)
/* Longer than the tooltip's own open delay, which `Bar.tsx` sets to 400ms for
   the strip and shadcn defaults to elsewhere. */
await page.waitForTimeout(1200)
const whileHovering = await page.evaluate(`(${COUNT})()`)

/* Off the container entirely, and far enough that no part of it is under the
   pointer -- the reveal un-matches, the header fades, and the question is
   whether anything told the tooltip. */
await page.mouse.move(box.x + box.width / 2, box.y + box.height + 60)
await page.waitForTimeout(1200)
const afterPointerOut = await page.evaluate(`(${COUNT})()`)

/* And the keyboard half. `:focus-within` opens the header too, and Radix opens
   a tooltip on focus as well as hover, which is the whole reason `title` was
   replaced. Focus a control, then move focus off it. */
await page.mouse.move(0, 0)
await page.waitForTimeout(600)
await page.evaluate(() => {
  const grip = document.querySelector('.react-grid-item .container-grip')
  const button = grip?.querySelector('button')
  button?.focus()
})
await page.waitForTimeout(1200)
const whileFocused = await page.evaluate(`(${COUNT})()`)

await page.evaluate(() => document.activeElement?.blur?.())
await page.waitForTimeout(1200)
const afterBlur = await page.evaluate(`(${COUNT})()`)

console.log(JSON.stringify({ whileHovering, afterPointerOut, whileFocused, afterBlur }))

await browser.close()
