/**
 * Whether an official module's newest release needs a protocol this host does
 * not speak. Such a release is out of reach of every released app: Updates
 * says "needs a newer Kehikot" until the host's pin is bumped and the app
 * released. The order is the other way: bump the host pin and release the app
 * FIRST, then release the module.
 *
 *   bun dev/protocol-ahead.ts [report.md]
 *
 * Reads the host's pin (package.json) and each entry of `modules.json`: the
 * newest published release of its repository and the protocol that release's
 * package.json pins, through the person's or the job's `gh`. Writes the report
 * to the file given (or stdout) and exits 3 when some release is ahead of the
 * host, 0 when none is. A repository that cannot be read is listed as unread,
 * never as ahead. Names come from `modules.json`; no module is named here.
 *
 * It WARNS (a scheduled workflow opens an issue; the desktop release prints a
 * warning) and never blocks: an app release that fixes something else should
 * not wait for a module's bump, and the issue is what makes the bump happen.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { protocolPin } from '../server/moduleReleases.ts'
import { compareVersions, protocolSaid } from '../src/host/worksWith.ts'

const ROOT = join(import.meta.dir, '..')

export interface Latest {
  tag: string
  /** The `package.json` of that tag, or null when it has none. */
  pkg: string | null
}

export interface Entry {
  id: string
  name: string
  repo: string
}

export interface Ahead {
  name: string
  repo: string
  tag: string
  pin: string
}

export interface Found {
  host: string
  ahead: Ahead[]
  /** Entries whose newest release could not be read (private, no releases, offline). */
  unread: string[]
}

/** Every entry's newest release against the host's pin. `latest` is null for "no release / unreadable". */
export async function look(host: string, entries: readonly Entry[], latest: (repo: string) => Promise<Latest | null>): Promise<Found> {
  const ahead: Ahead[] = []
  const unread: string[] = []
  for (const entry of entries) {
    let read: Latest | null = null
    try {
      read = await latest(entry.repo)
    } catch {
      read = null
    }
    if (!read) {
      unread.push(entry.name)
      continue
    }
    const pin = protocolPin(read.pkg)
    if (pin && compareVersions(pin, host) > 0) ahead.push({ name: entry.name, repo: entry.repo, tag: read.tag, pin })
  }
  return { host, ahead, unread }
}

/** The protocol the host has to reach: the newest one any release in `ahead` pins. */
export function neededOf(found: Found): string {
  return found.ahead.map((one) => one.pin).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))
}

/** The issue: a title and a body, or null when nothing is ahead. The names are the list's data. */
export function reportOf(found: Found): { title: string; body: string } | null {
  if (found.ahead.length === 0) return null
  const need = neededOf(found)
  const first = found.ahead[0]!
  const more = found.ahead.length > 1 ? ` and ${found.ahead.length - 1} more` : ''
  const lines = [
    `Kehikot speaks protocol ${protocolSaid(found.host)}, but the newest release of ${found.ahead.length === 1 ? 'a module' : `${found.ahead.length} modules`} needs a newer one. Updates tells a person "needs a newer Kehikot" for each until the host pin is bumped and the app released.`,
    '',
    ...found.ahead.map((one) => `- ${one.name} ${one.tag.replace(/^v/, '')} (${one.repo}) pins protocol ${protocolSaid(one.pin)}`),
    '',
    `Bump the \`kehikot-module-protocol\` pin in \`package.json\` to ${need} or later and release the app first; a module's release that pins a new protocol waits for it.`,
  ]
  if (found.unread.length) lines.push('', `Not read this time: ${found.unread.join(', ')}.`)
  return { title: `Kehikot speaks protocol ${protocolSaid(found.host)} but ${first.name} ${first.tag.replace(/^v/, '')}${more} needs ${protocolSaid(need)}: bump the host pin`, body: lines.join('\n') }
}

/** The newest release of a repository and its package.json at that tag, through `gh`. Null when either cannot be read. */
async function ghLatest(repo: string): Promise<Latest | null> {
  const gh = async (...args: string[]) => {
    const run = Bun.spawn(['gh', 'api', ...args], { stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(run.stdout).text()
    return (await run.exited) === 0 ? out : null
  }
  const tag = (await gh(`repos/${repo}/releases/latest`, '--jq', '.tag_name'))?.trim()
  if (!tag) return null
  const pkg = await gh('-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/package.json?ref=${encodeURIComponent(tag)}`)
  return { tag, pkg }
}

/** The host's own pin and the list's entries, from the host checkout at `root`. */
export function readHost(root = ROOT): { host: string; entries: Entry[] } {
  const host = protocolPin(readFileSync(join(root, 'package.json'), 'utf8'))
  if (!host) throw new Error('package.json does not pin the protocol package')
  const list = JSON.parse(readFileSync(join(root, 'modules.json'), 'utf8')) as { modules?: Entry[] } | Entry[]
  return { host, entries: Array.isArray(list) ? list : (list.modules ?? []) }
}

if (import.meta.main) {
  const { host, entries } = readHost()
  const report = reportOf(await look(host, entries, ghLatest))
  const text = report ? `${report.title}\n\n${report.body}\n` : `Kehikot speaks protocol ${protocolSaid(host)}: no module's newest release needs more.\n`
  const out = process.argv[2]
  if (out) writeFileSync(out, text)
  else process.stdout.write(text)
  process.exit(report ? 3 : 0)
}
