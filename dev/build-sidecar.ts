/**
 * Compile the host into one binary, with the page inside it, for the desktop app.
 *
 *   bun run build:sidecar [--target bun-darwin-arm64|bun-darwin-x64|…] [--out <path>]
 *
 * `--target` defaults to this machine, `--out` to `dist-sidecar/kehikko-host`.
 *
 * This is the ONLY place a built page exists, and it exists only inside the
 * binary. Development never serves one — see `run.sh` on the stale `dist` that
 * cost hours — so the page is built into a temporary directory, compiled in,
 * and the directory is removed. Nothing is left in the tree for a dev server to
 * find.
 *
 * How the page gets in: an entry module is generated beside the built files.
 * It imports each one `with { type: 'file' }`, which `bun build --compile`
 * embeds, hands the map to `server/page.ts`'s `embed`, and only then loads
 * `server/server.ts`. The server sees a page and knows it is bundled.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

function usage(message: string): never {
  console.error(`build:sidecar: ${message}`)
  console.error('usage: bun run build:sidecar [--target <bun target>] [--out <path>]')
  process.exit(2)
}

function parse(argv: string[]): { target: string | null; out: string } {
  let target: string | null = null
  let out = join(ROOT, 'dist-sidecar', 'kehikko-host')
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null]
    const value = () => {
      const v = inline ?? argv[++i]
      if (!v) usage(`${flag} needs a value`)
      return v
    }
    if (flag === '--target') target = value()
    else if (flag === '--out') out = resolve(process.cwd(), value())
    else usage(`unknown argument ${arg}`)
  }
  if (target !== null && !/^bun-[a-z0-9-]+$/.test(target)) usage(`${target} is not a bun target (e.g. bun-darwin-arm64)`)
  return { target, out }
}

function run(argv: string[]): void {
  console.error(`$ ${argv.join(' ')}`)
  const ran = Bun.spawnSync(argv, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', env: process.env })
  if (ran.exitCode !== 0) {
    console.error(`build:sidecar: ${argv.slice(0, 3).join(' ')} failed (${ran.exitCode})`)
    process.exit(ran.exitCode || 1)
  }
}

function filesUnder(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path))
    else found.push(path)
  }
  return found.sort()
}

const { target, out } = parse(process.argv.slice(2))
const work = mkdtempSync(join(tmpdir(), 'kehikko-sidecar-'))

try {
  const page = join(work, 'page')
  run([process.execPath, 'x', 'vite', 'build', '--outDir', page, '--emptyOutDir'])

  const files = filesUnder(page)
  if (!files.some((file) => relative(page, file) === 'index.html')) {
    console.error('build:sidecar: vite build produced no index.html')
    process.exit(1)
  }

  const lines = [
    `import { embed } from ${JSON.stringify(join(ROOT, 'server', 'page.ts'))}`,
    ...files.map((file, i) => `import f${i} from ${JSON.stringify(file)} with { type: 'file' }`),
    'embed(new Map<string, string>([',
    ...files.map((file, i) => `  [${JSON.stringify('/' + relative(page, file).split(sep).join('/'))}, f${i}],`),
    ']))',
    `await import(${JSON.stringify(join(ROOT, 'server', 'server.ts'))})`,
    '',
  ]
  const entry = join(work, 'sidecar-entry.ts')
  writeFileSync(entry, lines.join('\n'))

  mkdirSync(dirname(out), { recursive: true })
  run([
    process.execPath,
    'build',
    '--compile',
    '--minify',
    ...(target ? ['--target', target] : []),
    '--outfile',
    out,
    entry,
  ])
  console.error(`build:sidecar: ${out} (${files.length} page files embedded${target ? `, ${target}` : ''})`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
