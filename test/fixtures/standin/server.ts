/**
 * A stand-in module for `dev/pages-take-input.drive.mjs`: a page with a text
 * field, a button that counts its presses and a list that scrolls, and one
 * toggle in its header. Everything a person does to a module's page, in the
 * smallest page that lets a driver read whether it arrived.
 *
 *     bun test/fixtures/standin/server.ts <id> <name> <port> <host origins, space-separated>
 *
 * It greets the host the way a real module does (the protocol's `connect`),
 * because a page the host has not greeted is drawn hidden.
 */
import { MANIFEST_KIND, PROTOCOL, WELL_KNOWN, manifestSchema } from 'kehikot-module-protocol'
import { askHost, serverPassReply } from 'kehikot-module-protocol/serve'

const [id, name, portText, origins] = process.argv.slice(2)
if (!id || !name || !portText || !origins) throw new Error('usage: server.ts <id> <name> <port> <origins>')
const port = Number(portText)
/* `STANDIN_TRAFFIC=<host origin>`: this one also reads the host's record of traffic, as the
   Monitor does (`traffic:read`), and hands it to a driver at `/traffic?since=<seq>`. */
const trafficHost = process.env.STANDIN_TRAFFIC ?? null
/* `STANDIN_PING=<host origin>`: this one's server also asks the host whether it is there every
   second, as a module's server does (`dev/callers.drive.mjs`). */
const pingHost = process.env.STANDIN_PING ?? null
if (pingHost) setInterval(() => void fetch(`${pingHost}/host/hello`).catch(() => {}), 1000)

const manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  protocol: PROTOCOL,
  id,
  name,
  version: '0.1.0',
  dataVersion: 1,
  summary: `${name}, a stand-in with a field, a button and a list.`,
  tags: [],
  guidance: `This canvas has ${name} on it; it is a stand-in and does nothing.`,
  entry: '/app',
  modes: [{ id: id.split('.').pop()!, label: name, scope: 'epic' }],
  extensions: { emits: [], consumes: [] },
  reacts: [],
  partless: 'A stand-in for a test: it holds nothing of a part.',
  declares: { protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`, uses: trafficHost ? ['traffic:read'] : [], storage: true, prompt: false },
  health: '/healthz',
})

const built = await Bun.build({ entrypoints: [`${import.meta.dir}/page.ts`], target: 'browser', minify: true })
if (!built.success) throw new Error(built.logs.join('\n'))
const script = await built.outputs[0]!.text()
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

const page = `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<style>
  /* The module template's own colours (the protocol's template/src/index.css),
     so a switch is measured against what a module looks like. */
  :root { color-scheme: light } html.dark { color-scheme: dark }
  body { margin: 0; font: 13px system-ui; background: oklch(1 0 0); color: oklch(0.145 0 0) }
  html.dark body { background: oklch(0.145 0 0); color: oklch(0.985 0 0) }
  #list { height: 120px; overflow: auto; border: 1px solid GrayText; margin: 6px }
  #list div { height: 24px }
</style></head><body>
<div style="padding:6px"><input id="field" placeholder="type here" autocomplete="off"> <button id="press">press</button>
<span id="pressed">0</span> <span id="greeted">not greeted</span></div>
<div id="told" style="font:600 22px system-ui;padding:2px 6px">…</div>
<div id="list">${Array.from({ length: 60 }, (_, i) => `<div>row ${i}</div>`).join('')}</div>
<script>window.__standin = { id: ${json(id)}, origins: ${json(origins.split(' '))} }</script>
<script type="module">${script}</script></body></html>`

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url)
    const { pathname } = url
    if (pathname === WELL_KNOWN) return Response.json(manifest)
    const pass = serverPassReply(request.method, pathname, url.searchParams)
    if (pass) return Response.json(pass.body, { status: pass.status })
    if (trafficHost && pathname === '/traffic') {
      const since = Number(url.searchParams.get('since')) || 0
      const sample = url.searchParams.get('sample') === '1'
      return askHost('traffic.read', { since, limit: 5000, ...(sample ? { sample: true } : {}) }, { module: id, env: { KEHIKOT_ORIGINS: trafficHost } }).then((read) =>
        Response.json(read, { status: read.ok ? 200 : 502 }),
      )
    }
    if (pathname === '/healthz') return new Response('ok')
    if (pathname === '/app') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    return new Response('not here', { status: 404 })
  },
})
console.log(`${id} answers on ${port}`)
