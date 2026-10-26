import { describe, expect, test } from 'bun:test'

import { LIMITS } from 'kehikot-module-protocol'

import {
  agentOfPath,
  callerOf,
  exeName,
  GONE_SAID,
  owners,
  parseLsofPeers,
  parseNetstat,
  PeerLookup,
  remoteCaller,
  type Found,
} from '../server/callers.ts'
import { parsePs } from '../server/trafficProcesses.ts'
import { receivedRow, tag } from '../server/traffic.ts'

/*
 * Who sent a request the host received (protocol 2.25.0): the client's port → the pid at that end
 * (netstat, else lsof) → its parents (ps) → the nearest owner this host knows, named in a person's
 * words. Every program here is stubbed: nothing runs.
 */

const HOST_PORT = 4180
const SELF = 500

/* macOS 15's `netstat -anv -p tcp`: the client end of each connection to the host, and the host's own ends. */
const NETSTAT = [
  'Active Internet connections (including servers)',
  'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs',
  'tcp4       0      0  127.0.0.1.4180         127.0.0.1.51001        ESTABLISHED         1678          244  407552  146988              bun:500  00102 00000004 0000000003756a25 00000081 01000800      2      0 000000',
  'tcp4       0      0  127.0.0.1.51001        127.0.0.1.4180         ESTABLISHED          540          787  408128  146988              bun:601  00102 00020000 0000000003756a24 10180081 04080900      2      0 000000',
  'tcp4       0      0  127.0.0.1.51002        127.0.0.1.4180         ESTABLISHED          540          787  408128  146988             curl:902  00102 00020000 0000000003756a24 10180081 04080900      2      0 000000',
  'tcp4       0      0  127.0.0.1.51003        127.0.0.1.4180         ESTABLISHED          540          787  408128  146988          2.1.310:950  00102 00020000 0000000003756a24 10180081 04080900      2      0 000000',
  'tcp4       0      0  127.0.0.1.51004        127.0.0.1.4180         ESTABLISHED          540          787  408128  146988           claude:611  00102 00020000 0000000003756a24 10180081 04080900      2      0 000000',
  'tcp4       0      0  127.0.0.1.51005        127.0.0.1.4180         ESTABLISHED          540          787  408128  146988 Google Chrome He:700  00102 00020000 0000000003756a24 10180081 04080900      2      0 000000',
  'tcp6       0      0  ::1.51006              ::1.4180               ESTABLISHED          540          787  408128  146988              bun:801  00102 00020000 0000000003756a24 10180081 04080900      2      0 000000',
  'tcp4       0      0  127.0.0.1.51007        127.0.0.1.4180         ESTABLISHED          540          787  408128  146988           Kehikot:400  00102 00020000 0000000003756a24 10180081 04080900      2      0 000000',
  'tcp46      0      0  *.8021                 *.*                    LISTEN                 0            0  131072  131072              bun:801  00000 00000006 0000000003756e3e 00000000 00000800      1      0 000000',
  'tcp4       0      0  127.0.0.1.4180         *.*                    LISTEN                 0            0  131072  131072              bun:500  00000 00000006 0000000003756e3e 00000000 00000800      1      0 000000',
].join('\n')

/*
 * 400 Kehikot (the desktop app) → 500 the host. 600 a module the host started (Paper, its group
 * 600) → 601 its server, and 610 a module the host started (Claude) → 611 `claude`, a session.
 * 800 zsh in a terminal → 801 a module started by hand (Notes, listening on 8021) → 802 under it;
 * 800 also ran 803, the same group, which is not the module's. 900 zsh → 902 curl. 940 zsh → 950
 * Claude Code (named by its version). 700 Chrome, under launchd.
 */
const PS = [
  '    1     0     1 launchd',
  '  400     1   400 Kehikot',
  '  500   400   500 bun',
  '  600   500   600 sh',
  '  601   600   600 bun',
  '  610   500   610 sh',
  '  611   610   610 claude',
  '  700     1   700 Google Chrome He',
  '  800     1   800 -zsh',
  '  801   800   801 bun',
  '  802   801   801 esbuild',
  '  803   800   801 node',
  '  900     1   900 zsh',
  '  902   900   900 curl',
  '  940     1   940 zsh',
  '  950   940   950 2.1.310',
].join('\n')

function stubbed(over: Partial<Record<string, string | null>> = {}) {
  const ran: string[][] = []
  const run = async (argv: string[]) => {
    ran.push(argv)
    const key = argv[0]!
    if (key === 'lsof' && argv.includes('txt')) return over.txt ?? (argv.includes('950') ? 'p950\nftxt\nn/Users/me/.local/share/claude/versions/2.1.310\n' : null)
    if (key in over) return over[key] ?? null
    if (key === 'netstat') return NETSTAT
    if (key === 'ps') return PS
    return null
  }
  const lookup = new PeerLookup({
    run,
    port: HOST_PORT,
    self: SELF,
    netstat: true,
    started: () => [
      { module: 'kehikot.paper', pid: 600, group: true },
      { module: 'kehikot.claude', pid: 610, group: true },
    ],
    unstarted: () => [{ module: 'kehikot.notes', port: 8021 }],
  })
  return { lookup, ran }
}

const NAMES = { paper: 'Paper', claude: 'Claude', notes: 'Notes' } as Record<string, string>
const names = { module: (id: string) => NAMES[id.replace('kehikot.', '')] ?? id }

describe('reading who holds a connection', () => {
  test('netstat: each connection to the host by the client’s port, with its pid; names with spaces; listeners', () => {
    const rows = parseNetstat(NETSTAT)
    expect(rows.find((row) => row.localPort === 51002)).toMatchObject({ remotePort: HOST_PORT, pid: 902, state: 'ESTABLISHED' })
    expect(rows.find((row) => row.localPort === 51005)!.pid).toBe(700)
    expect(rows.find((row) => row.localPort === 51006)).toMatchObject({ localHost: '::1', pid: 801 })
    expect(rows.find((row) => row.localPort === 8021)).toMatchObject({ state: 'LISTEN', pid: 801 })
  })

  test('an older netstat, with the pid as a number after the windows', () => {
    const old = 'tcp4       0      0  127.0.0.1.51002        127.0.0.1.4180         ESTABLISHED 408128  146988    902      0 00102 00000000'
    expect(parseNetstat(old)[0]).toMatchObject({ localPort: 51002, pid: 902 })
  })

  test('lsof, where netstat says no pids', () => {
    expect(parseLsofPeers('p902\nn127.0.0.1:51002->127.0.0.1:4180\np500\nn127.0.0.1:4180->127.0.0.1:51002\n')[0]).toMatchObject({ localPort: 51002, remotePort: 4180, pid: 902 })
  })
})

describe('owners', () => {
  test('a module the host started is its whole group; one started by hand is what is under its listener; the desktop app is Kehikot', () => {
    const owner = owners(parsePs(PS), [{ module: 'kehikot.paper', pid: 600, group: true }, { module: 'kehikot.notes', pid: 801, group: false }], SELF)
    expect(owner.get(601)).toBe('kehikot.paper')
    expect(owner.get(802)).toBe('kehikot.notes')
    /* In the group of the terminal job, not under the module: not the module's. */
    expect(owner.has(803)).toBe(false)
    expect(owner.has(800)).toBe(false)
    expect(owner.get(500)).toBe('kehikko')
    expect(owner.get(400)).toBe('kehikko')
  })

  test('a host started from a terminal, or by a script runner, does not make the terminal Kehikot', () => {
    const fromShell = parsePs('  1 0 1 launchd\n 90 1 90 zsh\n 500 90 500 bun\n')
    expect(owners(fromShell, [], SELF).has(90)).toBe(false)
    const fromNode = parsePs('  1 0 1 launchd\n 90 1 90 node\n 500 90 500 bun\n')
    expect(owners(fromNode, [], SELF).has(90)).toBe(false)
  })
})

describe('peer port → pid → owner', () => {
  test('a module the host started', async () => {
    const { lookup } = stubbed()
    const found = await lookup.find(51001)
    expect(found).toEqual({ pid: 601, exe: 'bun', parent: 'sh', owner: 'kehikot.paper' })
    expect(callerOf(found, names)).toMatchObject({ kind: 'module', name: 'Paper', how: 'process', process: 'bun', pid: 601 })
  })

  test('a module started by hand, found by the process on its registered port', async () => {
    const { lookup } = stubbed()
    expect(callerOf(await lookup.find(51006), names)).toMatchObject({ kind: 'module', name: 'Notes', how: 'process' })
  })

  test('an agent session a module started: "Claude session", and on its place when it has one', async () => {
    const { lookup } = stubbed()
    const found = await lookup.find(51004)
    expect(callerOf(found, names)).toMatchObject({ kind: 'session', name: 'Claude session', process: 'claude', parent: 'sh' })
    expect(callerOf(found, { ...names, place: 'Wide · methods' })).toMatchObject({ kind: 'session', name: 'Claude session on Wide · methods', place: 'Wide · methods' })
  })

  test('curl from a terminal: its name and its shell', async () => {
    const { lookup } = stubbed()
    expect(callerOf(await lookup.find(51002), names)).toEqual({ kind: 'program', name: 'curl, from your terminal (zsh)', how: 'process', process: 'curl', parent: 'zsh', pid: 902 })
  })

  test('Claude Code named by its version is told by its executable’s path, and is outside Kehikot', async () => {
    const { lookup, ran } = stubbed()
    const found = await lookup.find(51003)
    expect(found!.exe).toBe('claude')
    expect(callerOf(found, names)).toMatchObject({ kind: 'program', name: 'Claude Code, started outside Kehikot', process: 'claude', parent: 'zsh' })
    expect(ran.some((argv) => argv[0] === 'lsof' && argv.includes('txt') && argv.includes('950'))).toBe(true)
  })

  test('a program under launchd: its name alone', async () => {
    const { lookup } = stubbed()
    expect(callerOf(await lookup.find(51005), names)).toMatchObject({ kind: 'program', name: 'Google Chrome He' })
  })

  test('the desktop app is Kehikot', async () => {
    const { lookup } = stubbed()
    expect(callerOf(await lookup.find(51007), names)).toMatchObject({ kind: 'host', name: 'Kehikot', how: 'process' })
  })

  test('a connection already closed: a program that closed before it could be named', async () => {
    const { lookup } = stubbed()
    expect(await lookup.find(59999)).toBeNull()
    expect(callerOf(null, names)).toEqual({ kind: 'gone', name: GONE_SAID, how: 'closed' })
  })

  test('a pid that exited between the two listings is gone too', async () => {
    const { lookup } = stubbed({ ps: '    1     0     1 launchd\n  500     1   500 bun\n' })
    expect(await lookup.find(51002)).toBeNull()
  })

  test('cheap: one netstat for lookups asked together, none for a connection already known, ps kept', async () => {
    const { lookup, ran } = stubbed()
    await Promise.all([lookup.find(51001), lookup.find(51002), lookup.find(51006)])
    await lookup.find(51001)
    expect(ran.filter((argv) => argv[0] === 'netstat').length).toBeLessThanOrEqual(2)
    const before = ran.filter((argv) => argv[0] === 'netstat').length
    expect(lookup.known(51001)).toBe(true)
    await lookup.find(51001)
    expect(ran.filter((argv) => argv[0] === 'netstat').length).toBe(before)
  })

  test('without netstat, lsof for the host’s port', async () => {
    const { lookup, ran } = stubbed({ netstat: null, lsof: 'p902\nn127.0.0.1:51002->127.0.0.1:4180\n' })
    expect((await lookup.find(51002))?.exe).toBe('curl')
    expect(ran.some((argv) => argv[0] === 'lsof' && argv.includes(`-iTCP:${HOST_PORT}`))).toBe(true)
  })

  test('never a command line: ps is asked for the accounting name only, lsof only for the executable', async () => {
    const { lookup, ran } = stubbed()
    await Promise.all([lookup.find(51002), lookup.find(51003)])
    const ps = ran.filter((one) => one[0] === 'ps')
    expect(ps.length).toBeGreaterThan(0)
    for (const argv of ps) expect(argv).toEqual(['ps', '-A', '-o', 'pid=,ppid=,pgid=,ucomm='])
    for (const argv of ran) expect(argv.join(' ')).not.toMatch(/\bcomm=|\bargs\b|\bcommand\b/)
    for (const argv of ran.filter((one) => one[0] === 'lsof')) expect(argv).toEqual(['lsof', '-a', '-p', '950', '-d', 'txt', '-F', 'n'])
    expect(exeName('/usr/bin/curl')).toBe('curl')
    expect(exeName('-zsh')).toBe('zsh')
    expect(exeName('x'.repeat(80)).length).toBe(LIMITS.TRAFFIC_KIND)
  })

  test('the executable’s path says only which agent it is', () => {
    expect(agentOfPath('/Users/me/.local/share/claude/versions/2.1.310')).toBe('claude')
    expect(agentOfPath('/opt/homebrew/bin/codex')).toBe('codex')
    expect(agentOfPath('/usr/local/bin/node')).toBeNull()
    const caller = callerOf({ pid: 9, exe: 'claude', parent: 'zsh', owner: null }, names)
    expect(JSON.stringify(caller)).not.toContain('/Users/')
  })
})

describe('the row of a received request names its caller', () => {
  const from = { pageOrigins: ['http://127.0.0.1:4181'], moduleAt: (origin: string) => (origin === 'http://127.0.0.1:8031' ? 'kehikot.paper' : null), nameOf: names.module }
  const ok = new Response('{}', { status: 200 })
  const at = (path: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:4180${path}`, init)

  test('the page, by its origin: Kehikot', () => {
    expect(receivedRow(at('/host/health', { headers: { origin: 'http://127.0.0.1:4181' } }), ok, 1, 1, from, { address: '127.0.0.1', port: 1 })).toMatchObject({ by: 'kehikko', via: 'page', caller: { kind: 'host', name: 'Kehikot', how: 'origin' } })
  })

  test('a module’s page, by the module’s origin', () => {
    expect(receivedRow(at('/host/hello', { headers: { origin: 'http://127.0.0.1:8031' } }), ok, 1, 1, from, { address: '127.0.0.1', port: 1 })).toMatchObject({ by: 'kehikot.paper', via: 'page', caller: { kind: 'module', name: 'Paper', how: 'origin' } })
  })

  test('a module’s server the route named', () => {
    const request = at('/host/server-ask', { method: 'POST' })
    tag(request, { by: 'kehikot.paper', via: 'server', reason: 'epics.list' })
    expect(receivedRow(request, ok, 1, 1, from, { address: '127.0.0.1', port: 1 })).toMatchObject({ by: 'kehikot.paper', caller: { kind: 'module', name: 'Paper', how: 'route' } })
  })

  test('an MCP call with a place token: that conversation’s session, even with no process found', () => {
    const request = at('/mcp?kehikot-place=abcdefghijklmnopqrstuvwxyz', { method: 'POST' })
    tag(request, { by: 'kehikot.claude', via: 'process', caller: { kind: 'session', name: 'Claude session on Wide · methods', how: 'token', place: 'Wide · methods' } })
    const row = receivedRow(request, ok, 1, 1, from, { address: '127.0.0.1', port: 1 }, undefined)
    expect(row).toMatchObject({ by: 'kehikot.claude', via: 'process', caller: { kind: 'session', name: 'Claude session on Wide · methods', how: 'token' } })
    expect(row!.path).not.toContain('abcdefghijklmnopqrstuvwxyz')
    const found: Found = { pid: 611, exe: 'claude', parent: 'sh', owner: 'kehikot.claude' }
    expect(receivedRow(request, ok, 1, 1, from, { address: '127.0.0.1', port: 1 }, found)!.caller).toMatchObject({ how: 'token', process: 'claude', pid: 611 })
  })

  test('an MCP session recorded with set_my_place, outside Kehikot: the program, on its place', () => {
    const request = at('/mcp', { method: 'POST' })
    tag(request, { place: 'Wide · methods' })
    expect(receivedRow(request, ok, 1, 1, from, { address: '127.0.0.1', port: 1 }, { pid: 950, exe: 'claude', parent: 'zsh', owner: null })).toMatchObject({
      by: '',
      via: 'process',
      caller: { kind: 'program', name: 'Claude Code, started outside Kehikot, on Wide · methods', place: 'Wide · methods' },
    })
  })

  test('another computer, by its address', () => {
    expect(receivedRow(at('/host/health'), ok, 1, 1, from, { address: '192.168.1.20', port: 1 })).toMatchObject({ by: '', caller: { kind: 'remote', name: 'Another computer (192.168.1.20)', how: 'address' } })
    expect(remoteCaller('::ffff:10.0.0.2').name).toBe('Another computer (10.0.0.2)')
  })

  test('a program that closed before it could be named; and never "unknown"', () => {
    const row = receivedRow(at('/host/health'), ok, 1, 1, from, null, null)
    expect(row).toMatchObject({ by: '', caller: { kind: 'gone', name: 'A program that closed before it could be named', how: 'closed' } })
    expect(JSON.stringify(row).toLowerCase()).not.toContain('unknown')
  })
})
