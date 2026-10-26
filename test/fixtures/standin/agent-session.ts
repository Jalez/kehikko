/**
 * A stand-in agent session for `dev/callers.drive.mjs`: what Claude Code does at the host's MCP
 * door — `initialize`, `tools/list`, one `tools/call` of `my_place` — with the place token on the
 * URL when it was given one. Run as `claude` (a copy of bun), so the process looks like the agent.
 *
 *     claude test/fixtures/standin/agent-session.ts <host origin> [token]
 */
export {}

const [host, token] = process.argv.slice(2)
if (!host) throw new Error('usage: agent-session.ts <host origin> [token]')
const door = `${host}/mcp${token ? `?kehikot-place=${encodeURIComponent(token)}` : ''}`
let session: string | null = null
let id = 0
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(door, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  session = response.headers.get('mcp-session-id') ?? session
  if (!response.ok) throw new Error(`${method}: ${response.status}`)
  return response.text()
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '0.0.0' } })
await rpc('tools/list')
await rpc('tools/call', { name: 'my_place', arguments: {} })
