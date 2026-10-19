import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WATCH_RETRY_MS } from '../server/open.ts'

/**
 * A page's `/host/watch` stream across a restart of the server, at the running
 * server.
 *
 * What a restarted host knows about which kehikko is open comes back with the
 * page's stream and nothing else. So the stream tells the browser to come back
 * soon (`retry`), and coming back on the same url is, by itself, enough for the
 * MCP door to name the open kehikko again. The page's half — opening the stream
 * again when the browser gave up on it — is in `watching.test.ts`.
 */
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-watch-restart-')))
const at = (name: string) => join(ROOT, name)
let port = 0
let api = ''
let child: ReturnType<typeof Bun.spawn> | null = null

async function start(): Promise<void> {
  child = Bun.spawn(['bun', 'run', join(import.meta.dir, '..', 'server', 'server.ts')], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      CLAUDE_CONFIG: at('claude.json'),
      KEHIKOT_FRAME_DB: at('frame.sqlite'),
      KEHIKOT_MODULES_DIR: at('modules'),
      KEHIKOT_VERSIONS_DIR: at('versions'),
      KEHIKOT_INSTALLS_DIR: at('installed'),
      KEHIKOT_OFFICIAL_CACHE: at('official-modules.json'),
      KEHIKOT_LOGS_DIR: at('logs'),
      KEHIKOT_SEED_PROJECT: at('project'),
      KEHIKOT_OFFICIAL_LIST: 'off',
      KEHIKKO_RESTART_FILE: at('restart'),
      KEHIKOT_ORIGIN: '',
      KEHIKOT_ORIGINS: '',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${api}/host/health`)).ok) return
    } catch {
      /* Not up yet. */
    }
    await Bun.sleep(100)
  }
  throw new Error('the server did not come up')
}

async function stop(): Promise<void> {
  child?.kill()
  await child?.exited
  child = null
}

async function readCanvas(): Promise<string> {
  const answer = await fetch(`${api}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_canvas', arguments: {} } }),
  }).then((r) => r.json() as Promise<{ result?: { content?: { text?: string }[] } }>)
  return answer.result?.content?.[0]?.text ?? ''
}

/** A page's stream, open, with its first chunk read. */
async function watch(kehikko: number): Promise<{ first: string; close: () => void }> {
  const aborter = new AbortController()
  const page = `http://127.0.0.1:${port + 1}`
  const response = await fetch(`${api}/host/watch?page=the-page&kehikko=${kehikko}`, {
    headers: { origin: page, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', accept: 'text/event-stream' },
    signal: aborter.signal,
  })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const chunk = await reader.read()
  return { first: new TextDecoder().decode(chunk.value), close: () => aborter.abort() }
}

beforeAll(async () => {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  port = probe.port ?? 0
  probe.stop(true)
  api = `http://127.0.0.1:${port}`
  for (const dir of ['project', 'modules', 'versions', 'installed', 'logs']) mkdirSync(at(dir), { recursive: true })
  await start()
}, 30000)

afterAll(async () => {
  await stop()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('a page’s stream and a restart of the server', () => {
  test('the stream asks to be reconnected soon, and reconnecting names the open kehikko again', async () => {
    const listed = (await fetch(`${api}/host/canvases`).then((r) => r.json())) as { canvases: { id: number }[] }
    const kehikko = listed.canvases[0]!.id

    const before = await watch(kehikko)
    expect(before.first).toContain(`retry: ${WATCH_RETRY_MS}\n`)
    /* Soon enough that a page is back within a couple of seconds. */
    expect(WATCH_RETRY_MS).toBeLessThanOrEqual(2000)
    expect(await readCanvas()).toStartWith(`kehikko ${kehikko}:`)

    await stop()
    before.close()
    await start()
    /* A restarted server has nothing to say about what is on somebody's screen… */
    expect(await readCanvas()).toContain('no page of this host has said which kehikko it has open')

    /* …until the page's stream comes back on the url it had. */
    const after = await watch(kehikko)
    expect(await readCanvas()).toStartWith(`kehikko ${kehikko}:`)
    after.close()
  }, 40000)
})
