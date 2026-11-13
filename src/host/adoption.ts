import { confidentMatch, sameConversationPlace, type ConversationCandidate, type ConversationPlace } from 'kehikot-module-protocol'

/**
 * Adopting a tracker item no epic names (protocol 2.88.0): the rules, pure, shared by the server
 * (`server/adoption.ts`, which reads and writes) and the page (the dialog's words).
 *
 * ## Suggested, never adopted
 *
 * The host suggests an epic when it can tell — the item's branch meets a change an epic names, or its
 * repository is the one an epic's other refs (or its own `repo`) are in — and says why. `sure` only
 * when exactly one epic matches at the strongest kind of match found: then a page may offer it as
 * one press. Nothing here adopts.
 *
 * ## Brought along by itself, only when sure
 *
 * After the person adopts, every conversation that confidently worked on the item (`confidentMatch`:
 * created it, pushed its branch, worked on that branch) and is filed under NO place is brought to the
 * epic by the agent module that runs it (`toBring`). A weak match is never brought; one filed under
 * another place is never moved and is said instead.
 */

/** What is known of the item being adopted. */
export interface AdoptingItem {
  ref: string
  host: string
  repo: string
  branch?: string
}

/** One epic, as far as a suggestion reads it: its refs, and the repository its own file names. */
export interface EpicForAdoption {
  epic: string
  title: string
  refs: readonly string[]
  /** `repo` in the epic's own file, when it names one (owner/name or a group path). */
  repo?: string
}

/** A row of the project's tracker reading, as far as a suggestion reads it. */
export interface RowForAdoption {
  ref: string
  host: string
  repo: string
  headBranch?: string
  baseBranch?: string
}

export interface Suggestion {
  epic: string
  parts: string[]
  why: string
  sure: boolean
}

const lower = (text: string | undefined) => (text ?? '').toLowerCase()

/**
 * The epic to suggest for an item, or null when none can be told. Branch first (a change an epic names
 * comes from, or goes into, the item's branch), then the repository (an epic's ref read in the same
 * repository, or the repository its file names).
 */
export function suggestEpic(item: AdoptingItem, epics: readonly EpicForAdoption[], rows: readonly RowForAdoption[]): Suggestion | null {
  const byRef = new Map<string, RowForAdoption>()
  for (const row of rows) if (!byRef.has(row.ref)) byRef.set(row.ref, row)
  const sameRepo = (row: RowForAdoption) => lower(row.host) === lower(item.host) && lower(row.repo) === lower(item.repo)
  const branchMatches: { epic: EpicForAdoption; why: string }[] = []
  const repoMatches: { epic: EpicForAdoption; why: string }[] = []
  for (const epic of epics) {
    const theirs = epic.refs.filter((ref) => ref !== item.ref).flatMap((ref) => {
      const row = byRef.get(ref)
      return row ? [row] : []
    })
    const branchy = item.branch
      ? theirs.find((row) => sameRepo(row) && (row.headBranch === item.branch || row.baseBranch === item.branch))
      : undefined
    if (branchy) {
      branchMatches.push({ epic, why: `its branch ${item.branch} meets ${branchy.ref}, which ${epic.title} names` })
      continue
    }
    if (theirs.some(sameRepo)) repoMatches.push({ epic, why: `${epic.title} names other changes in ${item.repo}` })
    else if (epic.repo && lower(epic.repo) === lower(item.repo)) repoMatches.push({ epic, why: `${epic.title} is about ${item.repo}` })
  }
  const pick = branchMatches.length ? branchMatches : repoMatches
  const first = pick[0]
  if (!first) return null
  return { epic: first.epic.epic, parts: [], why: first.why, sure: pick.length === 1 }
}

/** The conversations adopting brings along by itself: confident, and filed under no place. */
export function toBring<T extends Pick<ConversationCandidate, 'match' | 'place'>>(candidates: readonly T[]): T[] {
  return candidates.filter((one) => confidentMatch(one.match) && one.place === null)
}

/** Whether a candidate is filed under a place other than `to`: never moved, said instead. */
export const elsewhere = (one: Pick<ConversationCandidate, 'place'>, to: ConversationPlace): boolean =>
  one.place !== null && !sameConversationPlace(one.place, to)

/** What became of one conversation when an item was adopted. */
export interface BroughtOne {
  program: string
  outcome: 'brought' | 'elsewhere' | 'failed'
}

/**
 * The item's line after it was adopted: "Added to Auth · its <program> conversation came along",
 * "Added to Auth › Login · 2 <program> conversations came along", "… · one of its conversations is
 * filed elsewhere and stayed there".
 */
export function adoptedSaid(epicTitle: string, partNames: readonly string[], brought: readonly BroughtOne[]): string {
  const where = partNames.length ? `${epicTitle} › ${partNames.join(', ')}` : epicTitle
  const out = [`Added to ${where}`]
  const came = brought.filter((one) => one.outcome === 'brought')
  if (came.length) {
    const programs = [...new Set(came.map((one) => one.program))]
    const program = programs.length === 1 ? `${programs[0]} ` : ''
    out.push(came.length === 1 ? `its ${program}conversation came along` : `${came.length} ${program}conversations came along`)
  }
  const stayed = brought.filter((one) => one.outcome === 'elsewhere').length
  if (stayed) out.push(stayed === 1 ? 'one of its conversations is filed elsewhere and stayed there' : `${stayed} of its conversations are filed elsewhere and stayed there`)
  const failed = brought.filter((one) => one.outcome === 'failed').length
  if (failed) out.push(failed === 1 ? 'one conversation could not be brought' : `${failed} conversations could not be brought`)
  return out.join(' · ')
}

/** "Not tracked: !4721", the item's line after "Don't track this". */
export const untrackedSaid = (ref: string): string => `Not tracked: ${ref}. Kehikot tells you nothing more about it here.`

/** A candidate's place in words, for the page. */
export function placeSaid(place: ConversationPlace | null, epicTitle: (slug: string) => string | null): string | null {
  if (!place) return null
  const epic = place.epic ? (epicTitle(place.epic) ?? place.epic) : 'no epic'
  return place.parts.length ? `${epic} › ${place.parts.join(', ')}` : epic
}

/**
 * The prompt an agent is started with to place a tracker item (`startAgentSession` in
 * `server/agentSession.ts`): what the person would type in a new session. Short on purpose — the
 * item, what adopting means, and the Kehikot tools the agent finds the rest with: the spaces
 * (`my_place`, `read_canvas`), the item (`read_inbox`, `read_tracker`), the conversations that worked
 * on it (its own session history), and the one tool that proposes (`propose_adoption`). Every tool
 * takes `project`, so the agent can act on this project from any conversation.
 */
export function adoptPrompt(input: { project: string; kehikko: string | null; item: { ref: string; title: string; url: string; repo: string; host: string } }): string {
  const item = input.item
  const where = item.host && item.repo ? ` in ${item.host}/${item.repo}` : ''
  return [
    `Please adopt ${item.ref}${where} into a space of the Kehikot project at ${input.project}.`,
    `It is “${item.title}”${item.url ? `: ${item.url}` : ''}.`,
    '',
    'Adopting means choosing the space (at any depth) this item belongs to, and the earlier conversations that worked on it, so they are filed together. No space names it yet.',
    '',
    `Use Kehikot’s tools, passing project: "${input.project}"${input.kehikko ? ` (this kehikko is "${input.kehikko}")` : ''}:`,
    '- my_place and read_canvas for the project’s spaces;',
    `- read_inbox and read_tracker (refs: ["${item.ref}"]) for the item and its activity;`,
    '- your own session history for conversations that worked on it (its ref, URL or branch);',
    `- then propose_adoption with ref "${item.ref}", the space (epic and parts), the conversations’ session ids and a one-sentence why.`,
    '',
    'propose_adoption only proposes: the person confirms in Kehikot with one press. Do not edit Kehikot’s files yourself.',
  ].join('\n')
}

/** What the adoption dialog offers, from what the host read and whether an agent is working on it. */
export interface DialogPlan {
  /** `agent`: the person's agent is shown working and proposes; `picker`: the person chooses. */
  mode: 'agent' | 'picker'
  /** The one press, when there is something to confirm: the agent's proposal, else nothing (agent) or the suggestion (picker). */
  confirm: { epic: string; parts: string[]; label: string; conversations: string[] } | null
}

/**
 * The dialog's plan. With an agent picked, the agent's proposal is the one press — never before it
 * proposes; without one, the picker, with the host's suggestion chosen. A proposal naming an epic the
 * project does not have is not offered.
 */
export function dialogPlan(read: {
  epics: readonly { epic: string; title: string; parts: readonly { id: string; name: string }[] }[]
  suggested: { epic: string; parts: readonly string[] } | null
  agent: { module: string; name: string } | null
  proposal: { epic: string; parts: readonly string[]; conversations: readonly string[] } | null
  conversations: readonly { session: string; title: string; program: string }[]
}): DialogPlan {
  const words = (epic: string, parts: readonly string[], sessions: readonly string[]) => {
    const target = read.epics.find((one) => one.epic === epic)
    if (!target) return null
    const names = parts.map((part) => target.parts.find((one) => one.id === part)?.name ?? part)
    const brought = sessions.flatMap((session) => read.conversations.filter((one) => one.session === session))
    const where = names.length ? `${target.title} › ${names.join(', ')}` : target.title
    if (!brought.length) return `Adopt into ${where}`
    const one = brought[0]!
    return `Adopt into ${where} · bring ${one.title || 'its conversation'} (${one.program})${brought.length > 1 ? ` and ${brought.length - 1} more` : ''}`
  }
  if (read.agent) {
    const p = read.proposal
    const label = p ? words(p.epic, p.parts, p.conversations) : null
    return { mode: 'agent', confirm: p && label ? { epic: p.epic, parts: [...p.parts], label, conversations: [...p.conversations] } : null }
  }
  const s = read.suggested
  const label = s ? words(s.epic, s.parts, []) : null
  return { mode: 'picker', confirm: s && label ? { epic: s.epic, parts: [...s.parts], label, conversations: [] } : null }
}

/**
 * Which conversations the dialog lists, and which it folds. Only confident matches (`created`,
 * `pushed`, `branch`) and the ones an agent's proposal names are listed, at most `most`; every other
 * one — a conversation that only mentioned the item or worked in the same repository — is folded under
 * one line the person can open. A busy repository otherwise filled the dialog with twenty of them.
 */
export function conversationRows<T extends { session: string; match: string }>(
  conversations: readonly T[],
  proposed: readonly string[] = [],
  most = 3,
): { shown: T[]; folded: T[]; foldedSaid: string | null } {
  const strong = conversations.filter((one) => CONFIDENT.has(one.match) || proposed.includes(one.session))
  const shown = strong.slice(0, most)
  const folded = conversations.filter((one) => !shown.includes(one))
  const n = folded.length
  return { shown, folded, foldedSaid: n === 0 ? null : n === 1 ? 'One other conversation worked in this repository' : `${n} other conversations worked in this repository` }
}

const CONFIDENT = new Set(['created', 'pushed', 'branch'])

/* ---- which agent does the task ---- */

/**
 * Which agent starts the conversation for an adoption (protocol 2.88.0, `agent.tasks`), on the
 * kehikko the person is on: its PRIMARY agent (Kehikko settings; the only agent module there is
 * implicitly primary), when it provides `agent.tasks`. Otherwise the one agent module there that
 * does, when only one does. With two or more and none primary, the person is asked (`choose`, with the
 * cubes of the primary dialog), and their choice becomes the kehikko's primary agent. None: the picker
 * alone.
 *
 * `onKehikko`: the agent modules placed there, in order. `providers`: the modules providing
 * `agent.tasks` now. `primary`: the chosen primary, as kept (null when none).
 */
export interface TaskAgentPick {
  agent: string | null
  choose: string[]
}

export function taskAgentFor(onKehikko: readonly string[], providers: readonly string[], primary: string | null): TaskAgentPick {
  const able = onKehikko.filter((one) => providers.includes(one))
  const shown = onKehikko.length === 1 ? onKehikko[0]! : primary !== null && onKehikko.includes(primary) ? primary : null
  if (shown !== null && able.includes(shown)) return { agent: shown, choose: [] }
  if (able.length === 1) return { agent: able[0]!, choose: [] }
  if (able.length > 1) return { agent: null, choose: able }
  return { agent: null, choose: [] }
}

/** What the person is told above the cubes when an adoption has to ask which agent. */
export const TASK_AGENT_SAID = {
  title: 'Which agent should place it?',
  lede: 'More than one agent on this kehikko can work out where an item belongs.',
  becomes:
    'The one you choose becomes this kehikko’s primary agent: it also gets the kehikko’s shared news, such as tracker news about the epic. You can change this in Kehikko settings.',
  confirm: 'Choose and start',
  self: 'I’ll choose a space myself',
} as const

/**
 * Where "Adopt with…" (`inbox.adoptWith`) leads, from what the adoption read says — never a dead end:
 * the dialog with the agent (or the choice of agent in it), the update an agent module there needs
 * before it can help, or the module list to add an agent module. `none` only where nothing is known:
 * no kehikko, or an older host's answer.
 */
export type AdoptWithStep = { kind: 'dialog' } | { kind: 'update'; module: string } | { kind: 'add' } | { kind: 'none' }

export function adoptWithStep(read: {
  outcome: string
  agent: { module: string } | null
  taskAgents?: readonly { module: string }[]
  agentsToUpdate?: readonly { module: string }[]
}): AdoptWithStep {
  if (read.outcome !== 'ok') return { kind: 'none' }
  if (read.agent || (read.taskAgents?.length ?? 0) > 1) return { kind: 'dialog' }
  if (read.agentsToUpdate?.length) return { kind: 'update', module: read.agentsToUpdate[0]!.module }
  if (read.taskAgents) return { kind: 'add' }
  return { kind: 'none' }
}
