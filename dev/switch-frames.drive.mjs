/*
 * What a switch looks like, frame by frame: a kehikko switch, an epic switch
 * and a project switch, in WebKit and Chromium, light and dark — recorded,
 * cut at fixed times after the press, and measured for a dark flash. And the
 * pages at twice the device pixel ratio, at rest, before and after a switch.
 *
 *     node dev/switch-frames.drive.mjs [out dir]     # default /tmp/kehikko-switch-frames
 *
 * Needs `ffmpeg` and ImageMagick's `magick` on the PATH (evidence, not a
 * gate: `dev/pages-take-input.drive.mjs` is the gate, and `bun test` runs it).
 *
 * ## How a frame is put at a time
 *
 * Each browser records a video of the whole run. Just before each press a
 * small magenta square is drawn in the bottom-left corner of the window, and
 * a listener the page installs turns it green on the pointer-down of the
 * press itself — so the first video frame with a green square is the press,
 * to the frame, whatever the recording's own clock says. The video is
 * resampled to 50 frames a second and cut at +0, +60, +120, +200 and +400 ms.
 *
 * ## The dark flash
 *
 * For every frame from the press to +400 ms, the mean brightness of the
 * canvas (everything under the bar). A dip below both the frame before the
 * press and the frame at rest after it, by more than `DIP` (of 1) or to
 * less than `DARKER` of the darker of the two, is a flash: reported, and the
 * exit status is 1. Measured on a dark canvas before the underlay
 * (`canvas/Underlay.tsx`): 0.045 → 0.005 → 0.044, a black frame in every
 * switch; with it, 0.045 → 0.040 → 0.044.
 *
 * ## Sharpness
 *
 * At a device pixel ratio of 2: Alpha's page as drawn at rest on the first
 * load, and again after switching to another kehikko and back. The two must
 * be the same pixels — a page left drawn from a blurred or lower-resolution
 * raster after a switch is not.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { bootHost, stop } from './scratch-host.mjs'

const OUT = process.argv[2] ?? '/tmp/kehikko-switch-frames'
const BROWSERS = (process.env.BROWSERS ?? 'webkit,chromium').split(',').filter(Boolean)
const SCHEMES = (process.env.SCHEMES ?? 'light,dark').split(',').filter(Boolean)
const DIP = Number(process.env.DIP ?? 0.06)
const DARKER = Number(process.env.DARKER ?? 0.6)
const VIEW = { width: 1400, height: 900 }
const BAR = 40
const AT_MS = [0, 60, 120, 200, 400]

const pw = await import('playwright-core')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const problems = []
const report = []

async function ready(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-frame]', { state: 'attached', timeout: 30000 })
  for (let tries = 0; tries < 6 && (await page.locator('[role="dialog"]').count()); tries += 1) {
    const myself = page.locator('[role="dialog"] button', { hasText: 'do it myself' })
    if (await myself.count()) await myself.first().click()
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-frame]').length >= 3, null, { timeout: 30000 })
  await page.waitForTimeout(1500)
}

async function pressAt(page, locator) {
  await locator.waitFor({ state: 'visible' })
  const box = await locator.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/* The marker: magenta until the press's own pointer-down, green from it. */
const MARK = () => {
  let mark = document.getElementById('__press-mark')
  if (!mark) {
    mark = document.createElement('div')
    mark.id = '__press-mark'
    Object.assign(mark.style, { position: 'fixed', left: '0', bottom: '0', width: '16px', height: '16px', zIndex: '2147483647', pointerEvents: 'none' })
    document.body.append(mark)
  }
  mark.style.background = '#ff00ff'
  window.addEventListener('pointerdown', () => (mark.style.background = '#00ff00'), { capture: true, once: true })
}

async function switches(page) {
  const done = []
  const one = async (what, open, item) => {
    await pressAt(page, open)
    await item.waitFor({ state: 'visible' })
    await page.waitForTimeout(500)
    await page.evaluate(MARK)
    await page.waitForTimeout(300)
    await pressAt(page, item)
    await page.waitForTimeout(1200)
    done.push(what)
  }
  await one('kehikko', page.locator('button[aria-label="switch kehikko"]'), page.locator('[role="menuitem"]', { hasText: 'Tall' }).first())
  const epic = page.locator('button[aria-label="the epic this project is on"]')
  const other = (await epic.innerText()).includes('Results') ? 'Methods' : 'Results'
  await one('epic', epic, page.locator('[role^="menuitem"]', { hasText: other }).first())
  await one('project', page.locator('button[aria-label="switch project"]'), page.locator('[role="menuitem"]', { hasText: 'project-b' }).first())
  /* And back where it started, for the next browser. */
  await pressAt(page, page.locator('button[aria-label="switch project"]'))
  await pressAt(page, page.locator('[role="menuitem"]', { hasText: 'project-a' }).first())
  await page.waitForTimeout(800)
  await pressAt(page, page.locator('button[aria-label="switch kehikko"]'))
  await pressAt(page, page.locator('[role="menuitem"]', { hasText: 'Wide' }).first())
  await page.waitForTimeout(800)
  return done
}

const pixel = (file, x, y) => run('magick', [file, '-format', `%[pixel:p{${x},${y}}]`, 'info:'])
const brightness = (file) => Number(run('magick', [file, '-crop', `${VIEW.width}x${VIEW.height - BAR - 20}+0+${BAR}`, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']))

function cut(video, label, names) {
  const dir = join(OUT, `${label}-frames`)
  mkdirSync(dir, { recursive: true })
  run('ffmpeg', ['-loglevel', 'error', '-i', video, '-vf', 'fps=50', join(dir, '%05d.png')])
  const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => join(dir, f))
  /* Each press: the first green frame after a magenta one. Colours in a
     compressed video are near, not exact, so "green" and "magenta" are read loosely. */
  const near = (file, want) => {
    const [r, g, b] = (pixel(file, 6, VIEW.height - 6).match(/[\d.]+/g) ?? []).map(Number)
    if (r === undefined) return false
    const scale = pixel(file, 6, VIEW.height - 6).includes('%') ? 2.55 : 1
    const [R, G, B] = [r * scale, g * scale, b * scale]
    return want === 'green' ? G > 180 && G - R > 80 && G - B > 80 : R > 160 && B > 160 && R - G > 80
  }
  const presses = []
  let armed = false
  for (let i = 0; i < files.length; i += 1) {
    if (near(files[i], 'magenta')) armed = true
    else if (armed && near(files[i], 'green')) {
      presses.push(i)
      armed = false
    }
  }
  const rows = []
  presses.forEach((at, n) => {
    const what = names[n] ?? `switch ${n + 1}`
    const picked = AT_MS.map((ms) => files[Math.min(files.length - 1, at + Math.round(ms / 20))])
    const series = []
    for (let i = Math.max(0, at - 1); i <= Math.min(files.length - 1, at + 20); i += 1) series.push(brightness(files[i]))
    const before = series[0]
    const after = series.at(-1)
    const low = Math.min(...series)
    const high = Math.max(...series)
    const dip = Math.min(before, after) - low
    /* Absolute for a light canvas, relative for a dark one: 0.045 to 0.005 is
       a small number and a black frame. */
    const flash = dip > DIP || low < Math.min(before, after) * DARKER
    const sheet = join(OUT, `${label}-${what}.png`)
    run('magick', [
      'montage',
      ...picked.flatMap((file, k) => ['-label', `+${AT_MS[k]} ms`, file]),
      '-tile', `${picked.length}x1`, '-geometry', '560x360+4+4', '-pointsize', '20', '-title', `${label}: ${what} switch`, sheet,
    ])
    rows.push({ label, switch: what, sheet, before: +before.toFixed(3), lowest: +low.toFixed(3), highest: +high.toFixed(3), after: +after.toFixed(3), flash })
    if (flash) problems.push(`${label} ${what}: the canvas dipped to ${low.toFixed(3)} between ${before.toFixed(3)} and ${after.toFixed(3)}`)
  })
  if (presses.length !== names.length) problems.push(`${label}: found ${presses.length} presses in the video, expected ${names.length}`)
  rmSync(dir, { recursive: true, force: true })
  return rows
}

async function sharpness(kind, browserType, url) {
  const browser = await browserType.launch()
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, colorScheme: 'light' })
  await context.addCookies([{ name: 'kehikko.theme', value: 'light', url }])
  const page = await context.newPage()
  await ready(page, url)
  const holder = page.locator('[data-frame="kehikot.alpha"]')
  const shot = async (name) => {
    await page.mouse.move(VIEW.width - 2, VIEW.height - 2)
    await page.waitForTimeout(400)
    const box = await holder.boundingBox()
    const file = join(OUT, `${kind}-dpr2-${name}.png`)
    await page.screenshot({ path: file, clip: { x: box.x, y: box.y, width: Math.min(box.width, 520), height: Math.min(box.height, 260) } })
    return file
  }
  const before = await shot('at-rest')
  await pressAt(page, page.locator('button[aria-label="switch kehikko"]'))
  await pressAt(page, page.locator('[role="menuitem"]', { hasText: 'Tall' }).first())
  await page.waitForTimeout(900)
  await pressAt(page, page.locator('button[aria-label="switch kehikko"]'))
  await pressAt(page, page.locator('[role="menuitem"]', { hasText: 'Wide' }).first())
  await page.waitForTimeout(900)
  const after = await shot('after-a-switch')
  let differ = 0
  try {
    run('magick', ['compare', '-metric', 'AE', before, after, 'null:'])
  } catch (error) {
    differ = Number(String(error.stderr ?? '').trim().split(/\s/)[0]) || -1
  }
  const ratio = await page.evaluate(() => window.devicePixelRatio)
  const sheet = join(OUT, `${kind}-dpr2.png`)
  run('magick', ['montage', '-label', 'at rest, first load', before, '-label', 'at rest, after a switch and back', after, '-tile', '2x1', '-geometry', '+6+6', '-pointsize', '22', '-title', `${kind}, device pixel ratio ${ratio}`, sheet])
  report.push({ label: `${kind} dpr2`, devicePixelRatio: ratio, differingPixels: differ, sheet })
  if (differ !== 0) problems.push(`${kind}: at a device pixel ratio of 2, Alpha's page after a switch differs from before it in ${differ} pixels`)
  await browser.close()
}

try {
  const url = await bootHost('kehikko-switch-frames')
  for (const kind of BROWSERS) {
    for (const scheme of SCHEMES) {
      const label = `${kind}-${scheme}`
      const browser = await pw[kind].launch()
      const context = await browser.newContext({ viewport: VIEW, colorScheme: scheme, recordVideo: { dir: join(OUT, 'video'), size: VIEW } })
      /* The host's own theme is its cookie (`host/theme.ts`), dark when unset. */
      await context.addCookies([{ name: 'kehikko.theme', value: scheme, url }])
      const page = await context.newPage()
      await ready(page, url)
      const names = await switches(page)
      const video = await page.video().path()
      await context.close()
      await browser.close()
      const rows = cut(video, label, names)
      report.push(...rows)
      for (const row of rows) console.log(`${row.flash ? 'FLASH' : 'ok   '} ${label} ${row.switch}: canvas ${row.before} → lowest ${row.lowest} → ${row.after}  ${row.sheet}`)
    }
    await sharpness(kind, pw[kind], url)
    console.log(`${problems.some((p) => p.startsWith(kind + ':')) ? 'FAIL' : 'ok  '} ${kind} dpr2: ${JSON.stringify(report.at(-1))}`)
  }
} catch (error) {
  problems.push(`the drive itself failed: ${error.stack ?? error}`)
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ report, problems }, null, 2))
stop()
if (problems.length) console.log(`\n${problems.join('\n')}`)
console.log(`\nframes in ${OUT}`)
process.exit(problems.length ? 1 : 0)
