/**
 * What tools a module's MCP door actually offers, asked at the moment somebody
 * looks.
 *
 * ## Why the server asks and not the page
 *
 * The same division `src/host/ask.ts` draws. The page is a document with
 * modules framed inside it; a `fetch` written there runs in the same tab as the
 * thing it is asking about, and it would be asking across an origin — a module
 * on 7860 has no reason to have said anything about CORS, and the honest answer
 * "your module does not permit this browser to read it" is not a sentence about
 * the module that is worth showing anybody. The server is a process on the same
 * machine with no origin at all, so what it gets back is what the door said.
 *
 * ## Why on demand and never on the sweep
 *
 * `server/agents.ts` explains the rule and it is not repeated here at length: a
 * sweep that makes network calls is a host that hangs whenever somebody asks it
 * to look again, for reasons it cannot explain. Eleven modules on a canvas is
 * eleven MCP handshakes per press. So this is called from one place — a modal
 * that somebody opened — and the cost is paid by the person who asked for it.
 *
 * ## Three failures, three sentences
 *
 * A door that does not answer, a door that answers something that is not an MCP
 * response, and a door that answers correctly with no tools in it are three
 * different facts about a module, and collapsing them into "could not load
 * tools" sends a person to the wrong place every second time. The first is a
 * program that is not listening; the second is a program listening on that path
 * that is not an MCP server (the commonest cause is a manifest naming the wrong
 * path, and the second commonest is a dev server answering its index page with
 * 200); the third is a working module that has nothing to offer yet, which is
 * not a fault at all.
 */

/** One tool as it is worth showing: a name, and what it says it is for. */
export interface ToolAtTheDoor {
  name: string
  /** The tool's own description, or '' when it shipped without one. */
  description: string
}

export type ToolsAtTheDoor =
  | { ok: true; tools: ToolAtTheDoor[] }
  /**
   * `silent` — nothing answered. The module is not listening on that address,
   * or it is and the request never completed.
   * `refused` — something answered, with a status saying no.
   * `not-mcp` — something answered with a body that is not an MCP tool list.
   */
  | { ok: false; why: 'silent' | 'refused' | 'not-mcp'; says: string }

/**
 * How long to wait on a door.
 *
 * Short, because somebody is looking at a spinner in a modal they just opened,
 * and a module on loopback that has not answered in four seconds is not about
 * to. This is deliberately less patient than `launch.ts`'s six seconds: that
 * one is waiting for a program to boot, this one is asking a program that is
 * supposed to be up already.
 */
const ANSWERS_WITHIN_MS = 4000

/** The protocol version the host asks for. Any server worth listing speaks it. */
const MCP_VERSION = '2025-06-18'

/**
 * Read whatever came back off the wire as a JSON-RPC message.
 *
 * Streamable HTTP lets a server answer a single request either as
 * `application/json` or as an SSE stream carrying one `message` event, and
 * which of the two you get is the server's choice rather than the client's. So
 * both are read here. Anything else — HTML, a plain string, an empty body —
 * comes back as `null` and becomes `not-mcp` above.
 *
 * Exported because this is the part with the interesting failures in it, and a
 * parser that can only be exercised through a live module is a parser whose
 * failure shapes are never tested.
 */
export function readMessage(body: string): unknown {
  const trimmed = body.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }

  /* SSE framing. The last `data:` payload that parses wins: a stream may carry
     a comment or a ping before the message, and taking the first thing that
     looks like JSON would read a keepalive as the answer. */
  let found: unknown = null
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    try {
      found = JSON.parse(payload)
    } catch {
      /* A fragment of a multi-line data field, or a keepalive. Not the answer. */
    }
  }
  return found
}

/**
 * The tools out of a `tools/list` result, or why that message was not one.
 *
 * A JSON-RPC error is reported as `not-mcp` with the server's own message
 * rather than as a shape failure: a door that answers "method not found" IS
 * speaking MCP, and telling somebody their module is not an MCP server when it
 * said so in correct JSON-RPC would be worse than useless. The sentence carries
 * what it said, which is the thing to act on.
 */
export function toolsIn(message: unknown): ToolsAtTheDoor {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, why: 'not-mcp', says: 'It answered something that is not a JSON-RPC message.' }
  }

  const envelope = message as { result?: unknown; error?: unknown }

  if (envelope.error) {
    const error = envelope.error as { message?: unknown; code?: unknown }
    const said = typeof error.message === 'string' ? error.message : JSON.stringify(envelope.error)
    return { ok: false, why: 'not-mcp', says: `It is speaking MCP and refused the question: ${said}` }
  }

  const result = envelope.result as { tools?: unknown } | undefined
  if (!result || typeof result !== 'object' || !Array.isArray(result.tools)) {
    return {
      ok: false,
      why: 'not-mcp',
      says: 'It answered, and the answer has no list of tools in it.',
    }
  }

  const tools: ToolAtTheDoor[] = []
  for (const entry of result.tools) {
    if (!entry || typeof entry !== 'object') continue
    const tool = entry as { name?: unknown; description?: unknown; title?: unknown }
    if (typeof tool.name !== 'string' || !tool.name) continue
    tools.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
    })
  }

  /* An empty list is `ok`. A module that serves a door and offers nothing
     through it yet is working; the sentence for that belongs to whoever is
     showing it, and reporting it as a failure here would take that choice
     away. */
  return { ok: true, tools }
}

/** What a POST to the door needs on it, whichever way the server answers. */
function headers(session: string | null): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MCP_VERSION,
    ...(session ? { 'mcp-session-id': session } : {}),
  }
}

/**
 * Ask one door what it offers.
 *
 * The handshake is done in full — initialize, then the initialized
 * notification, then the question — even though several modules here answer
 * `tools/list` cold. A server that keeps session state is entitled to refuse a
 * question from a client that never introduced itself, and the host asking
 * politely costs two round trips on loopback.
 *
 * `at` is a URL the caller derived from the module's manifest. It is never
 * anything that arrived in a request body; see the endpoint in `server.ts`.
 */
export async function toolsAt(
  at: string,
  fetcher: typeof fetch = fetch,
): Promise<ToolsAtTheDoor> {
  let session: string | null = null

  const post = async (message: unknown) =>
    fetcher(at, {
      method: 'POST',
      headers: headers(session),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(ANSWERS_WITHIN_MS),
    })

  try {
    const hello = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_VERSION,
        capabilities: {},
        clientInfo: { name: 'kehikko-host', version: '0.1.0' },
      },
    })

    if (!hello.ok) {
      return {
        ok: false,
        why: 'refused',
        says: `Its door answered ${hello.status} to an MCP handshake.`,
      }
    }
    session = hello.headers.get('mcp-session-id')
    /* Read and discard. Some servers will not answer a second request until the
       first response body has been consumed, and a handshake left hanging is a
       socket held open for nothing. */
    await hello.text()

    /* The notification. No id, so no answer is expected and none is read; a
       server that has nothing to do with it may well 202 or 404 this, and
       neither is a reason to stop. */
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => null)

    const asked = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    if (!asked.ok) {
      return { ok: false, why: 'refused', says: `Its door answered ${asked.status} to tools/list.` }
    }

    return toolsIn(readMessage(await asked.text()))
  } catch (error) {
    /* A refused connection, a DNS failure and a timeout all land here and all
       mean the same thing to a person: nothing is listening there right now. */
    return {
      ok: false,
      why: 'silent',
      says: `Nothing answered at ${at}. ${(error as Error).message}`,
    }
  }
}
