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

/** The instruction an agent for Kehikot's own tasks is given with an item (`agent.tasks`). */
export const ADOPT_INSTRUCTION =
  'Find which epic and part this belongs to, and which of the candidate conversations worked on it. Then call propose_adoption.'

/** What the agent is told about the item, the epics and the candidates: the launch brief. */
export function adoptionBrief(input: {
  project: string
  item: { ref: string; title: string; url: string; author?: string; branch?: string; repo: string; host: string }
  epics: readonly { epic: string; title: string; parts: readonly { id: string; name: string }[]; refs: readonly string[] }[]
  candidates: readonly { program: string; session: string; title: string; reason: string; match: string; placed: string | null }[]
  suggested: Suggestion | null
}): string {
  const lines: string[] = []
  lines.push(`Kehikot asks you to place a tracker item that no epic of the project ${input.project} names yet.`)
  lines.push('')
  lines.push('The item:')
  lines.push(`- ref: ${input.item.ref}`)
  lines.push(`- title: ${input.item.title}`)
  lines.push(`- url: ${input.item.url}`)
  lines.push(`- repository: ${input.item.host}/${input.item.repo}`)
  if (input.item.branch) lines.push(`- branch: ${input.item.branch}`)
  if (input.item.author) lines.push(`- author: ${input.item.author}`)
  lines.push('')
  lines.push(input.epics.length ? 'The project\'s epics (slug — title; parts; refs):' : 'The project has no epics yet.')
  for (const epic of input.epics) {
    lines.push(`- ${epic.epic} — ${epic.title}`)
    if (epic.parts.length) lines.push(`  parts: ${epic.parts.map((part) => `${part.id} (${part.name})`).join(', ')}`)
    if (epic.refs.length) lines.push(`  refs: ${epic.refs.slice(0, 40).join(', ')}${epic.refs.length > 40 ? ', …' : ''}`)
  }
  lines.push('')
  lines.push(input.candidates.length ? 'Conversations that may have worked on it (session — title — why):' : 'No conversation was found that worked on it.')
  for (const one of input.candidates) {
    lines.push(`- ${one.session} (${one.program}) — ${one.title || 'untitled'} — ${one.reason}${one.placed ? ` — filed under ${one.placed}` : ''}`)
  }
  if (input.suggested) {
    lines.push('')
    lines.push(`Kehikot's own guess: ${input.suggested.epic}, because ${input.suggested.why}.`)
  }
  lines.push('')
  lines.push(ADOPT_INSTRUCTION)
  lines.push(
    `propose_adoption takes { ref: "${input.item.ref}", epic, parts?, conversations?: [session ids], why }. It only proposes: the person confirms in Kehikot with one press. Never write epics or files yourself.`,
  )
  return lines.join('\n')
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
