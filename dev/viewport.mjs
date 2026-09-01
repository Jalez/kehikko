/*
 * Does this host stay inside the window, and do the pages stay on their
 * containers when it is scrolled?
 *
 * ## What it establishes
 *
 * Six numbers per window size, and each one was an argument before it was a
 * measurement:
 *
 *   - `docScroll`: how many pixels the DOCUMENT can scroll. This must be 0.
 *     The whole point of the shell is that the window holds a strip, a canvas
 *     and a footer and none of them move out from under you; a document that
 *     scrolls at all means the footer can be pushed off the bottom, which is
 *     the one thing an always-visible strip must never do.
 *   - `canScroll`: how many pixels the CANVAS can scroll. This is allowed and
 *     usually wanted -- it is where the overflow went. `docScroll: 0` with
 *     `canScroll: 0` on an arrangement taller than the window would mean the
 *     bottom containers had been clipped away and made unreachable, which is
 *     worse than a scrolling page, so the pair has to be read together.
 *   - `footBottom` against `view`: where the footer's bottom edge is, against
 *     the window's height. Equal means the strip is sitting on the bottom of
 *     the window. Measured again AFTER a scroll, because a footer that is only
 *     in the right place at rest is a footer inside the scroller.
 *   - `wide`: `documentElement.scrollWidth`. Nothing may ever be wider than the
 *     window; a horizontal scrollbar on the document is the same defect in the
 *     other axis, and this workspace has already paid for one of those.
 *   - `off`: the worst disagreement, in pixels, between where a module's page
 *     is drawn and where its container's body actually is. This is the number
 *     the whole probe exists for. The pages are NOT children of the containers
 *     -- they live in one layer positioned from measured rectangles, see
 *     `src/host/rects.ts` -- so nothing in the browser keeps the two together,
 *     and a scroll is precisely the event that can separate them. A module's
 *     page floating somewhere its container is not is the class of bug this
 *     workspace keeps finding, and it is invisible in a screenshot taken at
 *     rest.
 *
 * `off` is reported at rest AND after scrolling, because reading it only at
 * `scrollTop: 0` measures the one position in which a scroll offset cannot be
 * wrong. `adrift` names which pages disagreed, so a bad run says which module
 * came off its container rather than only that one did.
 *
 * ## Running it
 *
 *   PLAYWRIGHT=/path/to/playwright/index.mjs CHROME=/path/to/chrome-headless-shell \
 *     node dev/viewport.mjs
 *
 * Playwright is not a dependency of this host and must not become one: it is a
 * hundred megabytes of browser for a program that ships none. Point it at
 * whatever copy is already on the machine. `./run.sh` must be up first, and
 * `PORT` here is the PAGE's port -- the Vite one, which is the API's plus one.
 *
 * This measures the kehikko that is actually open, with the modules that are
 * actually running. That is deliberate rather than lazy: the numbers that
 * matter here are how tall a real arrangement is against how tall the window
 * is, and a probe against an invented arrangement measures a layout nobody
 * will ever look at.
 *
 * ## The reading that made the footer safe to add
 *
 * Before, with no footer at all (`footBottom: null`), and after. The document
 * was already held to the window -- the shell has been `h-screen` with
 * `overflow-hidden` since the first commit -- so what the footer had to be
 * shown NOT to break was the canvas's scroll and the pages' alignment inside
 * it. It takes 24 pixels out of the canvas at every size and nothing else
 * moves:
 *
 *   1440x1000  canHeight 968 -> 944   canScroll   0 ->   0   off 0
 *   1280x800   canHeight 768 -> 744   canScroll   0 ->   0   off 0
 *   1200x560   canHeight 528 -> 504   canScroll 184 -> 208   off 0
 *   1200x400   canHeight 368 -> 344   canScroll 344 -> 368   off 0
 *
 * `docScroll` is 0 in every row of both runs, `wide` equals the window width in
 * every row, and `footBottom` equals `view` in every row of the second -- at
 * rest and after the scroll. `off` is 0 at rest and at the middle of the
 * travel.
 *
 * The kehikko open during that run had one visible page on it, so the same
 * measurement was taken again with four containers -- three visible pages -- at
 * 1280x700, at rest, at the middle of the travel and at the very bottom of it:
 * `off` was 0 in all three, `docScroll` 0, `footBottom` 700. That is the run
 * worth repeating after touching `rects.ts` or anything about how the canvas
 * scrolls.
 */

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright')
const CHROME = process.env.CHROME
const PORT = process.env.PORT ?? '4181'

/* A tall window where nothing should need to scroll, an ordinary laptop, and
   two short ones. The short ones are the case the owner asked about: a window
   barely taller than the chrome, where any arithmetic that assumes there is
   room left over falls apart. At 1200x400 the canvas is shorter than a single
   default container. */
const SIZES = [
  [1440, 1000],
  [1280, 800],
  [1200, 560],
  [1200, 400],
]

const MEASURE = `() => {
  const doc = document.scrollingElement
  const can = document.querySelector('main')
  const foot = document.querySelector('[data-footer]')
  const fbox = foot ? foot.getBoundingClientRect() : null

  /* Where each page is drawn against where its container's body is, in WINDOW
     coordinates -- the only frame of reference the two share. One is placed by
     a transform inside a scroller and the other by the grid, so comparing
     their own numbers would be comparing two different origins and would prove
     nothing at all. */
  const pairs = []
  for (const frame of document.querySelectorAll('[data-frame]')) {
    const id = frame.getAttribute('data-frame')
    const body = document.querySelector('[data-body="' + CSS.escape(id) + '"]')
    if (!body) continue
    /* A hidden page is one on another kehikko or in a folded container. It is
       laid out at its real size and deliberately not positioned over anything,
       so measuring it would report a disagreement that is the design. */
    if (frame.style.visibility === 'hidden') continue
    const f = frame.getBoundingClientRect()
    const b = body.getBoundingClientRect()
    pairs.push({
      id,
      dx: Math.round(f.left - b.left),
      dy: Math.round(f.top - b.top),
      dw: Math.round(f.width - b.width),
      dh: Math.round(f.height - b.height),
    })
  }
  const worst = pairs.reduce(
    (most, p) => Math.max(most, Math.abs(p.dx), Math.abs(p.dy), Math.abs(p.dw), Math.abs(p.dh)),
    0,
  )

  return {
    view: innerHeight,
    /* Travel, not height: how far a person can actually scroll the thing. */
    docScroll: Math.max(0, doc.scrollHeight - doc.clientHeight),
    docTop: Math.round(doc.scrollTop),
    canScroll: can ? Math.max(0, can.scrollHeight - can.clientHeight) : null,
    canTop: can ? Math.round(can.scrollTop) : null,
    canHeight: can ? Math.round(can.clientHeight) : null,
    footBottom: fbox ? Math.round(fbox.bottom) : null,
    footHeight: fbox ? Math.round(fbox.height) : null,
    wide: document.documentElement.scrollWidth,
    frames: pairs.length,
    off: pairs.length ? worst : null,
    adrift: pairs.filter((p) => p.dx || p.dy || p.dw || p.dh),
  }
}`

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {})

for (const [w, h] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' })
  /* The grid places every container twice -- once at `WidthProvider`'s
     hardcoded 1280 and once at the real width -- and the pages are positioned
     from measurements taken after that. Waiting for a container to exist is
     not enough; waiting out the settle is. */
  await page.waitForSelector('.react-grid-item', { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(2500)

  const rest = await page.evaluate(`(${MEASURE})()`)
  /* Half the remaining travel, so the reading is taken somewhere in the middle
     rather than at either end: an off-by-one-scroll-offset bug is invisible at
     0 and can be mistaken for a clamp at the bottom. */
  const after = await page.evaluate(`(async () => {
    const can = document.querySelector('main')
    const doc = document.scrollingElement
    const el = can && can.scrollHeight > can.clientHeight ? can : doc
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2)
    await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 400)))
    return (${MEASURE})()
  })()`)

  console.log(`${w}x${h}`, JSON.stringify({ rest, after }))
  await page.close()
}

await browser.close()
