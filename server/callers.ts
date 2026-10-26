import { LIMITS, TRAFFIC_HOST_BY, type TrafficCaller } from 'kehikot-module-protocol'

import { parsePs, runQuiet, type Proc } from './trafficProcesses.ts'

/**
 * Who sent a request this host received (protocol 2.25.0, `caller` on a row of traffic), named at
 * the moment it arrives, so the record never says "an unknown program" about something on this
 * computer that can be told.
 *
 * ## How
 *
 * A request on loopback comes from a TCP connection whose other end is a port on this computer
 * (`server.requestIP`). The process holding that port is the caller: `netstat -anv -p tcp` lists
 * every connection with the pid of its process, as a person, in a few milliseconds (macOS); where
 * it does not say pids, `lsof -nP -iTCP:<port> -sTCP:ESTABLISHED` does. Then `ps` gives the
 * process's parents, walked to the nearest owner this host knows:
 *
 *  - a module's processes: its group when this host started it (it is the group's leader), or
 *    everything under the process listening on its registered port when somebody else did;
 *  - an agent session under a module (`claude`, `codex`): "Claude session", with its place when its
 *    MCP call carried the place token (`tagged` in `server.ts`);
 *  - this host's own process, everything under it, and what started it (the desktop app): Kehikot;
 *  - anything else: the program's own name and its parent's ("curl, from your terminal (zsh)",
 *    "Claude Code, started outside Kehikot").
 *
 * ## What is never recorded
 *
 * A command line. Of a process, only its executable's name (`ps -o ucomm=`, the accounting name the
 * kernel keeps, which no program can set to its arguments). Claude Code names its executable by its
 * version (`~/.local/share/claude/versions/2.1.310`), so for a name that is a version the
 * executable's path is read (`lsof -d txt`) and only what it says — "this is Claude Code" — kept.
 *
 * ## Cheap
 *
 * One `netstat` answers for every connection open at that moment, so the lookups of requests
 * arriving together share one run, and a connection kept alive is looked up once (`PEERS_MS`). The
 * process table is kept for `PROCS_MS`. A request the page or a route already names, or that
 * carries a place token, needs no lookup at all.
 */

/** How long what is known of a connection's other end is kept: a keep-alive connection is looked up once. */
export const PEERS_MS = 30_000
/** How long a listing of the processes is good for; a pid not in it asks again, once. */
export const PROCS_MS = 1500
const PEERS_MAX = 4000

/** One TCP connection's ends and the pid of the process holding it, as `netstat -anv` lists it. */
export interface NetRow {
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
  state: string
  pid: number
}

/** `a.b.c.d.port` or `::1.port` (netstat's spelling), `*.port` for a listener. */
function end(text: string): { host: string; port: number } {
  const at = text.lastIndexOf('.')
  if (at < 0) return { host: text, port: 0 }
  const port = Number(text.slice(at + 1))
  return { host: text.slice(0, at), port: Number.isInteger(port) ? port : 0 }
}

/**
 * `netstat -anv -p tcp`. Since macOS 11 a row ends `… rhiwat shiwat process:pid state options …`;
 * before, `… rhiwat shiwat pid epid …`. Both are read; a row with no pid is left out.
 */
export function parseNetstat(text: string): NetRow[] {
  const out: NetRow[] = []
  for (const line of text.split('\n')) {
    const match = /^tcp[46]*\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+([A-Z_0-9]+)\s+(.*)$/.exec(line.trim())
    if (!match) continue
    const rest = match[4]!
    /* The name can hold spaces ("Google Chrome He"); the pid is the number after the last colon before the hex fields. */
    const named = /^(?:\d+\s+){4}(.+?):(\d+)\s/.exec(`${rest} `)
    const older = /^(?:\d+\s+){2}(\d+)\s+\d+/.exec(rest)
    const pid = named ? Number(named[2]) : older ? Number(older[1]) : 0
    if (!pid) continue
    const local = end(match[1]!)
    const remote = end(match[2]!)
    out.push({ localHost: local.host, localPort: local.port, remoteHost: remote.host, remotePort: remote.port, state: match[3]!, pid })
  }
  return out
}

/** `lsof -nP -iTCP:<port> -sTCP:ESTABLISHED -F pn`: the pid at each connection's local end. */
export function parseLsofPeers(text: string): NetRow[] {
  const out: NetRow[] = []
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid && line.includes('->')) {
      const [local, remote] = line.slice(1).split('->') as [string, string]
      const split = (one: string) => {
        const at = one.lastIndexOf(':')
        return { host: one.slice(0, at).replace(/^\[|\]$/g, ''), port: Number(one.slice(at + 1)) || 0 }
      }
      const l = split(local)
      const r = split(remote)
      out.push({ localHost: l.host, localPort: l.port, remoteHost: r.host, remotePort: r.port, state: 'ESTABLISHED', pid })
    }
  }
  return out
}

export const isLoopback = (address: string): boolean => {
  const plain = address.replace(/^::ffff:/i, '')
  return plain === '::1' || plain === 'localhost' || plain.startsWith('127.')
}

/* ------------------------------------------------------------------------ *
 * Programs, by name.
 * ------------------------------------------------------------------------ */

/** Agent programs: what a session's process is called, and how a person calls it. */
export const AGENTS: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex' }

/** Shells: a program whose parent is one was started from a terminal. */
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh', 'login'])

/** What runs a script rather than being a program of its own: the host's parent being one of these is not the desktop app. */
const RUNNERS = new Set(['launchd', 'node', 'bun', 'npm', 'npx', 'bunx', 'deno', 'python', 'python3', 'tmux', 'screen', 'make', 'systemd', 'init'])

/** A process's executable name, cleaned: a login shell's `-zsh` is `zsh`. Bounded; never a path. */
export const exeName = (name: string): string => name.trim().replace(/^-/, '').split('/').pop()!.slice(0, LIMITS.TRAFFIC_KIND)

/** Whether an executable name is a version number, as Claude Code's is. */
export const versionNamed = (name: string): boolean => /^\d+\.\d+\.\d+/.test(name)

/** From the path of a process's executable: which agent it is, or null. The path itself is not kept. */
export function agentOfPath(path: string): string | null {
  if (/\/claude\/versions\/[^/]+$/.test(path) || /\/claude(-code)?\/[^/]*$/.test(path)) return 'claude'
  if (/\/codex(\/[^/]*)?$/.test(path)) return 'codex'
  return null
}

/** `lsof -a -p <pid> -d txt -F n`: the first file is the executable. */
export function exePathOf(lsof: string): string | null {
  for (const line of lsof.split('\n')) if (line.startsWith('n/')) return line.slice(1)
  return null
}

/** How a person reads a program's name: "Claude Code", "curl". */
export const programSaid = (exe: string): string => AGENTS[exe] ?? exe

/* ------------------------------------------------------------------------ *
 * Owners.
 * ------------------------------------------------------------------------ */

/**
 * A module's process: `group` when this host started it — the pid leads its own process group,
 * and the whole group is the module's — or not, when it is the process somebody else started that
 * listens on the module's port, and then only what is under it is the module's (the group of a
 * process started from a terminal is the terminal's job, or a script's, with whatever else it ran).
 */
export interface Root {
  module: string
  pid: number
  group: boolean
}

/**
 * Who each process belongs to: a module's processes (`Root`), then this host's own process and
 * everything under it, and what started it (the desktop app), as Kehikot.
 */
export function owners(procs: readonly Proc[], roots: readonly Root[], self: number): Map<number, string> {
  const children = new Map<number, number[]>()
  const parent = new Map<number, number>()
  for (const proc of procs) {
    children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid])
    parent.set(proc.pid, proc.ppid)
  }
  const owner = new Map<number, string>()
  const claim = (pid: number, by: string) => {
    const stack = [pid]
    while (stack.length) {
      const one = stack.pop()!
      if (owner.has(one)) continue
      owner.set(one, by)
      stack.push(...(children.get(one) ?? []))
    }
  }
  for (const root of roots) {
    if (root.group) {
      const pgid = procs.find((proc) => proc.pid === root.pid)?.pgid ?? root.pid
      for (const proc of procs) if (proc.pgid === pgid && proc.pid !== self) claim(proc.pid, root.module)
    }
    claim(root.pid, root.module)
  }
  claim(self, TRAFFIC_HOST_BY)
  /* What started this host — the desktop app, when it did — is Kehikot too; not launchd, a shell, or a runtime that ran a script. */
  const up = parent.get(self)
  const name = exeName(procs.find((proc) => proc.pid === up)?.name ?? '')
  if (up && up > 1 && !owner.has(up) && name && !SHELLS.has(name) && !RUNNERS.has(name)) owner.set(up, TRAFFIC_HOST_BY)
  return owner
}

/** What the lookup found of a connection's process: enough to name it, and nothing else. */
export interface Found {
  pid: number
  /** Its executable's name, or the agent it is (`claude`, `codex`). */
  exe: string
  /** Its parent's executable name, '' when it has none worth naming. */
  parent: string
  /** The module or `kehikko` it belongs to, or null. */
  owner: string | null
}

export interface Names {
  /** A module's registered name: "Paper". */
  module(id: string): string
  /** A session's place, when its call carried a place token or its MCP session is recorded: "Wide · methods". */
  place?: string | null
}

export const GONE_SAID = 'A program that closed before it could be named'

/** The caller a found process is, in a person's words. Pure. */
export function callerOf(found: Found | null, names: Names): TrafficCaller {
  if (!found) return { kind: 'gone', name: GONE_SAID, how: 'closed' }
  const process = found.exe ? { process: found.exe } : {}
  const parent = found.parent ? { parent: found.parent } : {}
  const place = names.place ? { place: names.place.slice(0, LIMITS.TRAFFIC_CALLER) } : {}
  const clip = (name: string) => name.slice(0, LIMITS.TRAFFIC_CALLER)
  const agent = AGENTS[found.exe]
  if (found.owner === TRAFFIC_HOST_BY) return { kind: 'host', name: 'Kehikot', how: 'process', ...process, pid: found.pid }
  if (found.owner) {
    const module = names.module(found.owner)
    if (agent) return { kind: 'session', name: clip(`${module} session${names.place ? ` on ${names.place}` : ''}`), how: 'process', ...process, ...parent, ...place, pid: found.pid }
    return { kind: 'module', name: clip(module), how: 'process', ...process, pid: found.pid }
  }
  const from = !found.parent ? '' : SHELLS.has(found.parent) ? `, from your terminal (${found.parent})` : `, from ${programSaid(found.parent)}`
  const name = agent ? `${agent}, started outside Kehikot${names.place ? `, on ${names.place}` : ''}` : `${programSaid(found.exe) || 'A program'}${from}`
  return { kind: 'program', name: clip(name), how: 'process', ...process, ...parent, ...place, pid: found.pid }
}

/** A peer that is not this computer. */
export const remoteCaller = (address: string): TrafficCaller => ({
  kind: 'remote',
  name: `Another computer (${address.replace(/^::ffff:/i, '')})`.slice(0, LIMITS.TRAFFIC_CALLER),
  how: 'address',
})

/* ------------------------------------------------------------------------ *
 * The lookup.
 * ------------------------------------------------------------------------ */

export interface LookupDeps {
  /** Run a program and get what it printed, or null. */
  run?(argv: string[]): Promise<string | null>
  /** The port this host answers on. */
  port: number
  self?: number
  /** Each module this host started (`group: true`), by its pid. */
  started(): Root[]
  /** The registered port of each module this host did not start: the process listening there is its root. */
  unstarted(): Array<{ module: string; port: number }>
  now?(): number
  /** Whether `netstat` is tried first; false where it gives no pids (Linux). */
  netstat?: boolean
}

/**
 * Peer port → the process at the other end, then its owner. One `netstat` serves every lookup
 * asked while it runs; a lookup asked after it started waits for the next one (its connection may
 * be newer than the listing).
 */
export class PeerLookup {
  #deps: LookupDeps
  #peers = new Map<number, { at: number; pid: number | null }>()
  #running: Promise<void> | null = null
  #next: Promise<void> | null = null
  #procs: { at: number; list: Proc[]; owner: Map<number, string> } | null = null
  #listing: Promise<{ at: number; list: Proc[]; owner: Map<number, string> }> | null = null
  #agentPaths = new Map<number, string | null>()
  #listeners = new Map<number, number>()
  #netstat: boolean

  constructor(deps: LookupDeps) {
    this.#deps = deps
    this.#netstat = deps.netstat ?? process.platform === 'darwin'
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  #run(argv: string[]): Promise<string | null> {
    return (this.#deps.run ?? runQuiet)(argv)
  }

  /** Whether a connection's other end is already known (a keep-alive connection's second request). */
  known(port: number): boolean {
    const had = this.#peers.get(port)
    return had !== undefined && had.pid !== null && this.#now() - had.at < PEERS_MS
  }

  /** One listing of the connections, filed by the client's port; shared by every lookup that asked before it began. */
  #look(): Promise<void> {
    if (this.#running) {
      this.#next ??= this.#running.then(() => {
        this.#next = null
        return this.#look()
      })
      return this.#next
    }
    this.#running = (async () => {
      const rows = this.#netstat ? parseNetstat((await this.#run(['netstat', '-anv', '-p', 'tcp'])) ?? '') : []
      const now = this.#now()
      if (rows.length) {
        this.#listeners.clear()
        for (const row of rows) {
          if (row.state === 'LISTEN' && !this.#listeners.has(row.localPort)) this.#listeners.set(row.localPort, row.pid)
          else if (row.remotePort === this.#deps.port && isLoopback(row.remoteHost) && row.state !== 'LISTEN' && row.pid !== (this.#deps.self ?? process.pid)) {
            this.#peers.set(row.localPort, { at: now, pid: row.pid })
          }
        }
      } else {
        /* No netstat, or none that says pids: lsof, for the connections to this host's port. */
        this.#netstat = false
        for (const row of parseLsofPeers((await this.#run(['lsof', '-nP', `-iTCP:${this.#deps.port}`, '-sTCP:ESTABLISHED', '-F', 'pn'])) ?? '')) {
          if (row.remotePort === this.#deps.port && row.pid !== (this.#deps.self ?? process.pid)) this.#peers.set(row.localPort, { at: now, pid: row.pid })
        }
        const listening = await this.#run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'])
        if (listening) {
          this.#listeners.clear()
          let pid = 0
          for (const line of listening.split('\n')) {
            if (line.startsWith('p')) pid = Number(line.slice(1))
            else if (line.startsWith('n') && pid) {
              const port = Number(line.slice(line.lastIndexOf(':') + 1))
              if (port && !this.#listeners.has(port)) this.#listeners.set(port, pid)
            }
          }
        }
      }
      if (this.#peers.size > PEERS_MAX) for (const [port, one] of this.#peers) if (now - one.at > PEERS_MS) this.#peers.delete(port)
    })().finally(() => {
      this.#running = null
    })
    return this.#running
  }

  /** The processes and who owns each, kept `PROCS_MS`; `fresh` asks again. */
  async #table(fresh = false): Promise<{ at: number; list: Proc[]; owner: Map<number, string> }> {
    if (!fresh && this.#procs && this.#now() - this.#procs.at < PROCS_MS) return this.#procs
    this.#listing ??= (async () => {
      const list = parsePs((await this.#run(['ps', '-A', '-o', 'pid=,ppid=,pgid=,ucomm='])) ?? '')
      const roots = [...this.#deps.started()]
      const held = new Set(roots.map((root) => root.module))
      for (const one of this.#deps.unstarted()) {
        const pid = this.#listeners.get(one.port)
        if (pid && !held.has(one.module) && pid !== (this.#deps.self ?? process.pid)) roots.push({ module: one.module, pid, group: false })
      }
      const table = { at: this.#now(), list, owner: owners(list, roots, this.#deps.self ?? process.pid) }
      this.#procs = table
      return table
    })().finally(() => {
      this.#listing = null
    })
    return this.#listing
  }

  /** Which agent a process whose executable is named by a version is, from its executable's path. */
  async #agentOf(pid: number): Promise<string | null> {
    if (this.#agentPaths.has(pid)) return this.#agentPaths.get(pid)!
    const path = exePathOf((await this.#run(['lsof', '-a', '-p', String(pid), '-d', 'txt', '-F', 'n'])) ?? '')
    const agent = path ? agentOfPath(path) : null
    if (this.#agentPaths.size > 500) this.#agentPaths.clear()
    this.#agentPaths.set(pid, agent)
    return agent
  }

  async #exeOf(proc: Proc | undefined): Promise<string> {
    if (!proc) return ''
    const name = exeName(proc.name)
    if (versionNamed(name)) return (await this.#agentOf(proc.pid)) ?? name
    return name
  }

  /** The process at the other end of the connection from `port`, found and owned; null when it was gone. */
  async find(port: number): Promise<Found | null> {
    if (!this.known(port)) await this.#look()
    const pid = this.#peers.get(port)?.pid ?? null
    if (pid === null) {
      this.#peers.set(port, { at: this.#now(), pid: null })
      return null
    }
    /* A listing from before the connection was seen may name the pid as what it was before an `exec` (a shell that became curl). */
    const seen = this.#peers.get(port)?.at ?? 0
    let table = await this.#table()
    if (table.at < seen || !table.list.some((proc) => proc.pid === pid)) table = await this.#table(true)
    const proc = table.list.find((one) => one.pid === pid)
    if (!proc) return null
    const up = table.list.find((one) => one.pid === proc.ppid)
    const exe = await this.#exeOf(proc)
    const parent = proc.ppid > 1 ? await this.#exeOf(up) : ''
    return { pid, exe, parent: parent === 'launchd' ? '' : parent, owner: table.owner.get(pid) ?? null }
  }
}
