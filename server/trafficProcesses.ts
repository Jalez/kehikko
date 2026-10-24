import { reverse } from 'node:dns/promises'

import { LIMITS, TRAFFIC_HOST_BY, type TrafficConnection, type TrafficProcesses } from 'kehikot-module-protocol'

import { untraced, type TrafficRecord } from './traffic.ts'

/**
 * Connections nobody reported (protocol 2.20.0): what is open on this host's own processes and on each
 * module's process group, sampled with macOS's own tools — no privileges, nothing installed.
 *
 * ## What it can see, and what it cannot
 *
 * `nettop -L 1 -n -x -J bytes_in,bytes_out -p <pid>…` lists every socket of the named processes with
 * the bytes each carried since it opened, as a person (not root). `ps` gives the process tree, so a
 * module's group is everything under the pid this host started it as — its dev server, a Chrome the
 * Browser started, a `claude` the Claude module started — and a module somebody started by hand is
 * found by the port it listens on (`lsof … -sTCP:LISTEN`). What it cannot see: a connection that
 * opened and closed between two looks (a short `fetch` usually is one), what a connection carried
 * (it is encrypted, and only bytes are counted), and DNS, which macOS resolves in its own
 * `mDNSResponder` on everybody's behalf. Without `nettop` it falls back to `lsof -i`, which lists
 * the connections and no bytes, and says so.
 *
 * ## Only while somebody looks
 *
 * A `traffic.read` with `sample: true` asks for it; the sampler looks every `EVERY_MS` and stops
 * `WANTED_MS` after the last such read. Nothing runs while no Monitor is open.
 */

export const EVERY_MS = 3000
export const WANTED_MS = 10_000
/** How many processes one look names. */
const PIDS_MAX = 200
/** How many addresses are looked up by name in one look; the rest stay numbers until a later one. */
const NAMES_PER_LOOK = 6

export interface Proc {
  pid: number
  ppid: number
  pgid: number
  name: string
}

/** `ps -A -o pid=,ppid=,pgid=,ucomm=`. */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line)
    if (match) out.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), name: (match[4] ?? '').slice(0, LIMITS.TRAFFIC_KIND) })
  }
  return out
}

/**
 * Who each process belongs to: the members of each module's group and everything under them, then
 * this host's own process and everything under it that no module claimed.
 */
export function attribute(procs: readonly Proc[], roots: ReadonlyArray<readonly [string, number]>, self: number): Map<number, string> {
  const children = new Map<number, number[]>()
  for (const proc of procs) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid])
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
  for (const [by, pid] of roots) {
    /* The whole group the process leads or belongs to, and everything under it. */
    const pgid = procs.find((proc) => proc.pid === pid)?.pgid ?? pid
    for (const proc of procs) if (proc.pgid === pgid && proc.pid !== self) claim(proc.pid, by)
    claim(pid, by)
  }
  claim(self, TRAFFIC_HOST_BY)
  return owner
}

export interface Socket {
  pid: number
  process: string
  proto: 'tcp' | 'udp'
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
  bytesIn?: number
  bytesOut?: number
}

/** One side of `a:b` (IPv4) or `a.b` (IPv6) as nettop prints it. */
function side(text: string, v6: boolean): { host: string; port: number } {
  const at = v6 ? text.lastIndexOf('.') : text.lastIndexOf(':')
  if (at < 0) return { host: text, port: 0 }
  const port = Number(text.slice(at + 1))
  return { host: text.slice(0, at), port: Number.isInteger(port) ? port : 0 }
}

/** `nettop -L 1 -n -x -J bytes_in,bytes_out`: process lines (`name.pid,in,out,`) and their sockets. */
export function parseNettop(text: string): Socket[] {
  const out: Socket[] = []
  let pid = 0
  let process = ''
  for (const line of text.split('\n')) {
    if (!line || line.startsWith(',')) continue
    const socket = /^(tcp|udp)([46]) (.+?)<->(.+?),(\d*),(\d*),?$/.exec(line)
    if (socket) {
      if (!pid) continue
      const v6 = socket[2] === '6'
      const local = side(socket[3]!, v6)
      const remote = side(socket[4]!, v6)
      out.push({
        pid,
        process,
        proto: socket[1] as 'tcp' | 'udp',
        localHost: local.host,
        localPort: local.port,
        remoteHost: remote.host,
        remotePort: remote.port,
        ...(socket[5] ? { bytesIn: Number(socket[5]) } : {}),
        ...(socket[6] ? { bytesOut: Number(socket[6]) } : {}),
      })
      continue
    }
    const head = /^(.*)\.(\d+),\d*,\d*,?$/.exec(line)
    if (head) {
      process = (head[1] ?? '').slice(0, LIMITS.TRAFFIC_KIND)
      pid = Number(head[2])
    }
  }
  return out
}

/** `lsof -nP -i -a -p <pids> -F pcnPT`: connections without bytes, for when nettop is not there. */
export function parseLsof(text: string): Socket[] {
  const out: Socket[] = []
  let pid = 0
  let process = ''
  let proto: 'tcp' | 'udp' = 'tcp'
  for (const line of text.split('\n')) {
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') pid = Number(value)
    else if (field === 'c') process = value.slice(0, LIMITS.TRAFFIC_KIND)
    else if (field === 'P') proto = value.toLowerCase() === 'udp' ? 'udp' : 'tcp'
    else if (field === 'n') {
      /* A listener (`*:8021`) has no other end: kept, so a connection to it is known for the other side's. */
      const [local, remote] = (value.includes('->') ? value.split('->') : [value, '*:0']) as [string, string]
      const split = (text: string) => {
        const at = text.lastIndexOf(':')
        return { host: text.slice(0, at).replace(/^\[|\]$/g, ''), port: Number(text.slice(at + 1)) || 0 }
      }
      const l = split(local)
      const r = split(remote)
      out.push({ pid, process, proto, localHost: l.host, localPort: l.port, remoteHost: r.host, remotePort: r.port })
    }
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pn`: which pid listens on each port. */
export function parseListeners(text: string): Map<number, number> {
  const out = new Map<number, number>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1))
      if (Number.isInteger(port) && port > 0 && !out.has(port)) out.set(port, pid)
    }
  }
  return out
}

const LOOPBACK = (host: string) => host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.')
const UNKNOWN = (host: string) => host === '*' || host === '' || host === '0.0.0.0' || host === '::'

export interface SamplerDeps {
  record: TrafficRecord
  /**
   * A process of each module: the pid this host started it as, or the process listening on its
   * registered port. Its whole group, and everything under it, is the module's.
   */
  roots(): Promise<Array<readonly [string, number]>>
  /** Run a program and get what it printed, or null. */
  run?(argv: string[]): Promise<string | null>
  /** This host's own pid. */
  self?: number
  now?(): number
  /** Look an address up by name: cheap, cached, and allowed to fail. */
  name?(address: string): Promise<string | null>
}

export async function runQuiet(argv: string[]): Promise<string | null> {
  return untraced(async () => {
    try {
      const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
      const timer = setTimeout(() => child.kill(), 5000)
      const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      clearTimeout(timer)
      return code === 0 ? text : null
    } catch {
      return null
    }
  })
}

async function nameOf(address: string): Promise<string | null> {
  try {
    const names = await Promise.race([reverse(address), new Promise<string[]>((done) => setTimeout(() => done([]), 1000))])
    return names[0]?.slice(0, LIMITS.TRAFFIC_HOST) ?? null
  } catch {
    return null
  }
}

/** The sampler: asked for while somebody reads with `sample: true`, quiet otherwise. */
export class ProcessSampler {
  #deps: SamplerDeps
  #wantedUntil = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  #looking = false
  #last: TrafficProcesses = { on: false, bytes: false, at: null, why: '', connections: [] }
  /** Connections already seen, by a key of process and both ends, with when they were first seen. */
  #seen = new Map<string, number>()
  #names = new Map<string, string | null>()
  /** Local port → who holds it, from the last look: who a request from a program came from. */
  #ports = new Map<number, string>()

  constructor(deps: SamplerDeps) {
    this.#deps = deps
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  /** Somebody looked: keep sampling for `WANTED_MS`. Returns what was last seen. */
  want(): TrafficProcesses {
    const was = this.#wantedUntil > this.#now()
    this.#wantedUntil = this.#now() + WANTED_MS
    if (!was && !this.#timer) this.#schedule(0)
    return { ...this.#last, on: true }
  }

  get last(): TrafficProcesses {
    return { ...this.#last, on: this.#wantedUntil > this.#now() }
  }

  /** Who held a local port at the last look, while looking. */
  portOwner(port: number): string | null {
    return this.#wantedUntil > this.#now() ? (this.#ports.get(port) ?? null) : null
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#wantedUntil = 0
  }

  #schedule(ms: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = null
      if (this.#wantedUntil <= this.#now()) {
        this.#seen.clear()
        this.#ports.clear()
        return
      }
      void this.look().finally(() => {
        if (this.#wantedUntil > this.#now()) this.#schedule(EVERY_MS)
      })
    }, ms)
    ;(this.#timer as { unref?: () => void }).unref?.()
  }

  /** One look. Public for the tests. */
  async look(): Promise<TrafficProcesses> {
    if (this.#looking) return this.#last
    this.#looking = true
    try {
      const run = this.#deps.run ?? runQuiet
      const ps = await run(['ps', '-A', '-o', 'pid=,ppid=,pgid=,ucomm='])
      if (ps === null) {
        this.#last = { on: true, bytes: false, at: this.#now(), why: 'This computer would not list its processes (ps), so connections cannot be told apart by module.', connections: [] }
        return this.#last
      }
      const owner = attribute(parsePs(ps), await this.#deps.roots(), this.#deps.self ?? process.pid)
      const pids = [...owner.keys()].slice(0, PIDS_MAX)
      let bytes = true
      let why = ''
      let sockets: Socket[] = []
      const net = await run(['nettop', '-L', '1', '-n', '-x', '-J', 'bytes_in,bytes_out', ...pids.flatMap((pid) => ['-p', String(pid)])])
      if (net !== null) sockets = parseNettop(net)
      else {
        bytes = false
        why = 'nettop did not answer, so connections are listed without the bytes they carried.'
        const lsof = await run(['lsof', '-nP', '-i', '-a', '-p', pids.join(','), '-F', 'pcPn'])
        sockets = lsof === null ? [] : parseLsof(lsof)
      }
      const listening = new Set(sockets.filter((s) => UNKNOWN(s.remoteHost) && s.proto === 'tcp').map((s) => `${s.pid}:${s.localPort}`))
      const now = this.#now()
      const connections: TrafficConnection[] = []
      const still = new Set<string>()
      this.#ports.clear()
      let lookups = 0
      for (const socket of sockets) {
        const by = owner.get(socket.pid)
        if (by === undefined) continue
        if (socket.proto === 'tcp' && UNKNOWN(socket.remoteHost)) continue
        /* A connection somebody made TO this process (its own server's port) is the other side's call, not this one's. */
        if (listening.has(`${socket.pid}:${socket.localPort}`)) continue
        if (socket.proto === 'udp' && UNKNOWN(socket.remoteHost) && !socket.bytesIn && !socket.bytesOut) continue
        const local = LOOPBACK(socket.remoteHost)
        if (local) this.#ports.set(socket.localPort, by)
        /* This host's own process on this computer: every such call is already in the record, from `fetch`. */
        if (local && socket.pid === (this.#deps.self ?? process.pid)) continue
        const key = `${socket.pid}|${socket.proto}|${socket.localHost}:${socket.localPort}|${socket.remoteHost}:${socket.remotePort}`
        still.add(key)
        let since = this.#seen.get(key)
        let remote = UNKNOWN(socket.remoteHost) ? '' : socket.remoteHost
        if (remote && !local) {
          if (!this.#names.has(remote) && lookups < NAMES_PER_LOOK) {
            lookups++
            this.#names.set(remote, await (this.#deps.name ?? nameOf)(remote))
          }
          remote = this.#names.get(remote) ?? remote
        }
        if (since === undefined) {
          since = now
          this.#seen.set(key, now)
          this.#deps.record.add({
            at: now,
            ms: null,
            reason: null,
            kind: socket.proto,
            host: (remote ? `${remote}${socket.remotePort ? `:${socket.remotePort}` : ''}` : '').slice(0, LIMITS.TRAFFIC_HOST),
            path: '',
            status: null,
            ok: null,
            ...(socket.bytesIn !== undefined ? { bytesIn: socket.bytesIn } : {}),
            ...(socket.bytesOut !== undefined ? { bytesOut: socket.bytesOut } : {}),
            by,
            via: 'process',
            side: 'seen',
            reported: 'sampled',
          })
        }
        if (connections.length < LIMITS.TRAFFIC_CONNECTIONS) {
          connections.push({
            by,
            pid: socket.pid,
            process: socket.process,
            proto: socket.proto,
            remote: remote.slice(0, LIMITS.TRAFFIC_HOST),
            port: socket.remotePort,
            local,
            ...(socket.bytesIn !== undefined ? { bytesIn: socket.bytesIn } : {}),
            ...(socket.bytesOut !== undefined ? { bytesOut: socket.bytesOut } : {}),
            since,
          })
        }
      }
      for (const key of this.#seen.keys()) if (!still.has(key)) this.#seen.delete(key)
      this.#last = { on: true, bytes, at: now, why, connections }
      return this.#last
    } finally {
      this.#looking = false
    }
  }
}
