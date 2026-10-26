/*
 * Who the host's record of traffic says asked it, read on a scratch host (`dev/scratch-host.mjs`)
 * over plain HTTP — no browser. Every caller a person's machine has, in small:
 *
 *  - a module somebody started by hand (Epsilon, its server asking `/host/hello` every second),
 *  - a module the host started itself (Delta, registered with a `dir`, started by `/host/start`),
 *  - a module's page asking the host on its own origin,
 *  - an agent module (a stand-in `kehikot.claude`) that issues a place token and starts a session —
 *    a program named `claude` — that calls the host's MCP door with it,
 *  - the same agent program started from a terminal, outside Kehikot, calling the door without one,
 *  - `curl`, from a shell and from this script,
 *  - this host's page (requests with its origin).
 *
 * Then it reads the record (`traffic.read`, through the Gamma stand-in, as the Monitor does) and
 * lists every row received (`side: 'in'`) by who it says asked. A row nobody is named on — `by: ''`
 * and no `caller` — is "unknown", and is what this drive counts.
 *
 *     node dev/callers.drive.mjs            # the table
 *     CHECK=1 node dev/callers.drive.mjs    # and fail on any unknown row
 *     SAMPLE=1 node dev/callers.drive.mjs   # with the process sampler on, as with a Monitor open
 */
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { bootHost, freePort, HOST, scratch, stop } from './scratch-host.mjs'

const CHECK = process.env.CHECK === '1'
const SAMPLE = process.env.SAMPLE === '1'
const BUN = process.env.BUN ?? 'bun'
const BUN_PATH = execFileSync('/bin/sh', ['-c', `command -v ${BUN}`], { encoding: 'utf8' }).trim()
const say = (line) => console.log(line)
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

let agentPort = 0
let claude = ''
await bootHost('callers', {
  traffic: true,
  modules: async ({ root, origins, start }) => {
    /* `claude`: bun under another name, so the session's process is called what Claude Code's is. */
    mkdirSync(join(root, 'bin'), { recursive: true })
    claude = join(root, 'bin', 'claude')
    copyFileSync(BUN_PATH, claude)
    chmodSync(claude, 0o755)
    agentPort = await freePort()
    /* origins: the page's two, then the API's two. */
    start(BUN, [join(HOST, 'test/fixtures/standin/agent-module.ts'), String(agentPort), origins[2], claude, join(root, 'project-a')], 'Claude.log')
    return [{ id: 'kehikot.claude', name: 'Claude', port: agentPort }]
  },
})
const api = `http://127.0.0.1:${scratch.api}`
const page = `http://127.0.0.1:${scratch.page}`

let ping = null
try {
  /* Epsilon, started by hand — by this script, not the host — asks the host every second. */
  const alpha = scratch.modules.find((one) => one.id === 'kehikot.alpha')
  const epsilonPort = await freePort()
  ping = spawn(BUN, [join(HOST, 'test/fixtures/standin/server.ts'), 'kehikot.epsilon', 'Epsilon', String(epsilonPort), `${page} ${api}`], {
    env: { ...process.env, HOME: join(scratch.root, 'home'), PORT: '', KEHIKOT_ORIGIN: '', KEHIKOT_ORIGINS: '', STANDIN_PING: api },
    stdio: 'ignore',
  })
  writeFileSync(join(scratch.root, 'modules/kehikot.epsilon.json'), JSON.stringify({ url: `http://127.0.0.1:${epsilonPort}`, keep: true }))

  /* Delta, which the host starts: a registration with a `dir` whose run.sh starts a stand-in that asks the host. */
  const deltaPort = await freePort()
  const deltaDir = join(scratch.root, 'delta')
  mkdirSync(deltaDir, { recursive: true })
  writeFileSync(
    join(deltaDir, 'run.sh'),
    `#!/bin/sh\nSTANDIN_PING=${api} exec ${BUN_PATH} ${join(HOST, 'test/fixtures/standin/server.ts')} kehikot.delta Delta "$PORT" "${page} ${api}"\n`,
  )
  chmodSync(join(deltaDir, 'run.sh'), 0o755)
  writeFileSync(join(scratch.root, 'modules/kehikot.delta.json'), JSON.stringify({ url: `http://127.0.0.1:${deltaPort}`, dir: deltaDir }))

  /* The record starts here: what came before is the scratch host setting itself up. */
  const reader = `http://127.0.0.1:${scratch.modules.find((one) => one.id === 'kehikot.gamma').port}/traffic`
  const read = async (since) => (await fetch(`${reader}?since=${since}${SAMPLE ? '&sample=1' : ''}`)).json()
  const from = (await read(0)).data?.newest ?? 0
  if (SAMPLE) await pause(3500)

  const started = await fetch(`${api}/host/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: page }, body: JSON.stringify({ module: 'kehikot.delta' }) })
  say(`Delta started by the host: ${started.status}`)
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${deltaPort}/healthz`).then((r) => r.ok, () => false)) break
    await pause(100)
  }

  /* The page, on its own origin. */
  await fetch(`${api}/host/health`, { headers: { origin: page } })
  /* A module's page, on its own origin. */
  await fetch(`${api}/host/hello`, { headers: { origin: `http://127.0.0.1:${alpha.port}` } })
  /* curl, from a shell and from this script. */
  for (let i = 0; i < Number(process.env.CURLS ?? 1); i++) execFileSync('/bin/zsh', ['-f', '-c', `curl -s -o /dev/null ${api}/host/health; true`])
  execFileSync('curl', ['-s', '-o', '/dev/null', `${api}/host/hello`])
  /* An agent session the agent module started, on a kehikko and an epic. */
  const canvases = await (await fetch(`${api}/host/canvases`)).json()
  const wide = canvases.canvases.find((one) => one.name === 'Wide' && one.project === canvases.projects[0].id)
  const session = await fetch(`http://127.0.0.1:${agentPort}/session?kehikko=${encodeURIComponent(wide.key)}&epic=methods`, { method: 'POST' })
  say(`a session the agent module started: ${session.status} ${await session.text()}`)
  /* The agent program, started from a terminal, outside Kehikot. */
  execFileSync('/bin/zsh', ['-f', '-c', `${claude} ${join(HOST, 'test/fixtures/standin/agent-session.ts')} ${api}`])

  /* What the one wait costs: curl's whole request, unnamed (its first request on a new connection waits for its process) and as the page. */
  const timed = (extra) => Number(execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{time_total}', ...extra, `${api}/host/health`], { encoding: 'utf8' }))
  const median = (list) => list.sort((a, b) => a - b)[Math.floor(list.length / 2)]
  const unnamed = median(Array.from({ length: 9 }, () => timed([])))
  const asPage = median(Array.from({ length: 9 }, () => timed(['-H', `origin: ${page}`])))

  await pause(4000)
  const rows = []
  let since = from
  for (;;) {
    const got = await read(since)
    rows.push(...(got.data?.calls ?? []))
    if (!got.data || got.data.newest <= since || (got.data.calls ?? []).length === 0) break
    since = got.data.newest
  }

  const received = rows.filter((row) => row.side === 'in')
  const unknown = received.filter((row) => !row.by && !row.caller)
  const groups = new Map()
  for (const row of received) {
    const who = row.caller ? `${row.caller.name} [${row.caller.kind}, ${row.caller.how}${row.caller.process ? `, ${row.caller.process}` : ''}]` : row.by || 'UNKNOWN'
    const key = `${who} — ${row.kind} ${row.path.split('?')[0]}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  say('')
  say(`rows received: ${received.length}, unknown: ${unknown.length}${SAMPLE ? ' (sampler on)' : ''}`)
  for (const [key, count] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) say(`  ${String(count).padStart(3)}  ${key}`)
  say(`curl's request, median of 9: ${Math.round(unnamed * 1000)} ms unnamed (looked up), ${Math.round(asPage * 1000)} ms as the page (not looked up)`)
  if (CHECK && unknown.length) {
    console.error(`${unknown.length} rows name nobody`)
    process.exitCode = 1
  }
} finally {
  if (ping) ping.kill('SIGTERM')
  stop()
}
