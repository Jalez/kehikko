import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'

/**
 * Whether a module has to be restarted to run what an update brought.
 *
 * ## The rule
 *
 * Restart, unless every changed file is provably only the page's. A module's
 * page is served by Vite in dev mode and replaces itself when its files change;
 * everything else — the doors in front of the server, the manifest, the start
 * script, the dependencies — was read once, by a process that is still running
 * what it read.
 *
 * "Provably the page's" is two tests, and a file must pass both:
 *
 *  1. It is where pages, tests and words live: under `src/`, `test/`, `tests/`,
 *     `docs/` or `.github/`, or a Markdown/licence/ignore file.
 *  2. The server does not load it: it is not in what `vite.config.*` imports,
 *     followed through every local import. A shared file under `src/` that a
 *     door imports is server code wherever it sits.
 *
 * The rule can only be wrong towards restarting. A restart nobody needed costs
 * a few seconds of a cover; a restart that was needed and skipped is a module
 * running old code under a row that says it is up to date.
 *
 * ## What it does not know
 *
 * Code a module loads without importing it from its config — a script it
 * spawns, a file it reads at run time — is seen only by where it sits. And
 * nothing here knows what a running process actually loaded: that needs the
 * module to say which build it is, which is what `stale.ts` is the seam for.
 */

export interface RestartDecision {
  restart: boolean
  /** The first few files that decided it, relative to the checkout. Empty when no restart is needed. */
  because: string[]
}

const PAGE_DIRS = ['src/', 'test/', 'tests/', 'docs/', '.github/']
const WORDS = /(^|\/)(LICENSE|LICENCE|NOTICE|CHANGELOG|\.gitignore|\.gitattributes|\.editorconfig)$|\.(md|mdx|txt)$/i

function inPageDirs(file: string): boolean {
  return PAGE_DIRS.some((dir) => file.startsWith(dir)) || WORDS.test(file)
}

/**
 * Decide from what changed and from what the server loads.
 *
 * `serverFiles` is `serverGraph` of the checkout as it is AFTER the update,
 * relative paths. Pure, so the rule is tested without a repository.
 */
export function restartDecision(changed: readonly string[], serverFiles: ReadonlySet<string>): RestartDecision {
  const because = changed.filter((file) => !inPageDirs(file) || serverFiles.has(file))
  return { restart: because.length > 0, because: because.slice(0, 3) }
}

const CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']
const ENDINGS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json', '/index.ts', '/index.tsx', '/index.js']
/* Vite follows a config's imports; a graph this large is not a config's, and
   reading on would be this host parsing somebody's whole application. */
const GRAPH_MAX = 400

/**
 * Every local file the module's server loads, relative to its checkout:
 * `vite.config.*` and whatever it imports, transitively.
 *
 * Imports that point at a file that is not there are kept too, by the path
 * they name — a door importing a file the update deleted still depends on it.
 * `@/…` is read as `src/…`, the alias every module here uses. Packages are not
 * followed: a dependency changing shows as `package.json` or `bun.lock`.
 */
export function serverGraph(dir: string): Set<string> {
  const root = resolve(dir)
  const seen = new Set<string>()
  const queue: string[] = []
  for (const name of CONFIGS) if (existsSync(join(root, name))) queue.push(join(root, name))
  const transpiler = new Bun.Transpiler({ loader: 'tsx' })

  while (queue.length > 0 && seen.size < GRAPH_MAX) {
    const file = queue.pop()!
    const rel = relative(root, file).split(sep).join('/')
    if (seen.has(rel) || rel.startsWith('..')) continue
    seen.add(rel)
    if (!/\.(m?[jt]sx?)$/.test(file)) continue
    let imports: { path: string }[]
    try {
      imports = transpiler.scanImports(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const { path } of imports) {
      const base = path.startsWith('.')
        ? resolve(dirname(file), path)
        : path.startsWith('@/')
          ? join(root, 'src', path.slice(2))
          : null
      if (base === null) continue
      queue.push(found(base) ?? normalize(base))
    }
  }
  return seen
}

/** The file an import names, trying the endings a bundler would. */
function found(base: string): string | null {
  /* `./doors.js` written for a `doors.ts`, as TypeScript allows. */
  const bases = /\.m?jsx?$/.test(base) ? [base, base.replace(/\.(m?)jsx?$/, '.$1ts'), base.replace(/\.jsx?$/, '.tsx')] : [base]
  for (const one of bases) {
    for (const ending of ENDINGS) {
      try {
        if (statSync(one + ending).isFile()) return one + ending
      } catch {
        /* Not that one. */
      }
    }
  }
  return null
}
