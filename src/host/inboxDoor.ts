import {
  INBOX_NEXT_MS,
  actNeedsPress,
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
  /**
   * The host's own quick answers for an entry (its ask "which epic is this conversation for?",
   * `host/placeAsk.ts`), shown as the entry's question; null for none.
   */
  choicesFor?(entry: Entry): { label: string; run(): void }[] | null
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
  choices: readonly { label: string }[] | null = null,
): InboxItem {
  return {
    module: entry.module,
    id: entry.id,
    by: byLine(entry),
    state: entry.state,
    ...(entry.named?.says ? { says: entry.named.says } : {}),
    label: entry.label,
    ...(entry.detail ? { detail: entry.detail } : {}),
    priority: entry.priority,
    where: placeOf(entry, names, projectName),
    here: inScope(entry.place, 'here', at),
    project: aboutProject(entry),
    entered: entry.entered,
    seen: false,
    ...(entry.question
      ? {
          question: {
            text: entry.question.text,
            choices: [...entry.question.choices],
            answered: entry.answered?.entered === entry.entered ? entry.answered.text : null,
          },
        }
      : choices?.length
        ? { question: { text: entry.detail ?? entry.label, choices: choices.map((one) => one.label), answered: null } }
        : {}),
    mutable: mayMute(entry.module),
  }
}

/** `inbox.read`, from what the page holds. */
export function readOf(door: InboxDoor): InboxReadResult {
  const names = door.names()
  const at = door.at()
  const projectName = door.projectName()
  const next = door.next()
  return {
    rev: door.rev(),
    items: door.entries().filter(isLive).slice(0, 500).map((entry) => itemOf(entry, names, at, projectName, door.choicesFor?.(entry) ?? null)),
    next: next ? { module: next.module, id: next.id } : null,
    elsewhere: door
      .elsewhere()
      .slice(0, 50)
      .map(({ project, entries }) => ({
        project,
        items: entries.slice(0, 500).map((entry) => ({ ...itemOf(entry, names, at, project.name), where: [entry.place?.epic, entry.place?.parts?.join(' + ')].filter(Boolean).join(' · ') || project.name, here: false })),
      })),
    earlier: door.earlier(),
    muted: door.muted().slice(0, 200).map((one) => ({ id: one.id, name: one.name })),
  }
}

/** One Earlier row in the protocol's words. */
export function logRowOf(row: LogRow, names: Namer, projectName: string | null): InboxLogRow {
  const what = row.kind === 'closed' ? closedWords(row) : row.kind === 'seen' ? 'finished, seen' : wasWords(row.state)
  return {
    key: row.key,
    module: row.module,
    id: row.id,
    by: byLine(row),
    label: row.label,
    what,
    where: placeOf(row, names, projectName),
    at: row.at,
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
const declined = (method: string, why: string): Answer =>
  ok(method === 'inbox.answer' ? { outcome: 'declined', why } : method === 'inbox.open' ? { outcome: 'declined', why } : { outcome: 'declined', changed: 0, why })

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
        ? { rows: got.rows.slice(0, 100).map((row) => logRowOf(row, names, door.projectName())), more: got.more, total: got.total }
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
      const own = entry && project === undefined ? (door.choicesFor?.(entry) ?? null) : null
      if (entry && own?.length && !entry.question) {
        const picked = typeof params.choice === 'string' ? own.find((one) => one.label === params.choice) : undefined
        if (!picked) return declined(method, 'That is not one of the question’s choices.')
        picked.run()
        return ok({ outcome: 'sent', why: '' })
      }
      if (!entry?.question) return declined(method, DOOR_SAYS.noItem)
      let said: Said
      if (typeof params.choice === 'string') {
        const index = entry.question.choices.indexOf(params.choice)
        if (index < 0) return declined(method, 'That is not one of the question’s choices.')
        said = { choice: index }
      } else said = { answer: String(params.answer) }
      const got = await door.answer(entry, said, project)
      return ok(got.ok ? { outcome: 'sent', why: '' } : { outcome: 'declined', why: got.why })
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
