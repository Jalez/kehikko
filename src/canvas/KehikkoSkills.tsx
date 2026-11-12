import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { ModalBody, ModalContent, ModalHeader } from '@/components/ui/modal.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import {
  DELIVERY_SAID,
  draftIssue,
  fetchKehikkoSkills,
  LIMITS_SAID,
  previewOf,
  removeKehikkoSkill,
  saveKehikkoSkill,
  slugOf,
  type KeptSkill,
} from '@/host/kehikkoSkills.ts'

/**
 * "Skills for this kehikko…": the person's own skills for every agent session on the open kehikko
 * (protocol 2.53.0). A list, a form to add or change one, removal in two presses, and the skill as a
 * session reads it (its SKILL.md) shown as text. Everything here is the person's: the server takes
 * these writes from this page alone (`PAGE_ONLY`). See `src/host/kehikkoSkills.ts`.
 */

type Draft = { name: string; description: string; body: string; was: string | null }
const EMPTY: Draft = { name: '', description: '', body: '', was: null }

export function KehikkoSkillsDialog({
  open,
  onOpenChange,
  kehikko,
  load = fetchKehikkoSkills,
  save = saveKehikkoSkill,
  remove = removeKehikkoSkill,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  kehikko: { id: number; name: string } | null
  load?: typeof fetchKehikkoSkills
  save?: typeof saveKehikkoSkill
  remove?: typeof removeKehikkoSkill
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ModalContent className="sm:max-w-lg" data-kehikko-skills="">
        <ModalHeader
          title={<>Skills for {kehikko ? kehikko.name : 'this kehikko'}</>}
          titleClassName="text-base"
          description={DELIVERY_SAID}
          descriptionClassName="text-sm leading-relaxed"
        />
        <ModalBody>
          <KehikkoSkillsPanel active={open} kehikko={kehikko} load={load} save={save} remove={remove} />
        </ModalBody>
      </ModalContent>
    </Dialog>
  )
}

/**
 * The list and the form, without a window around them: Kehikko settings › Skills draws this, and
 * the dialog above does too. Read again each time `active` turns on.
 */
export function KehikkoSkillsPanel({
  active,
  kehikko,
  load = fetchKehikkoSkills,
  save = saveKehikkoSkill,
  remove = removeKehikkoSkill,
}: {
  active: boolean
  kehikko: { id: number; name: string } | null
  load?: typeof fetchKehikkoSkills
  save?: typeof saveKehikkoSkill
  remove?: typeof removeKehikkoSkill
}) {
  const [skills, setSkills] = useState<KeptSkill[] | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [arming, setArming] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!kehikko) return
    try {
      const got = await load(kehikko.id)
      setSkills(got.skills)
      setFolder(got.folder)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [kehikko, load])

  useEffect(() => {
    if (!active) return
    setSkills(null)
    setDraft(null)
    setArming(null)
    setPreview(false)
    setSaid(null)
    setError(null)
    void reload()
  }, [active, reload])

  const issue = draft ? draftIssue(draft) : null
  const full = (skills?.length ?? 0) >= LIMITS_SAID.most

  const submit = async () => {
    if (!kehikko || !draft || issue) return
    setBusy(true)
    setError(null)
    try {
      setSaid(await save(kehikko.id, draft))
      setDraft(null)
      setPreview(false)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const drop = async (name: string) => {
    if (!kehikko) return
    setBusy(true)
    setError(null)
    try {
      setSaid(await remove(kehikko.id, name))
      setArming(null)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>

        {draft ? (
          <form
            className="flex flex-col gap-3"
            data-kehikko-skill-form=""
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="kehikko-skill-name" className="text-xs">
                Name <span className="text-muted-foreground font-normal">(lowercase words joined by dashes)</span>
              </Label>
              <Input
                id="kehikko-skill-name"
                value={draft.name}
                maxLength={LIMITS_SAID.name}
                placeholder="review-checklist"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                onBlur={() => setDraft({ ...draft, name: slugOf(draft.name) })}
                className="h-8 font-mono"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="kehikko-skill-description" className="text-xs">
                When to use it <span className="text-muted-foreground font-normal">(one line; an agent decides by it)</span>
              </Label>
              <Input
                id="kehikko-skill-description"
                value={draft.description}
                maxLength={LIMITS_SAID.description}
                placeholder="When reviewing a change on this kehikko"
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                className="h-8"
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="kehikko-skill-body" className="text-xs">
                  What the agent should do <span className="text-muted-foreground font-normal">(markdown)</span>
                </Label>
                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setPreview(!preview)} data-kehikko-skill-preview-toggle="">
                  {preview ? 'Edit' : 'Preview'}
                </Button>
              </div>
              {preview ? (
                <pre className="bg-muted max-h-72 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap" data-kehikko-skill-preview="">
                  {previewOf(draft)}
                </pre>
              ) : (
                <Textarea
                  id="kehikko-skill-body"
                  value={draft.body}
                  maxLength={LIMITS_SAID.body}
                  rows={10}
                  onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                  className="font-mono text-xs"
                />
              )}
              <span className="text-muted-foreground text-right text-[11px] tabular-nums">
                {draft.body.length.toLocaleString('en')} / {LIMITS_SAID.body.toLocaleString('en')}
              </span>
            </div>
            {issue && (draft.name || draft.description || draft.body) ? <p className="text-muted-foreground text-xs">{issue}</p> : null}
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || issue !== null}>
                {draft.was ? 'Save' : 'Add skill'}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            {skills === null && !error ? <p className="text-muted-foreground text-sm">Reading…</p> : null}
            {skills?.length === 0 ? <p className="text-muted-foreground text-sm">This kehikko has no skills of its own yet.</p> : null}
            {skills?.length ? (
              <ul className="flex flex-col divide-y rounded-md border" data-kehikko-skill-list="">
                {skills.map((skill) => (
                  <li key={skill.name} className="flex items-start gap-2 p-2" data-kehikko-skill={skill.name}>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="font-mono text-sm">{skill.name}</span>
                      <span className="text-muted-foreground text-xs break-words">{skill.description}</span>
                    </div>
                    {arming === skill.name ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs">
                        remove it?
                        <Button type="button" variant="destructive" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void drop(skill.name)}>
                          Remove
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setArming(null)}>
                          Keep
                        </Button>
                      </span>
                    ) : (
                      <span className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          aria-label={`edit ${skill.name}`}
                          onClick={() => {
                            setSaid(null)
                            setError(null)
                            setDraft({ name: skill.name, description: skill.description, body: skill.body, was: skill.name })
                          }}
                        >
                          <Pencil className="size-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="size-6" aria-label={`remove ${skill.name}`} onClick={() => setArming(skill.name)}>
                          <Trash2 className="size-3" />
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {said ? <p className="text-xs" data-kehikko-skill-said="">{said}</p> : null}
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
            {folder ? <p className="text-muted-foreground text-xs">Kept in the project’s {folder} — commit it and the kehikko keeps them on every computer.</p> : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!kehikko || skills === null || full || folder === null}
                onClick={() => {
                  setSaid(null)
                  setError(null)
                  setDraft(EMPTY)
                }}
              >
                <Plus className="size-3" />
                New skill
              </Button>
            </div>
            {full ? <p className="text-muted-foreground text-xs">A kehikko keeps at most {LIMITS_SAID.most} skills.</p> : null}
          </div>
        )}
    </>
  )
}
