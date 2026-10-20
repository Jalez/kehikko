import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import {
  active,
  automatic,
  FIRST_QUESTION,
  MORE_AGENTS,
  onOpenSettings,
  openSettings,
  PROVIDERS,
  SKILL_STATE_SAYS,
  skillsSaid,
  START_HOOK_WHERE,
  TOOL_STATE_SAYS,
  toolsSaid,
  type AgentSettings,
  type SettingsAnswer,
} from '@/host/agentSettings.ts'
import { notAnswering } from '@/host/reachable.ts'

/**
 * Settings: how Kehikot works with the person's coding agents, chosen once for
 * every module and every project (`host/agentSettings.ts` has the shape and the
 * words, `server/agentSync.ts` what is done with them).
 *
 * Three pieces, all here so the words stay together:
 *
 *  - `AgentSettingsHost`, mounted once by the page: asks the one-time question
 *    while it is unanswered, and opens the dialog when anything calls
 *    `openSettings()` — the projects menu, a module's Tools or Skills window,
 *    the sync's line in the Inbox.
 *  - `SettingsDialog` and its body: the providers, the two kinds of thing kept
 *    set up with their exceptions and status, and the start hook, read only.
 *  - `KeptBySettings`: the line a module's Tools or Skills window shows.
 *
 * Every state is a word, never a colour alone; every control is a native
 * checkbox or button with its own label, so the keyboard and a reader know it.
 */

type Change = { settings: Partial<Record<keyof AgentSettings, unknown>> } | { except: { kind: 'tools' | 'skills'; module: string; out: boolean } }

export async function fetchSettings(signal?: AbortSignal): Promise<SettingsAnswer> {
  const response = await fetch('/host/settings', { cache: 'no-store', signal })
  const body = (await response.json()) as SettingsAnswer | { ok: false; why?: string }
  if (!response.ok || !body.ok || !body.settings || !body.status) throw new Error(('why' in body && body.why) || 'The host would not say its settings.')
  return body
}

export async function postSettings(change: Change): Promise<SettingsAnswer> {
  const response = await fetch('/host/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
  })
  const body = (await response.json()) as SettingsAnswer | { ok: false; why?: string }
  if (!response.ok || !body.ok || !body.settings) throw new Error(('why' in body && body.why) || 'The host did not take that change.')
  return body
}

/** The settings as the server has them, read when `open`, and the way to change them. */
export function useAgentSettings(open: boolean, load = fetchSettings, save = postSettings) {
  const [answer, setAnswer] = useState<SettingsAnswer | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const read = useCallback(async () => {
    try {
      setAnswer(await load())
      setTrouble(null)
    } catch (error) {
      setTrouble(notAnswering(error))
    }
  }, [load])

  useEffect(() => {
    if (open) void read()
  }, [open, read])

  const change = useCallback(
    async (what: Change) => {
      setBusy(true)
      try {
        setAnswer(await save(what))
        setTrouble(null)
      } catch (error) {
        setTrouble(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [save],
  )

  return { answer, trouble, busy, read, change }
}

/** Mounted once by the page: the one-time question, and the dialog wherever it is asked for. */
export function AgentSettingsHost({ load = fetchSettings, save = postSettings }: { load?: typeof fetchSettings; save?: typeof postSettings } = {}) {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState(false)

  useEffect(() => onOpenSettings(() => setOpen(true)), [])

  /* Asked once per page load while unanswered. Closing it without answering asks again next time. */
  useEffect(() => {
    const stop = new AbortController()
    load(stop.signal)
      .then((answer) => setQuestion(!answer.settings.asked))
      .catch(() => {})
    return () => stop.abort()
  }, [load])

  return (
    <>
      <FirstQuestion
        open={question && !open}
        onOpenChange={setQuestion}
        onAnswer={async (choice) => {
          await save({
            settings: { asked: true, tools: { auto: choice?.tools ?? false }, skills: { auto: choice?.skills ?? false } },
          })
          setQuestion(false)
        }}
      />
      <SettingsDialog open={open} onOpenChange={setOpen} load={load} save={save} />
    </>
  )
}

/**
 * The one-time question. Both boxes checked to start; "Keep it set up" takes
 * what is checked, "I'll do it myself" turns both off. Either answer is kept.
 */
export function FirstQuestion({
  open,
  onOpenChange,
  onAnswer,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** `null`: the person will do it themselves. */
  onAnswer(choice: { tools: boolean; skills: boolean } | null): Promise<void>
}) {
  const [tools, setTools] = useState(true)
  const [skills, setSkills] = useState(true)
  const [busy, setBusy] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)

  const answer = async (choice: { tools: boolean; skills: boolean } | null) => {
    setBusy(true)
    setTrouble(null)
    try {
      await onAnswer(choice)
    } catch (error) {
      setTrouble(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-first-question>
        <DialogHeader>
          <DialogTitle>{FIRST_QUESTION.title}</DialogTitle>
          <DialogDescription>{FIRST_QUESTION.lead}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3 text-sm">
          <Box checked={tools} onChange={setTools} disabled={busy}>
            {FIRST_QUESTION.toolsBox}
          </Box>
          <Box checked={skills} onChange={setSkills} disabled={busy}>
            {FIRST_QUESTION.skillsBox}
          </Box>
          <div>
            <p className="text-xs font-semibold">What Kehikot will write</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-relaxed">
              {FIRST_QUESTION.writes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">{FIRST_QUESTION.after}</p>
          {trouble ? (
            <p role="alert" className="text-xs">
              {trouble}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} data-answer="self" onClick={() => void answer(null)}>
              {FIRST_QUESTION.self}
            </Button>
            <Button size="sm" disabled={busy} data-answer="keep" onClick={() => void answer({ tools, skills })}>
              {FIRST_QUESTION.keep}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function SettingsDialog({
  open,
  onOpenChange,
  load = fetchSettings,
  save = postSettings,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  load?: typeof fetchSettings
  save?: typeof postSettings
}) {
  const { answer, trouble, busy, read, change } = useAgentSettings(open, load, save)

  /* What the sync finds lands a moment after a change; read again while the window is open. */
  useEffect(() => {
    if (!open) return
    const every = setInterval(() => void read(), 4000)
    return () => clearInterval(every)
  }, [open, read])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-settings>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            How Kehikot works with your coding agents, for every module and every project on this computer.
          </DialogDescription>
        </DialogHeader>
        {trouble ? (
          <p role="alert" className="text-sm">
            {trouble}
          </p>
        ) : null}
        {answer ? (
          <SettingsBody answer={answer} busy={busy} onChange={(what) => void change(what)} />
        ) : !trouble ? (
          <p className="text-muted-foreground text-sm">Reading the settings…</p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** The dialog's body, drawn from one answer. Exported for tests. */
export function SettingsBody({ answer, busy, onChange }: { answer: SettingsAnswer; busy: boolean; onChange(what: Change): void }) {
  const { settings, status, hook } = answer
  /* Any choice made here is an answer to the one-time question too. */
  const set = (patch: Partial<Record<keyof AgentSettings, unknown>>) => onChange({ settings: { ...patch, asked: true } })
  const doors = status.modules.filter((one) => one.tools !== null)
  const offering = status.modules.filter((one) => one.skills.length > 0)
  const claude = settings.providers.claudeCode.enabled

  return (
    <div className="flex min-w-0 flex-col gap-5 text-sm">
      {!settings.asked ? (
        <p className="rounded-md border p-2 text-xs leading-relaxed" data-unasked>
          You have not chosen yet, so nothing is done for you automatically. Any choice below counts as your answer.
        </p>
      ) : null}

      <Section title="Agents" id="agents">
        <ul className="flex flex-col gap-2">
          {PROVIDERS.map((provider) => (
            <li key={provider.key} className="min-w-0">
              <Box checked={settings.providers[provider.key].enabled} disabled={busy} onChange={(on) => set({ providers: { [provider.key]: { enabled: on } } })}>
                Set up {provider.name}
              </Box>
              <p className="text-muted-foreground mt-0.5 pl-6 text-xs leading-relaxed">{provider.says}</p>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-2 text-xs">{MORE_AGENTS}</p>
      </Section>

      <Section title="Module tools" id="tools">
        <Box checked={settings.tools.auto} disabled={busy || !claude} onChange={(on) => set({ tools: { auto: on } })}>
          Connect every module’s tools to Claude Code, and keep them connected
        </Box>
        <p className="mt-1 text-xs" data-status="tools">
          {toolsSaid(status)}
          {!active(settings, 'tools') ? ' Nothing is connected for you while this is off.' : ''}
        </p>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Written to Claude Code’s user-wide MCP list. Only entries Kehikot added are re-pointed or removed; a server you added is never touched.
        </p>
        {doors.length ? (
          <Exceptions
            label="Which modules"
            rows={doors.map((one) => ({ id: one.id, name: one.name, says: TOOL_STATE_SAYS[one.tools!], out: settings.tools.except.includes(one.id) }))}
            keep="keep connected"
            disabled={busy || !active(settings, 'tools')}
            onOut={(module, out) => onChange({ except: { kind: 'tools', module, out } })}
          />
        ) : null}
      </Section>

      <Section title="Skills" id="skills">
        <Box checked={settings.skills.auto} disabled={busy || !claude} onChange={(on) => set({ skills: { auto: on } })}>
          Install every module’s skills, and keep them up to date
        </Box>
        <p className="mt-1 text-xs" data-status="skills">
          {skillsSaid(status)}
          {!active(settings, 'skills') ? ' Nothing is installed for you while this is off.' : ''}
        </p>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Written to <span className="font-mono break-all">{answer.skillsAt}</span>. A skill you changed, or a name another skill already has, is left alone.
        </p>
        {offering.length ? (
          <Exceptions
            label="Which modules"
            rows={offering.map((one) => ({
              id: one.id,
              name: one.name,
              says: one.skills.map((skill) => `/${skill.name}: ${SKILL_STATE_SAYS[skill.state]}`).join(', '),
              out: settings.skills.except.includes(one.id),
            }))}
            keep="keep installed"
            disabled={busy || !active(settings, 'skills')}
            onOut={(module, out) => onChange({ except: { kind: 'skills', module, out } })}
          />
        ) : null}
      </Section>

      {status.problems.length ? (
        <Section title="Left alone" id="problems">
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed">
            {status.problems.map((line) => (
              <li key={line} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Conversations started outside Kehikot" id="hook">
        <p className="text-xs leading-relaxed" data-hook={hook.on === null ? 'unknown' : hook.on ? 'on' : 'off'}>
          {hook.on === true
            ? 'Reported: when a Claude Code session starts anywhere — a terminal, an editor — the Claude module hears of it.'
            : hook.on === false
              ? 'Not reported: a session started in a terminal or an editor is not known to Kehikot until you attach it.'
              : `Kehikot could not read ${hook.file}, so it cannot say.`}
        </p>
        {hook.on !== true ? <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{START_HOOK_WHERE}</p> : null}
        <p className="text-muted-foreground mt-1 font-mono text-[11px] break-all">{hook.file}</p>
      </Section>
    </div>
  )
}

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`settings-${id}`} className="min-w-0">
      <h3 id={`settings-${id}`} className="mb-1.5 text-xs font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** A native checkbox and its label, as one target. */
function Box({ checked, onChange, disabled, children }: { checked: boolean; onChange(on: boolean): void; disabled?: boolean; children: ReactNode }) {
  const id = useId()
  return (
    <div className="flex min-w-0 items-start gap-2">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-3.5 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <label htmlFor={id} className="min-w-0 leading-snug">
        {children}
      </label>
    </div>
  )
}

function Exceptions({
  label,
  rows,
  keep,
  disabled,
  onOut,
}: {
  label: string
  rows: { id: string; name: string; says: string; out: boolean }[]
  keep: string
  disabled: boolean
  onOut(module: string, out: boolean): void
}) {
  return (
    <fieldset className="mt-2 min-w-0 rounded-md border px-2 py-1.5">
      <legend className="px-1 text-[11px]">{label} — uncheck one to leave it to you</legend>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2" data-module={row.id}>
            <Box checked={!row.out} disabled={disabled} onChange={(on) => onOut(row.id, !on)}>
              <span className="font-medium">{row.name}</span>
              <span className="sr-only">: {keep}</span>
            </Box>
            <span className="text-muted-foreground min-w-0 text-[11px] break-words">{row.out ? 'Left to you' : row.says}</span>
          </li>
        ))}
      </ul>
    </fieldset>
  )
}

/**
 * What a module's Tools or Skills window says about Settings: that this module
 * is kept set up (with a way to leave it out), that it is left out, or that
 * Settings could do this for every module.
 */
export function KeptBySettings({
  kind,
  module,
  name,
  answer,
  busy,
  onExcept,
  onSettings,
}: {
  kind: 'tools' | 'skills'
  module: string
  name: string
  answer: SettingsAnswer | null
  busy: boolean
  onExcept(out: boolean): void
  /** Close the window this sits in, then `openSettings()`. */
  onSettings(): void
}) {
  if (!answer) return null
  const settings = answer.settings
  const kept = kind === 'tools' ? 'Kept connected by Settings' : 'Kept installed and up to date by Settings'
  const change = (
    <button type="button" className="underline underline-offset-2" onClick={onSettings} data-press="settings">
      change
    </button>
  )
  if (!active(settings, kind)) {
    return (
      <p className="text-muted-foreground text-xs" data-kept="off">
        <button type="button" className="underline underline-offset-2" onClick={onSettings} data-press="settings">
          Do this for every module → Settings
        </button>
      </p>
    )
  }
  const on = automatic(settings, kind, module)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-kept={on ? 'on' : 'excepted'}>
      <span>
        {on ? kept : `Left to you in Settings`} · {change}
      </span>
      <Box checked={!on} disabled={busy} onChange={onExcept}>
        Leave {name} out
      </Box>
    </div>
  )
}

/** Close a window, then open Settings over where it was. */
export function toSettings(close: () => void): void {
  close()
  setTimeout(openSettings, 0)
}
