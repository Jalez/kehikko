import { useCallback, useEffect, useState } from 'react'

import { KeptBySettings, toSettings, useAgentSettings } from './Settings.tsx'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { notAnswering } from '@/host/reachable.ts'
import { lineDiff, NEXT_SESSION_SKILLS, OWN_SKILLS_MODULE, pressFor, removable, whyNot, type SkillRow } from '@/host/skills.ts'

/**
 * A module's Claude Code skills, and the person's presses on them (protocol 2.5.0).
 *
 * The window belongs to the host for the Tools window's reasons (`Tools.tsx`):
 * a module's page is in a sandboxed frame, and what this changes is the
 * person's own Claude Code, which a module must never be handed a way to write.
 *
 * A skill is instructions for every Claude Code session on the machine, so
 * nothing is installed unread: Install and Update are offered only inside the
 * open text (for Update, a diff from what is installed, with the whole text a
 * press away), and the press carries the sha256 of exactly what was shown. The
 * server fetches the text again and refuses one that changed in between.
 *
 * Everything is read from the module and the disk when the window opens, and
 * again after every press. Nothing is kept on the page.
 */

interface Answer {
  ok: true
  module: string
  name: string
  writesTo: string
  skills: SkillRow[]
}

export function SkillsDialog({
  open,
  onOpenChange,
  module,
  name,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  module: string
  name: string
}) {
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [asking, setAsking] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const [pressing, setPressing] = useState<string | null>(null)
  const [said, setSaid] = useState<{ name: string; text: string } | null>(null)
  /* Whether Settings keeps this module's skills installed, and leaving it out from here. */
  const kept = useAgentSettings(open)

  const ask = useCallback(async () => {
    setAsking(true)
    setRefused(null)
    try {
      const response = await fetch(`/host/skills?module=${encodeURIComponent(module)}`, { cache: 'no-store' })
      const body = (await response.json()) as Answer | { ok: false; why?: string }
      if (!response.ok || !body.ok) {
        setAnswer(null)
        setRefused(('why' in body && body.why) || "The host's server would not answer for that module.")
        return
      }
      setAnswer(body)
    } catch (error) {
      setAnswer(null)
      setRefused(notAnswering(error))
    } finally {
      setAsking(false)
    }
  }, [module])

  useEffect(() => {
    if (!open) return
    setAnswer(null)
    setSaid(null)
    setReading(null)
    void ask()
  }, [open, ask])

  const press = async (row: SkillRow, what: 'install' | 'update' | 'remove') => {
    setPressing(row.name)
    setSaid(null)
    try {
      const response = await fetch('/host/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        /* An id, a name, a word, and the hash of the text on screen. Never the text: the server fetches it. */
        body: JSON.stringify({ module, name: row.name, press: what, ...(what === 'remove' ? {} : { sha256: row.sha256 }) }),
      })
      const body = (await response.json()) as { ok?: boolean; why?: string; said?: string }
      setSaid({ name: row.name, text: body.ok ? (body.said ?? 'Done.') : (body.why ?? 'It did not work, and the host did not say why.') })
      if (body.ok) setReading(null)
      await ask()
    } catch (error) {
      setSaid({ name: row.name, text: notAnswering(error) })
    } finally {
      setPressing(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Skills from {name}</DialogTitle>
          <DialogDescription>
            Claude Code skills {module === OWN_SKILLS_MODULE ? 'Kehikot itself' : 'this module'} offers. Installed, a skill is in your own Claude Code for every project
            {answer ? (
              <>
                {' '}
                (<span className="font-mono text-xs break-all">{answer.writesTo}</span>)
              </>
            ) : null}
            , so read what it says before you install it.
          </DialogDescription>
        </DialogHeader>

        <KeptBySettings
          kind="skills"
          module={module}
          name={name}
          answer={kept.answer}
          busy={kept.busy}
          onExcept={(out) => void kept.change({ except: { kind: 'skills', module, out } })}
          onSettings={() => toSettings(() => onOpenChange(false), 'skills')}
        />

        {refused ? <p className="text-sm leading-relaxed break-words">{refused}</p> : null}

        {answer ? (
          <div className="min-w-0 space-y-3">
            <p className="text-muted-foreground text-xs leading-relaxed">{NEXT_SESSION_SKILLS}</p>
            {answer.skills.length === 0 ? <p className="text-sm">{name} offers no skills now.</p> : null}
            <ul className="min-w-0 space-y-2">
              {answer.skills.map((row) => (
                <SkillItem
                  key={row.name}
                  row={row}
                  reading={reading === row.name}
                  onRead={() => setReading(reading === row.name ? null : row.name)}
                  pressing={pressing === row.name}
                  busy={pressing !== null}
                  said={said?.name === row.name ? said.text : null}
                  onPress={(what) => void press(row, what)}
                />
              ))}
            </ul>
          </div>
        ) : asking ? (
          <p className="text-muted-foreground text-sm">Asking {name} what it offers…</p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SkillItem({
  row,
  reading,
  onRead,
  pressing,
  busy,
  said,
  onPress,
}: {
  row: SkillRow
  reading: boolean
  onRead(): void
  pressing: boolean
  busy: boolean
  said: string | null
  onPress(what: 'install' | 'update' | 'remove'): void
}) {
  const next = pressFor(row)
  const why = whyNot(row)
  const loud = row.status === 'outdated' || row.status === 'edited' || row.status === 'taken'

  return (
    <li className="min-w-0 rounded-md border p-3" data-skill={row.name} data-status={row.status}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-sm break-all">{row.name}</span>
        <span className="text-muted-foreground text-[11px]">
          {row.version}
          {row.installedVersion && row.installedVersion !== row.version ? ` (installed: ${row.installedVersion})` : ''}
        </span>
        <span className={loud ? 'ml-auto text-[11px] font-medium' : 'text-muted-foreground ml-auto text-[11px]'} data-says>
          {row.says}
        </span>
      </div>
      {row.summary ? <p className="mt-1 min-w-0 text-xs leading-relaxed break-words">{row.summary}</p> : null}
      {why ? <p className="text-muted-foreground mt-1 min-w-0 text-xs leading-relaxed break-words">{why}</p> : null}

      <div className="mt-2 flex flex-wrap gap-2">
        {row.text !== null || row.installedText !== null ? (
          <Button variant="secondary" size="sm" className="h-7 px-3 text-xs" aria-expanded={reading} data-press="read" onClick={onRead}>
            {reading ? 'Hide' : next === 'install' ? 'Read and install…' : next === 'update' ? 'Read the changes…' : 'Read…'}
          </Button>
        ) : null}
        {removable(row) ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={busy}
            data-press="remove"
            title={`deletes ${row.path}`}
            onClick={() => onPress('remove')}
          >
            {pressing ? 'Removing…' : 'Remove'}
          </Button>
        ) : null}
      </div>

      {reading ? <Reading row={row} next={next} pressing={pressing} busy={busy} onPress={onPress} /> : null}

      {said ? <p className="bg-muted mt-2 min-w-0 rounded-md p-2 text-xs leading-relaxed break-words">{said}</p> : null}
    </li>
  )
}

/** The text a press would write, whole or as a diff, with the press at its foot. */
function Reading({
  row,
  next,
  pressing,
  busy,
  onPress,
}: {
  row: SkillRow
  next: 'install' | 'update' | null
  pressing: boolean
  busy: boolean
  onPress(what: 'install' | 'update'): void
}) {
  const diffable = row.text !== null && row.installedText !== null && row.installedText !== row.text
  const [whole, setWhole] = useState(!diffable)

  return (
    <div className="mt-2 min-w-0 space-y-2">
      {diffable ? (
        <div className="flex gap-2 text-[11px]">
          <button type="button" className={whole ? 'text-muted-foreground underline' : 'font-medium'} onClick={() => setWhole(false)}>
            {row.status === 'outdated' ? 'What changes' : 'Yours against the module’s'}
          </button>
          <button type="button" className={whole ? 'font-medium' : 'text-muted-foreground underline'} onClick={() => setWhole(true)}>
            The module’s whole text
          </button>
        </div>
      ) : null}
      {whole || !diffable ? (
        <pre className="bg-muted max-h-80 min-w-0 overflow-auto rounded-md p-2 text-[11px] leading-snug whitespace-pre-wrap break-words" data-text>
          {row.text ?? row.installedText}
        </pre>
      ) : (
        <pre className="bg-muted max-h-80 min-w-0 overflow-auto rounded-md p-2 text-[11px] leading-snug whitespace-pre-wrap break-words" data-diff>
          {lineDiff(row.installedText!, row.text!).map((line, n) => (
            <div
              key={n}
              data-line={line.kind}
              className={line.kind === 'added' ? 'bg-emerald-500/15' : line.kind === 'removed' ? 'bg-red-500/15 line-through' : 'text-muted-foreground'}
            >
              {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
              {line.text}
            </div>
          ))}
        </pre>
      )}
      {next ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-7 px-3 text-xs" disabled={busy} data-press={next} onClick={() => onPress(next)}>
            {pressing ? (next === 'install' ? 'Installing…' : 'Updating…') : next === 'install' ? 'Install' : 'Update'}
          </Button>
          <span className="text-muted-foreground min-w-0 text-[11px] break-all">writes {row.path}/SKILL.md</span>
        </div>
      ) : null}
    </div>
  )
}
