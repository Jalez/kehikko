import { FolderOpen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import type { Project } from '@/host/projects.ts'

/**
 * The dialog a module gets instead of a list of projects.
 *
 * ## Why this screen exists, and what it is standing in the way of
 *
 * A framed module is told one `projectPath` and may read what the host named.
 * Every module in this workspace keeps its data inside that project, so the
 * first thing anybody wants once they have two projects is to move something
 * between them — a checklist, a set of notes — and the obvious way to build it
 * is a method that answers "what projects exist". That method would hand a
 * stranger's program a listing of somebody's disk, and no amount of care
 * afterwards takes it back.
 *
 * So the module asks, and this is where the asking lands. It is the browser's
 * file picker's shape: the module cannot name a project, cannot filter this
 * list, cannot write a word of what is on this screen, and cannot learn that it
 * was refused for want of projects rather than for any other reason. What it
 * receives is one path, because a person pressed one row.
 *
 * ## Everything on this screen is the host's own words
 *
 * The title names the module out of the registration the conversation was built
 * on — never out of anything the frame said — for the same reason `events.emit`
 * takes its sender from the host's material. This is the one screen where
 * somebody decides whether to hand a program a folder, and a sentence a module
 * wrote would be read as the host's.
 *
 * ## Closing it is an answer
 *
 * Escape, the overlay, the X and Cancel all mean `cancelled`, and the module is
 * told so rather than left waiting. A dialog that could be dismissed into
 * silence would leave a module spinning until its own deadline, which is the
 * "a spinner is a claim that an answer is coming" failure with the claim made
 * false by this end.
 */
export function Picking({
  projects,
  asking,
  onPick,
  onCancel,
}: {
  projects: readonly Project[]
  /**
   * What the asking module is called, in the host's own words, or null when
   * nothing is asking and this draws nothing.
   */
  asking: string | null
  onPick(project: Project): void
  onCancel(): void
}) {
  const [typing, setTyping] = useState('')
  const box = useRef<HTMLInputElement | null>(null)

  /* Cleared whenever a new ask arrives. A filter left over from the last time
     somebody was asked would hide most of the list on a screen where the person
     has not typed anything, which reads as "you have three projects". */
  useEffect(() => {
    setTyping('')
  }, [asking])

  /*
   * The combobox, which is a box and a list rather than a component.
   *
   * shadcn's combobox is `cmdk` inside a popover, and a popover inside a modal
   * is two layers of portal for a menu that is already the only thing on the
   * screen. What a combobox actually is — type to narrow, press to choose — is
   * a filtered list under an input, and that is what this is. The dependency
   * buys nothing here and costs a second focus trap.
   *
   * Matched on the name AND the path, because two projects called `paper` in
   * different folders is the case where the name alone cannot tell them apart —
   * which is also why the path is drawn under every row rather than hidden in a
   * tooltip.
   */
  const shown = useMemo(() => {
    const wanted = typing.trim().toLowerCase()
    if (!wanted) return projects
    return projects.filter(
      (one) => one.name.toLowerCase().includes(wanted) || one.path.toLowerCase().includes(wanted),
    )
  }, [projects, typing])

  return (
    <Dialog open={asking !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={(event) => {
          /* The box, not the first row. A person who knows which project they
             want types three letters; a person who does not reads the list, and
             the list is right there either way. Pressing the first row by
             accident is the one outcome this screen must not make easy. */
          event.preventDefault()
          box.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{asking ?? 'A module'} is asking for a project</DialogTitle>
          <DialogDescription>
            It will be told where the one you choose is on this machine, and nothing about the rest. Nothing
            is opened here — the canvas stays on the project it is on.
          </DialogDescription>
        </DialogHeader>

        <Input
          ref={box}
          value={typing}
          onChange={(e) => setTyping(e.target.value)}
          placeholder="Filter by name or path"
          aria-label="Filter projects"
        />

        {projects.length === 0 ? (
          /* This host holds no projects. The MODULE is told `declined` — see the
             protocol's essay on the outcomes — but the person in front of the
             screen is not a stranger's program and gets the real sentence. */
          <p className="text-muted-foreground text-sm">
            There are no projects here yet. Add one from the project menu in the header, and this will have
            something to offer.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing here matches “{typing.trim()}”.</p>
        ) : (
          <ul className="max-h-72 divide-y overflow-y-auto rounded border" data-picking="projects">
            {shown.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  data-project={project.id}
                  onClick={() => onPick(project)}
                  className="hover:bg-accent/60 focus-visible:ring-ring flex w-full items-start gap-2 px-3 py-2 text-left focus-visible:ring-2 focus-visible:outline-none"
                >
                  <FolderOpen className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium break-words">{project.name}</span>
                    {/* The path, drawn rather than hidden: it is the only thing
                        that tells two folders with the same basename apart, and
                        it is also exactly what the module is about to be given.
                        A person deciding should be reading the thing that is
                        being handed over. */}
                    <span className="text-muted-foreground block text-xs break-all">{project.path}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
