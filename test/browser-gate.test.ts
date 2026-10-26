import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/*
 * No test reaches a browser without the gate (`test/browser-gate.ts`).
 *
 * Browsers never start on the person's Mac: the browser tests run on bee, with
 * `dev/bee-browser-tests.sh`, and a plain `bun test` skips them. That holds only
 * while every such test is declared with `browserTest`, so this reads every
 * file under `test/` and fails on one whose code — comments aside — imports
 * Playwright or names a drive (a `dev/` script that imports it), unless the
 * file declares its tests with `browserTest` and nothing else.
 */
const ROOT = join(import.meta.dir, '..')
const SELF = new Set(['test/browser-gate.ts', 'test/browser-gate.test.ts'])

/** Source without its comments: what the file does, not what it says about other files. */
export function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n')
}

/** The `dev/` scripts that drive a browser: every one that imports Playwright. */
export function drives(dir = join(ROOT, 'dev')): string[] {
  return readdirSync(dir)
    .filter((name) => /\.(m?js|ts)$/.test(name))
    .filter((name) => /playwright/.test(code(readFileSync(join(dir, name), 'utf8'))))
}

export type Verdict = 'none' | 'gated' | 'ungated'

/** Does this test source reach a browser, and if it does, only through `browserTest`? */
export function verdict(source: string, driveNames: string[]): Verdict {
  const body = code(source)
  const reaches = /playwright/.test(body) || driveNames.some((name) => body.includes(name))
  if (!reaches) return 'none'
  const gate = /import\s*\{[^}]*\bbrowserTest\b[^}]*\}\s*from\s*['"]\.\/browser-gate(\.ts)?['"]/.test(body)
  const bare = /(^|[^.\w])(test|it|describe)(\.\w+)*\s*\(/m.test(body)
  return gate && !bare ? 'gated' : 'ungated'
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path)
    return /\.(m?[jt]sx?)$/.test(name) ? [path] : []
  })
}

describe('the browser gate', () => {
  const names = drives()

  test('knows the drives', () => {
    for (const drive of ['pages-take-input.drive.mjs', 'whats-new-notice.drive.mjs', 'place-in-gaps.drive.mjs', 'traffic-counts.drive.mjs', 'layout-chips.drive.mjs', 'tooltips.mjs', 'viewport.mjs']) {
      expect(names).toContain(drive)
    }
  })

  test('every test file that reaches a browser comes through browserTest', () => {
    const seen: Record<string, Verdict> = {}
    for (const path of files(join(ROOT, 'test'))) {
      const at = relative(ROOT, path)
      if (SELF.has(at)) continue
      const said = verdict(readFileSync(path, 'utf8'), names)
      if (said !== 'none') seen[at] = said
    }
    const ungated = Object.entries(seen).filter(([, said]) => said === 'ungated').map(([at]) => at)
    expect(ungated).toEqual([])
    for (const at of ['pages-take-input', 'whats-new-notice', 'place-in-gaps', 'traffic-counts', 'layout-chips-fit']) {
      expect(seen[`test/${at}.test.ts`]).toBe('gated')
    }
  })

  test('the rule itself: a spawned drive or Playwright without the gate is caught, a comment is not', () => {
    const spawn = (decl: string) =>
      `${decl}\nconst run = Bun.spawnSync(['node', join(root, 'dev/pages-take-input.drive.mjs')])`
    expect(verdict(spawn(`import { test } from 'bun:test'\ntest('x', () => {})`), names)).toBe('ungated')
    expect(verdict(`import { test } from 'bun:test'\nconst pw = await import('playwright-core')\ntest('x', () => {})`, names)).toBe('ungated')
    expect(verdict(spawn(`import { browserTest } from './browser-gate.ts'\nbrowserTest('x', () => {}, 1)`), names)).toBe('gated')
    expect(verdict(spawn(`import { browserTest } from './browser-gate.ts'\nbrowserTest('x', () => {}, 1)\ntest('y', () => {})`), names)).toBe('ungated')
    expect(verdict(`/* measured by \`dev/viewport.mjs\` */\n// and playwright\ntest('x', () => {})`, names)).toBe('none')
  })
})
