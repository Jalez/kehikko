import type { mcp } from './mcp.ts'
import type { Door } from './mcp/door.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'

/**
 * `POST /mcp` — the host's own door, for an agent. Any other method there is refused with a 405.
 *
 * Not under `/host/` — that prefix is the page's own vocabulary, proxied by
 * Vite so the page talks to one origin. This is spoken to directly, on this
 * port, by something that is not a browser. `/mcp` is where every module in
 * this workspace puts its door and an agent's configuration is one line
 * shorter for the host's being in the same place.
 */
export const MCP_ROUTES = {
  door: { method: 'POST', path: '/mcp' },
} as const satisfies RouteTable

export interface McpRouteDeps {
  mcp: typeof mcp
  /**
   * What the door is handed for one call: this host's state, and the place the call is in (the token
   * on the URL, or the binding of its MCP session). Built by the server, which holds all of it.
   */
  door(request: Request, url: URL, body: Record<string, unknown>, session: string | null): Promise<Door>
  /** Who answers: this host's id and version. */
  about: { name: string; version: string }
}

export function mcpDesk(deps: McpRouteDeps): Desk {
  const table = routes(MCP_ROUTES, {
    door: async (request, url) => {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body.method !== 'string') {
        return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } }, 400)
      }
      /* The place this call is in: the token on the URL, or the binding of its MCP session. */
      const session = request.headers.get('mcp-session-id')
      const answered = await deps.mcp(body, await deps.door(request, url, body, session), deps.about)
      if (answered.body === null) return new Response(null, { status: answered.status, ...(answered.headers ? { headers: answered.headers } : {}) })
      const out = json(answered.body, answered.status)
      for (const [name, value] of Object.entries(answered.headers ?? {})) out.headers.set(name, value)
      return out
    },
  })
  return {
    async route(request, url) {
      if (url.pathname !== '/mcp') return null
      if (request.method !== 'POST') return json({ ok: false, error: 'the MCP door takes POST' }, 405)
      return table.route(request, url)
    },
  }
}
