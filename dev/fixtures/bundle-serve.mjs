/*
 * The server of a drive's sample module, as one file with nothing to import: what a ready-built
 * bundle's `serve.ts` does when the protocol's serving runs it, as far as a host can tell.
 *
 * A bundle says in `bundle.json` which protocol it was built against, and from 2.65.0 on the host
 * starts it on a port it hands (`server/anyPort.ts`, `server/modulePorts.ts`) and waits for it to
 * answer where its registration says, as the process it started. So this, like the protocol's
 * serving (`claim`, `registerBound`, the start header):
 *
 *   - binds `PORT`, or the next free port when something holds that one;
 *   - says the start token it was handed (`KEHIKOT_START_TOKEN`) back on every answer;
 *   - writes where it bound into its registration — only when nothing is registered, the registered
 *     folder is gone, or it is this same folder (a pinned version running beside the module, from a
 *     folder of its own, never takes the module's registration over) — and never anywhere but the
 *     scratch registry the drive's host was given (`KEHIKOT_MODULES_DIR`).
 *
 * A drive's sample once bound `PORT` and said nothing else, which only a host that started it on a
 * port it knew in advance could find.
 */
import { START_HEADER, START_TOKEN_ENV, WELL_KNOWN } from 'kehikot-module-protocol'

/** The source of `serve.ts` for a module whose manifest is `manifest`, whose page is titled `title`. */
export function bundleServe(manifest, title = manifest.name) {
  return `
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const manifest = ${JSON.stringify(manifest)}
const start = process.env[${JSON.stringify(START_TOKEN_ENV)}]
const said = start ? { ${JSON.stringify(START_HEADER)}: start } : {}
const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json', ...said }
const fetch = (request) => {
  const path = new URL(request.url).pathname
  if (path === ${JSON.stringify(WELL_KNOWN)}) return new Response(JSON.stringify(manifest), { headers })
  if (path === '/healthz') return new Response('ok', { headers: said })
  return new Response(${JSON.stringify(`<!doctype html><title>${title}</title>`)}, { headers: { 'content-type': 'text/html', ...said } })
}

const wanted = Number(process.env.PORT)
let server = null
for (let port = wanted; !server && port < wanted + 64 && port <= 65535; port += 1) {
  try {
    server = Bun.serve({ port, hostname: '127.0.0.1', fetch })
  } catch {}
  if (wanted === 0) break
}
if (!server) {
  console.error(manifest.id + ' found no free port from ' + wanted)
  process.exit(1)
}
const origin = 'http://127.0.0.1:' + server.port
if (server.port !== wanted) console.log(manifest.id + ' answers at ' + origin + ': ' + wanted + ' was taken')

const where = process.env.KEHIKOT_MODULES_DIR
if (where) {
  const file = join(where, manifest.id + '.json')
  let held = {}
  try {
    held = JSON.parse(readFileSync(file, 'utf8')) ?? {}
  } catch {}
  const real = (path) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  const here = process.cwd()
  const mine = typeof held.dir !== 'string' || !existsSync(held.dir) || real(held.dir) === real(here)
  if (mine) {
    mkdirSync(where, { recursive: true })
    writeFileSync(file, JSON.stringify({ ...held, url: origin, dir: typeof held.dir === 'string' && existsSync(held.dir) ? held.dir : here }, null, 2) + '\\n')
    console.log(manifest.id + ' registered: ' + file + ' -> ' + origin)
  } else console.log(manifest.id + ' answers at ' + origin + ' and was NOT registered: the registration names ' + held.dir)
}
`
}
