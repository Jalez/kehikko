import {
  INBOX_ITEMS_MAX,
  INBOX_NEXT_MS,
  LIMITS,
  actNeedsPress,
  inboxActResult,
  inboxAnswerResult,
  inboxItemSchema,
  inboxLogResult,
  inboxLogRowSchema,
  inboxOpenResult,
  inboxReadResult,
  inboxUseResult,
  methodParams,
  type InboxItem,
  type InboxLogResult,
  type InboxLogRow,
  type InboxReadResult,
  type InboxScope,
} from 'kehikot-module-protocol'

import type { Namer } from './activity.ts'
import {
  PROJECT_GROUP,
  STATE_WORDS,
  aboutProject,
  byLine,
  closedWords,
  inScope,
  isLive,
  placeLines,
  rowKey,
  wasWords,
  type Entry,
  type LogRow,
} from './inbox.ts'
import { mayMute } from './inboxUse.ts'
import type { Said } from './inboxClient.ts'
import type { Answer } from './conversation.ts'

/**
 * The person's Inbox, answered to a module's PAGE (protocol 2.79.0, `inbox:person`): the record is
 * the server's (`server/inbox.ts`), the page holds the latest of it (`useInbox`), and this is the
 * one place a frame's `inbox.*` call is turned into what the page already does for the person —
 * read, see, dismiss, forget, answer, go, mute.
 *
 * Only this page answers them (`ANSWERED_BY_THE_VIEW`): none is a server method, so a module's
 * server is refused by the protocol's own schema, and no MCP tool reaches any. Every act but
 * reading and `seen` needs the person's fresh press in the frame (`actNeedsPress`), read when the
 * request arrived; `inbox.open` of the item the host's own Next named is taken for `INBOX_NEXT_MS`
 * after the host told the page (the person's press was the host's shortcut).
 */

/** What the page holds and does, as the door needs it. */
export interface InboxDoor {
  /** The open project's open entries, muted modules left out (`useInbox().open`). */
  entries(): readonly Entry[]
  /** The other projects' live entries. */
  elsewhere(): readonly { project: { id: number; name: string }; entries: readonly Entry[] }[]
  /** Muted modules, named. */
  muted(): readonly { id: string; name: string }[]
  /** How many closed entries the log holds. */
  earlier(): number
  rev(): number
  next(): Entry | null
  /** Where the frame stands: the epic and kehikko key. */
  at(): { epic: string | null; kehikko: string | null }
  names(): Namer
  projectName(): string | null
  log(scope: InboxScope, offset: number, limit: number): Promise<{ rows: LogRow[]; more: boolean; total: number } | null>
  act(what: 'seen' | 'dismiss' | 'forget' | 'seen-all', keys: readonly { module: string; id: string }[] | undefined, scope: InboxScope, project?: number): void
  answer(entry: Entry, said: Said, project?: number): Promise<{ ok: true } | { ok: false; why: string }>
  /** Go to an entry's place, as pressing it did. */
  open(entry: Entry, project?: number): void
  use(module: string, on: boolean): void
  /** Whether a project id is one of the person's (another project named by `project`). */
  hasProject(project: number): boolean
}

/** The item the host's Next last told a page to go to, and when; `null` before any. */
export interface NextTold {
  module: string
  key: string
  at: number
}

export const DOOR_SAYS = {
  noPress: 'The Inbox acts only on your own press in this module, and none came with it. Nothing was done.',
  noProject: 'That names no project of yours.',
  noItem: 'That names no open item in the Inbox.',
  muteHost: 'Kehikot’s own lists are not muted here; they have their own settings.',
} as const

/*
 * The answer is held to the protocol's schema before it goes (`inboxReadResult`, `inboxLogResult`):
 * a module reads it with that schema and refuses the whole answer for one field over its limit. So
 * every string is clipped to its limit with "…", every time is a whole number of ms, a question
 * carries at most the protocol's number of choices, and an item or project that still does not fit
 * is left out with one line naming the field — never sent.
 */

/** A string at most `max` characters long, ending in "…" when it was cut. */
export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`)

/** A time or count as the protocol takes it: a whole number, never below zero. */
export const whole = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/**
 * A question's choices as the protocol carries them: at most `MESSAGE_CHOICES`, each clipped to
 * `MESSAGE_CHOICE`. When there are more, the first ones and the LAST are kept (a last choice is
 * often the way out, which must stay on offer). Each kept choice says which of the
 * original ones it stands for, so an answer by its words finds it.
 */
export function fitChoices<T>(choices: readonly T[], label: (one: T) => string): { label: string; of: T }[] {
  const max = LIMITS.MESSAGE_CHOICES
  const kept = choices.length <= max ? [...choices] : [...choices.slice(0, max - 1), choices[choices.length - 1]!]
  const seen = new Set<string>()
  const out: { label: string; of: T }[] = []
  for (const one of kept) {
    const said = clip(label(one), LIMITS.MESSAGE_CHOICE)
    if (seen.has(said)) continue
    seen.add(said)
    out.push({ label: said, of: one })
  }
  return out
}

/** One line for an item or project left out of an answer: the method, which one, and the field. */
function leftOut(method: string, what: string, issue: { path: PropertyKey[]; message: string } | undefined): void {
  console.warn(`[inbox] ${method}: left out ${what} — ${issue?.path.length ? issue.path.join('.') : 'it'}: ${issue?.message ?? 'malformed'}`)
}

/** An item that fits the protocol's schema, or null (and a line) for one that still does not. */
function fitted(item: InboxItem, method = 'inbox.read'): InboxItem | null {
  const got = inboxItemSchema.safeParse(item)
  if (got.success) return got.data
  leftOut(method, `item ${clip(item.module, 64)}/${clip(item.id, 128)}`, got.error.issues[0])
  return null
}

const placeOf = (entry: Pick<Entry, 'place'>, names: Namer, projectName: string | null): string => {
  const { here, epic } = placeLines(entry, names)
  return [here, epic].filter(Boolean).join(' · ') || projectName || PROJECT_GROUP
}

/** One entry as an `inboxItemSchema` item: the host's words, and nothing of where an answer goes. */
export function itemOf(
  entry: Entry,
  names: Namer,
  at: { epic: string | null; kehikko: string | null },
  projectName: string | null,
): InboxItem {
  const detail = entry.detail ? clip(entry.detail, LIMITS.ACTIVITY_DETAIL) : ''
  const label = clip(entry.label, LIMITS.ACTIVITY_LABEL)
  return {
    module: entry.module,
    id: entry.id,
    by: clip(byLine(entry), LIMITS.TITLE),
    state: entry.state,
    ...(entry.named?.says ? { says: clip(entry.named.says, LIMITS.TITLE) } : {}),
    label,
    ...(detail ? { detail } : {}),
    priority: entry.priority,
    where: clip(placeOf(entry, names, projectName), LIMITS.TITLE * 2),
    here: inScope(entry.place, 'here', at),
    project: aboutProject(entry),
    entered: whole(entry.entered),
    seen: false,
    ...(entry.question
      ? {
          question: {
            text: clip(entry.question.text, LIMITS.ACTIVITY_QUESTION),
            choices: fitChoices(entry.question.choices, (one) => one).map((one) => one.label),
            answered: entry.answered?.entered === entry.entered ? clip(entry.answered.text, LIMITS.MESSAGE_BODY) : null,
          },
        }
      : {}),
    mutable: mayMute(entry.module),
  }
}

/** `inbox.read`, from what the page holds: every item held to the protocol's schema, and the whole answer too. */
export function readOf(door: InboxDoor): InboxReadResult {
  const names = door.names()
  const at = door.at()
  const projectName = door.projectName()
  const next = door.next()
  const items = (list: readonly Entry[], one: (entry: Entry) => InboxItem): InboxItem[] => {
    const out: InboxItem[] = []
    for (const entry of list) {
      if (out.length >= INBOX_ITEMS_MAX) break
      const item = fitted(one(entry))
      if (item) out.push(item)
    }
    return out
  }
  const elsewhere: InboxReadResult['elsewhere'] = []
  for (const { project, entries } of door.elsewhere()) {
    if (elsewhere.length >= 50) break
    if (!Number.isInteger(project.id) || project.id <= 0) {
      leftOut('inbox.read', `another project (${clip(String(project.name), 60)})`, { path: ['elsewhere', 'project', 'id'], message: `not a positive whole number: ${String(project.id)}` })
      continue
    }
    const name = clip(project.name, LIMITS.TITLE)
    elsewhere.push({
      project: { id: project.id, name },
      items: items(entries, (entry) => ({
        ...itemOf(entry, names, at, name),
        where: clip([entry.place?.epic, entry.place?.parts?.join(' + ')].filter(Boolean).join(' · ') || name, LIMITS.TITLE * 2),
        here: false,
      })),
    })
  }
  const nextKey = next ? inboxKeyOf(next) : null
  return {
    rev: whole(door.rev()),
    items: items(door.entries().filter(isLive), (entry) => itemOf(entry, names, at, projectName)),
    next: nextKey,
    elsewhere,
    earlier: whole(door.earlier()),
    muted: door
      .muted()
      .filter((one) => one.id.length > 0 && one.id.length <= 64)
      .slice(0, 200)
      .map((one) => ({ id: one.id, name: clip(one.name, LIMITS.TITLE) })),
  }
}

/** An item's key, when it is one the protocol can name (`next`); null for one it cannot. */
function inboxKeyOf(entry: Pick<Entry, 'module' | 'id'>): { module: string; id: string } | null {
  const fits = entry.module.length > 0 && entry.module.length <= 64 && entry.id.length > 0 && entry.id.length <= LIMITS.ACTIVITY_ID
  return fits ? { module: entry.module, id: entry.id } : null
}

/** Earlier's rows in the protocol's words: at most a page of them, each held to its schema. */
export function logRowsOf(rows: readonly LogRow[], names: Namer, projectName: string | null): InboxLogRow[] {
  const out: InboxLogRow[] = []
  for (const row of rows) {
    if (out.length >= 100) break
    const got = inboxLogRowSchema.safeParse(logRowOf(row, names, projectName))
    if (got.success) out.push(got.data)
    else leftOut('inbox.log', `row ${clip(row.module, 64)}/${clip(row.id, 128)}`, got.error.issues[0])
  }
  return out
}

/** One Earlier row in the protocol's words. */
export function logRowOf(row: LogRow, names: Namer, projectName: string | null): InboxLogRow {
  const what = row.kind === 'closed' ? closedWords(row) : row.kind === 'seen' ? 'finished, seen' : wasWords(row.state)
  return {
    key: row.key,
    module: row.module,
    id: row.id,
    by: clip(byLine(row), LIMITS.TITLE),
    label: clip(row.label, LIMITS.ACTIVITY_LABEL),
    what: clip(what, LIMITS.TITLE),
    where: clip(placeOf(row, names, projectName), LIMITS.TITLE * 2),
    at: whole(row.at),
    priority: row.priority,
  }
}

const ok = (data: unknown): Answer => ({ ok: true, data })
const malformed = (method: string, issue: { path: PropertyKey[]; message: string } | undefined): Answer => ({
  ok: false,
  reason: 'failed',
  error: `${method} was called with something the canvas will not accept: ${issue?.path.length ? issue.path.join('.') : 'params'} — ${issue?.message ?? 'malformed'}.`,
})

/** The refusal each method says when it is declined. */
const declined = (method: string, rawWhy: string): Answer => {
  const why = clip(rawWhy, LIMITS.REASON)
  return ok(method === 'inbox.answer' ? { outcome: 'declined', why } : method === 'inbox.open' ? { outcome: 'declined', why } : { outcome: 'declined', changed: 0, why })
}

/** The entry a key names, in the open project or another. */
function find(door: InboxDoor, module: string, id: string, project: number | undefined): Entry | null {
  if (project === undefined) return door.entries().find((one) => one.module === module && one.id === id && isLive(one)) ?? null
  return door.elsewhere().find((one) => one.project.id === project)?.entries.find((one) => one.module === module && one.id === id) ?? null
}

/**
 * Answer one `inbox.*` call from a module's frame. `pressed` is whether the person's press in that
 * frame was fresh when the request arrived; `told` the host's last Next for the page.
 */
export async function answerInbox(
  method: string,
  rawParams: unknown,
  pressed: boolean,
  door: InboxDoor,
  told: NextTold | null = null,
  now: number = Date.now(),
): Promise<Answer> {
  return checked(method, await answerUnchecked(method, rawParams, pressed, door, told, now))
}

/** The schema each method's answer is read with by a module. */
const RESULTS: Record<string, { safeParse(data: unknown): { success: true; data: unknown } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }> = {
  'inbox.read': inboxReadResult,
  'inbox.log': inboxLogResult,
  'inbox.act': inboxActResult,
  'inbox.answer': inboxAnswerResult,
  'inbox.open': inboxOpenResult,
  'inbox.use': inboxUseResult,
}

/**
 * The last check before an answer goes: one the module would refuse is never sent. What is
 * repaired is repaired above; this is the guard for anything that was not, said in one line, and
 * answered as a failure naming the field rather than as a shape the module cannot read.
 */
function checked(method: string, answer: Answer): Answer {
  const schema = RESULTS[method]
  if (!answer.ok || !schema) return answer
  const got = schema.safeParse(answer.data)
  if (got.success) return answer
  const issue = got.error.issues[0]
  const where = issue?.path.length ? issue.path.join('.') : 'the answer'
  console.warn(`[inbox] ${method}: not sent — ${where}: ${issue?.message ?? 'malformed'}`)
  return { ok: false, reason: 'failed', error: `The canvas could not answer ${method} in the protocol’s shape (${where}: ${issue?.message ?? 'malformed'}).` }
}

async function answerUnchecked(
  method: string,
  rawParams: unknown,
  pressed: boolean,
  door: InboxDoor,
  told: NextTold | null,
  now: number,
): Promise<Answer> {
  const schema = (methodParams as Record<string, (typeof methodParams)[keyof typeof methodParams]>)[method]
  if (!schema || !method.startsWith('inbox.')) return { ok: false, reason: 'unknown-method', error: `${method} is not an Inbox method.` }
  const parsed = schema.safeParse(rawParams ?? {})
  if (!parsed.success) return malformed(method, parsed.error.issues[0])
  const params = parsed.data as Record<string, unknown>

  if (actNeedsPress(method, params) && !pressed) {
    const byNext =
      method === 'inbox.open' &&
      told !== null &&
      now - told.at <= INBOX_NEXT_MS &&
      told.key === rowKey({ module: String(params.module), id: String(params.id) }) &&
      params.project === undefined
    if (!byNext) return declined(method, DOOR_SAYS.noPress)
  }
  const project = typeof params.project === 'number' ? params.project : undefined
  if (project !== undefined && !door.hasProject(project)) return declined(method, DOOR_SAYS.noProject)

  switch (method) {
    case 'inbox.read':
      return ok(readOf(door))
    case 'inbox.log': {
      const got = await door.log(params.scope as InboxScope, params.offset as number, params.limit as number)
      const names = door.names()
      const result: InboxLogResult = got
        ? { rows: logRowsOf(got.rows, names, door.projectName()), more: got.more, total: whole(got.total) }
        : { rows: [], more: false, total: 0 }
      return ok(result)
    }
    case 'inbox.act': {
      const keys = params.keys as { module: string; id: string }[] | undefined
      door.act(params.do as 'seen' | 'dismiss' | 'forget' | 'seen-all', keys, params.scope as InboxScope, project)
      return ok({ outcome: 'done', changed: keys?.length ?? 0, why: '' })
    }
    case 'inbox.answer': {
      const entry = find(door, String(params.module), String(params.id), project)
      if (!entry?.question) return declined(method, DOOR_SAYS.noItem)
      let said: Said
      if (typeof params.choice === 'string') {
        const shown = fitChoices(entry.question.choices.map((text, index) => ({ text, index })), (one) => one.text)
        const index = shown.find((one) => one.label === params.choice)?.of.index ?? -1
        if (index < 0) return declined(method, 'That is not one of the question’s choices.')
        said = { choice: index }
      } else said = { answer: String(params.answer) }
      const got = await door.answer(entry, said, project)
      return ok(got.ok ? { outcome: 'sent', why: '' } : { outcome: 'declined', why: clip(got.why, LIMITS.REASON) })
    }
    case 'inbox.open': {
      const entry = find(door, String(params.module), String(params.id), project)
      if (!entry) return ok({ outcome: 'no-such-item', why: DOOR_SAYS.noItem })
      door.open(entry, project)
      return ok({ outcome: 'opened', why: '' })
    }
    case 'inbox.use': {
      const module = String(params.module)
      if (!mayMute(module)) return declined(method, DOOR_SAYS.muteHost)
      door.use(module, params.use === true)
      return ok({ outcome: 'done', changed: 1, why: '' })
    }
  }
  return { ok: false, reason: 'unknown-method', error: `${method} is not an Inbox method.` }
}

/** The state words, re-exported for the bar's plain list. */
export { STATE_WORDS }
