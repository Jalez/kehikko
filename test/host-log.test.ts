import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkAddresses, checkedLine, resetAddressCheck, whyFramed } from '@/host/addressCheck.ts'
import { addressOnly, areaOfMessage, formatLine, LINE_MAX, redact, REDACTED, timeOf } from '@/host/logLine.ts'
import { BATCH_LINES, capturePage, decide, flushPageLog, pendingPageLog, resetPageLog, type PageLine } from '@/host/pageLog.ts'
import { PAGE_ONLY, own, refusal } from '../server/guard.ts'
import { HostLog, lastLines, LogFile } from '../server/hostLog.ts'
import { hostLogFile, logsDir, pageLogFile } from '../server/machineDirs.ts'
import { call, mcp } from '../server/mcp.ts'
import { logFile } from '../server/moduleLog.ts'
import { BATCH_MAX, BODY_MAX, PageLog, PER_MINUTE } from '../server/pageLog.ts'
import { diagnostics, LINES_MAX, readLogs, sinceIn } from '../server/readLogs.ts'

/**
 * Kehikot's own logs: the host's (`host.log`), the page's (`page.log`), and
 * reading them back (`read_logs`, "Copy recent diagnostics").
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kehikot-logs-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetPageLog()
  resetAddressCheck()
})

const AT = new Date('2026-11-13T09:41:02.118Z')

describe('where the logs are', () => {
  test('beside the modules’ logs, moved by KEHIKOT_LOGS_DIR', () => {
    expect(hostLogFile({ KEHIKOT_LOGS_DIR: '/x' })).toBe('/x/host.log')
    expect(pageLogFile({ KEHIKOT_LOGS_DIR: '/x' })).toBe('/x/page.log')
    expect(hostLogFile({ HOME: '/Users/a' }, 'darwin')).toBe('/Users/a/Library/Logs/Kehikot/host.log')
  })

  test('the tests’ own: never under the real home', () => {
    expect(hostLogFile().startsWith(logsDir())).toBe(true)
    expect(logsDir()).not.toContain(join('Library', 'Logs', 'Kehikot'))
  })
})

describe('the line', () => {
  test('ISO time, level, area, message — one line', () => {
    expect(formatLine({ at: AT, level: 'warn', area: 'addresses', message: 'not used' })).toBe('2026-11-13T09:41:02.118Z WARN  [addresses] not used')
    expect(formatLine({ at: AT, level: 'info', area: 'start', message: 'a\nb\r\nc' })).toBe('2026-11-13T09:41:02.118Z INFO  [start] a ⏎ b ⏎ c')
    expect(formatLine({ at: AT, level: 'error', area: 'x', message: '\u001b[31mred\u001b[0m' })).toBe('2026-11-13T09:41:02.118Z ERROR [x] red')
    expect(formatLine({ at: AT, level: 'info', area: 'x', message: 'y'.repeat(10_000) }).length).toBe(LINE_MAX)
    expect(timeOf(formatLine({ at: AT, level: 'info', area: 'x', message: 'y' }))).toBe(AT.getTime())
  })

  test('the area a host line names', () => {
    expect(areaOfMessage('kehikko: module addresses: the page could not')).toEqual({ area: 'module addresses', message: 'the page could not' })
    expect(areaOfMessage('kehikko: kehikot.example stopped again')).toEqual({ area: 'host', message: 'kehikot.example stopped again' })
    expect(areaOfMessage('plain words')).toEqual({ area: 'host', message: 'plain words' })
  })

  test('an address is named by its origin and path, never its query', () => {
    expect(addressOnly('http://127.0.0.1:7920/app?pass=abc&theme=dark#x')).toBe('http://127.0.0.1:7920/app')
  })
})

describe('rotation', () => {
  test('at the bound the file moves to .1, .1 to .2, and the oldest goes', () => {
    const file = join(dir, 'host.log')
    const log = new LogFile(file, { maxBytes: 100, keep: 3 })
    for (let n = 0; n < 20; n++) log.write(`line ${String(n).padStart(2, '0')} ${'x'.repeat(30)}`)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(existsSync(`${file}.2`)).toBe(true)
    expect(existsSync(`${file}.3`)).toBe(false)
    for (const one of [file, `${file}.1`, `${file}.2`]) expect(statSync(one).size).toBeLessThanOrEqual(100)
    /* The newest lines are in the newest file, and reading back crosses files in order. */
    expect(readFileSync(file, 'utf8')).toContain('line 19')
    const back = lastLines(file, 4)
    expect(back.map((line) => line.slice(0, 7))).toEqual(['line 16', 'line 17', 'line 18', 'line 19'])
  })

  test('a file already there counts toward the bound', () => {
    const file = join(dir, 'host.log')
    writeFileSync(file, `${'o'.repeat(90)}\n`)
    new LogFile(file, { maxBytes: 100 }).write('new line that does not fit')
    expect(readFileSync(`${file}.1`, 'utf8')).toStartWith('ooo')
    expect(readFileSync(file, 'utf8')).toBe('new line that does not fit\n')
  })

  test('5 MB × 3 by default', () => {
    const log = new LogFile(join(dir, 'a.log'))
    expect(log.maxBytes).toBe(5 * 1024 * 1024)
    expect(log.keep).toBe(3)
  })
})

describe('the host’s log', () => {
  test('console calls go to the file with their level and area; the start line says versions, pid and port', () => {
    const file = join(dir, 'host.log')
    const log = new HostLog(file, { now: () => AT })
    const printed: unknown[][] = []
    const fake = { log: (...a: unknown[]) => printed.push(a), info: (...a: unknown[]) => printed.push(a), warn: (...a: unknown[]) => printed.push(a), error: (...a: unknown[]) => printed.push(a), debug: (...a: unknown[]) => printed.push(a) }
    const restore = log.captureConsole(fake)
    log.started({ app: '0.7.9', host: '0.1.0', protocol: '2.93.0', pid: 42, port: 4170, bundled: true })
    fake.log('kehikko: module addresses: frames keep their ports')
    fake.warn('careful', { n: 1 })
    fake.error(new Error('boom'))
    restore()
    fake.log('after restore')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines[0]).toBe('2026-11-13T09:41:02.118Z INFO  [start] --- Kehikot host started: app 0.7.9, host 0.1.0, protocol 2.93.0, pid 42, port 4170, bundled ---')
    expect(lines[1]).toBe('2026-11-13T09:41:02.118Z INFO  [module addresses] frames keep their ports')
    expect(lines[2]).toBe('2026-11-13T09:41:02.118Z WARN  [host] careful {"n":1}')
    expect(lines[3]).toStartWith('2026-11-13T09:41:02.118Z ERROR [host] Error: boom at ')
    expect(lines).toHaveLength(4)
    /* And it still printed where it always did. */
    expect(printed).toHaveLength(4)
  })

  test('an uncaught error or rejection is written, then the process ends as it would have', () => {
    const file = join(dir, 'host.log')
    const log = new HostLog(file, { now: () => AT })
    const handlers = new Map<string, (error: unknown) => void>()
    const ended: unknown[] = []
    log.captureCrashes((event, handler) => handlers.set(event, handler), (error) => ended.push(error))
    handlers.get('uncaughtException')!(new TypeError('x is not a function'))
    handlers.get('unhandledRejection')!('no reason')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('ERROR [uncaught] TypeError: x is not a function')
    expect(text).toContain('ERROR [unhandled rejection] no reason')
    expect(ended).toHaveLength(2)
  })
})

describe('the page’s log at the host', () => {
  const body = (lines: unknown[]) => JSON.stringify({ lines })
  const line = (message: string, level = 'warn', area = 'console') => ({ level, area, message, at: AT.getTime() })

  test('lines are written in the same shape, the area scrubbed', () => {
    const file = join(dir, 'page.log')
    const log = new PageLog(file, { now: () => AT.getTime() })
    expect(log.take(body([line('a warning'), line('chose', 'info', 'Frames<script>')]))).toEqual({ ok: true, taken: 2, dropped: 0 })
    expect(readFileSync(file, 'utf8')).toBe('2026-11-13T09:41:02.118Z WARN  [console] a warning\n2026-11-13T09:41:02.118Z INFO  [framesscript] chose\n')
  })

  test('bounded: a body, a batch, a line', () => {
    const log = new PageLog(join(dir, 'page.log'), { now: () => AT.getTime() })
    expect(log.take('x'.repeat(BODY_MAX + 1))).toMatchObject({ ok: false, status: 413 })
    expect(log.take(body(Array.from({ length: BATCH_MAX + 1 }, () => line('x'))))).toMatchObject({ ok: false, status: 413 })
    expect(log.take('not json')).toMatchObject({ ok: false, status: 400 })
    expect(log.take(body([line('x'.repeat(5_000))]))).toMatchObject({ ok: true, taken: 1 })
    expect(readFileSync(join(dir, 'page.log'), 'utf8').length).toBeLessThan(1_100)
    /* A line with no level or message is skipped, not written. */
    expect(log.take(body([{ message: 'no level' }, { level: 'warn' }, { level: 'shout', message: 'x' }]))).toEqual({ ok: true, taken: 0, dropped: 0 })
  })

  test('rate-limited: past the minute’s budget lines are dropped and counted once', () => {
    let now = AT.getTime()
    const file = join(dir, 'page.log')
    const log = new PageLog(file, { now: () => now })
    let taken = 0
    let dropped = 0
    for (let n = 0; n < 5; n++) {
      const said = log.take(body(Array.from({ length: 100 }, (_, i) => line(`line ${n}-${i}`))))
      if (!said.ok) throw new Error('refused')
      taken += said.taken
      dropped += said.dropped
    }
    expect(taken).toBe(PER_MINUTE)
    expect(dropped).toBe(500 - PER_MINUTE)
    now += 60_000
    expect(log.take(body([line('next minute')]))).toEqual({ ok: true, taken: 1, dropped: 0 })
    const text = readFileSync(file, 'utf8')
    expect(text).toContain(`[log] ${500 - PER_MINUTE} lines from the page were dropped: more than ${PER_MINUTE} a minute.`)
    expect(text.trim().split('\n')).toHaveLength(PER_MINUTE + 2)
  })

  test('the route is the page’s alone: in PAGE_ONLY, the page let through, a frame, a site and a program refused', () => {
    const PAGE = 'http://127.0.0.1:4181'
    const SELF = own({}, 4180, [PAGE])
    const ask = (pathname: string, headers: Record<string, string>) => refusal({ method: 'POST', pathname, headers: new Headers({ host: '127.0.0.1:4180', ...headers }) }, SELF)
    const json = { 'content-type': 'application/json', 'content-length': '2' }
    for (const route of ['/host/log', '/host/logs/open']) {
      expect(PAGE_ONLY).toContain(route)
      expect(ask(route, { origin: PAGE, ...json })).toBeNull()
      for (const headers of [{ origin: 'http://127.0.0.1:4300', ...json }, { origin: 'https://example.org', ...json }, { ...json }]) {
        expect(ask(route, headers)?.status).toBe(403)
      }
      /* And not as a form: the page's log is JSON. */
      expect(ask(route, { origin: PAGE, 'content-type': 'text/plain', 'content-length': '2' })).not.toBeNull()
    }
  })
})

describe('the page’s side', () => {
  test('lines wait, then go in batches; pagehide sends with keepalive', () => {
    const sent: Array<{ lines: PageLine[]; keepalive: boolean }> = []
    resetPageLog({ post: (lines, keepalive) => sent.push({ lines, keepalive }), now: () => AT.getTime() })
    const listeners = new Map<string, (event: never) => void>()
    const printed: unknown[] = []
    const target = {
      console: { warn: (...a: unknown[]) => printed.push(a), error: (...a: unknown[]) => printed.push(a) },
      addEventListener: (type: string, listener: (event: never) => void) => listeners.set(type, listener),
    }
    capturePage(target)
    target.console.warn('a warning')
    target.console.error(new Error('broke'))
    decide('frames', 'kehikot.example: framed at http://127.0.0.1:7920/app — its own port')
    expect(pendingPageLog()).toHaveLength(3)
    expect(sent).toHaveLength(0)
    listeners.get('unhandledrejection')!({ reason: new Error('nobody caught') } as never)
    listeners.get('pagehide')!({} as never)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.keepalive).toBe(true)
    expect(sent[0]!.lines.map((one) => [one.level, one.area])).toEqual([
      ['warn', 'console'],
      ['error', 'console'],
      ['info', 'frames'],
      ['error', 'unhandled rejection'],
    ])
    expect(printed).toHaveLength(2)
    for (let n = 0; n < BATCH_LINES; n++) decide('x', `line ${n}`)
    expect(sent).toHaveLength(2)
    expect(sent[1]!.keepalive).toBe(false)
  })
})

describe('the decision lines for the stable-address check', () => {
  const SAID = { on: true, frames: true, check: { url: 'http://at--self-check.kehikot.localhost:4170/.well-known/kehikot-host-check', host: 'nonce' } }
  const fake = (check: () => Response | Promise<Response>, said: unknown = SAID): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/host/module-addresses') return Response.json(said)
      if (url === '/host/module-addresses/check') return Response.json({ ok: true })
      return check()
    }) as typeof fetch
  const clock = () => {
    let t = 1_000
    return () => (t += 37)
  }

  test('usable: the result, how long it took and its timeout', async () => {
    const said: Array<[string, string]> = []
    await checkAddresses(fake(() => Response.json({ host: 'nonce' })), (area, message) => said.push([area, message]), clock())
    expect(said).toEqual([['addresses', 'stable addresses usable: the check address answered as this host after 37 ms (timeout 2500 ms); frames go on /m/<id>/ addresses']])
    expect(whyFramed({ address: 'http://example.kehikot.localhost:4170' })).toBe('its stable address: the check passed')
    expect(whyFramed({})).toBe('its own port: the host gave this module no stable address')
  })

  test('not usable: why, how long and the timeout; a frame says the same reason', async () => {
    const said: Array<[string, string]> = []
    await checkAddresses(fake(() => Promise.reject(new TypeError('Could not connect'))), (area, message) => said.push([area, message]), clock())
    expect(said).toHaveLength(1)
    expect(said[0]![0]).toBe('addresses')
    expect(said[0]![1]).toStartWith('stable addresses not used after 37 ms (timeout 2500 ms); frames stay on their modules\' own ports: ')
    expect(said[0]![1]).toContain('could not be reached')
    expect(whyFramed({ address: 'http://example.kehikot.localhost:4170' })).toContain('could not be reached')
  })

  test('before it finishes, a frame says so', () => {
    expect(whyFramed({ address: 'http://example.kehikot.localhost:4170' })).toBe('its own port: the stable-address check has not finished')
    expect(checkedLine({ usable: false, why: null }, 5)).toContain('the host has them off, or did not say')
  })

  test('the default goes to the page log', async () => {
    const sent: PageLine[] = []
    resetPageLog({ post: (lines) => sent.push(...lines) })
    await checkAddresses(fake(() => Response.json({ host: 'nonce' })))
    flushPageLog()
    expect(sent.map((one) => one.area)).toEqual(['addresses'])
  })
})

describe('privacy', () => {
  /* Secrets as they could turn up in a line: a query, a header someone printed, JSON, a URL's user part, prefixed tokens. */
  const SECRETS = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'sk-ant-abcdefghijklmnopqrstuvwx',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'hunter2-very-secret',
    'S3ss10nC00k1eValue',
    'pass-0123456789abcdef',
  ]
  const FLOWS = [
    `kehikko: fetching http://127.0.0.1:7920/app?pass=${SECRETS[6]}&theme=dark`,
    `kehikko: github: asked with Authorization: Bearer ${SECRETS[0]}`,
    `request headers {"authorization":"token ${SECRETS[1]}","cookie":"sid=${SECRETS[5]}"}`,
    `kehikko: install: cloning https://someone:${SECRETS[4]}@example.org/owner/repo.git`,
    `an agent key ${SECRETS[2]} was in the environment`,
    `session token=${SECRETS[3]}`,
    `password: ${SECRETS[4]}`,
    `Set-Cookie: session=${SECRETS[5]}; Path=/`,
  ]
  const SECRETISH = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_/, /sk-[A-Za-z0-9_-]{16,}/, /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, /(token|password|pass|cookie|authorization|session|sid)\s*[=:]\s*"?(?!\[redacted\])[A-Za-z0-9]/i, /:\/\/[^/\s:@]+:[^/\s@]+@/]

  const scan = (text: string) => {
    for (const secret of SECRETS) expect(text).not.toContain(secret)
    for (const line of text.split('\n')) for (const pattern of SECRETISH) expect({ line, hit: pattern.test(line) }).toEqual({ line, hit: false })
  }

  test('the host’s log, from typical flows, holds no secret', () => {
    const file = join(dir, 'host.log')
    const log = new HostLog(file, { now: () => AT })
    const fake = { log(..._: unknown[]) {}, info(..._: unknown[]) {}, warn(..._: unknown[]) {}, error(..._: unknown[]) {}, debug(..._: unknown[]) {} }
    log.captureConsole(fake)
    log.started({ app: '0.7.9', host: '0.1.0', protocol: '2.93.0', pid: 1, port: 4170, bundled: true })
    for (const flow of FLOWS) fake.log(flow)
    fake.error(new Error(`failed with ${SECRETS[0]}`))
    log.captureCrashes((event, handler) => event === 'unhandledRejection' && handler(new Error(`rejected: token=${SECRETS[3]}`)), () => {})
    const text = readFileSync(file, 'utf8')
    expect(text).toContain(REDACTED)
    expect(text).toContain('http://127.0.0.1:7920/app')
    scan(text)
  })

  test('the page’s log, from typical flows, holds no secret — scrubbed on the page and again at the host', () => {
    const sent: PageLine[] = []
    resetPageLog({ post: (lines) => sent.push(...lines), now: () => AT.getTime() })
    const target = { console: { warn(..._: unknown[]) {}, error(..._: unknown[]) {} }, addEventListener() {} }
    capturePage(target)
    for (const flow of FLOWS) target.console.warn(flow)
    decide('frames', `kehikot.example: framed at ${addressOnly(`http://127.0.0.1:7920/app?pass=${SECRETS[6]}`)} — its own port`)
    decide('press', 'restart kehikot.example pressed')
    flushPageLog()
    scan(JSON.stringify(sent))
    /* And what reached the host unscrubbed is scrubbed as it is written. */
    const file = join(dir, 'page.log')
    const log = new PageLog(file, { now: () => AT.getTime() })
    log.take(JSON.stringify({ lines: FLOWS.map((message) => ({ level: 'warn', area: 'console', message })) }))
    scan(readFileSync(file, 'utf8'))
  })

  test('a module’s own output is scrubbed as it is read', () => {
    const file = logFile('kehikot.example', dir)
    mkdirSync(join(dir, 'modules'), { recursive: true })
    writeFileSync(file, `--- kehikko started this at ${AT.toISOString()} ---\n${FLOWS.join('\n')}\n`)
    const read = readLogs({ which: 'module', module: 'kehikot.example', lines: 50 }, { dir })
    if (!read.ok) throw new Error(read.why)
    scan(read.text)
  })

  test('redact keeps what is not a secret', () => {
    const plain = 'kehikot.example: framed at http://example.kehikot.localhost:4170/app — its stable address, commit 0123456789abcdef0123456789abcdef01234567'
    expect(redact(plain)).toBe(plain)
  })
})

describe('read_logs', () => {
  const host = () => {
    const log = new LogFile(join(dir, 'host.log'))
    for (let n = 0; n < 1_000; n++) log.write(formatLine({ at: new Date(AT.getTime() + n * 1000), level: n % 10 === 0 ? 'warn' : 'info', area: 'host', message: `line ${n}` }))
  }

  test('bounded: at most 400 lines, 100 by default', () => {
    host()
    const all = readLogs({ which: 'host' }, { dir })
    if (!all.ok) throw new Error(all.why)
    expect(all.lines).toHaveLength(100)
    expect(all.lines.at(-1)).toContain('line 999')
    const most = readLogs({ which: 'host', lines: LINES_MAX }, { dir })
    expect(most.ok && most.lines.length).toBe(LINES_MAX)
    for (const lines of [0, LINES_MAX + 1, 1.5, '10', -1]) expect(readLogs({ which: 'host', lines }, { dir }).ok).toBe(false)
  })

  test('grep and since filter; a bad one is refused in a sentence', () => {
    host()
    const warns = readLogs({ which: 'host', grep: 'WARN', lines: 400 }, { dir })
    expect(warns.ok && warns.lines.length).toBe(100)
    const recent = readLogs({ which: 'host', since: new Date(AT.getTime() + 990_000).toISOString() }, { dir })
    expect(recent.ok && recent.lines.length).toBe(10)
    expect(readLogs({ which: 'host', since: 'yesterday-ish' }, { dir })).toMatchObject({ ok: false })
    expect(readLogs({ which: 'host', grep: 'x'.repeat(201) }, { dir })).toMatchObject({ ok: false })
    expect(sinceIn('15m', 1_000_000)).toBe(100_000)
    expect(sinceIn('2h', 10_000_000)).toBe(10_000_000 - 7_200_000)
  })

  test('which file: the host’s, the page’s, or a module’s by a safe id — never a path', () => {
    expect(readLogs({ which: 'module' }, { dir }).ok).toBe(false)
    for (const module of ['../../etc/passwd', '/etc/passwd', 'a/b', '']) expect(readLogs({ which: 'module', module }, { dir }).ok).toBe(false)
    expect(readLogs({ which: 'everything' }, { dir }).ok).toBe(false)
    const page = readLogs({ which: 'page' }, { dir })
    expect(page.ok && page.file).toBe(join(dir, 'page.log'))
  })

  test('at the door: listed read-only, it reads and never writes', async () => {
    const db = new Database(':memory:')
    const door = { db, which: () => [], wake: () => {}, epicsChanged: () => {}, dispositionsChanged: () => {}, seen: async () => [] } as never
    const reply = await mcp({ id: 1, method: 'tools/list' }, door, { name: 'kehikko', version: '0.1.0' })
    const tool = (reply.body as { result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }> } }).result.tools.find((one) => one.name === 'read_logs')
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    /* The tests' logs folder (`test/setup.ts`): what is there is not changed by reading it. */
    const file = hostLogFile()
    mkdirSync(logsDir(), { recursive: true })
    writeFileSync(file, `${formatLine({ at: AT, level: 'info', area: 'start', message: 'started' })}\n`)
    const before = readFileSync(file, 'utf8')
    const read = await call('read_logs', { which: 'host', lines: 5 }, door)
    expect(read.failed).toBe(false)
    expect(read.text).toContain('[start] started')
    expect((await call('read_logs', { lines: 401 }, door)).failed).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(before)
    db.close()
  })
})

describe('diagnostics', () => {
  test('versions first, then the last lines of both logs', () => {
    new LogFile(join(dir, 'host.log')).write(formatLine({ at: AT, level: 'info', area: 'start', message: 'host up' }))
    new LogFile(join(dir, 'page.log')).write(formatLine({ at: AT, level: 'info', area: 'addresses', message: 'usable' }))
    const text = diagnostics({ app: '0.7.9', protocol: '2.93.0', missing: null }, { dir })
    expect(text).toContain('app: 0.7.9')
    expect(text).not.toContain('missing')
    expect(text).toContain('[start] host up')
    expect(text).toContain('[addresses] usable')
  })
})
