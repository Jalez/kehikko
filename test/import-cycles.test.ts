import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * No import cycles under `src/` and `server/`: two files that import each other (or a ring of
 * them) load in an order that depends on who was imported first, and a value read at load time is
 * `undefined` for one of them. Each cycle the audit found was broken at a seam — a helper both sides
 * needed moved into a file of its own (`host/settingsClient.ts`, `host/dialogs.ts`,
 * `canvas/LayoutPreview.tsx`, `server/quietEnv.ts`, `server/trafficContext.ts`,
 * `server/processTable.ts`) — and this keeps them from coming back.
 *
 * Only what runs counts: `import type` and imports whose every name is a type are dropped by the
 * transpiler (`Bun.Transpiler.scanImports` reports what is left), and a dynamic `import()` is
 * loaded later, when it is called, so it is not part of the load order either.
 */

const ROOT = resolve(import.meta.dir, '..')
const DIRS = ['src', 'server']
const SOURCE = /\.(ts|tsx)$/

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (SOURCE.test(name) && !name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/** Where a specifier points, when it is one of ours: relative, or `@/` for `src/` (tsconfig `paths`). */
function named(from: string, spec: string): string | null {
  return spec.startsWith('@/') ? join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null
}

/** The file on disk a specifier names, extension or `index` filled in as the bundler would. */
function onDisk(from: string, spec: string): string | null {
  const base = named(from, spec)
  if (!base) return null
  for (const path of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(path) && statSync(path).isFile()) return path
  }
  return null
}

const TS = new Bun.Transpiler({ loader: 'ts' })
const TSX = new Bun.Transpiler({ loader: 'tsx' })

/** Each file and the files among `files` it imports at load time. */
function graphOf(files: readonly string[], read: (file: string) => string, find = onDisk): Map<string, string[]> {
  const known = new Set(files)
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const to = (file.endsWith('.tsx') ? TSX : TS)
      .scanImports(read(file).replace(/^#!.*/, ''))
      .filter((one) => one.kind !== 'dynamic-import')
      .map((one) => find(file, one.path))
      .filter((path): path is string => path !== null && known.has(path))
    graph.set(file, [...new Set(to)])
  }
  return graph
}

/** The strongly connected components of more than one file, and the files that import themselves (Tarjan). */
function cyclesOf(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let next = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const found: string[][] = []
  const visit = (v: string) => {
    index.set(v, next)
    low.set(v, next)
    next += 1
    stack.push(v)
    onStack.add(v)
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) !== index.get(v)) return
    const component: string[] = []
    let w: string
    do {
      w = stack.pop()!
      onStack.delete(w)
      component.push(w)
    } while (w !== v)
    if (component.length > 1 || (graph.get(v) ?? []).includes(v)) found.push(component.sort())
  }
  for (const v of graph.keys()) if (!index.has(v)) visit(v)
  return found
}

describe('import cycles', () => {
  test('the walk finds a ring, and leaves type-only and dynamic imports out', () => {
    const files: Record<string, string> = {
      [join(ROOT, 'src/a.ts')]: "import { b } from './b.ts'\nexport const a = b",
      [join(ROOT, 'src/b.ts')]: "import { c } from '@/c.ts'\nexport const b = c",
      [join(ROOT, 'src/c.ts')]: "import { a } from './a.ts'\nexport const c = () => a",
      [join(ROOT, 'src/d.ts')]: "import type { E } from './e.ts'\nimport { type F } from './e.ts'\nexport const d = (e: E, f: F) => import('./e.ts')",
      [join(ROOT, 'src/e.ts')]: "import { d } from './d.ts'\nexport type E = 1\nexport type F = 2\nexport const e = d",
    }
    const graph = graphOf(Object.keys(files), (file) => files[file]!, named)
    const cycles = cyclesOf(graph).map((ring) => ring.map((path) => relative(ROOT, path)))
    expect(cycles).toEqual([['src/a.ts', 'src/b.ts', 'src/c.ts']])
  })

  test('there are none under src/ and server/', () => {
    const files = DIRS.flatMap((dir) => sources(join(ROOT, dir)))
    expect(files.length).toBeGreaterThan(100)
    const graph = graphOf(files, (file) => readFileSync(file, 'utf8'))
    const cycles = cyclesOf(graph).map((ring) => ring.map((path) => relative(ROOT, path)).join(' ↔ '))
    expect(cycles).toEqual([])
  })
})
