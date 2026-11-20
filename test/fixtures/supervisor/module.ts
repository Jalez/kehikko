/**
 * A module for `test/supervisor.test.ts`: the smallest program the host can start, watch and stop.
 *
 *     bun test/fixtures/supervisor/module.ts <id> <runs file> [broken]
 *
 * Every run appends `<pid> <PORT>` to the runs file before anything else, so a test counts the
 * starts and sees the port each was handed. It serves the protocol's doors on `PORT` (a manifest,
 * `/healthz`), saying back the start token the host gave it, and `POST /die` ends it with exit
 * code 1, as a module that crashed. `broken` exits with code 3 at once, without ever answering.
 */
import { appendFileSync } from 'node:fs'
import { manifestSchema } from 'kehikot-module-protocol'
import { doorsFetch, establishBuild } from 'kehikot-module-protocol/serve'

const [id, runs, mode] = process.argv.slice(2)
if (!id || !runs) throw new Error('usage: module.ts <id> <runs file> [broken]')
appendFileSync(runs, `${process.pid} ${process.env.PORT ?? ''}\n`)
if (mode === 'broken') process.exit(3)

const manifest = manifestSchema.parse({
  kind: 'kehikot.module',
  protocol: 2,
  id,
  name: id.split('.').pop()!,
  version: '1.0.0',
  entry: '/app',
  modes: [{ id: 'main', label: 'Main' }],
  partless: 'A module for a test: nothing in it belongs to a part.',
  health: '/healthz',
})
const doors = doorsFetch({ manifest, build: establishBuild({ version: '1', commit: null }), page: { title: id }, answer: () => null })

Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT),
  fetch: async (request) => {
    if (new URL(request.url).pathname === '/die' && request.method === 'POST') {
      setTimeout(() => process.exit(1), 20)
      return new Response('bye')
    }
    return (await doors(request)) ?? new Response('', { status: 404 })
  },
})
