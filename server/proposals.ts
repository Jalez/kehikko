import type { FramedModule } from './discover.ts'
import { ghTrouble, githubRepo, type Runner } from './feedback.ts'
import { officialOf, type Official } from './official.ts'

/**
 * Proposing a registered module for the official list.
 *
 * ## What a proposal is
 *
 * An issue in the host's own repository, filled in from what the running
 * module says about itself and from its checkout's remote, so the proposer
 * retypes nothing. Accepting one is a person adding an entry to
 * `modules.json`; nothing here adds it, and nothing about a proposal changes
 * the module on the proposer's machine.
 *
 * ## What cannot be proposed
 *
 * A module already on the list, and a module nobody else could look at: one
 * registered without a directory, with no remote, with a remote that is not
 * GitHub, or with a repository that is not public. Each gets a sentence
 * instead of an issue a reviewer could not follow.
 *
 * ## Whose account, and what reaches a shell
 *
 * `feedback.ts`'s answers, and its runner: the person's own `gh`, an argument
 * array, the body on stdin. The module is named by id and everything else is
 * read on this side.
 */

export interface Deps {
  list: readonly Official[]
  run: Runner
  /** `owner/repo` proposals are filed in: the host's own. */
  repo: string
  /** The registration under an id: where it lives and where it answers. */
  registration(id: string): Promise<{ id: string; dir?: string; url: string } | null>
  /** What the module says it is, when it is answering; null when it is not. */
  manifest(id: string): Promise<FramedModule | null>
  /** What the host calls it when it is not answering. */
  remembered(id: string): { name: string; summary: string; tags: string[] } | null
}

export interface Proposal {
  url: string
  number: number
  /** True when an open proposal for this module was already there, and no second one was filed. */
  existing: boolean
}

export type Outcome = { ok: true; value: Proposal } | { ok: false; why: string; status: number }

export function titleFor(name: string, id: string): string {
  return `Module proposal: ${name} (${id})`
}

function portOf(url: string): number {
  try {
    return Number(new URL(url).port) || 0
  } catch {
    return 0
  }
}

/** The issue, in the shape of `.github/ISSUE_TEMPLATE/module-proposal.md`. */
export function composeProposal(facts: {
  id: string
  repo: string
  port: number
  name: string
  summary: string
  tags: readonly string[]
  module: FramedModule | null
}): string {
  const { module } = facts
  const list = (items: readonly string[]) => (items.length ? items.map((one) => `\`${one}\``).join(', ') : 'none')
  const entry = { id: facts.id, name: facts.name, repo: facts.repo, port: facts.port, tags: facts.tags, summary: facts.summary }
  const declared = module
    ? [
        `- **Uses:** ${list(module.declares.uses)}`,
        `- **Storage:** ${module.declares.storage ? 'keeps data under `.kehikot/`' : 'none'}`,
        `- **Reacts to:** ${list(module.reacts)}`,
        `- **MCP door:** ${module.mcp ? module.mcp.about || 'yes' : 'none'}`,
      ]
    : ['The module was not running when this was filed, so what it declares could not be read.']
  return [
    '## The module',
    '',
    `- **Id:** \`${facts.id}\``,
    `- **Name:** ${facts.name}`,
    `- **Repository:** https://github.com/${facts.repo}`,
    `- **Summary:** ${facts.summary || 'none given'}`,
    `- **Tags:** ${list(facts.tags)}`,
    `- **Version:** ${module?.version ?? 'unknown'}`,
    `- **Protocol:** ${module ? `\`${module.declares.protocol}\`` : 'unknown'}`,
    '',
    '## What it declares',
    '',
    ...declared,
    '',
    '## The entry to add',
    '',
    "Accepting this proposal means adding the entry below to `modules.json`. Nothing about a proposal changes the module on the proposer's machine.",
    '',
    '```json',
    JSON.stringify(entry),
    '```',
    '',
    '— Proposed from Kehikot',
  ].join('\n')
}

export function proposalDesk(deps: Deps) {
  async function propose(id: string): Promise<Outcome> {
    const registration = await deps.registration(id)
    if (!registration) return { ok: false, why: 'No module is registered under that id.', status: 404 }
    if (officialOf(registration.id, deps.list)) {
      return { ok: false, why: `${registration.id} is already on the official module list.`, status: 409 }
    }
    if (!registration.dir) {
      return { ok: false, why: `${registration.id} is registered without a directory, so there is no repository to propose.`, status: 409 }
    }
    const remote = await deps.run(['git', '-C', registration.dir, 'remote', 'get-url', 'origin'])
    const repo = remote.code === 0 && remote.out ? githubRepo(remote.out) : null
    if (!repo) {
      return {
        ok: false,
        why: `${registration.id} has no public repository on GitHub — its checkout has no GitHub origin — so there is nothing a reviewer could look at. Push it somewhere public first.`,
        status: 409,
      }
    }
    const seen = await deps.run(['gh', 'repo', 'view', repo, '--json', 'visibility'])
    if (seen.code !== 0) return { ok: false, why: ghTrouble(seen), status: 502 }
    if (!/"visibility"\s*:\s*"PUBLIC"/i.test(seen.out)) {
      return { ok: false, why: `${repo} is not public, so a reviewer could not look at it. Make the repository public first.`, status: 409 }
    }

    const module = await deps.manifest(registration.id).catch(() => null)
    const remembered = deps.remembered(registration.id)
    const name = module?.name ?? remembered?.name ?? registration.id
    const title = titleFor(name, registration.id)

    /* One open proposal per module. The id is what is matched, because a
       module can be renamed between two presses and is still the same one. */
    const open = await deps.run([
      'gh', 'issue', 'list',
      '--repo', deps.repo,
      '--state', 'open',
      '--search', `"Module proposal:" "(${registration.id})" in:title`,
      '--json', 'number,title,url',
    ])
    if (open.code !== 0) return { ok: false, why: ghTrouble(open), status: 502 }
    try {
      const rows = JSON.parse(open.out || '[]') as { number: number; title: string; url: string }[]
      const already = rows.find((row) => row.title.startsWith('Module proposal:') && row.title.endsWith(`(${registration.id})`))
      if (already) return { ok: true, value: { url: already.url, number: already.number, existing: true } }
    } catch {
      return { ok: false, why: 'gh answered with something that is not a list of issues.', status: 502 }
    }

    const body = composeProposal({
      id: registration.id,
      repo,
      port: portOf(registration.url),
      name,
      summary: module?.summary ?? remembered?.summary ?? '',
      tags: module?.tags ?? remembered?.tags ?? [],
      module,
    })
    const made = await deps.run(['gh', 'issue', 'create', '--repo', deps.repo, `--title=${title}`, '--body-file', '-'], { stdin: body })
    if (made.code !== 0) return { ok: false, why: ghTrouble(made), status: 502 }
    const url = /https:\/\/github\.com\/\S+\/issues\/(\d+)/.exec(made.out)
    if (!url) return { ok: false, why: `gh did not say where the proposal went: ${made.out || made.err}`, status: 502 }
    return { ok: true, value: { url: url[0], number: Number(url[1]), existing: false } }
  }

  /** `POST /host/official/propose`; null for any other request. */
  async function route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== '/host/official/propose' || request.method !== 'POST') return null
    const body = (await request.json().catch(() => null)) as { module?: unknown } | null
    if (!body || typeof body.module !== 'string' || !body.module || body.module.length > 64) {
      return reply({ error: 'A proposal names one registered module.' }, 400)
    }
    const made = await propose(body.module)
    return made.ok ? reply(made.value, made.value.existing ? 200 : 201) : reply({ error: made.why }, made.status)
  }

  return { propose, route }
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
