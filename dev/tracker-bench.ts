/**
 * What one scheduled tracker read costs, against the fixture tracker
 * (`test/trackerFixture.ts`): processes started, requests, bytes read and the
 * host's own time, for a project of `--size` items (2000 by default) where 5
 * changed since the last read, and again where nothing did.
 *
 *   bun dev/tracker-bench.ts [--size 2000] [--tracker github|gitlab] [--argv]
 *
 * Runs in a scratch folder under the system's temp directory; reaches no
 * tracker, no module and no running host.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Trackers } from '../server/trackers/reading.ts'
import { fixtureTracker } from '../test/trackerFixture.ts'

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1]! : fallback
}
const size = Number(arg('size', '2000'))
const trackers = arg('tracker', 'github,gitlab').split(',') as Array<'github' | 'gitlab'>

const START = Date.parse('2026-10-05T12:00:00.000Z')

async function bench(tracker: 'github' | 'gitlab') {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-tracker-bench-')))
  try {
    let clock = START
    const host = tracker === 'github' ? 'github.com' : 'gitlab.example.org'
    const repo = 'acme/widgets'
    const f = fixtureTracker({ tracker, host, repo, size, now: START })
    /* A repository, as a project is: its remotes are in its config (the fixture's git answers what they are). */
    mkdirSync(join(folder, '.git'))
    writeFileSync(join(folder, '.git', 'config'), `[remote "origin"]\n\turl = https://${host}/${repo}.git\n`)
    const reading = new Trackers({ run: f.run, now: () => new Date(clock) })
    /* What the project's spaces and modules name: old closed items and open ones. */
    const prefix = tracker === 'github' ? 'gh#' : '#'
    const named = [
      ...Array.from({ length: 60 }, (_, i) => 100 + i * 10).filter((n) => n % 5 !== 0 && f.items.get(n)?.state !== 'open'),
      ...[...f.items.values()].filter((it) => it.state === 'open' && it.kind === 'issue').slice(0, 20).map((it) => it.number),
    ].map((n) => `${prefix}${n}`)
    reading.get(folder, { refs: named })

    const measure = async (label: string, by: 'schedule' | 'press') => {
      f.reset()
      const t = performance.now()
      const result = await reading.refresh(folder, { project: true }, by)
      const ms = performance.now() - t
      const kinds = new Map<string, number>()
      for (const argv of f.asked) {
        const what = argv[0] === 'git'
          ? 'git'
          : argv.includes('graphql')
            ? `${argv[0]} graphql`
            : argv.includes('-i')
              ? `${argv[0]} conditional`
              : `${argv[0]} rest`
        kinds.set(what, (kinds.get(what) ?? 0) + 1)
      }
      /* `--argv` prints every process the read started. */
      if (process.argv.includes('--argv')) for (const a of f.asked) console.log('   ', a.join(' ').slice(0, 200))
      const rows = reading.rowsHeld(folder).length
      console.log(
        `${tracker.padEnd(6)} ${label.padEnd(30)} ${result.outcome.padEnd(6)} processes ${String(f.asked.length).padStart(4)}  `
          + `bytes ${String(f.bytes).padStart(9)}  host ms ${ms.toFixed(0).padStart(5)}  rows ${rows}  [${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}]`,
      )
    }

    await measure('first read (whole)', 'schedule')
    clock += 15 * 60_000
    /* Five things happen: two open changes get commits, an issue is commented on, one is closed, one is filed. */
    const at = new Date(clock - 5 * 60_000).toISOString()
    const openChanges = [...f.items.values()].filter((it) => it.kind === 'change' && it.state === 'open')
    const openIssues = [...f.items.values()].filter((it) => it.kind === 'issue' && it.state === 'open')
    f.touch(openChanges[0]!.number, at, { checks: 'PENDING' })
    f.touch(openChanges[1]!.number, at, { checks: 'PENDING' })
    f.touch(openIssues[3]!.number, at, { comments: 9 })
    f.touch(openIssues[4]!.number, at, { state: 'closed', closedAt: at })
    f.add({ kind: 'issue', state: 'open', createdAt: at, updatedAt: at, closedAt: null, checks: 'SUCCESS', comments: 0 })
    await measure('15 min later, 5 changed', 'schedule')
    clock += 15 * 60_000
    /* Their checks finish without anything else moving. */
    f.items.get(openChanges[0]!.number)!.checks = 'SUCCESS'
    f.items.get(openChanges[1]!.number)!.checks = 'FAILURE'
    await measure('15 min later, CI finished', 'schedule')
    clock += 15 * 60_000
    await measure('15 min later, nothing changed', 'schedule')
    clock += 60_000
    await measure('Refresh all (press)', 'press')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

for (const one of trackers) await bench(one)
