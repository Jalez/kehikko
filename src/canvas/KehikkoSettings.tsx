import { BookOpen, Bot, Check, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal.tsx'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { DELIVERY_SAID, onOpenKehikkoSkills } from '@/host/kehikkoSkills.ts'
import {
  fetchKehikkoSettings,
  KEHIKKO_SECTIONS,
  onOpenKehikkoSettings,
  postKehikkoSettings,
  PRIMARY_SAID,
  type AgentChoice,
  type KehikkoSection,
  type KehikkoSettingsAnswer,
} from '@/host/kehikkoSettings.ts'
import { revealTarget } from '@/host/settingsTarget.ts'
import { KehikkoSkillsPanel } from './KehikkoSkills.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'
import { whenNoDialog } from './Onboarding.tsx'

/**
 * Kehikko settings: one kehikko's own settings, in the same window shape as the app's Settings —
 * General (its name), Skills (the person's skills for it) and Agents (which agent module is the
 * primary one). Opened from the gear on each row of the kehikko menu, or by
 * `openKehikkoSettings(section, target, kehikko)` from anywhere.
 *
 * And the question that comes by itself: when a kehikko has two or more agent modules and none is
 * primary, `PrimaryAgentDialog` asks which one is. See `src/host/kehikkoSettings.ts` for what that
 * decides.
 */

export interface KehikkoRef {
  id: number
  name: string
  project: number | null
}

const SECTION_SAID: Record<KehikkoSection, { title: string; icon: typeof Bot }> = {
  general: { title: 'General', icon: SlidersHorizontal },
  skills: { title: 'Skills', icon: BookOpen },
  agents: { title: 'Agents', icon: Bot },
}

/* ------------------------------------------------------------ the cubes */

/**
 * The agent modules as cubes, like their tiles on the canvas: the icon, large, and the name. One is
 * picked at a time. A radio group to assistive technology: Tab reaches the group, the arrow keys
 * move and pick, Space or Enter picks the one focused.
 */
export function AgentCubes({
  agents,
  picked,
  onPick,
  label,
  current = null,
}: {
  agents: readonly AgentChoice[]
  picked: string | null
  onPick(id: string): void
  label: string
  /** The primary as it is now, marked as such. */
  current?: string | null
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const focusIndex = Math.max(0, agents.findIndex((one) => one.id === picked))
  const move = (from: number, by: number) => {
    if (!agents.length) return
    const to = (from + by + agents.length) % agents.length
    onPick(agents[to]!.id)
    refs.current[to]?.focus()
  }
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2" data-agent-cubes="">
      {agents.map((agent, index) => {
        const on = agent.id === picked
        return (
          <button
            key={agent.id}
            ref={(node) => {
              refs.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={index === focusIndex ? 0 : -1}
            data-agent-cube={agent.id}
            data-picked={on ? 'true' : undefined}
            onClick={() => onPick(agent.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault()
                move(index, 1)
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault()
                move(index, -1)
              } else if (event.key === 'Home') {
                event.preventDefault()
                move(0, 0)
              } else if (event.key === 'End') {
                event.preventDefault()
                move(agents.length - 1, 0)
              } else if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault()
                onPick(agent.id)
              }
            }}
            className={`bg-card hover:bg-accent/40 focus-visible:ring-ring relative flex aspect-square flex-col items-center justify-center gap-1.5 overflow-hidden rounded-lg border p-2 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none ${on ? 'border-primary ring-primary ring-2' : ''}`}
          >
            {on ? (
              <span className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full" aria-hidden>
                <Check className="size-3" />
              </span>
            ) : null}
            <ModuleIcon id={agent.id} icon={agent.icon} name={agent.name} className="text-foreground size-8 shrink-0" />
            <span data-agent-name="" className="w-full truncate text-xs font-medium">{agent.name}</span>
            {current === agent.id ? <span className="text-muted-foreground text-[11px]">primary now</span> : null}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------ the question */

/** "Which agent is primary here?": the cubes, what choosing means, Confirm selection and Later. */
export function PrimaryAgentDialog({
  open,
  kehikkoName,
  agents,
  onConfirm,
  onLater,
}: {
  open: boolean
  kehikkoName: string
  agents: readonly AgentChoice[]
  onConfirm(id: string): void | Promise<void>
  onLater(): void | Promise<void>
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setPicked(null)
  }, [open])
  const act = async (what: () => void | Promise<void>) => {
    setBusy(true)
    try {
      await what()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : void act(onLater))}>
      <ModalContent className="sm:max-w-lg" data-primary-agent="">
        <ModalHeader title={PRIMARY_SAID.title} context={kehikkoName} description={PRIMARY_SAID.lede} descriptionClassName="text-sm leading-relaxed" />
        <ModalBody>
          <p className="text-sm leading-relaxed" data-primary-implications="">
            {PRIMARY_SAID.implications}
          </p>
          <AgentCubes agents={agents} picked={picked} onPick={setPicked} label="Agents on this kehikko" />
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void act(onLater)} data-primary-later="">
            Later
          </Button>
          <Button type="button" size="sm" disabled={busy || picked === null} onClick={() => picked && void act(() => onConfirm(picked))} data-primary-confirm="">
            Confirm selection
          </Button>
        </ModalFooter>
      </ModalContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------ the window */

/** Kehikko settings › Agents: the same cubes, what they mean, and a quiet reminder after Later. */
export function AgentsSection({
  answer,
  trouble,
  onChoose,
}: {
  answer: KehikkoSettingsAnswer | null
  trouble: string | null
  onChoose(id: string): Promise<void>
}) {
  const [picked, setPicked] = useState<string | null>(answer?.primary ?? null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setPicked(answer?.primary ?? null), [answer?.primary])
  if (trouble) return <p className="text-destructive text-sm">{trouble}</p>
  if (!answer) return <p className="text-muted-foreground text-sm">Reading…</p>
  const { agents, primary, settings } = answer
  const later = primary === null && agents.length >= 2 && agents.every((one) => settings.later.includes(one.id))
  return (
    <div className="flex flex-col gap-4" data-settings-target="primary-agent">
      <p className="text-sm leading-relaxed">{PRIMARY_SAID.implications}</p>
      {agents.length === 0 ? <p className="text-muted-foreground text-sm">{PRIMARY_SAID.zero}</p> : null}
      {agents.length === 1 ? <p className="text-muted-foreground text-sm">{PRIMARY_SAID.one}</p> : null}
      {agents.length >= 2 && primary === null ? (
        <p className="bg-muted/60 rounded-lg px-3 py-2 text-xs leading-relaxed" data-primary-reminder={later ? 'later' : 'none'}>
          {later ? PRIMARY_SAID.later : PRIMARY_SAID.none}
        </p>
      ) : null}
      {agents.length >= 2 ? (
        <>
          <AgentCubes agents={agents} picked={picked} onPick={setPicked} label="Primary agent" current={primary} />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={busy || picked === null || picked === primary}
              data-primary-confirm=""
              onClick={async () => {
                if (!picked) return
                setBusy(true)
                try {
                  await onChoose(picked)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Confirm selection
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** Kehikko settings › General: what the kehikko is called. */
function GeneralSection({ kehikko, onRename }: { kehikko: KehikkoRef; onRename(id: number, name: string): void }) {
  const [name, setName] = useState(kehikko.name)
  const [said, setSaid] = useState<string | null>(null)
  useEffect(() => {
    setName(kehikko.name)
    setSaid(null)
  }, [kehikko.id, kehikko.name])
  const tidy = name.trim().replace(/\s+/g, ' ')
  return (
    <form
      className="flex flex-col gap-2"
      data-settings-target="kehikko-name"
      onSubmit={(event) => {
        event.preventDefault()
        if (!tidy || tidy === kehikko.name) return
        onRename(kehikko.id, tidy)
        setSaid('Renamed.')
      }}
    >
      <Label htmlFor="kehikko-settings-name" className="text-xs">
        Name
      </Label>
      <div className="flex gap-2">
        <Input id="kehikko-settings-name" value={name} maxLength={60} placeholder="kehikko" onChange={(event) => setName(event.target.value)} className="h-8" aria-label={`what ${kehikko.name} is called`} />
        <Button type="submit" size="sm" disabled={!tidy || tidy === kehikko.name} data-kehikko-rename="">
          Rename
        </Button>
      </div>
      <p className="text-muted-foreground text-xs" aria-live="polite">
        {said ?? 'What this kehikko is called in the kehikko menu.'}
      </p>
    </form>
  )
}

export function KehikkoSettingsDialog({
  open,
  onOpenChange,
  kehikko,
  section,
  onSection,
  target = null,
  onTargetShown,
  onRename,
  load = fetchKehikkoSettings,
  save = postKehikkoSettings,
  skills,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  kehikko: KehikkoRef | null
  section: KehikkoSection
  onSection(section: KehikkoSection): void
  target?: string | null
  onTargetShown?(): void
  onRename(id: number, name: string): void
  load?: typeof fetchKehikkoSettings
  save?: typeof postKehikkoSettings
  /** For tests: how Skills reads and writes. */
  skills?: Pick<React.ComponentProps<typeof KehikkoSkillsPanel>, 'load' | 'save' | 'remove'>
}) {
  const [answer, setAnswer] = useState<KehikkoSettingsAnswer | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const id = kehikko?.id ?? null
  const forSkills = useMemo(() => (kehikko ? { id: kehikko.id, name: kehikko.name } : null), [kehikko?.id, kehikko?.name])

  useEffect(() => {
    if (!open || id === null) return
    let alive = true
    setAnswer(null)
    setTrouble(null)
    load(id).then(
      (got) => alive && setAnswer(got),
      (error: Error) => alive && setTrouble(error.message),
    )
    return () => {
      alive = false
    }
  }, [open, id, load])

  useEffect(() => {
    if (!open || !target) return
    const frame = requestAnimationFrame(() => {
      if (revealTarget(document, target)) onTargetShown?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, target, section, answer, onTargetShown])

  const shown = KEHIKKO_SECTIONS.includes(section) ? section : 'general'
  const skillsShown = (kehikko?.project ?? null) !== null
  const sections = KEHIKKO_SECTIONS.filter((one) => one !== 'skills' || skillsShown)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ModalContent className="h-[min(600px,calc(100dvh-2rem))] sm:max-w-3xl" data-kehikko-settings="">
        <ModalHeader title="Kehikko settings" context={kehikko?.name} description="This kehikko’s own settings: its name, its skills, and which agent gets its shared news." descriptionClassName="max-sm:sr-only" />
        <ModalBody scroll={false}>
          {kehikko ? (
            <Tabs value={shown} onValueChange={(value) => onSection(value as KehikkoSection)} orientation="vertical" className="flex min-h-0 flex-1 flex-col gap-0 sm:flex-row">
              <aside className="bg-muted/40 flex shrink-0 flex-col border-b sm:min-h-0 sm:w-48 sm:overflow-y-auto sm:border-r sm:border-b-0">
                <TabsList aria-label="Kehikko settings sections" className="h-auto w-full justify-start gap-0.5 overflow-x-auto rounded-none bg-transparent px-2 py-2 sm:flex-col sm:items-stretch sm:overflow-visible">
                  {sections.map((key) => {
                    const { title, icon: Icon } = SECTION_SAID[key]
                    return (
                      <TabsTrigger
                        key={key}
                        value={key}
                        data-section={key}
                        className="text-muted-foreground hover:text-foreground data-[state=active]:text-foreground h-8 flex-none justify-start gap-2 px-2.5 text-[13px] font-normal data-[state=active]:font-medium"
                      >
                        <Icon className="size-4" aria-hidden />
                        {title}
                        {key === 'agents' && answer?.due ? (
                          <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-300" data-agents-due="">
                            choose
                          </span>
                        ) : null}
                      </TabsTrigger>
                    )
                  })}
                </TabsList>
              </aside>
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <ScrollArea className="min-h-0 flex-1" data-modal-scroll="">
                  <div className="flex min-w-0 flex-col gap-4 px-5 py-5 sm:px-6">
                    {sections.map((key) => (
                      <TabsContent key={key} value={key} forceMount className="flex min-w-0 flex-col gap-4 data-[state=inactive]:hidden">
                        {key === 'general' ? (
                          <GeneralSection kehikko={kehikko} onRename={onRename} />
                        ) : key === 'skills' ? (
                          <>
                            <p className="text-muted-foreground text-sm leading-relaxed">{DELIVERY_SAID}</p>
                            <KehikkoSkillsPanel active={open && shown === 'skills'} kehikko={forSkills} {...skills} />
                          </>
                        ) : (
                          <AgentsSection
                            answer={answer}
                            trouble={trouble}
                            onChoose={async (primary) => {
                              try {
                                setAnswer(await save(kehikko.id, { primary }))
                              } catch (error) {
                                setTrouble((error as Error).message)
                              }
                            }}
                          />
                        )}
                      </TabsContent>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </Tabs>
          ) : (
            <p className="text-muted-foreground p-5 text-sm">There is no kehikko open.</p>
          )}
        </ModalBody>
      </ModalContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------ held once, in the app */

/**
 * Kehikko settings and the primary-agent question, held once beside the app's other windows.
 *
 * The question is asked for the kehikko on screen: on opening it, and whenever what is placed on it
 * changes (a person adding a module, or an agent through `place_modules`, which the page sees on its
 * next read of the kehikot). The server says whether it is due (`choiceDue`); a question the person
 * closed is not asked again for the same kehikko until its agent modules change.
 */
export function KehikkoSettingsHost({
  canvases,
  open,
  onRename,
  load = fetchKehikkoSettings,
  save = postKehikkoSettings,
}: {
  canvases: readonly (KehikkoRef & { placements: readonly { i: string }[] })[]
  open: (KehikkoRef & { placements: readonly { i: string }[] }) | null
  onRename(id: number, name: string): void
  load?: typeof fetchKehikkoSettings
  save?: typeof postKehikkoSettings
}) {
  const [showing, setShowing] = useState(false)
  const [which, setWhich] = useState<number | null>(null)
  const [section, setSection] = useState<KehikkoSection>('general')
  const [target, setTarget] = useState<string | null>(null)
  const [asking, setAsking] = useState<{ kehikko: number; name: string; agents: AgentChoice[] } | null>(null)
  const asked = useRef(new Set<string>())

  const openId = open?.id ?? null
  useEffect(() => {
    const off = [
      onOpenKehikkoSettings((link) => {
        setWhich(link.kehikko ?? openId)
        setSection(link.section ?? 'general')
        setTarget(link.target)
        setShowing(true)
      }),
      onOpenKehikkoSkills(() => {
        setWhich(openId)
        setSection('skills')
        setTarget(null)
        setShowing(true)
      }),
    ]
    return () => off.forEach((one) => one())
  }, [openId])

  const kehikko = canvases.find((one) => one.id === which) ?? null

  /* What is placed on the kehikko on screen: the question is looked at again when it changes. */
  const placed = open ? [...new Set(open.placements.map((one) => one.i))].sort().join('\n') : ''
  const openName = open?.name ?? ''
  useEffect(() => {
    if (openId === null || open?.project === null || !placed) return
    let alive = true
    let stop = () => {}
    load(openId).then(
      (got) => {
        if (!alive || !got.due) return
        const seen = `${openId}\n${got.agents.map((one) => one.id).sort().join('\n')}`
        if (asked.current.has(seen)) return
        stop = whenNoDialog(() => {
          if (!alive) return
          asked.current.add(seen)
          setAsking({ kehikko: openId, name: openName, agents: got.agents })
        })
      },
      () => undefined,
    )
    return () => {
      alive = false
      stop()
    }
  }, [openId, open?.project, placed, openName, load])

  const close = useCallback(() => setAsking(null), [])

  return (
    <>
      <KehikkoSettingsDialog
        open={showing && kehikko !== null}
        onOpenChange={(next) => {
          setShowing(next)
          if (!next) setTarget(null)
        }}
        kehikko={kehikko}
        section={section}
        onSection={setSection}
        target={target}
        onTargetShown={() => setTarget(null)}
        onRename={onRename}
        load={load}
        save={save}
      />
      <PrimaryAgentDialog
        open={asking !== null}
        kehikkoName={asking?.name ?? ''}
        agents={asking?.agents ?? []}
        onConfirm={async (primary) => {
          if (!asking) return
          await save(asking.kehikko, { primary }).catch(() => undefined)
          close()
        }}
        onLater={async () => {
          if (!asking) return
          await save(asking.kehikko, { later: true }).catch(() => undefined)
          close()
        }}
      />
    </>
  )
}
