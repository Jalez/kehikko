import { spawn } from 'node:child_process'

import { awarenessOf, pointingAt, tailOf, type AgentAwareness } from './agents.ts'
import { look, type Presence } from './discover.ts'
import { HOST_ID } from './kehikot.ts'
import { readRegistrations, registryDir } from './registrations.ts'

/**
 * Telling the agent about a module's door, and untelling it.
 *
 * ## The press `agents.ts` said would be a separate decision
 *
 * `agents.ts` reads the agent's configuration and does not touch it, and it
 * says why: a host that quietly edited a person's agent config would be a host
 * that reaches outside itself. It also says the other half — that doing
 * something about it is a press, and a separate decision. This file is that
 * decision, taken.
 *
 * Nothing here softens the original rule; it names the exception precisely, the
 * way `launch.ts` names its own. **Quietly** is the word doing the work. The
 * host never writes to that file on a sweep, on a page load, on a canvas
 * opening, or because it noticed something was missing. It writes when somebody
 * presses a button in a window that has already told them, in the same
 * sentence, which server name it will use, which address it will point at, and
 * which scope it will write to. What the host must not do — decide for
 * somebody, or decide silently — it still does not.
 *
 * ## Why the CLI and not the file
 *
 * `agents.ts` READS `~/.claude.json` directly, and that is fine: a read cannot
 * corrupt anything. Writing is a different question and the answer is the
 * opposite one.
 *
 *   - That file is not an MCP config. It is a person's entire Claude Code
 *     state — history, project settings, onboarding flags, things this host has
 *     never heard of. A host that round-trips it through `JSON.parse` and
 *     `JSON.stringify` to add four lines has taken responsibility for every key
 *     in it, and the failure mode is somebody's settings quietly changing shape
 *     because a host rewrote a file it did not understand.
 *   - The CLI owns that format and moves it. When the shape changes, `claude
 *     mcp add` changes with it and a host writing JSON by hand does not.
 *   - Scopes are the CLI's, not a field. `local`, `user` and `project` are
 *     three different places, one of which is not even in that file, and
 *     re-deriving that mapping here would mean maintaining a second
 *     implementation of somebody else's decision.
 *
 * ## Which scope, and why this one
 *
 * `user`. Global, in the root `mcpServers` of the agent's config.
 *
 * `agentKnows` flattens global and project scope when it READS, deliberately —
 * whichever scope a person arranged is their business and the question there is
 * only whether the agent has been told. A write cannot be equally relaxed: it
 * has to put the entry somewhere specific, and the somewhere is worth saying
 * out loud before it happens rather than discovering afterwards.
 *
 * `user` is chosen because a module on this canvas is a program running on this
 * machine, not a fact about one checkout. `local` would tie the registration to
 * whichever directory this host's server happened to be started from, which is
 * an accident. `project` writes a `.mcp.json` into that directory — a file
 * meant to be committed and shared with other people, which is emphatically not
 * what "I have this module running on my laptop" means.
 */

/** The scope every write here goes to, and the word the UI shows. */
export const SCOPE = 'user' as const

/**
 * What the server will be called.
 *
 * The id's last segment, so `kehikot.checklist` becomes `checklist`. Two
 * reasons, and neither is brevity for its own sake. A tool reaches the agent as
 * `mcp__<server>__<tool>`, so the server name is read constantly and in full by
 * whoever is looking at a tool call. And `agents.ts` already matches on the
 * tail for exactly this reason — `claude mcp add` is usually given a short
 * name — so writing the long one would mean the host registering under a name
 * its own reader treats as the second-best match.
 *
 * The cost is a name that can collide with something unrelated somebody already
 * has. That collision is not silent: it arrives as `elsewhere`, the modal says
 * a server of that name points somewhere else, and repointing it is its own
 * press with its own sentence.
 */
export function serverName(id: string): string {
  return tailOf(id)
}

/**
 * What a module's door is called: the name its manifest declares (`mcp.as`,
 * protocol 1.3.0), and `serverName(id)` when it declares none.
 *
 * The host names no module. `kehikot.claude` derives `claude`, which in Claude
 * Code's own list of servers reads as something else entirely, and the fix is
 * not a table of better names here: the module says what it is called, in the
 * one document it already says everything else in. The protocol holds the
 * shape — lowercase, no whitespace, cannot start with `-` — so what arrives
 * here is already safe to hand to `claude mcp add` as an argument.
 *
 * Every reader of a door's name goes through this: `doorFor` for the writer,
 * `awarenessOf` (which is given the declared name) for the reader, and the
 * sweep and the two endpoints in `server.ts` through those.
 */
export function doorName(id: string, declared?: string | null): string {
  return declared || serverName(id)
}

/**
 * The name another registered module's door holds, as far as this host can
 * tell — or `null` when it has no door to hold one.
 *
 * A module that is answering says: its declared name, the derived one, or no
 * MCP door at all. A module that is NOT answering cannot say, and is taken to
 * hold the name its id derives: it held that name the last time this host
 * registered it, and a name is not freed by its owner being asleep.
 */
export function heldName(presence: Pick<Presence, 'id' | 'module'> | undefined, id: string): string | null {
  if (!presence?.module) return serverName(id)
  return presence.module.mcp ? doorName(id, presence.module.mcp.as) : null
}

/**
 * Why a DECLARED name cannot be used, in one sentence — or `null` when it can.
 *
 * Only a declared name is refused. A derived name that collides is the old
 * behaviour and stays what it was: it arrives as `elsewhere`, and the window
 * says where the entry points. A module that ASKS for a name is different: it
 * is asking for the host's own, or for one another module's door already has,
 * and granting it would have two doors taking turns at one entry in somebody's
 * configuration. So that module's door is refused — the module still frames;
 * it is its door that is not registered — and when two modules declare the
 * same name both are, since neither asked first in any sense this host keeps.
 *
 * `others` maps every OTHER registered module's id to the name it holds
 * (`heldName`).
 */
export function nameRefusal(id: string, declared: string | null | undefined, others: ReadonlyMap<string, string | null>): string | null {
  if (!declared) return null
  if (declared === HOST_ID) {
    return `${id} asks for its door to be connected as "${declared}", which is this host's own door, so its door is not connected. The module has to declare another name in its manifest (mcp.as).`
  }
  for (const [other, held] of others) {
    if (other === id || held !== declared) continue
    return `${id} asks for its door to be connected as "${declared}", which is the name of ${other}'s door, so its door is not connected. One of the two has to declare another name in its manifest (mcp.as).`
  }
  return null
}

/**
 * The door this host would register, taken from the module's manifest.
 *
 * Never from a request body. The endpoint takes a module id, finds the module
 * in the host's own registry, and builds this — see the essay on the endpoint
 * in `server.ts`. An endpoint that accepted a name and a url would be an
 * endpoint for registering arbitrary MCP servers on somebody's machine, which
 * is a considerably larger thing to have listening on loopback than a canvas.
 */
export interface Door {
  /**
   * Whose door this is: a module id from the registry, or `HOST_ID` for the
   * host's own — see `hostDoor` for why that one is not from the registry and
   * is still not from a request.
   */
  module: string
  /** What the server will be called: what the manifest declares, else derived from the id. See `doorName`. */
  as: string
  /** The module's MCP url, resolved on its own origin by discovery. */
  url: string
  /** What the manifest says the door speaks. */
  transport: string
}

/** What the host will run, as a line a person can read before pressing. */
export function addArgs(door: Door): string[] {
  return ['mcp', 'add', '--scope', SCOPE, '--transport', door.transport, door.as, door.url]
}

/**
 * Removing does NOT name a scope.
 *
 * `claude mcp remove` with no `-s` removes the server from whichever scope it
 * is in, and that is the right behaviour here: the entry being removed is one
 * the host found by reading, and it may well have been written by hand into a
 * scope this host would never write to. A remove pinned to `user` would report
 * success on a server it had not touched.
 */
export function removeArgs(name: string): string[] {
  return ['mcp', 'remove', name]
}

/**
 * A transport this host can register from a url.
 *
 * `stdio` is a command and a set of arguments, not an address. A module that
 * declared `stdio` alongside a url has said something incoherent, and the host
 * refuses rather than inventing a command line — inventing one is precisely the
 * thing `launch.ts` refuses to let a registration do.
 */
export function overTheWire(transport: string): boolean {
  return transport === 'http' || transport === 'sse'
}

/** What running the CLI produced. Kept small on purpose: it is shown verbatim. */
export interface Ran {
  ok: boolean
  /** The line that was run, so the page can show it whether or not it worked. */
  command: string
  /** Whatever the CLI printed, trimmed. Its words, not this host's. */
  said: string
}

/**
 * How the CLI is actually run — and the seam that makes this testable.
 *
 * The same shape as `launch.ts`: the decision about WHAT to run is a pure
 * function over the registry, and the running is one small thing behind a
 * parameter. A test can pass its own runner and check the arguments without a
 * `claude` binary anywhere near it, which matters more here than it does for a
 * start — the thing being exercised writes to the developer's own config file.
 */
export type Runner = (args: string[]) => Promise<{ ok: boolean; said: string }>

/**
 * Spawn `claude` with the arguments, and read what it printed.
 *
 * `shell: false` and an argument array, never a string: nothing here is
 * interpolated into a command line, so a module id that contained a semicolon
 * would be a name that does not match a server rather than a shell.
 */
export const runClaude: Runner = (args) => {
  /* One `claude` at a time, whoever asked — a press in a Tools window and the
     Settings sync (`agentSync.ts`) both write the same file through it. */
  const turn = claudeQueue.then(() => spawnClaude(args))
  claudeQueue = turn.then(
    () => undefined,
    () => undefined,
  )
  return turn
}

let claudeQueue: Promise<void> = Promise.resolve()

const spawnClaude: Runner = (args) =>
  new Promise((settle) => {
    let out = ''
    try {
      const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()))
      child.on('error', (error) =>
        settle({
          ok: false,
          said: `The \`claude\` command could not be run: ${error.message}. It is what owns this configuration, so the host will not edit the file itself.`,
        }),
      )
      child.on('close', (code) => settle({ ok: code === 0, said: out.trim() }))
    } catch (error) {
      settle({ ok: false, said: (error as Error).message })
    }
  })

const line = (args: string[]) => `claude ${args.join(' ')}`

/** Tell the agent about this door. */
export async function connect(door: Door, run: Runner = runClaude): Promise<Ran> {
  if (!overTheWire(door.transport)) {
    return {
      ok: false,
      command: '',
      said: `${door.module} says its door speaks "${door.transport}", which is not something that can be reached at a url. This host registers http and sse doors and will not invent a command line for a stdio one.`,
    }
  }
  const args = addArgs(door)
  const ran = await run(args)
  return { ok: ran.ok, command: line(args), said: ran.said }
}

/** Untell it. The name comes from what was read, never from a request. */
export async function disconnect(name: string, run: Runner = runClaude): Promise<Ran> {
  const args = removeArgs(name)
  const ran = await run(args)
  return { ok: ran.ok, command: line(args), said: ran.said }
}

/**
 * Point an existing entry at this module instead.
 *
 * Remove, then add, rather than adding over the top: `claude mcp add` refuses a
 * name that is already taken, and it is right to — an add that silently
 * replaced would be the quiet edit this whole file is arranged to avoid. So the
 * replacement is two explicit steps, and if the remove fails the add is not
 * attempted, because the alternative is a host that has deleted somebody's
 * server and then failed to put anything in its place.
 *
 * The existing entry may be in any scope; the new one goes to `user`. That is a
 * move as well as a rewrite, and the modal says so before the press.
 */
export async function repoint(existing: string, door: Door, run: Runner = runClaude): Promise<Ran> {
  const gone = await disconnect(existing, run)
  if (!gone.ok) {
    return {
      ok: false,
      command: gone.command,
      said: `The existing "${existing}" could not be removed, so nothing was changed. ${gone.said}`,
    }
  }
  const made = await connect(door, run)
  return {
    ok: made.ok,
    command: `${gone.command} && ${made.command}`,
    said: made.ok ? made.said : `"${existing}" was removed and the new entry failed. ${made.said}`,
  }
}

/**
 * One module's MCP door, found in the host's OWN registry.
 *
 * This is the single most important function behind the two endpoints in
 * `server.ts` — `/host/tools` and `/host/agent` — and it lives here, beside the
 * writing, rather than beside the routing, so that the rule it enforces cannot
 * be edited without reading why it exists.
 *
 * Both of those endpoints act on an MCP server: one asks it what it offers, the
 * other writes it into a person's agent configuration. Neither takes a server
 * name or a url from the request. What arrives over the wire is a module id and
 * nothing else; the id is looked up in the registrations directory — files
 * somebody wrote on their own disk — the module is asked for its manifest, and
 * the address comes from what the module said about itself.
 *
 * The alternative is a loopback endpoint that registers an MCP server at any
 * url a POST names. That is not a canvas any more: it is a way for anything
 * that can reach 127.0.0.1:4180 — a page in another tab, a script, a module's
 * own iframe — to add a server to somebody's agent, which the agent will then
 * start talking to. The id-only shape is what makes the set of registrable
 * addresses exactly "the modules this person registered", and it is the same
 * argument `launch.ts` makes about directories.
 *
 * Every refusal is a sentence, because all four say different things: nothing
 * is registered under that id, the module is registered but not answering, it
 * is answering and declares no MCP door, or it declares one this host cannot
 * reach at a url.
 *
 * A fifth, since a module may declare its door's name: the name it asks for
 * is another door's (`nameRefusal`). `seen` is what the last sweep found of
 * the OTHER modules — what each one's door is called. It is not asked again
 * here: this is one module's window, and the wait for every stopped neighbour
 * would be this module's person's to sit through.
 */
export async function doorFor(
  id: string,
  seen: ReadonlyMap<string, Pick<Presence, 'id' | 'module'>> = new Map(),
): Promise<{ ok: true; door: Door } | NoDoor> {
  const now = await readRegistrations()
  const registration = now.registrations.find((r) => r.id === id)
  if (!registration) {
    return {
      ok: false,
      status: 404,
      why: `Nothing is registered as "${id}". This host only knows the modules in ${registryDir()}, and it will not act on a server it did not find there.`,
    }
  }

  /* Asked now rather than read off the last sweep. The address of a door is a
     fact about a running program, and the whole point of this window is that
     somebody is about to write that address down somewhere durable. Writing a
     remembered one is how a config ends up pointing at a port the module has
     moved off. */
  const presence = await look(registration)
  const mcp = presence.module?.mcp ?? null
  if (!mcp) {
    return presence.module
      ? {
          ok: false,
          status: 409,
          why: `${presence.name ?? id} is answering and its manifest declares no MCP door, so there is nothing for an agent to be told about.`,
        }
      : {
          ok: false,
          status: 409,
          why: `${id} is registered at ${registration.url} and is not answering, so this host cannot read where its door is. Start it and try again.`,
        }
  }

  const others = new Map<string, string | null>()
  for (const other of now.registrations) {
    if (other.id !== id) others.set(other.id, heldName(seen.get(other.id), other.id))
  }
  const refusal = nameRefusal(id, mcp.as, others)
  if (refusal) return { ok: false, status: 409, why: refusal, at: mcp.url }

  return {
    ok: true,
    door: { module: id, as: doorName(id, mcp.as), url: mcp.url, transport: mcp.transport },
  }
}

/**
 * Why there is no door to act on.
 *
 * `at` is set for one reason only: the module is answering and has a door,
 * and the NAME it asks for is refused (`nameRefusal`). Nothing is written for
 * such a door — but an entry made before the refusal may still point at it,
 * and that one is the module's to remove: see `staleAt`.
 */
export type NoDoor = { ok: false; why: string; status: number; at?: string }

/**
 * The entry that still points at a door whose name is refused, or null.
 *
 * Found by the address and never by a name: the name the module asks for is
 * another door's, and removing THAT would disconnect the wrong module. An
 * entry whose url is this door can only be this module's.
 */
export function staleAt(found: NoDoor, known: Map<string, unknown>): string | null {
  return found.at ? (pointingAt(found.at, known)[0] ?? null) : null
}

/**
 * What the agent has been told about a door, read against the door's own name.
 *
 * The one way the endpoints in `server.ts` ask, so that the name the reader
 * matches on is the name the writer would write. A door whose name is the one
 * its id derives declared nothing as far as the reader needs to know — which
 * is every module that says nothing, and the host.
 */
export function awarenessAt(door: Door, known: Map<string, unknown>): AgentAwareness {
  return awarenessOf(door.url, door.module, known, door.as === serverName(door.module) ? null : door.as)
}

/**
 * The host's own door, which is the one door `doorFor` cannot find.
 *
 * ## The gap
 *
 * `server/mcp.ts` serves a door on the host's own API — `read_canvas` and
 * `select_modules`, the two tools an agent needs to know which containers a
 * person has picked out. Every module's door got a plug on its container
 * header; this one got nothing, because everything above reads the REGISTRY,
 * and the host is not in its own registry. So the one door on the screen that
 * an agent most needs was the one door no control on the screen would connect.
 *
 * ## Why this is still not "a url from a request"
 *
 * The rule `doorFor` enforces is that the set of addresses this host will write
 * into somebody's agent configuration is exactly the programs that person
 * registered on their own disk. The host's door is derived from two things and
 * neither is the request: the port `run.sh` claimed and `server.ts` bound, and
 * a path that is a literal here. `/host/tools` and `/host/agent` still take an
 * id and nothing else; the id `HOST_ID` is answered from this function instead
 * of from a registration file, and any other id is looked up as before.
 *
 * ## What it is called, and why that name
 *
 * `HOST_ID` — `kehikko`. The same word the host calls itself at its own door's
 * `initialize` and the folder it keeps under a project's `.kehikot/`, so the
 * server name in somebody's agent config, the `serverInfo` the agent reads
 * back, and the folder on disk are one word and cannot drift. It is stable
 * across ports and machines: the ADDRESS is what moves, and `agents.ts` reads
 * the address, not the name, to decide whether the agent has been told.
 *
 * It cannot collide with a module registered under this host's convention —
 * module ids are dotted (`kehikot.checklist`) and `serverName` takes the tail
 * — unless somebody registers a module whose tail is literally `kehikko`. That
 * collision is not silent: whichever of the two is connected, the other reads
 * as `elsewhere`, and the window says which address the entry points at.
 *
 * ## The port, and why `repoint` applies here exactly as it does to a module
 *
 * `run.sh` takes `PORT`, and `claim.ts` moves to the next pair when 4180 is
 * taken. A config entry written against 4180 while the host is on 4182 is
 * stale in precisely the way a module that moved port is stale — the agent
 * reaches the old address and gets nothing — and `awarenessOf` reports it as
 * `elsewhere` for precisely the same reason: url first, then the name. So the
 * repoint press the module window already has is the right press here, and
 * nothing about it is special-cased.
 */
export function hostDoor(port: number): Door {
  return { module: HOST_ID, as: HOST_ID, url: `http://127.0.0.1:${port}/mcp`, transport: 'http' }
}
