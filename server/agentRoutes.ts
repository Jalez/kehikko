import type { Database } from 'bun:sqlite'

import { agentKnows, scopeOf } from './agents.ts'
import { forgetMade, recordMade } from './agentSettings.ts'
import type { Presence } from './discover.ts'
import { HOST_ID } from './kehikot.ts'
import { addArgs, awarenessAt, connect, disconnect, repoint, SCOPE, staleAt, type Door, type NoDoor } from './register.ts'
import { json, moduleIn, routes, type Desk, type RouteTable } from './routes.ts'
import { toolsAt } from './tools.ts'

/**
 * A door, and the agent told about it:
 *
 *  - `GET  /host/tools?module=M` — what one module's door offers, and what the agent has been told about it.
 *  - `POST /host/agent` — tell the agent about a door, stop telling it, or repoint it. The press, and the
 *    only route that writes the agent's configuration (through `register.ts`'s writers).
 */
export const AGENT_ROUTES = {
  tools: { method: 'GET', path: '/host/tools' },
  agent: { method: 'POST', path: '/host/agent' },
} as const satisfies RouteTable

export interface AgentRouteDeps {
  db: Database
  /** Which door an id names: the host's own, or one found in the registry. */
  doorOf(id: string): Promise<{ ok: true; door: Door } | NoDoor>
  /** What the last sweep heard each module call itself. */
  lastPresences: ReadonlyMap<string, Presence>
}

export function agentDesk(deps: AgentRouteDeps): Desk {
  const { db, doorOf, lastPresences } = deps
  return routes(AGENT_ROUTES, {
    /*
     * What one module's door offers, and what the agent has been told about it.
     *
     * Asked when a modal opens and at no other time. See the essay in
     * `tools.ts`: a sweep that handshakes with eleven MCP servers is a host that
     * hangs whenever somebody asks it to look again, and the person pressing
     * "look again" would have no way to know that is what they were waiting for.
     *
     * Everything acted on here is derived from the id — see `doorFor`.
     */
    tools: async (_request, url) => {
      const id = moduleIn(url.searchParams.get('module'))
      if (!id) return json({ ok: false, why: 'A request for tools names one module.' }, 400)

      const found = await doorOf(id)
      if (!found.ok) {
        /* A door whose name is refused is not connected, and an entry made
           before the refusal may still point at it. Said, with where it is,
           so the window can offer to remove it. See `staleAt`. */
        const stale = staleAt(found, agentKnows())
        return json(
          { ok: false, why: found.why, ...(stale ? { stale: { as: stale, configuredIn: scopeOf(stale) } } : {}) },
          found.status,
        )
      }
      const door = found.door

      const agent = awarenessAt(door, agentKnows())
      /* Which scope the EXISTING entry is in, when there is one. The name to ask
         about is the one that was found, not the one this host would write —
         a server pointing here may be called anything at all. */
      const existing =
        agent.kind === 'told' || agent.kind === 'elsewhere' || agent.kind === 'renamed' ? agent.as : null

      return json({
        ok: true,
        module: id,
        /* Which kind of thing the window is describing. The server says it,
           rather than the page guessing from the id, because the server is the
           one that decided — see `doorOf`. */
        about: id === HOST_ID ? 'host' : 'module',
        as: door.as,
        url: door.url,
        transport: door.transport,
        agent,
        /* Named before anything is written, which is the whole reason it is in
           the answer rather than only in the code. */
        writesTo: SCOPE,
        configuredIn: existing ? scopeOf(existing) : null,
        command: `claude ${addArgs(door).join(' ')}`,
        tools: await toolsAt(door.url),
      })
    },

    /*
     * Tell the agent about a module's door, or stop telling it.
     *
     * The press `agents.ts` said would be a separate decision. It is a POST
     * because it changes something, and it changes something on the person's
     * own machine outside this host — so it happens on an explicit press, and
     * the answer says exactly what was run.
     *
     * The host does not edit `~/.claude.json`. It runs `claude mcp add` and
     * `claude mcp remove`, for the reasons set out in `register.ts`: the CLI
     * owns that file's format, it knows what a scope is, and that file holds
     * far more of a person's state than MCP servers.
     */
    agent: async (request) => {
      const body = (await request.json().catch(() => null)) as {
        module?: unknown
        press?: unknown
      } | null

      const id = moduleIn(body?.module)
      const press = body?.press
      if (!id || (press !== 'connect' && press !== 'disconnect' && press !== 'repoint')) {
        return json({ ok: false, why: 'A press names one module and one of connect, disconnect or repoint.' }, 400)
      }

      const found = await doorOf(id)
      if (!found.ok) {
        /* The one press a door with a refused name still takes: removing the
           entry that points at it. The name comes from the configuration as
           read now, by the door's address — never from the request, and never
           the name the module asks for, which is another door's. */
        const stale = press === 'disconnect' ? staleAt(found, agentKnows()) : null
        if (stale === null) return json({ ok: false, why: found.why }, found.status)
        return json({ ...(await disconnect(stale)), stale: staleAt(found, agentKnows()) })
      }
      const door = found.door

      /* Read the configuration again at the moment of the press rather than
         trusting what the modal was shown. The window may have been open for a
         while, and `claude mcp add` in another terminal is exactly the sort of
         thing that happens in between. The NAME being removed comes from this
         read — never from the request. */
      const before = awarenessAt(door, agentKnows())

      let ran
      if (press === 'connect') {
        if (before.kind === 'told') {
          return json({ ok: false, why: `The agent has already been told about this door, as "${before.as}".` }, 409)
        }
        if (before.kind === 'elsewhere') {
          return json(
            {
              ok: false,
              why: `A server called "${before.as}" already exists and points at ${before.pointsAt}. Repointing it is a different press, because it rewrites an entry this host did not create.`,
            },
            409,
          )
        }
        /* Connected under the name this host used to derive, and the module
           now declares another: the old name is removed and the new one
           written, in that order and only if the remove worked — `repoint`'s
           two steps. `renamed` is only ever said of an entry whose url IS this
           door, read a moment ago, so the name removed cannot be a server that
           points anywhere else. */
        ran = before.kind === 'renamed' ? await repoint(before.as, door) : await connect(door)
      } else if (press === 'repoint') {
        if (before.kind !== 'elsewhere') {
          return json(
            { ok: false, why: 'There is no entry of that name pointing somewhere else, so there is nothing to repoint.' },
            409,
          )
        }
        ran = await repoint(before.as, door)
      } else {
        if (before.kind !== 'told' && before.kind !== 'elsewhere' && before.kind !== 'renamed') {
          return json({ ok: false, why: 'The agent has not been told about this door, so there is nothing to remove.' }, 409)
        }
        ran = await disconnect(before.as)
      }

      /* What Kehikot made is what the Settings sync may later re-point or
         remove (`agent_made`, `agentSettings.ts`); what it removed is not its. */
      if (ran.ok && press === 'disconnect') forgetMade(db, id)
      else if (ran.ok) recordMade(db, { module: id, name: door.as, url: door.url, title: id === HOST_ID ? 'Kehikot' : (lastPresences.get(id)?.name ?? id) })

      /* Read back rather than assume. The CLI is the thing that decides whether
         it worked, and reporting the awareness this host can now READ is the
         only claim it is in a position to make. */
      return json({ ...ran, agent: awarenessAt(door, agentKnows()) })
    },
  })
}
