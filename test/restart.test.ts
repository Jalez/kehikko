import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { restartDecision, serverGraph } from '../server/restart.ts'
import { Staleness } from '../server/stale.ts'

/**
 * Whether an update needs a restart: restart unless every changed file is
 * provably only the page's. The rule may only be wrong towards restarting.
 */

const made: string[] = []
function checkout(files: Record<string, string>): string {
  const root = join(tmpdir(), `kehikko-restart-${process.pid}-${made.length}`)
  rmSync(root, { recursive: true, force: true })
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  made.push(root)
  return root
}
afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

const none = new Set<string>()

describe('what needs a restart', () => {
  test('a change to the page, its tests or its words does not', () => {
    for (const file of ['src/app.tsx', 'src/deep/view.css', 'test/app.test.ts', 'tests/x.ts', 'docs/how.md', 'README.md', 'LICENSE', '.gitignore', '.github/workflows/ci.yml']) {
      expect(restartDecision([file], none)).toEqual({ restart: false, because: [] })
    }
    expect(restartDecision([], none).restart).toBe(false)
  })

  test('anything else does: the doors, the manifest, the start script, the dependencies, and what nobody listed', () => {
    for (const file of ['doors.ts', 'manifest.ts', 'page/document.ts', 'vite.config.ts', 'run.sh', 'package.json', 'bun.lock', 'store.ts', 'tsconfig.json', 'server/x.ts', 'something-new/file.ts', 'index.html']) {
      expect(restartDecision([file], none)).toEqual({ restart: true, because: [file] })
    }
  })

  test('one server file among many page files is enough, and is the one named', () => {
    const decided = restartDecision(['src/a.tsx', 'README.md', 'doors.ts', 'src/b.tsx'], none)
    expect(decided).toEqual({ restart: true, because: ['doors.ts'] })
  })

  test('a file under src/ that the server loads is server code wherever it sits', () => {
    expect(restartDecision(['src/shared/schema.ts'], new Set(['vite.config.ts', 'doors.ts', 'src/shared/schema.ts']))).toEqual({
      restart: true,
      because: ['src/shared/schema.ts'],
    })
    expect(restartDecision(['src/app.tsx'], new Set(['vite.config.ts', 'doors.ts', 'src/shared/schema.ts'])).restart).toBe(false)
  })
})

describe('what the server loads', () => {
  test('is the vite config and every local file it imports, followed through', () => {
    const root = checkout({
      'vite.config.ts': `import { defineConfig } from 'vite'\nimport { answer } from './doors.ts'\nimport { page } from './page/document'\nexport default defineConfig({})`,
      'doors.ts': `import { ID } from './manifest.js'\nimport { shape } from '@/shared/schema'\nexport const answer = ID + shape`,
      'manifest.ts': `export const ID = 'x'`,
      'page/document.ts': `import words from './words.json'\nexport const page = words`,
      'page/words.json': `{}`,
      'src/shared/schema.ts': `export const shape = 1`,
      'src/app.tsx': `import { shape } from './shared/schema'\nexport const App = () => shape`,
      'unrelated.ts': `export {}`,
    })
    expect([...serverGraph(root)].sort()).toEqual(
      ['doors.ts', 'manifest.ts', 'page/document.ts', 'page/words.json', 'src/shared/schema.ts', 'vite.config.ts'].sort(),
    )
  })

  test('keeps an import whose file is gone, so a door that lost a file it imports still counts it', () => {
    const root = checkout({
      'vite.config.ts': `import './doors.ts'`,
      'doors.ts': `import { gone } from './src/gone.ts'\nexport const x = gone`,
    })
    const graph = serverGraph(root)
    expect(graph.has('src/gone.ts')).toBe(true)
    expect(restartDecision(['src/gone.ts'], graph).restart).toBe(true)
  })

  test('a checkout with no vite config loads nothing this can see, and nothing escapes the checkout', () => {
    expect(serverGraph(checkout({ 'run.sh': '#!/bin/sh' })).size).toBe(0)
    const root = checkout({ 'vite.config.ts': `import '../outside.ts'\nimport 'react'` })
    expect([...serverGraph(root)]).toEqual(['vite.config.ts'])
  })
})

describe('a module left running old code', () => {
  test('is remembered with its sentence until it is started or found not running', () => {
    const stale = new Staleness()
    expect(stale.staleness('a')).toBeNull()
    stale.leftBehind('a', 'its registration says to keep it')
    stale.leftBehind('b', 'it is somebody else’s process')
    expect(stale.staleness('a')).toBe('its registration says to keep it')
    expect(stale.all()).toEqual({ a: 'its registration says to keep it', b: 'it is somebody else’s process' })
    stale.fresh('a')
    expect(stale.staleness('a')).toBeNull()
    stale.forgetAllBut(['a'])
    expect(stale.all()).toEqual({})
  })
})
