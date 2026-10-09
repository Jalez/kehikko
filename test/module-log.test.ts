import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RUN_SCRIPT, start } from '../server/launch.ts'
import { logsDir } from '../server/machineDirs.ts'
import { installing, lastRun, logFile, openRun, tail, trim } from '../server/moduleLog.ts'
import { chmodSync, mkdirSync } from 'node:fs'

/** What a module the host starts prints is kept, bounded, and read back for a failure and for an install. */

const made: string[] = []
function dir(): string {
  const path = join(tmpdir(), `kehikko-log-${process.pid}-${made.length}`)
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
  made.push(path)
  return path
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('where the log is', () => {
  test('under the machine’s logs, never in a project or a checkout, and overridable', () => {
    expect(logsDir({ HOME: '/Users/x' }, 'darwin')).toBe('/Users/x/Library/Logs/Kehikot')
    expect(logsDir({ HOME: '/home/x' }, 'linux')).toBe('/home/x/.local/share/kehikot/logs')
    expect(logsDir({ HOME: '/Users/x', KEHIKOT_LOGS_DIR: '/scratch/logs' }, 'darwin')).toBe('/scratch/logs')
    expect(logFile('kehikot.notes', '/scratch/logs')).toBe('/scratch/logs/modules/kehikot.notes.log')
    /* An id is a file name here, and nothing in it may climb out. */
    expect(logFile('../../etc/x', '/scratch/logs')).toBe('/scratch/logs/modules/.._.._etc_x.log')
  })
})

describe('one run', () => {
  test('starts at its header, and the tail is the last lines after it', () => {
    const file = join(dir(), 'modules', 'a.log')
    openRun(file)
    appendFileSync(file, 'old run line\n')
    openRun(file)
    appendFileSync(file, 'one\n\n\u001b[31mtwo in red\u001b[0m\r\nthree\n')
    expect(lastRun(file)).toEqual(['one', 'two in red', 'three'])
    expect(tail(file, 2)).toEqual(['two in red', 'three'])
    expect(readFileSync(file, 'utf8')).toContain('old run line')
  })

  test('a failure is quoted from the line that says what went wrong, not from the end of its stack', () => {
    const file = join(dir(), 'a.log')
    openRun(file)
    appendFileSync(file, ['starting', 'failed to load config from /x/vite.config.ts', 'Error: this server does not start', ...Array.from({ length: 20 }, (_, i) => `    at frame ${i}`)].join('\n') + '\n')
    expect(tail(file, 4)).toEqual(['failed to load config from /x/vite.config.ts', 'Error: this server does not start', '    at frame 0', '    at frame 1'])
  })

  test('a log that is not there reads as nothing', () => {
    const file = join(dir(), 'none.log')
    expect(tail(file)).toEqual([])
    expect(installing(file)).toBe(false)
    expect(trim(file)).toBe(false)
  })

  test('says it is installing when run.sh said so in THIS run, and not because an earlier one did', () => {
    const file = join(dir(), 'a.log')
    openRun(file)
    appendFileSync(file, 'installing…\nbun install v1.3\n')
    expect(installing(file)).toBe(true)
    openRun(file)
    appendFileSync(file, 'VITE ready in 300 ms\n')
    expect(installing(file)).toBe(false)
  })
})

describe('the bound', () => {
  test('a file past the limit is cut to its end, from a whole line', () => {
    const file = join(dir(), 'a.log')
    writeFileSync(file, Array.from({ length: 2000 }, (_, i) => `line ${String(i).padStart(4, '0')}`).join('\n') + '\n')
    const before = statSync(file).size
    expect(trim(file, 1000, 300)).toBe(true)
    const kept = readFileSync(file, 'utf8')
    expect(kept.length).toBeLessThanOrEqual(300)
    expect(kept.length).toBeLessThan(before)
    expect(kept.endsWith('line 1999\n')).toBe(true)
    expect(kept.startsWith('line ')).toBe(true)
    expect(trim(file, 1000, 300)).toBe(false)
  })

  test('every start trims first, so a module restarted for a year does not grow a log for a year', () => {
    const file = join(dir(), 'a.log')
    writeFileSync(file, 'x'.repeat(600 * 1024) + '\nlast\n')
    openRun(file)
    expect(statSync(file).size).toBeLessThan(200 * 1024)
    expect(lastRun(file)).toEqual([])
  })
})

describe('a script the host runs', () => {
  test('writes what it prints to the log, and the host is told when it ends and with what', async () => {
    const root = dir()
    const script = join(root, RUN_SCRIPT)
    writeFileSync(script, '#!/bin/sh\necho "installing…" >&2\necho "error: cannot find ./gone.ts" >&2\nexit 3\n')
    chmodSync(script, 0o755)
    const file = join(root, 'logs', 'a.log')
    openRun(file)
    const code = await new Promise<number | null>((ended) => {
      const ran = start({ dir: root, script, port: null, url: 'http://127.0.0.1:1', command: script, log: file }, ended)
      expect(ran.ok).toBe(true)
    })
    expect(code).toBe(3)
    expect(existsSync(file)).toBe(true)
    expect(tail(file)).toEqual(['installing…', 'error: cannot find ./gone.ts'])
    expect(installing(file)).toBe(true)
  })
})
