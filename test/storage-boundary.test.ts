import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { format, scanRepo, scanText, workspace } from '../dev/storage-boundary.ts'

/**
 * The storage boundary: project data lives only under `<project>/.kehikot/`.
 * See `dev/storage-boundary.ts` for the rule and the allowlist, and
 * README "Where data lives".
 */

const rules = (text: string, file = 'store.ts') => scanText(text, file).map((v) => v.rule)

describe('what the scanner flags', () => {
  test('the shapes that have actually been wrong', () => {
    expect(rules("const dir = process.env.NOTIFICATIONS_DATA ?? join(HERE, 'data')")).toEqual(['data-segment'])
    expect(rules("const dir = process.env.TESTS_DATA ?? join(process.cwd(), 'data')")).toEqual(['data-segment'])
    expect(rules("const guess = join(roadmap, 'data', 'papers')")).toEqual(['data-segment'])
    expect(rules("db = new Database(join(ROOT, 'data', 'requests.db'))")).toEqual(['data-segment'])
    expect(rules("return statSync(resolve(root, 'data', 'epics'))")).toEqual(['data-segment'])
    expect(rules("const where = 'data/epics/x.json'")).toEqual(['data-literal'])
    expect(rules("const store = join(homedir(), '.mymodule', 'store.json')")).toEqual(['home-path'])
    expect(rules('const flag = `${process.env.HOME}/.thing`')).toEqual(['home-path'])
    expect(rules("writeFileSync(join(import.meta.dir, 'notes.json'), text)")).toEqual(['anchored-write'])
    expect(rules('db = new Database(path, { create: true })')).toEqual(['database'])
  })

  test('shell scripts', () => {
    expect(rules('[ -d "$ROOT/data/epics" ]', 'run.sh')).toEqual(['data-literal'])
    expect(rules('mkdir -p "$HOME/.mything"', 'run.sh')).toEqual(['home-path'])
    expect(rules('echo hi > ~/.mything/log', 'run.sh')).toEqual(['home-path'])
    expect(rules('# mkdir -p "$HOME/.mything" in a comment', 'run.sh')).toEqual([])
  })

  test('what it leaves alone', () => {
    expect(rules("const file = moduleFile(projectPath, MODULE_ID, 'notes')")).toEqual([])
    expect(rules("child.stdout.on('data', (chunk) => out += chunk)")).toEqual([])
    expect(rules("const html = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8')")).toEqual([])
    expect(rules('for (const root of [homedir(), ...paths]) {}')).toEqual([])
    expect(rules('db = new Database(file)\nconst d = moduleDir(p, id)')).toEqual([])
  })

  test('comments are not code', () => {
    expect(rules("// join(HERE, 'data')")).toEqual([])
    expect(rules(" * It was `join(import.meta.dir, 'data')`, and that was wrong")).toEqual([])
    expect(rules("/* join(ROOT, 'data')\n   join(ROOT, 'data') */\nconst x = 1")).toEqual([])
    expect(rules("const x = 1 // was join(ROOT, 'data')")).toEqual([])
  })

  test('the allowlist: machine-level state, each with a reason', () => {
    expect(rules("return env.ROADMAP_MODULES_DIR ?? join(homedir(), '.roadmap', 'modules')")).toEqual([])
    expect(rules("return env.ROADMAP_FRAME_DB ?? join(homedir(), '.roadmap', 'frame.sqlite')")).toEqual([])
    expect(rules("return join(homedir(), 'Library', 'Application Support', 'Kehikot', 'modules')")).toEqual([])
    expect(rules("const m = join(homedir(), 'Library', 'Application Support', 'Kehikot')")).toEqual([])
    expect(rules("return join(homedir(), '.claude.json')")).toEqual([])
    expect(rules("const AGENTS = join(homedir(), 'Library', 'LaunchAgents')")).toEqual([])
    expect(rules("const dir = mkdtempSync(join(tmpdir(), 'x-'))")).toEqual([])
    expect(rules("const db = new Database(':memory:')")).toEqual([])
    /* File-scoped entries only hold in their file. */
    expect(scanText('const db = new Database(file, { create: true })', 'server/canvases.ts')).toEqual([])
    expect(rules('const db = new Database(file, { create: true })', 'server/other.ts')).toEqual(['database'])
    expect(scanText('db = new Database(DB_PATH, { create: true })', 'src/requests.ts')).toEqual([])
    expect(rules('db = new Database(somewhere, { create: true })', 'src/requests.ts')).toEqual(['database'])
  })

  test('the inline escape hatch needs a reason', () => {
    expect(rules("const x = join(root, 'data') // kehikot-storage: allow legacy, read to migrate")).toEqual([])
    expect(rules("// kehikot-storage: allow legacy, read to migrate\nconst x = join(root, 'data')")).toEqual([])
    expect(rules("const x = join(root, 'data') // kehikot-storage: allow")).toEqual(['data-segment'])
  })
})

describe('the boundary holds', () => {
  test('this host stores nothing outside .kehikot/', () => {
    const host = { name: 'kehikko', dir: join(import.meta.dir, '..') }
    const found = scanRepo(host)
    if (found.length) console.error(format(found, [host]))
    expect(found).toEqual([])
  })

  const { repos, missing } = workspace()
  const siblings = repos.length > 1
  if (!siblings) {
    console.warn(
      'storage-boundary: SKIPPING the workspace scan — no sibling repos found '
        + `(looked for ${missing.join(', ') || 'the protocol and the module registry'}).`,
    )
  }
  test.skipIf(!siblings)('every workspace repo stores nothing outside .kehikot/ (bun run check:storage)', () => {
    const found = repos.flatMap(scanRepo)
    if (found.length) {
      console.error(`storage-boundary: ${found.length} violation(s) — project data belongs under <project>/.kehikot/<module>/`)
      console.error(format(found, repos))
    }
    expect(found.map((v) => `${v.repo}/${v.file}:${v.line} [${v.rule}]`)).toEqual([])
  })

  test('the workspace scan reads only what exists', () => {
    for (const repo of repos) expect(existsSync(repo.dir)).toBe(true)
  })
})
