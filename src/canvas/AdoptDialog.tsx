import { useEffect, useMemo, useRef, useState } from 'react'
import type { InboxAdoptionResult, SpaceNode } from 'kehikot-module-protocol'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { dialogPlan } from '@/host/adoption.ts'
import { fetchAdoption, postAdopt, postTask, type TaskStarted } from '@/host/adoptClient.ts'

/**
 * Adopting a tracker item no epic names, with the person's agent for Kehikot's own tasks (protocol
 * 2.88.0). The dialog starts a NEW conversation with that agent, fed the item, the epics and the
 * conversations that worked on it (`postTask`), and shows its page while it works. The agent only
 * PROPOSES (`propose_adoption`); the person confirms with ONE press — "Adopt into <epic> · bring
 * <conversation>" — or changes it in the picker, or cancels. With no agent picked, the picker alone,
 * with the host's suggestion chosen (`dialogPlan`).
 *
 * The task's conversation is filed under the epic with the adoption, and left in its module's
 * records like any other when the dialog closes.
 */

export interface AdoptDialogProps {
  project: number
  item: { module: string; id: string }
  /** The kehikko the person is on: the place a conversation brought along is filed at. */
  kehikko: string | null
  onClose(said: string | null): void
  /** For tests: how often the proposal is read again while the agent works. */
  pollMs?: number
}

export function AdoptDialog({ project, item, kehikko, onClose, pollMs = 2500 }: AdoptDialogProps) {
  const [read, setRead] = useState<InboxAdoptionResult | null>(null)
  const [task, setTask] = useState<TaskStarted | null>(null)
  const [changing, setChanging] = useState(false)
  const [epic, setEpic] = useState<string>('')
  /** The space chosen, by its path of ids (protocol 2.89.0): the epic is its first id. */
  const [space, setSpace] = useState<string[]>([])
  const [parts, setParts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  const started = useRef(false)

  /* Read what to offer; with an agent, start it once. */
  useEffect(() => {
    let live = true
    void fetchAdoption(project, item).then((got) => {
      if (!live) return
      setRead(got)
      if (got.suggested) {
        setEpic(got.suggested.epic)
        setSpace(got.suggested.space ? [...got.suggested.space] : [got.suggested.epic])
      } else if (got.epics[0]) {
        setEpic(got.epics[0].epic)
        setSpace([got.epics[0].epic])
      }
      if (got.agent && !started.current) {
        started.current = true
        void postTask(project, item).then((one) => live && setTask(one))
      }
    })
    return () => {
      live = false
    }
  }, [project, item.module, item.id])

  /* While the agent works and has proposed nothing, read again for its proposal. */
  useEffect(() => {
    if (!read?.agent || read.proposal || !task?.ok) return
    const timer = setInterval(() => {
      void fetchAdoption(project, item).then((got) => got.outcome === 'ok' && setRead(got))
    }, pollMs)
    return () => clearInterval(timer)
  }, [read?.agent, read?.proposal, task, project, item.module, item.id, pollMs])

  const plan = useMemo(() => (read ? dialogPlan(read) : null), [read])
  const picking = plan?.mode === 'picker' || changing || (task !== null && !task.ok)
  const chosen = read?.epics.find((one) => one.epic === epic) ?? null
  /* Every space at any depth, as one list: the tree the host sent, or the epics and their parts from an older one. */
  const tree = useMemo<SpaceNode[]>(
    () => read?.spaces ?? (read?.epics ?? []).map((one) => ({ id: one.epic, name: one.title, children: one.parts.map((part) => ({ id: part.id, name: part.name, children: [] })) })),
    [read],
  )
  const rows = useMemo(() => {
    const out: { ids: string[]; said: string }[] = []
    const walk = (nodes: readonly SpaceNode[], above: string[], names: string[]) => {
      for (const node of nodes) {
        const ids = [...above, node.id]
        out.push({ ids, said: [...names, node.name || node.id].join(' › ') })
        walk(node.children, ids, [...names, node.name || node.id])
      }
    }
    walk(tree, [], [])
    return out
  }, [tree])
  const chosenSaid = rows.find((row) => row.ids.join('/') === space.join('/'))?.said ?? chosen?.title ?? ''

  const adopt = async (target: string, inParts: readonly string[], also: readonly string[] = [], into: readonly string[] | null = null) => {
    setBusy(true)
    setTrouble(null)
    const got = await postAdopt(project, item, target, inParts, kehikko, task?.ok ? { module: task.module, session: task.session } : null, also, into)
    setBusy(false)
    if (got.outcome === 'adopted') onClose(got.said)
    else setTrouble(got.why || 'It was not adopted.')
  }

  const title = read?.item ? `Adopt ${read.item.ref}` : 'Adopt into a space'
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(null)}>
      <ModalContent data-adopt-dialog="" className="sm:max-w-3xl">
        <ModalHeader
          title={title}
          titleClassName="text-base"
          description={read?.item ? `${read.item.title} · ${read.item.host}/${read.item.repo}` : 'Reading the item…'}
          descriptionClassName="text-sm"
        />
        <ModalBody>
          {read && read.outcome !== 'ok' ? <p className="text-sm" data-adopt-trouble="">{read.why}</p> : null}
          {task && !task.ok ? (
            <p className="text-muted-foreground mb-2 text-sm" data-adopt-task="failed">
              {task.why} Choose the space yourself.
            </p>
          ) : null}
          {read?.agent && task?.ok ? (
            <div className="mb-3 flex flex-col gap-2" data-adopt-agent={task.module}>
              <p className="text-muted-foreground text-xs">
                {task.name} is working out where it belongs in a new conversation, kept with its others.
              </p>
              <iframe title={`${task.name}: placing ${read.item?.ref ?? 'the item'}`} src={task.view} className="h-80 w-full rounded-md border" data-adopt-view="" />
            </div>
          ) : read?.agent && !task ? (
            <p className="text-muted-foreground mb-3 text-sm" data-adopt-task="starting">
              Starting {read.agent.name}…
            </p>
          ) : null}
          {read?.proposal ? (
            <div className="bg-muted/40 mb-3 rounded-md border px-3 py-2 text-sm" data-adopt-proposal={read.proposal.epic}>
              <p className="font-medium">{plan?.confirm?.label ?? read.proposal.epic}</p>
              <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{read.proposal.why}</p>
            </div>
          ) : null}
          {read && read.conversations.length ? (
            <ul className="text-muted-foreground mb-3 flex flex-col gap-1 text-xs" data-adopt-conversations="">
              {read.conversations.map((one) => (
                <li key={`${one.module}:${one.session}`} data-comes={one.comes ? '' : undefined}>
                  {one.title || 'Untitled'} ({one.program}) — {one.reason}
                  {one.placed ? ` · filed under ${one.placed}, stays there` : one.comes ? ' · comes along' : ''}
                </li>
              ))}
            </ul>
          ) : null}
          {read && picking ? (
            <div className="flex flex-col gap-3" data-adopt-picker="">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="adopt-epic">Space</Label>
                <NativeSelect
                  id="adopt-epic"
                  value={space.join('/')}
                  onChange={(event) => {
                    const ids = event.target.value.split('/').filter(Boolean)
                    setSpace(ids)
                    setEpic(ids[0] ?? '')
                    setParts([])
                  }}
                >
                  {rows.map((row) => (
                    <NativeSelectOption key={row.ids.join('/')} value={row.ids.join('/')}>
                      {row.said}
                      {row.ids.length === 1 && read.suggested?.epic === row.ids[0] ? ' (suggested)' : ''}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {read.suggested && read.suggested.epic === epic ? <p className="text-muted-foreground text-xs">Suggested: {read.suggested.why}.</p> : null}
              </div>
              {space.length === 1 && chosen?.parts.length ? (
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1 text-sm font-medium">Spaces in it</legend>
                  {chosen.parts.map((part) => (
                    <div key={part.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`adopt-part-${part.id}`}
                        checked={parts.includes(part.id)}
                        onCheckedChange={(on) => setParts((was) => (on ? [...was, part.id] : was.filter((one) => one !== part.id)))}
                      />
                      <Label htmlFor={`adopt-part-${part.id}`} className="text-sm font-normal">
                        {part.name}
                      </Label>
                    </div>
                  ))}
                </fieldset>
              ) : null}
            </div>
          ) : null}
          {trouble ? <p className="text-destructive mt-2 text-sm">{trouble}</p> : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" size="sm" onClick={() => onClose(null)}>
            Cancel
          </Button>
          {plan?.mode === 'agent' && !picking ? (
            <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
              Change…
            </Button>
          ) : null}
          {picking ? (
            <Button size="sm" disabled={busy || !chosen} onClick={() => void adopt(epic, parts, [], space.length > 1 ? space : null)} data-adopt-confirm="picker">
              {chosen ? `Adopt into ${chosenSaid}` : 'Adopt'}
            </Button>
          ) : plan?.confirm ? (
            <Button size="sm" disabled={busy} onClick={() => void adopt(plan.confirm!.epic, plan.confirm!.parts, plan.confirm!.conversations)} data-adopt-confirm="proposal">
              {plan.confirm.label}
            </Button>
          ) : null}
        </ModalFooter>
      </ModalContent>
    </Dialog>
  )
}
