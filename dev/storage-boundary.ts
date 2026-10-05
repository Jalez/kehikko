#!/usr/bin/env bun
/**
 * The storage boundary: no code in this workspace keeps a project's data
 * anywhere but `<project>/.kehikot/<module>/`.
 *
 * ## Why this exists
 *
 * The protocol says where a module's data goes (`KEHIKOT_DIR`, `moduleDir`,
 * `moduleFile` in `kehikko-protocol/src/project.ts`), and for a while every
 * module followed it except the ones that did not: the roadmap kept epics,
 * state, papers and `requests.db` under its own `data/`, notifications kept a
 * store next to its own source (`join(HERE, 'data')`), tests kept one under
 * whatever directory it was started from (`process.cwd()/data`), citations read
 * papers out of `$KEHIKKO_ROADMAP_DIR/data/papers`, and this host read
 * `<project>/data/epics`. None of those were bugs anybody could see — each
 * worked — and each put somebody's work where the next program would not look.
 *
 * So the rule is checked, not asked for. This walks the source of this host,
 * the protocol, and every module in the registry
 * (`Application Support/Kehikot/modules/*.json`, and the retired
 * `~/.roadmap/modules`; each names its `dir`), READ-ONLY, and reports
 * every line that builds a storage path outside `.kehikot/`.
 *
 * ## What it flags
 *
 * Line-based and deliberately conservative — a false positive teaches people to
 * ignore the check, so each rule names a shape that has actually been wrong:
 *
 * - `data-segment`: a `join(`/`resolve(` with a `'data'` segment — `join(ROOT,
 *   'data', 'epics')`, `join(HERE, 'data')`, `join(process.cwd(), 'data')`,
 *   `join(roadmap, 'data', 'papers')`.
 * - `data-literal`: a string literal that starts `data/…` or `./data/…`, and a
 *   `data/…` path in a shell script.
 * - `home-path`: a path joined onto the home directory (`join(homedir(), …)`,
 *   `${process.env.HOME}/…`, `$HOME/…` written to by a shell script).
 * - `anchored-write`: a write (`writeFileSync`, `mkdirSync`, `Bun.write`,
 *   `new Database`, …) on the same line as a path anchored at the program's own
 *   location (`import.meta.dir`, `__dirname`, `process.cwd()`, `HERE`, `ROOT`).
 * - `database`: `new Database(` that is not `:memory:`, in a file that never
 *   mentions `KEHIKOT_DIR`/`kehikotDir`/`moduleDir`/`moduleFile`.
 *
 * Comments are skipped (`//`, `/* … *\/`, ` * ` continuation lines, `#` in
 * shell), and so are tests, `dev/` scripts, build output, `node_modules`,
 * `.claude/worktrees`, and the roadmap's `modules/` built-ins (dead code).
 *
 * ## Machine-level state is allowed, and listed
 *
 * Some state really is the machine's and not a project's. Each is in `ALLOW`
 * below with one line saying why. Anything else that has to be an exception
 * says so where it is, with a reason:
 *
 *     const x = join(homedir(), '.cache', 'tool') // kehikot-storage: allow tool cache, not project data
 *
 * (on the line itself or the line above). A bare `allow` with no reason does
 * not count.
 *
 * Usage: `bun dev/storage-boundary.ts [--warn] [--json]`. Exits 1 when it finds
 * anything, unless `--warn`.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { legacyModulesDir, modulesDir } from '../server/machineDirs.ts'

export interface Violation {
  repo: string
  file: string
  line: number
  rule: Rule
  text: string
}

export type Rule = 'data-segment' | 'data-literal' | 'home-path' | 'anchored-write' | 'database'

export interface Repo {
  /** A short name for output. */
  name: string
  dir: string
  /** Paths relative to `dir` not to scan, on top of the global exclusions. */
  skip?: string[]
}

/**
 * Machine-level state that is allowed outside `.kehikot/`. Matched against the
 * code on the line (comments already stripped). Each entry needs its reason.
 */
export const ALLOW: ReadonlyArray<{ id: string; match: RegExp; reason: string; file?: RegExp }> = [
  {
    id: 'machine-dir',
    match: /Application Support['"`]?\s*,\s*['"`]Kehikot|Application Support\/Kehikot|['"`]\.local['"`]\s*,\s*['"`]share|XDG_DATA_HOME/,
    reason: '~/Library/Application Support/Kehikot (XDG data dir elsewhere) is this machine\'s Kehikot state: the module registry and the canvases cache (host server/machineDirs.ts)',
  },
  {
    id: 'module-registry',
    match: /\.roadmap['"`]?\s*,\s*['"`]modules|\.roadmap\/modules/,
    reason: '~/.roadmap/modules is the RETIRED module registry: modules still register there until they move to Application Support/Kehikot/modules, and the host reads it as a fallback',
  },
  {
    id: 'frame-db',
    match: /frame\.sqlite/,
    reason: 'frame.sqlite is the host\'s canvases cache (Application Support/Kehikot; once ~/.roadmap); <project>/.kehikot/kehikot.json is the record',
  },
  {
    id: 'frame-db-migrate',
    match: /new Database\(from, \{ readonly: true \}\)/,
    file: /(^|\/)server\/machineDirs\.ts$/,
    reason: 'the host opening the retired ~/.roadmap/frame.sqlite READ-ONLY to snapshot it into the new home',
  },
  {
    id: 'frame-db-open',
    match: /new Database\(file\b/,
    file: /(^|\/)server\/canvases\.ts$/,
    reason: 'the host opening the frame.sqlite path above (canvases.ts `frameDb`)',
  },
  {
    id: 'claude-config',
    match: /\.claude\b/,
    reason: '~/.claude* is Claude Code\'s own configuration, read (and hooks installed) where Claude looks for it',
  },
  {
    id: 'launchd',
    match: /Library['"`]?\s*,\s*['"`](?:LaunchAgents|Logs)|Library\/(?:LaunchAgents|Logs)/,
    reason: '~/Library/LaunchAgents and ~/Library/Logs are where macOS keeps the roadmap service\'s plist and logs',
  },
  {
    id: 'service-marker',
    match: /\.innovium-roadmap\.running/,
    reason: 'the machine-level "roadmap is serving on port N" marker the delivery hook reads',
  },
  {
    id: 'temp',
    match: /tmpdir\(\)|mkdtemp|['"`]\/tmp\b|\$TMPDIR|\bTMPDIR\b/,
    reason: 'temporary directories are scratch, not storage',
  },
  {
    id: 'module-codegen',
    match: /mkdirSync\(join\(ROOT, OUT_MODULES/,
    file: /(^|\/)scripts\/split-modules\.ts$/,
    reason: 'the roadmap\'s code generator writing module SOURCE trees into the repo, not data',
  },
  {
    id: 'roadmap-requests-db',
    match: /new Database\((?:dbPath\(\)|DB_PATH|process\.env\.ROADMAP_DB \?\? join\(DATA, 'requests\.db'\))/,
    file: /(^|\/)src\/(?:calls|requests|concerns|stages|activity|journeys)\.ts$/,
    reason: 'the roadmap opening requests.db, whose default is DATA = <project>/.kehikot/roadmap (src/store.ts)',
  },
  {
    id: 'memory-db',
    match: /:memory:/,
    reason: 'an in-memory database stores nothing',
  },
]

const INLINE = /kehikot-storage:\s*allow\s+\S/

const SOURCE = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh'])
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'coverage',
  '.git',
  '.claude',
  '.kehikot',
  'test',
  'tests',
  '__tests__',
  'dev',
])
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/

const HELPERS = /\bKEHIKOT_DIR\b|\bkehikotDir\b|\bmoduleDir\b|\bmoduleFile\b/

const RULES: ReadonlyArray<{ rule: Rule; match: RegExp; shell?: boolean; code?: boolean }> = [
  { rule: 'data-segment', code: true, match: /\b(?:join|resolve|joinPath)\([^;]*?['"`]data['"`]/ },
  { rule: 'data-literal', code: true, match: /['"`](?:\.\/)?data\/[\w.-]/ },
  { rule: 'data-literal', shell: true, match: /(?:^|[\s"'=/}])data\/[\w.-]/ },
  {
    rule: 'home-path',
    code: true,
    match: /\b(?:join|resolve|joinPath)\(\s*(?:os\.)?(?:homedir\(\)|process\.env\.HOME\b)|\$\{\s*(?:(?:os\.)?homedir\(\)|process\.env\.HOME)\s*\}\//,
  },
  { rule: 'home-path', shell: true, match: /\b(?:mkdir|touch|tee|cp|mv|ln)\b[^#]*(?:\$HOME|\$\{HOME\}|~)\/|>>?\s*["']?(?:\$HOME|\$\{HOME\}|~)\// },
  /* `import[.]meta[.]dir`, not the backslash-escaped form: Bun's transpiler
     mangles the escaped spelling (and `dirname?`) inside a regex literal. */
  {
    rule: 'anchored-write',
    code: true,
    match: /(?:writeFileSync|appendFileSync|mkdirSync|createWriteStream|Bun\.write|new Database)\([^;]*(?:import[.]meta[.]dir(?:name)?|__dirname|process\.cwd\(\)|\bHERE\b|\bROOT\b)/,
  },
]

/** Strip comments from one line, given whether a block comment is open. */
function code(line: string, shell: boolean, state: { block: boolean }): string {
  if (shell) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('#')) return ''
    return line.replace(/\s#\s.*$/, '')
  }
  let out = ''
  let i = 0
  while (i < line.length) {
    if (state.block) {
      const end = line.indexOf('*/', i)
      if (end === -1) return out
      state.block = false
      i = end + 2
      continue
    }
    const start = line.indexOf('/*', i)
    const slashes = line.indexOf('//', i)
    /* `//` inside a string (`http://`) is not a comment; only take it when it
       starts the line or follows whitespace. */
    const lineComment = slashes !== -1 && (slashes === 0 || /\s/.test(line[slashes - 1] ?? '')) ? slashes : -1
    if (start !== -1 && (lineComment === -1 || start < lineComment)) {
      out += line.slice(i, start)
      state.block = true
      i = start + 2
      continue
    }
    if (lineComment !== -1) return out + line.slice(i, lineComment)
    return out + line.slice(i)
  }
  return out
}

/** One file's violations. Exported for the tests. */
export function scanText(text: string, file: string, repo = ''): Violation[] {
  const shell = extname(file) === '.sh'
  const lines = text.split('\n')
  const state = { block: false }
  const usesHelpers = HELPERS.test(text)
  const found: Violation[] = []

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n] ?? ''
    const was = state.block
    const trimmed = raw.trimStart()
    /* A JSDoc/essay continuation line is a comment even when the `/*` was
       missed (e.g. inside a template literal we do not parse). */
    const stripped = !shell && !was && /^\*(?:\s|\/|$)/.test(trimmed) ? '' : code(raw, shell, state)
    if (!stripped.trim()) continue
    if (INLINE.test(raw) || INLINE.test(lines[n - 1] ?? '')) continue
    if (ALLOW.some((entry) => entry.match.test(stripped) && (!entry.file || entry.file.test(file)))) continue

    let rule: Rule | null = null
    for (const candidate of RULES) {
      if (shell ? !candidate.shell : !candidate.code) continue
      if (candidate.match.test(stripped)) {
        rule = candidate.rule
        break
      }
    }
    if (!rule && !shell && !usesHelpers && /new Database\(/.test(stripped)) rule = 'database'
    if (rule) found.push({ repo, file, line: n + 1, rule, text: raw.trim().slice(0, 160) })
  }
  return found
}

function walk(root: string, rel: string, skip: Set<string>, into: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(join(root, rel))
  } catch {
    return
  }
  for (const name of entries) {
    const path = rel ? `${rel}/${name}` : name
    if (skip.has(path)) continue
    let stat
    try {
      stat = statSync(join(root, path))
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name) || name.endsWith('-worktrees')) continue
      walk(root, path, skip, into)
    } else if (SOURCE.has(extname(name)) && !SKIP_FILE.test(name)) {
      into.push(path)
    }
  }
}

/** Every violation in one repository. */
export function scanRepo(repo: Repo): Violation[] {
  const files: string[] = []
  walk(repo.dir, '', new Set(repo.skip ?? []), files)
  return files.flatMap((file) => {
    let text: string
    try {
      text = readFileSync(join(repo.dir, file), 'utf8')
    } catch {
      return []
    }
    return scanText(text, file, repo.name)
  })
}

/**
 * The workspace: this host, the protocol, and every registered module. The
 * roadmap prototype is retired and deliberately not scanned. Read-only. Missing repos are reported in `missing`, not scanned.
 */
export function workspace(env: Record<string, string | undefined> = process.env): { repos: Repo[]; missing: string[] } {
  const home = env.HOME ?? homedir()
  const projects = env.KEHIKOT_SCAN_PROJECTS ?? join(home, 'Projects')
  const host = join(import.meta.dir, '..')
  const candidates: Repo[] = [
    { name: 'kehikko', dir: host },
    { name: 'kehikko-protocol', dir: env.KEHIKOT_SCAN_PROTOCOL ?? join(projects, 'kehikko-protocol') },
  ]
  /* The registry, and the retired one modules may still write to. */
  const registries = [modulesDir({ ...env, HOME: home }), legacyModulesDir({ ...env, HOME: home })].filter(
    (dir): dir is string => dir !== null,
  )
  const files: Array<{ registry: string; file: string }> = []
  for (const registry of registries) {
    try {
      for (const file of readdirSync(registry).filter((name) => name.endsWith('.json')).sort()) files.push({ registry, file })
    } catch {
      /* No registry here; nothing registered to scan. */
    }
  }
  for (const { registry, file } of files) {
    try {
      const dir = (JSON.parse(readFileSync(join(registry, file), 'utf8')) as { dir?: unknown }).dir
      /* Named by the registration's id rather than the folder: two checkouts
         can share a basename (every `.claude/worktrees/<branch>` does), and the
         report groups by name. */
      if (typeof dir === 'string' && dir) candidates.push({ name: basename(file, '.json'), dir })
    } catch {
      /* An unreadable registration is not this check's business. */
    }
  }

  const seen = new Set<string>()
  const repos: Repo[] = []
  const missing: string[] = []
  for (const repo of candidates) {
    if (!existsSync(repo.dir)) {
      missing.push(repo.dir)
      continue
    }
    const real = realpathSync(repo.dir)
    if (seen.has(real)) continue
    seen.add(real)
    repos.push({ ...repo, dir: real })
  }
  return { repos, missing }
}

export function format(violations: Violation[], repos: Repo[]): string {
  const byRepo = new Map<string, Violation[]>()
  for (const v of violations) byRepo.set(v.repo, [...(byRepo.get(v.repo) ?? []), v])
  const lines: string[] = []
  for (const repo of repos) {
    const list = byRepo.get(repo.name)
    if (!list?.length) continue
    lines.push(`${repo.name} (${repo.dir})`)
    for (const v of list) lines.push(`  ${v.file}:${v.line}  [${v.rule}]  ${v.text}`)
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2))
  const { repos, missing } = workspace()
  const violations = repos.flatMap(scanRepo)
  if (args.has('--json')) {
    console.log(JSON.stringify({ repos, missing, violations }, null, 2))
  } else if (violations.length) {
    const bar = '!'.repeat(78)
    console.error(bar)
    console.error(`kehikot-storage: ${violations.length} place(s) store data outside <project>/.kehikot/`)
    console.error('Project data belongs under <project>/.kehikot/<module>/ (protocol: KEHIKOT_DIR, moduleDir, moduleFile).')
    console.error(bar)
    console.error(format(violations, repos))
    console.error(bar)
    console.error(`scanned ${repos.length} repo(s)${missing.length ? `; missing: ${missing.join(', ')}` : ''}`)
  } else {
    console.log(`kehikot-storage: clean — ${repos.length} repo(s) scanned${missing.length ? `; missing: ${missing.join(', ')}` : ''}`)
  }
  if (violations.length && !args.has('--warn')) process.exit(1)
}
