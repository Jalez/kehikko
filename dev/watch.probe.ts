/*
 * A module dies while somebody is watching. Does the light go honest?
 *
 *     bun run dev/watch.probe.ts
 *
 * ## Why this is a probe and not a test
 *
 * Nothing in `test/` can answer this question. The policy is pure and is tested
 * exhaustively in `test/lifecycle.test.ts`, but the fault was never in the
 * policy — it was in nobody CALLING it, which is a fact about a timer, a
 * socket, a spawned process and a port. All four are real here: this starts the
 * host's own server on a spare port with its own database and its own
 * registrations directory, starts a fake module, kills it, and waits on the
 * page's stream for the host to say so.
 *
 * It takes about a minute, because the thing being demonstrated is deliberately
 * slow — see `WATCH_EVERY_MS` in `server/lifecycle.ts` for why thirty seconds
 * is the right number and why making it fast enough to test comfortably would
 * be making it the polling loop this host refuses.
 *
 * Nothing here touches ~/.roadmap. The modules directory and the database are
 * both temporary and both removed at the end, which is the only reason it is
 * safe to run beside a live host.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MANIFEST_KIND, PROTOCOL } from 'roadmap-module-protocol'

const API = 4380
const MODULE = 4382
const HOST = `http://127.0.0.1:${API}`
const ID = 'probe.module'

const dir = mkdtempSync(join(tmpdir(), 'kehikko-watch-'))
const db = join(dir, 'frame.sqlite')
const modules = join(dir, 'modules')
mkdirSync(modules, { recursive: true })
writeFileSync(join(modules, `${ID}.json`), JSON.stringify({ url: `http://127.0.0.1:${MODULE}` }))

/**
 * The smallest thing that answers a manifest, in its own process.
 *
 * Its own process on purpose: the fault is a program going away, and a fake
 * that were a `Bun.serve` in this process would be stopped by a method call
 * rather than by a pid dying. Killed by pid and by pid only — a `pkill` on this
 * machine once took a person's whole workspace down.
 */
function fakeModule(): Bun.Subprocess {
  const script = join(dir, 'module.ts')
  const manifest = {
    kind: MANIFEST_KIND,
    protocol: PROTOCOL,
    id: ID,
    name: 'Probe',
    version: '0.0.0',
    summary: 'A module that exists only in order to be killed.',
    entry: '/',
    modes: [{ id: 'probe', label: 'Probe', scope: 'global' }],
    extensions: { emits: [], consumes: [] },
    declares: { protocol: `>=${PROTOCOL}`, uses: [], storage: false },
  }
  writeFileSync(
    script,
    [
      `const manifest = ${JSON.stringify(manifest)}`,
      `Bun.serve({ hostname: '127.0.0.1', port: ${MODULE}, fetch: () => Response.json(manifest) })`,
      '',
    ].join('\n'),
  )
  return Bun.spawn(['bun', 'run', script], { stdout: 'ignore', stderr: 'inherit' })
}

const say = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`)

const server = Bun.spawn(['bun', 'run', 'server/server.ts'], {
  env: { ...process.env, PORT: String(API), ROADMAP_FRAME_DB: db, ROADMAP_MODULES_DIR: modules },
  stdout: 'inherit',
  stderr: 'inherit',
})

const module_ = fakeModule()

async function up(url: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url)
      return
    } catch {
      await Bun.sleep(250)
    }
  }
  throw new Error(`${url} never came up`)
}

const conditionOf = async (): Promise<string> => {
  const view = (await (await fetch(`${HOST}/host/modules`)).json()) as {
    presences: { id: string; condition: string; line: string }[]
  }
  const presence = view.presences.find((p) => p.id === ID)
  /* The line as well as the word, because the word is what the light is drawn
     from and the line is what the person actually reads. A probe that checked
     only the word would pass on a host that had gone honest about the colour
     and gone on saying the wrong sentence. */
  return presence ? `${presence.condition} — ${presence.line}` : 'absent'
}

try {
  await up(`${HOST}/host/modules`)
  await up(`http://127.0.0.1:${MODULE}/`)

  /* A kehikko with the module on it, and a page saying it has that kehikko
     open — which is the whole of what makes the module `needed`. */
  const made = (await (
    await fetch(`${HOST}/host/canvases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'probe' }),
    })
  ).json()) as { canvas?: { id: number } }
  const kehikko = made.canvas?.id
  if (!kehikko) throw new Error('the host would not make a kehikko')
  await fetch(`${HOST}/host/canvases/${kehikko}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ placements: [{ i: ID, x: 0, y: 0, w: 4, h: 6 }] }),
  })

  /* The stream, exactly as `watchCanvases` opens it: the page id and the open
     kehikko on the URL, because that is also the report the watch is scoped by. */
  const news: string[] = []
  const stream = await fetch(`${HOST}/host/watch?page=probe&kehikko=${kehikko}`)
  void (async () => {
    const reader = stream.body?.getReader()
    if (!reader) return
    const decode = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        for (const line of decode.decode(value).split('\n')) {
          if (line.startsWith('data: ')) {
            news.push(line.slice(6))
            say(`  page hears  ${line.slice(6)}`)
          }
        }
      }
    } catch {
      /* The server was killed at the end of the run, which is how this probe
         stops. A browser sees the same thing and reconnects; there is nothing
         here left to reconnect to. */
    }
  })()

  await fetch(`${HOST}/host/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 'probe', kehikko }),
  })

  say(`condition, module running: ${await conditionOf()}`)

  say(`killing the module (pid ${module_.pid}) — and asking nothing further`)
  module_.kill()
  await module_.exited

  say('the page now does nothing at all: no focus, no reload, no request')
  const heard = await (async () => {
    for (let i = 0; i < 90; i++) {
      if (news.some((one) => one.includes('"registry":true'))) return true
      await Bun.sleep(1000)
    }
    return false
  })()

  if (!heard) {
    say('FAILED: nothing was ever said on the stream')
  } else {
    say(`condition, after being told: ${await conditionOf()}`)
    say('PASSED: the host noticed and said so, with nobody having touched the page')
  }
} finally {
  server.kill()
  module_.kill()
  rmSync(dir, { recursive: true, force: true })
}
