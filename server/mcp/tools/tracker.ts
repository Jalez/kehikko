import { LIMITS, methodParams, type TrackerRow } from 'kehikot-module-protocol'

import { READS_DEFAULT, readsOf, writtenReads } from '../../../src/host/trackerReads.ts'
import { listingText, rolesOf, sourceName } from '../../../src/host/trackerSources.ts'
import type { Canvas } from '../../canvases.ts'
import { projectById } from '../../projects.ts'
import type { Edit } from '../../trackers/edit.ts'
import type { Door } from '../door.ts'
import { KEHIKKO_PROPERTY } from '../params.ts'
import { kehikkoTool } from '../tool.ts'
import { missingSaid } from '../words.ts'

export const readTracker = kehikkoTool({
  name: 'read_tracker',
  schema: {
    description:
      'What GitHub and GitLab last said about issues, merge requests and pull requests in the project a kehikko '
      + 'is standing in — the one reading every module on the canvas shows, read with the person’s own logged-in '
      + 'gh and glab. Name refs (e.g. "gh#41", "#2274", "!1848", "gh:owner/repo#12"), or a top-level space (epic, its older name), or neither for '
      + 'the whole project. Says when the reading is from and which sources failed. refresh: true reads the '
      + 'trackers again first and waits for it, which every module on the canvas then sees; leave it off to '
      + 'answer from what was last read.',
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        refs: { type: 'array', items: { type: 'string' }, description: `Up to ${LIMITS.TRACKER_ASK} refs.` },
        epic: { type: 'string', description: 'Older name, still accepted: a top-level space’s id (an epic’s slug) — every ref it names.' },
        refresh: { type: 'boolean', description: 'Read the trackers again before answering.' },
        whole: {
          type: 'boolean',
          description:
            'For a conversation that belongs to a space, where leaving out refs reads its top-level space: true '
            + 'reads the whole project instead.',
        },
      },
    },
  },
  run: ({ door, canvas }, args) => readTrackerAt(canvas, args, door),
})

export const setTrackerSource = kehikkoTool({
  name: 'set_tracker_source',
  schema: {
    description:
      'Change which repositories the project’s trackers read — one edit per call. The sources are where '
      + 'references like gh#41 or !7 are looked up, and every module that shows issues or changes reads from '
      + 'them (read_tracker lists them and what each is for). action "add" takes a repository link '
      + '(https://github.com/owner/repo, git@host:group/proj.git) or owner/repo with tracker (and host for a '
      + 'self-hosted GitLab); "default" makes a source the one short spellings mean for its tracker (value: '
      + 'false does not leave a tracker without one); "list" sets whether its recent issues and changes are '
      + 'listed; "reads" narrows what a listed source\'s listing reads — kinds (issues, tasks, changes), closed '
      + '(false: open only; a number: open and closed within that many days; true: every state) and since (only '
      + 'what changed since the last read), each kept as it is when left out; a ref somebody names is still read; '
      + '"off" stops reading a repository a git remote names (value: false turns it back on); "remove" '
      + 'takes out a source somebody added. A source named by a git remote cannot be removed, only turned off. '
      + 'This cannot log anybody in: if gh or glab is not logged in, the person must run its auth login in a '
      + 'terminal once. Writes .kehikot/host/trackers.json in the project; every container is told.',
    inputSchema: {
      type: 'object',
      properties: {
        ...KEHIKKO_PROPERTY,
        action: { type: 'string', enum: ['add', 'remove', 'default', 'list', 'off', 'reads'] },
        source: {
          type: 'string',
          description: 'For add: a repository link or owner/repo. For the rest: a source as read_tracker names it (owner/repo or host/group/project).',
        },
        tracker: { type: 'string', enum: ['github', 'gitlab'], description: 'For add of owner/repo, or a link on a host that does not say.' },
        host: { type: 'string', description: 'For add of owner/repo on a self-hosted GitLab.' },
        value: { type: 'boolean', description: 'For default, list and off: on (default true) or off. For add: whether to make it the default.' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['issues', 'tasks', 'changes'] },
          description: 'For reads: the kinds its listing reads (tasks: a GitLab work item type; changes: merge or pull requests).',
        },
        closed: {
          type: ['boolean', 'integer'],
          description: 'For reads: false reads open items only; a number of days (1 to 3650) also reads what closed or merged within it; true reads every state.',
        },
        since: { type: 'boolean', description: 'For reads: read only what changed since the last read, merged into what is held.' },
      },
      required: ['action', 'source'],
    },
    annotations: {
      title: 'Change the tracker sources',
      /* It writes the project's trackers.json. */
      readOnlyHint: false,
      /* Only `remove` takes anything out, and a hint cannot vary by argument; it is the one that can lose a person's choice. */
      destructiveHint: true,
      /* Setting a flag twice is the same file; adding twice is one source. */
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  run: ({ door, canvas }, args) => setTrackerSourceAt(canvas, args, door),
})

/**
 * One row of the tracker reading as `read_tracker` says it: state, pipeline,
 * review, board column, (protocol 2.7.0) the reviewers, the person's roles,
 * the review threads and the last push, (2.8.0) the branches, the stack
 * and the last activity, (2.11.0) a GitLab issue's work item type and
 * (2.19.0) an issue's linked branches, and (2.26.0) the work that is part
 * of an issue — `#12 issue (task) open` — each only when the row has it.
 */
export function trackerLine(row: TrackerRow): string {
  return `${row.ref} ${row.kind}${row.workItem ? ` (${row.workItem.replace(/_/g, ' ')})` : ''} ${row.state}${row.stateReason ? ` (${row.stateReason.toLowerCase()})` : ''}`
    + `${row.draft ? ' draft' : ''}${row.pipeline ? ` pipeline:${row.pipeline}` : ''}${row.review ? ` review:${row.review}` : ''}`
    + `${(row.columns ?? (row.column ? [row.column] : [])).map((c) => ` column:"${c.name}" on "${c.board}"`).join('')}`
    + `${row.reviewers?.length ? ` reviewers:${row.reviewers.map((r) => `${r.login}(${r.state})`).join(',')}` : ''}`
    + `${row.myRoles?.length ? ` my roles:${row.myRoles.join(',')}` : ''}`
    + `${row.discussions ? ` threads:${row.discussions.unresolved} unresolved,${row.discussions.resolved} resolved` : ''}`
    + `${row.lastPushAt ? ` pushed:${row.lastPushAt}` : ''}`
    + `${row.baseBranch ? ` base:${row.baseBranch}` : ''}${row.headBranch ? ` head:${row.headBranch}` : ''}`
    + `${row.branches?.length ? ` linked branches:${row.branches.map((b) => b.name).join(',')}` : ''}`
    + `${row.stack ? ` stack:${row.stack.below ? `on ${row.stack.below}` : 'bottom'}${row.stack.above.length ? `,under ${row.stack.above.join('+')}` : ''}` : ''}`
    + `${row.lastActivity ? ` last:${row.lastActivity.kind} by ${row.lastActivity.login}${row.lastActivity.mine === true ? ' (me)' : row.lastActivity.mine === false ? ' (not me)' : ''} at ${row.lastActivity.at}` : ''}`
    + ` — ${row.title}${tiesOf(row)}`
}

/**
 * A row's ties to other refs, in brackets: its closing links as the protocol
 * words them (`closes #12`, `closed-by !7`), then the work that is only part of
 * an issue (protocol 2.26.0) — `contributes to #12` on the change,
 * `has contributions from !7` on the issue. Never one for the other.
 */
function tiesOf(row: TrackerRow): string {
  const ties = [
    ...row.links.map((l) => `${l.relation} ${l.ref}`),
    ...(row.contributes ?? []).map((ref) => `contributes to ${ref}`),
    ...(row.contributedBy?.length ? [`has contributions from ${row.contributedBy.join(', ')}`] : []),
  ]
  return ties.length ? ` [${ties.join(', ')}]` : ''
}

/**
 * The shared tracker reading, for an agent: the same rows a module gets from
 * `tracker.get`, as lines. A read of the host's material, plus — with
 * `refresh` — the same read a person's "Refresh all" starts.
 */
async function readTrackerAt(
  canvas: Canvas,
  args: Record<string, unknown>,
  door: Door,
): Promise<{ text: string; failed: boolean }> {
  if (!door.trackers) return { text: 'This host has no tracker reading to answer from.', failed: true }
  const project = canvas.project === null ? null : projectById(door.db, canvas.project)
  if (!project) {
    return { text: `kehikko ${canvas.id} (${canvas.name}) is in no project, so there is no tracker reading for it. Pass project (a project’s folder, name or id) to act on any project this host knows.`, failed: true }
  }
  if (project.missing) return { text: missingSaid(project), failed: true }
  /* A conversation that belongs to an epic of this project reads that epic unless it asks for more. */
  const here = door.here && door.here.project.id === project.id && door.here.epic ? door.here : null
  const ownEpic = args.refs === undefined && args.epic === undefined && args.whole !== true && here ? here.epic : null
  const asked = methodParams['tracker.get'].safeParse(
    args.refs !== undefined ? { refs: args.refs } : args.epic !== undefined ? { epic: args.epic } : ownEpic ? { epic: ownEpic } : { project: true },
  )
  if (!asked.success) {
    const issue = asked.error.issues[0]
    return { text: `nothing was read — ${issue?.path.join('.') || 'the call'}: ${issue?.message ?? 'malformed'}.`, failed: true }
  }
  const scope = Array.isArray(asked.data.refs)
    ? { refs: asked.data.refs }
    : asked.data.epic
      ? { epic: asked.data.epic }
      : { project: true as const }
  let refreshed = ''
  if (args.refresh === true) {
    const result = await door.trackers.refresh(project.path, scope, 'asked')
    /* Forgotten while it was read: asking the reading now would hold the project, and write there, again. */
    if (!projectById(door.db, project.id)) {
      return { text: `${project.name} is no longer on the project list, so there is no tracker reading for it.`, failed: true }
    }
    refreshed =`Refreshed: ${result.outcome}${result.why ? ` — ${result.why.replace(/\.$/, '')}` : ''}.\n`
  }
  const reading = door.trackers.get(project.path, scope, 'summary')
  if ('refused' in reading) return { text: reading.refused, failed: true }
  const sources = reading.sources
    .map((s) => `${s.tracker} ${s.host}/${s.repo}${s.default ? ' (default)' : ''}: ${s.error ? `FAILED — ${s.error}` : s.at ? `read ${s.at}` : 'never read'}`)
    .join('\n')
  const shown = reading.rows.slice(0, 300)
  const listing = door.trackers.describe ? await door.trackers.describe(project.path) : null
  return {
    text:
      `${ownEpic ? `This conversation's top-level space, ${ownEpic}: the refs it names. whole: true reads the whole project.\n` : ''}${refreshed}${listing ? `${listingText(listing, Date.now())}\n\n` : ''}Tracker reading for ${project.name}, ${reading.at ? `last changed ${reading.at}` : 'never read'}`
      + `${reading.refreshing ? ' (a read is running now)' : ''}.\n${sources || 'No sources.'}\n\n`
      + (shown.length ? shown.map(trackerLine).join('\n') : 'No rows.')
      + (reading.rows.length > shown.length ? `\n…and ${reading.rows.length - shown.length} more.` : '')
      + (reading.missing.length ? `\n\nNot in the reading: ${reading.missing.map((m) => `${m.ref} (${m.reason})`).join(', ')}.` : ''),
    failed: false,
  }
}

/**
 * `set_tracker_source`: one edit of the project's tracker sources, through the
 * same writer the page's panel uses, refused in the same sentences. It cannot
 * log in to `gh` or `glab`, and says so where that is what is missing.
 */
async function setTrackerSourceAt(
  canvas: Canvas,
  args: Record<string, unknown>,
  door: Door,
): Promise<{ text: string; failed: boolean }> {
  const trackers = door.trackers
  if (!trackers?.edit || !trackers.describe) return { text: 'This host has no tracker sources to change.', failed: true }
  const project = canvas.project === null ? null : projectById(door.db, canvas.project)
  if (!project) return { text: `kehikko ${canvas.id} (${canvas.name}) is in no project, so there are no tracker sources to change. Pass project (a project’s folder, name or id) to act on any project this host knows.`, failed: true }
  if (project.missing) return { text: missingSaid(project), failed: true }
  const action = args.action
  const source = typeof args.source === 'string' && args.source.length <= 600 ? args.source.trim() : ''
  if (action !== 'add' && action !== 'remove' && action !== 'default' && action !== 'list' && action !== 'off' && action !== 'reads') {
    return { text: 'set_tracker_source needs action: add, remove, default, list, off or reads.', failed: true }
  }
  if (!source) return { text: 'set_tracker_source needs source: a repository link or owner/repo.', failed: true }
  const tracker = args.tracker === 'github' || args.tracker === 'gitlab' ? args.tracker : undefined
  const host = typeof args.host === 'string' && args.host.length <= 253 ? args.host : undefined
  const value = typeof args.value === 'boolean' ? args.value : undefined

  let edit: Edit
  if (action === 'add') {
    edit = { kind: 'add', input: source, ...(tracker ? { tracker } : {}), ...(host ? { host } : {}), ...(value ? { default: true } : {}) }
  } else {
    const now = await trackers.describe(project.path)
    if (now.broken) return { text: `${now.broken.file} will not read (${now.broken.why}); the person can start it fresh in Settings › Trackers. Nothing was changed.`, failed: true }
    const wanted = source.toLowerCase()
    const found = now.sources.filter((s) => {
      const name = sourceName(s).toLowerCase()
      return name === wanted || s.repo.toLowerCase() === wanted || `${s.host}/${s.repo}`.toLowerCase() === wanted
    })
    if (found.length !== 1) {
      return {
        text:
          `${found.length ? 'More than one source answers to that' : `No source is called "${source}"`}. The sources are: `
          + `${now.sources.map((s) => `${s.tracker} ${s.host}/${s.repo}`).join(', ') || 'none'}. Nothing was changed.`,
        failed: true,
      }
    }
    const one = found[0]!
    const key = { tracker: one.tracker, host: one.host, repo: one.repo }
    if (action === 'reads') {
      /* The choices not given stay as they are. */
      const was = readsOf(one.reads ?? {}) ?? READS_DEFAULT
      const next = readsOf({
        kinds: args.kinds ?? was.kinds,
        closed: args.closed ?? was.closed,
        since: args.since ?? was.since,
      })
      if (!next) {
        return { text: 'reads takes kinds (any of issues, tasks, changes; at least one), closed (true, false or 1 to 3650 days) and since (true or false). Nothing was changed.', failed: true }
      }
      edit = { kind: 'set', ...key, reads: writtenReads(next) }
    } else {
      edit =
        action === 'remove'
          ? { kind: 'remove', ...key }
          : action === 'default'
            ? { kind: 'set', ...key, default: value ?? true }
            : action === 'list'
              ? { kind: 'set', ...key, list: value ?? true }
              : { kind: 'set', ...key, off: value ?? true }
    }
  }
  const done = await trackers.edit(project.path, edit)
  if (done.outcome === 'declined') return { text: `${done.why} Nothing was changed.`, failed: true }
  const roles = done.listing.sources
    .map((s) => `- ${s.tracker} ${sourceName(s)}: ${rolesOf(s).join('; ')}.`)
    .join('\n')
  return {
    text:
      `${done.outcome === 'unchanged' ? done.said || done.why : done.said} The sources now:\n${roles || 'none'}\n`
      + 'The host is reading them again; read_tracker has what came of it. This tool cannot log in to gh or glab: '
      + 'if a source fails as not logged in, the person has to run its auth login in a terminal once.',
    failed: false,
  }
}
