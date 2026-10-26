/*
 * What the host asks of a module it starts, while it waits for it to answer — read from its own
 * record of traffic (`traffic.read`, the Monitor's door) on a scratch host (`dev/scratch-host.mjs`).
 * No browser: the page's two requests on arriving (`POST /host/open`, `GET /host/modules`) are made
 * here as the page makes them, for a kehikko holding one module whose `run.sh` takes START_S
 * seconds (default 5) before it serves.
 *
 *     node dev/start-wait.drive.mjs            # the counts
 *     CHECK=1 node dev/start-wait.drive.mjs    # what `bun test` runs: fails on the old shape
 *
 * Monitor once showed, for every module of a restart round, its manifest fetched about thirty times
 * in five and a half seconds under "the page reads the modules": the host's wait for a module it had
 * started asked every 300 ms, filed under whichever page request had decided to start it. With
 * CHECK=1 this fails when the wait asks more than WAIT_MOST times, or when any of its asks is filed
 * under a page's request.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { bootHost, HOST, scratch, stop } from './scratch-host.mjs'

const CHECK = process.env.CHECK === '1'
const START_S = Number(process.env.START_S ?? 5)
const WAIT_MOST = Number(process.env.WAIT_MOST ?? 11)
const BUN = process.env.BUN ?? 'bun'
const MANIFEST = '/.well-known/kehikot-module.json'
const WAITS = 'the host waits for a module it started'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const failures = []

try {
  const page = new URL(await bootHost('start-wait', { traffic: true })).origin
  const api = `http://127.0.0.1:${scratch.api}`
  const gamma = scratch.modules.find((one) => one.id === 'kehikot.gamma').port
  /* A port nothing on this machine is likely to hold; the stand-in takes it after START_S. */
  const port = 41_000 + Math.floor(Math.random() * 3_000)
  const dir = join(scratch.root, 'slow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'run.sh'),
    `#!/bin/sh\nsleep ${START_S}\nexec "${BUN}" "${join(HOST, 'test/fixtures/standin/server.ts')}" kehikot.slow Slow ${port} "$KEHIKOT_ORIGINS"\n`,
  )
  chmodSync(join(dir, 'run.sh'), 0o755)
  writeFileSync(join(scratch.root, 'modules/kehikot.slow.json'), JSON.stringify({ url: `http://127.0.0.1:${port}`, dir }))

  /* As the page asks: its own origin, same-origin. */
  const asPage = { origin: page, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  const { canvases } = await (await fetch(`${api}/host/canvases`, { headers: asPage })).json()
  const canvas = canvases[0]
  const placed = await fetch(`${api}/host/canvases/${canvas.id}`, {
    method: 'PATCH',
    headers: asPage,
    body: JSON.stringify({ placements: [...canvas.placements, { i: 'kehikot.slow', x: 0, y: 80, w: 4, h: 16 }] }),
  })
  if (!placed.ok) throw new Error(`placing the module: ${placed.status}`)

  let since = 0
  const rows = []
  const read = async () => {
    const got = await (await fetch(`http://127.0.0.1:${gamma}/traffic?since=${since}`)).json()
    if (!got.ok) throw new Error(`traffic.read: ${got.why}`)
    rows.push(...got.data.calls)
    since = got.data.calls.length ? got.data.calls.at(-1).seq : got.data.newest
  }
  await read()
  const from = Date.now()
  /* The page arriving: what it has open, then the modules. */
  await fetch(`${api}/host/open`, { method: 'POST', headers: asPage, body: JSON.stringify({ page: 'start-wait', kehikko: canvas.id }) })
  await fetch(`${api}/host/modules`, { headers: asPage })
  await sleep(START_S * 1000 + 5_000)
  await read()

  const asked = rows.filter((row) => row.at >= from && row.side === 'out' && row.path === MANIFEST && String(row.host).endsWith(`:${port}`))
  const by = new Map()
  for (const row of asked) by.set(row.reason ?? 'no reason given', (by.get(row.reason ?? 'no reason given') ?? 0) + 1)
  console.log(`a module that takes ${START_S} s to start: its manifest was asked ${asked.length} times`)
  for (const [why, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${why}`)

  if (CHECK) {
    const waited = by.get(WAITS) ?? 0
    if (waited === 0) failures.push(`nothing was filed under "${WAITS}"`)
    if (waited > WAIT_MOST) failures.push(`the wait asked ${waited} times; at most ${WAIT_MOST}`)
    const fromPage = asked.filter((row) => row.reason === 'the page says what it has open' || row.reason === 'the page reads the modules')
    /* One read each is the page's own: the report's sweep and the modules read ask what is not kept. */
    if (fromPage.length > 2) failures.push(`${fromPage.length} asks were filed under the page's requests; the wait is the host's`)
  }
} catch (error) {
  failures.push(`the drive failed: ${error?.stack ?? error}`)
} finally {
  stop()
}

if (failures.length) {
  console.log('\nFAILED')
  for (const line of failures) console.log(`  ${line}`)
  process.exit(1)
}
console.log('\nthe counts were read from the record of traffic')
