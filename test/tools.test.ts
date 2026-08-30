import { describe, expect, test } from 'bun:test'

import { readMessage, toolsAt, toolsIn } from '../server/tools.ts'

/**
 * What a module's MCP door says it offers, and every way that answer goes wrong.
 *
 * The three failures are the point. A door that does not answer, a door that
 * answers something that is not MCP, and a door that answers correctly with an
 * empty list are three different facts about a module, and a host that folded
 * them into "could not load tools" would send a person to the wrong place every
 * second time. So each is exercised separately here.
 */

describe('reading whatever came back off the wire', () => {
  test('plain JSON', () => {
    expect(readMessage('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}')).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [] },
    })
  })

  test('SSE framing, because which of the two you get is the server’s choice', () => {
    /* Streamable HTTP lets a server answer a single request either as JSON or
       as a stream carrying one message event, and a client that only read one
       of them would work against half the servers in existence. */
    const stream = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n'
    expect(readMessage(stream)).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } })
  })

  test('a keepalive before the message is not the message', () => {
    const stream = ': ping\ndata: not json at all\n\nevent: message\ndata: {"result":{"tools":[]}}\n'
    expect(readMessage(stream)).toEqual({ result: { tools: [] } })
  })

  test('an empty body, HTML, and broken JSON are all nothing', () => {
    expect(readMessage('')).toBeNull()
    expect(readMessage('   \n ')).toBeNull()
    expect(readMessage('<!doctype html><html><body>hi</body></html>')).toBeNull()
    expect(readMessage('{ "tools": ')).toBeNull()
  })
})

describe('the tools out of a message, and what is not one', () => {
  test('a name and a description, which is all that is shown', () => {
    const got = toolsIn({
      result: {
        tools: [
          { name: 'checklists', description: 'Every checklist this app holds.', inputSchema: {} },
        ],
      },
    })
    expect(got).toEqual({ ok: true, tools: [{ name: 'checklists', description: 'Every checklist this app holds.' }] })
  })

  test('a tool with no description keeps its name rather than being dropped', () => {
    const got = toolsIn({ result: { tools: [{ name: 'bare' }] } })
    expect(got).toEqual({ ok: true, tools: [{ name: 'bare', description: '' }] })
  })

  test('an entry with no name is not a tool and is skipped', () => {
    /* A nameless tool cannot be called and cannot be listed usefully. Dropping
       it is better than showing an empty row somebody cannot act on. */
    const got = toolsIn({ result: { tools: [{ description: 'x' }, null, 5, { name: 'real' }] } })
    expect(got).toEqual({ ok: true, tools: [{ name: 'real', description: '' }] })
  })

  test('zero tools is ok, not a failure', () => {
    /* A module that serves a door and offers nothing through it yet is working.
       The sentence for that belongs to whoever is showing it. */
    expect(toolsIn({ result: { tools: [] } })).toEqual({ ok: true, tools: [] })
  })

  test('a JSON-RPC error is not-mcp, and carries the server’s own words', () => {
    /* A door that answers "method not found" IS speaking MCP. Telling somebody
       their module is not an MCP server when it said so in correct JSON-RPC
       would be worse than useless, so the sentence carries what it said. */
    const got = toolsIn({ error: { code: -32601, message: 'Method not found' } })
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.why).toBe('not-mcp')
    expect(got.says).toContain('Method not found')
  })

  test('a result with no tools list is not-mcp', () => {
    expect(toolsIn({ result: {} })).toMatchObject({ ok: false, why: 'not-mcp' })
    expect(toolsIn({ result: { tools: 'lots' } })).toMatchObject({ ok: false, why: 'not-mcp' })
  })

  test('something that is not a JSON-RPC message at all', () => {
    expect(toolsIn(null)).toMatchObject({ ok: false, why: 'not-mcp' })
    expect(toolsIn('a string')).toMatchObject({ ok: false, why: 'not-mcp' })
    expect(toolsIn([1, 2, 3])).toMatchObject({ ok: false, why: 'not-mcp' })
  })
})

describe('asking a door, with the fetching handed in', () => {
  const ok = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers })

  test('the handshake happens before the question, and the session id is carried', async () => {
    const seen: { method: string; session: string | null }[] = []
    const got = await toolsAt('http://door/mcp', (async (_at: string, init: RequestInit) => {
      const message = JSON.parse(String(init.body)) as { method: string }
      const headers = init.headers as Record<string, string>
      seen.push({ method: message.method, session: headers['mcp-session-id'] ?? null })
      if (message.method === 'initialize') return ok({ result: {} }, { 'mcp-session-id': 'abc' })
      return ok({ result: { tools: [{ name: 'one', description: 'first' }] } })
    }) as unknown as typeof fetch)

    expect(seen.map((s) => s.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ])
    /* A server entitled to refuse a question from a client that never
       introduced itself gets introduced to, and gets its session id back. */
    expect(seen[0]?.session).toBeNull()
    expect(seen[2]?.session).toBe('abc')
    expect(got).toEqual({ ok: true, tools: [{ name: 'one', description: 'first' }] })
  })

  test('nothing listening is silent, and says where it looked', async () => {
    const got = await toolsAt('http://127.0.0.1:9/mcp', (() => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch)
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.why).toBe('silent')
    expect(got.says).toContain('http://127.0.0.1:9/mcp')
  })

  test('a status saying no is refused, and names the status', async () => {
    const got = await toolsAt('http://door/mcp', (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch)
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.why).toBe('refused')
    expect(got.says).toContain('404')
  })

  test('a dev server answering its index page at that path is not-mcp, not silent', async () => {
    /* The commonest wrong answer of the three, and the one that used to look
       like a broken module: something IS there, it is 200, and it is HTML. */
    let first = true
    const got = await toolsAt('http://door/mcp', (async () => {
      if (first) {
        first = false
        return new Response('{"result":{}}', { status: 200 })
      }
      return new Response('<!doctype html><html></html>', { status: 200 })
    }) as unknown as typeof fetch)
    expect(got).toMatchObject({ ok: false, why: 'not-mcp' })
  })

  test('a tools/list that fails after a successful handshake reports its own status', async () => {
    const got = await toolsAt('http://door/mcp', (async (_at: string, init: RequestInit) => {
      const message = JSON.parse(String(init.body)) as { method: string }
      if (message.method === 'tools/list') return new Response('no', { status: 500 })
      return ok({ result: {} })
    }) as unknown as typeof fetch)
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.says).toContain('500')
    expect(got.says).toContain('tools/list')
  })
})
