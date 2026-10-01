import { QUIET_ENV } from './updates.ts'

/**
 * Feedback on a module, as GitHub issues in that module's own repository.
 *
 * ## Where the repository comes from
 *
 * The registration's `dir`, then that checkout's `origin`. Never the request:
 * what arrives over the wire is a module id, and a page that could name the
 * repository could file issues anywhere the person's `gh` can reach. A module
 * with no `dir`, no remote, or a remote that is not GitHub gets a sentence.
 *
 * ## Whose account
 *
 * The person's own, through the `gh` they are already logged in to. The host
 * holds no token. "Your feedback" is `--author @me`, so the list is what this
 * person opened there, not everything filed against the module.
 *
 * ## No shell, ever
 *
 * Every call is an argument array handed to `Bun.spawn`, and the body travels
 * on stdin. A title is something a person typed; it is never parsed by a shell.
 */

export type Status = 'open' | 'completed' | 'not planned' | 'closed'

export interface Item {
  number: number
  title: string
  status: Status
  url: string
  updatedAt: string
}

export interface Listing {
  repo: string
  items: Item[]
}

export interface Ran {
  code: number | null
  out: string
  err: string
  /** The program is not installed (spawn failed). */
  missing?: boolean
  timedOut?: boolean
}

/** Runs one program by argv. Injectable so tests never reach the real `gh`. */
export type Runner = (argv: string[], options?: { stdin?: string; timeout?: number }) => Promise<Ran>

export const TIMEOUT_MS = 15_000
export const TITLE_MAX = 200
export const BODY_MAX = 20_000
const LIST_LIMIT = 50
const CACHE_MS = 60_000

/** gh must not ask anything either: a server has no terminal to answer from. */
const GH_ENV = { ...QUIET_ENV, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }

export const spawnRunner: Runner = async (argv, { stdin, timeout = TIMEOUT_MS } = {}) => {
  let child
  try {
    child = Bun.spawn(argv, {
      env: GH_ENV,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    })
  } catch {
    return { code: null, out: '', err: '', missing: true }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeout)
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  return { code, out: out.trim(), err: err.trim(), timedOut }
}

/** `owner/repo` from a GitHub remote URL, or null for anything else. */
export function githubRepo(remote: string): string | null {
  const url = remote.trim()
  const name = '([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\\.git)?/?'
  const forms = [
    new RegExp(`^git@github\\.com:${name}$`),
    new RegExp(`^ssh://git@github\\.com(?::\\d+)?/${name}$`),
    new RegExp(`^https?://(?:[^@/]+@)?github\\.com/${name}$`),
  ]
  for (const form of forms) {
    const match = form.exec(url)
    if (match) return `${match[1]}/${match[2]}`
  }
  return null
}

/** gh's state and reason, as the one word a person reads. */
export function statusOf(state: string, reason: string | null | undefined): Status {
  if (state.toUpperCase() === 'OPEN') return 'open'
  const why = (reason ?? '').toUpperCase()
  if (why === 'COMPLETED') return 'completed'
  if (why === 'NOT_PLANNED') return 'not planned'
  return 'closed'
}

/** The line appended to every issue, so whoever reads it knows what it was about. */
export function footer(context: {
  module: string
  version: string | null
  commit: string | null
  kehikko: string | null
  epic: string | null
}): string {
  const version = context.version ?? 'version unknown'
  const commit = context.commit ? ` (${context.commit})` : ''
  const kehikko = context.kehikko ? `kehikko “${context.kehikko}”` : 'no kehikko'
  return `— Sent from Kehikot · module ${context.module} ${version}${commit} · ${kehikko} · epic ${context.epic ?? 'none'}`
}

export function composeBody(text: string, foot: string): string {
  const said = text.trim()
  return said ? `${said}\n\n${foot}` : foot
}

/** Why gh failed, as a sentence somebody can act on. */
export function ghTrouble(ran: Ran): string {
  if (ran.missing) return 'The GitHub CLI (gh) is not installed, so feedback cannot be read or sent from here.'
  if (ran.timedOut) return `GitHub did not answer within ${TIMEOUT_MS / 1000}s.`
  const said = `${ran.err}\n${ran.out}`
  /* gh exits 4 when it needs a login, and older versions only say so in words. */
  if (ran.code === 4 || /gh auth login|not logged in|authentication/i.test(said)) {
    return 'GitHub CLI is not logged in: run `gh auth login`.'
  }
  return (ran.err || ran.out || 'gh failed and did not say why').split('\n').slice(-2).join(' ')
}

type Found = { ok: true; repo: string; dir: string } | { ok: false; why: string; status: number }

export interface Deps {
  run: Runner
  /** The registration under an id, from the server's last sweep. */
  registration(id: string): { id: string; dir?: string } | null
  /** The module's own version, as its manifest says; null when it cannot be read. */
  version(id: string): Promise<string | null>
  now?(): number
}

export interface Sent {
  module: string
  title: string
  body: string
  kehikko: string | null
  epic: string | null
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; why: string; status: number }

/** One host's feedback desk: the repo lookup, the list cache, and the create. */
export function feedbackDesk(deps: Deps) {
  const now = deps.now ?? Date.now
  const cache = new Map<string, { at: number; items: Item[] }>()

  async function repoOf(id: string): Promise<Found> {
    const registration = deps.registration(id)
    if (!registration) return { ok: false, why: 'No module is registered under that id.', status: 404 }
    if (!registration.dir) {
      return {
        ok: false,
        why: `${id}'s registration names no directory, so there is no repository to send feedback to.`,
        status: 409,
      }
    }
    const ran = await deps.run(['git', '-C', registration.dir, 'remote', 'get-url', 'origin'])
    if (ran.code !== 0 || !ran.out) {
      return { ok: false, why: `${id} has no origin remote, so there is no repository to send feedback to.`, status: 409 }
    }
    const repo = githubRepo(ran.out)
    if (!repo) {
      return { ok: false, why: `${id}'s origin is not on GitHub (${ran.out}), so feedback cannot be filed as an issue.`, status: 409 }
    }
    return { ok: true, repo, dir: registration.dir }
  }

  async function list(id: string): Promise<Outcome<Listing>> {
    const found = await repoOf(id)
    if (!found.ok) return found
    const kept = cache.get(found.repo)
    if (kept && now() - kept.at < CACHE_MS) return { ok: true, value: { repo: found.repo, items: kept.items } }

    const ran = await deps.run([
      'gh', 'issue', 'list',
      '--repo', found.repo,
      '--author', '@me',
      '--state', 'all',
      '--limit', String(LIST_LIMIT),
      '--json', 'number,title,state,stateReason,url,createdAt,updatedAt',
    ])
    if (ran.code !== 0) return { ok: false, why: ghTrouble(ran), status: 502 }
    let rows: unknown
    try {
      rows = JSON.parse(ran.out || '[]')
    } catch {
      return { ok: false, why: 'gh answered with something that is not a list of issues.', status: 502 }
    }
    if (!Array.isArray(rows)) return { ok: false, why: 'gh answered with something that is not a list of issues.', status: 502 }
    const items: Item[] = rows.map((row: Record<string, unknown>) => ({
      number: Number(row.number),
      title: String(row.title ?? ''),
      status: statusOf(String(row.state ?? ''), row.stateReason as string | null),
      url: String(row.url ?? ''),
      updatedAt: String(row.updatedAt ?? row.createdAt ?? ''),
    }))
    cache.set(found.repo, { at: now(), items })
    return { ok: true, value: { repo: found.repo, items } }
  }

  async function create(sent: Sent): Promise<Outcome<{ repo: string; item: Item }>> {
    const found = await repoOf(sent.module)
    if (!found.ok) return found
    const [version, head] = await Promise.all([
      deps.version(sent.module).catch(() => null),
      deps.run(['git', '-C', found.dir, 'rev-parse', '--short', 'HEAD']),
    ])
    const body = composeBody(
      sent.body,
      footer({
        module: sent.module,
        version,
        commit: head.code === 0 && head.out ? head.out : null,
        kehikko: sent.kehikko,
        epic: sent.epic,
      }),
    )
    /* `--title=` as one argument, so a title that starts with a dash is still a
       title; the body goes on stdin so its size and content never meet argv. */
    const ran = await deps.run(
      ['gh', 'issue', 'create', '--repo', found.repo, `--title=${sent.title}`, '--body-file', '-'],
      { stdin: body },
    )
    if (ran.code !== 0) return { ok: false, why: ghTrouble(ran), status: 502 }
    const url = /https:\/\/github\.com\/\S+\/issues\/(\d+)/.exec(ran.out)
    if (!url) return { ok: false, why: `gh did not say where the issue went: ${ran.out || ran.err}`, status: 502 }
    cache.delete(found.repo)
    return {
      ok: true,
      value: {
        repo: found.repo,
        item: {
          number: Number(url[1]),
          title: sent.title,
          status: 'open',
          url: url[0],
          updatedAt: new Date(now()).toISOString(),
        },
      },
    }
  }

  /** `/host/feedback`, GET and POST; null for any other request. */
  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== '/host/feedback') return null
    if (request.method === 'GET') {
      const id = moduleId(url.searchParams.get('module'))
      if (!id) return reply({ error: 'Feedback is asked for about one module.' }, 400)
      const listed = await list(id)
      return listed.ok ? reply(listed.value) : reply({ error: listed.why }, listed.status)
    }
    if (request.method === 'POST') {
      if (Number(request.headers.get('content-length') ?? 0) > BODY_MAX * 4) {
        return reply({ error: 'That feedback is too large to read.' }, 413)
      }
      const checked = readSent(await request.json().catch(() => null))
      if (!checked.ok) return reply({ error: checked.why }, 400)
      const made = await create(checked.value)
      return made.ok ? reply(made.value, 201) : reply({ error: made.why }, made.status)
    }
    return null
  }

  return { repoOf, list, create, route }
}

function moduleId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null
}

/** What a POST must carry, checked one field at a time. */
export function readSent(raw: unknown): { ok: true; value: Sent } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'Feedback is an object with a module, a title and a body.' }
  const body = raw as Record<string, unknown>
  const module = moduleId(body.module)
  if (!module) return { ok: false, why: 'Feedback names one module.' }
  if (typeof body.title !== 'string') return { ok: false, why: 'Feedback needs a title.' }
  /* One line: an issue title with a newline in it is not a title gh will keep. */
  const title = body.title.replace(/\s+/g, ' ').trim()
  if (title.length < 1) return { ok: false, why: 'Feedback needs a title.' }
  if (title.length > TITLE_MAX) return { ok: false, why: `A title is at most ${TITLE_MAX} characters.` }
  const text = body.body ?? ''
  if (typeof text !== 'string') return { ok: false, why: 'The description is text.' }
  if (text.length > BODY_MAX) return { ok: false, why: `A description is at most ${BODY_MAX} characters.` }
  const kehikko =
    typeof body.kehikko === 'string' && body.kehikko.trim() ? body.kehikko.replace(/\s+/g, ' ').trim().slice(0, 200) : null
  const epic = typeof body.epic === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(body.epic) ? body.epic : null
  return { ok: true, value: { module, title, body: text, kehikko, epic } }
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
