/**
 * A stand-in agent module for `dev/callers.drive.mjs`: it says it is `kehikot.claude` ("Claude"),
 * keeps one conversation record per place token, as the Claude module does
 * (`/api/kehikot/place`), and starts "sessions": a program named `claude` (`<root>/bin/claude`, a
 * copy of bun) that calls the host's MCP door with the token, the way Claude Code calls it.
 *
 *     bun test/fixtures/standin/agent-module.ts <port> <host origin> <claude program> <project path>
 *
 * `POST /session?kehikko=<key>&epic=<slug>` issues a token at the host and starts a session; it
 * answers when the session has ended, with its exit code.
 */
import { MANIFEST_KIND, PROTOCOL, WELL_KNOWN, manifestSchema } from 'kehikot-module-protocol'

const [portText, host, claude, project] = process.argv.slice(2)
if (!portText || !host || !claude || !project) throw new Error('usage: agent-module.ts <port> <host origin> <claude program> <project path>')
const port = Number(portText)

const manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  protocol: PROTOCOL,
  id: 'kehikot.claude',
  name: 'Claude',
  version: '0.1.0',
  dataVersion: 1,
  summary: 'A stand-in agent module: it starts sessions that call the host.',
  tags: ['agents'],
  guidance: 'A stand-in for a test.',
  entry: '/app',
  modes: [{ id: 'claude', label: 'Claude', scope: 'epic' }],
  extensions: { emits: [], consumes: [] },
  partless: 'A stand-in for a test: it holds nothing of a part.',
  declares: { protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`, uses: [], storage: true, prompt: false },
  health: '/healthz',
})

/** token → the place the conversation is in. */
const records = new Map<string, { epic: string; parts: string[]; kehikko: string; conversation: string }>()

const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')

Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === WELL_KNOWN) return Response.json(manifest)
    if (url.pathname === '/healthz') return new Response('ok')
    if (url.pathname === '/api/kehikot/place') {
      const said = records.get(url.searchParams.get('kehikot-place') ?? '')
      return Response.json({ ok: true, place: said ?? null })
    }
    if (url.pathname === '/session' && request.method === 'POST') {
      const kehikko = url.searchParams.get('kehikko') ?? ''
      const epic = url.searchParams.get('epic') ?? ''
      const one = token()
      const issued = await fetch(`${host}/host/place`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ module: 'kehikot.claude', token: one, project, kehikko }),
      })
      if (!issued.ok) return new Response(`the host would not issue: ${issued.status} ${await issued.text()}`, { status: 502 })
      records.set(one, { epic, parts: [], kehikko, conversation: `conversation-${records.size + 1}` })
      const child = Bun.spawn([claude, `${import.meta.dir}/agent-session.ts`, host, one], { stdout: 'inherit', stderr: 'inherit' })
      return Response.json({ code: await child.exited })
    }
    return new Response('not here', { status: 404 })
  },
})
console.log(`kehikot.claude answers on ${port}`)
