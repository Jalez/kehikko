import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/*
 * Work the host does on a timer is filed with a reason, so Monitor can say what is polling and why.
 * Monitor's record showed 927 of 2,837 calls in five minutes "carried no reason" (Jalez/kehikko#384):
 * module pages polling through the proxy, manifests asked before each forward, sweeps started from
 * callbacks. A repeating timer in `server/` either runs its work under `because(...)` or is named here
 * with the one line that says why it calls nothing (no network, no program).
 */

const SERVER = join(import.meta.dir, '..', 'server')

/** Timers whose work calls nothing outside this process, each with why. Keyed `file: the call's first line`. */
const QUIET_TIMERS: Record<string, string> = {
  'server.ts: setInterval(() => watchOpenProjects(), 60_000).unref?.()': 'points file watchers at the open projects: no network, no program',
  'server.ts: setInterval(() => followMoved(), FOLLOW_EVERY_MS).unref?.()': 'one stat per project; a moved one is relinked from its bookmark',
}

const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.ts$/.test(name) ? [path] : []
  })
}

/** Every `setInterval(` in the server: where, its first line, and its callback's text up to the interval. */
function timers(): Array<{ key: string; body: string }> {
  const out: Array<{ key: string; body: string }> = []
  for (const path of files(SERVER)) {
    const text = code(readFileSync(path, 'utf8'))
    for (let at = text.indexOf('setInterval('); at >= 0; at = text.indexOf('setInterval(', at + 1)) {
      /* The call's own text: up to the parenthesis that closes it. */
      let depth = 0
      let end = at + 'setInterval'.length
      for (; end < text.length; end += 1) {
        if (text[end] === '(') depth += 1
        else if (text[end] === ')' && --depth === 0) break
      }
      const line = text.slice(at, text.indexOf('\n', at)).trim()
      out.push({ key: `${relative(SERVER, path)}: ${line}`, body: text.slice(at, end + 1) })
    }
  }
  return out
}

describe('timers in the server', () => {
  test('finds them', () => {
    expect(timers().length).toBeGreaterThanOrEqual(3)
  })

  test('each one runs its work under a reason, or is named as calling nothing', () => {
    const without = timers().filter((one) => !/\bbecause\(/.test(one.body) && !(one.key in QUIET_TIMERS))
    expect(without.map((one) => one.key)).toEqual([])
  })

  test('a quiet timer named here still exists', () => {
    const keys = new Set(timers().map((one) => one.key))
    expect(Object.keys(QUIET_TIMERS).filter((key) => !keys.has(key))).toEqual([])
  })
})
