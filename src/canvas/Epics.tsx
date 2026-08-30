import { ChevronDown, Circle, CircleSlash } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import type { Epic, Epics as Held } from '@/host/projects.ts'
import { Hint } from './Hint.tsx'

/**
 * The epic every module on this kehikko is shown, picked from a list.
 *
 * ## It used to be a text field, and a text field was the wrong control
 *
 * The bar had an `<input>`: you typed a slug, it was trimmed, and whatever came
 * out became `roadmap.context.epic`. That was the right control while the host
 * had no idea what epics existed — it holds no data of its own, and a picker
 * over a list it could not read would have been a picker with nothing in it.
 *
 * Now a kehikko is in a project and a project is a folder, so the host CAN read
 * the list: `data/epics` under the project, which is the same reading
 * `epics.list` gives a framed module. A field you type a slug into, next to a
 * list of the slugs that exist, is a way to make a typo authoritative. So it is
 * a select.
 *
 * The fallback in `toWireContext` for a slug the schema will not take is kept
 * rather than deleted, and its comment now says what it actually guards: a slug
 * persisted before this picker existed, and a kehikko whose remembered epic is
 * no longer in its project.
 *
 * ## A project with no epics says so
 *
 * The user's thesis folder has `main.tex`, `chapters/` and `references.bib` and
 * no `data/epics` at all. A kehikko there honestly has nothing to pick, and an
 * empty dropdown is indistinguishable from a project whose epics failed to
 * load. So `holds` — whether the directory exists at all — is carried
 * separately from the list, and the control says which of the two it is in
 * words. It is disabled in that case rather than hidden: a control that
 * vanishes is one somebody hunts for, and its absence explains nothing.
 *
 * ## `view.goto` moves this, and it is not a second source of truth
 *
 * A module may ask the canvas to show an epic — `view.goto` in `host/ask.ts`,
 * which is a protocol method rather than any one module's feature. It does not
 * touch this component. It sets the canvas's subject, which is where this reads
 * from, so the select follows for the same reason every framed module does.
 * That is deliberate: the subject is one fact, and a control holding its own
 * copy would be a second one for the method to fail to move.
 */
export function Epics({
  epic,
  held,
  hasProject,
  onPick,
}: {
  /** What the kehikko is on now, straight from the canvas's subject. */
  epic: string | null
  /** What this project holds, or null while it is still being read. */
  held: Held | null
  hasProject: boolean
  onPick(epic: string | null): void
}) {
  const epics = held?.epics ?? []
  const holds = held?.holds ?? false
  /* Three states and not two: no project, a project with no epics directory,
     and a directory that is there and empty. Only the first is the host not
     knowing yet; the other two are answers. */
  const nothingToPick = !hasProject || !holds || epics.length === 0

  const label = !hasProject
    ? 'no project is open, so there is no epic to pick'
    : !held
      ? 'reading this project’s epics…'
      : !holds
        ? 'this project has no data/epics, so there is no epic to pick — which is not a fault: not every project has any'
        : epics.length === 0
          ? 'this project’s data/epics is empty'
          : 'the epic every module on this kehikko is shown'

  return (
    <DropdownMenu>
      <Hint label={label} align="start">
        {/* A span, because a disabled button dispatches no pointer events and
            so never opens its tooltip — which is precisely the moment the
            explanation is worth having. The same trick `Canvases.tsx` uses on
            the delete button, for the same reason. */}
        <span className="inline-flex shrink-0">
          <DropdownMenuTrigger asChild disabled={nothingToPick}>
            <Button
              variant="ghost"
              size="sm"
              aria-label="the epic this kehikko is about"
              disabled={nothingToPick}
              className="h-6 max-w-52 gap-1 px-1.5 font-mono text-xs disabled:pointer-events-none"
            >
              {epic ? (
                <Circle className="text-muted-foreground size-3 shrink-0" />
              ) : (
                <CircleSlash className="text-muted-foreground size-3 shrink-0" />
              )}
              <span className={epic ? 'min-w-0 truncate' : 'text-muted-foreground min-w-0 truncate'}>
                {epic ?? sentenceFor(hasProject, held)}
              </span>
              {nothingToPick ? null : <ChevronDown className="text-muted-foreground size-3 shrink-0" />}
            </Button>
          </DropdownMenuTrigger>
        </span>
      </Hint>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-80 overflow-auto">
        <DropdownMenuLabel>epics</DropdownMenuLabel>
        {epics.map((one) => (
          <DropdownMenuItem key={one.slug} onSelect={() => onPick(one.slug)}>
            <DropdownMenuCheck checked={one.slug === epic} />
            <span className="min-w-0 flex-1 truncate">{titleOf(one)}</span>
            {/* How much it names, when the file says. Never invented — see
                `countOf` in `server/holdings.ts`, which answers null rather
                than zero when there is nothing to count. */}
            {one.size ? (
              <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{one.size}</span>
            ) : null}
          </DropdownMenuItem>
        ))}
        {epic ? (
          <>
            <DropdownMenuSeparator />
            {/* "No epic" is a state a kehikko is allowed to be in, and every
                module is required to be able to move into it — so it is a thing
                a person can choose rather than one they can only leave. */}
            <DropdownMenuItem onSelect={() => onPick(null)}>
              <CircleSlash className="text-muted-foreground size-3 shrink-0" />
              <span className="flex-1">no epic</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * What the control says when no epic is picked.
 *
 * Four different sentences for four different situations, because "no epic" and
 * "this project has none" and "still reading" look identical if they are all
 * rendered as an empty box — and only one of the four is something a person
 * should do anything about.
 */
function sentenceFor(hasProject: boolean, held: Held | null): string {
  if (!hasProject) return 'no project'
  if (!held) return 'reading epics…'
  if (!held.holds) return 'no epics here'
  if (!held.epics.length) return 'no epics yet'
  return 'pick an epic'
}

/** The title when the file has one, the slug when it does not. Never invented. */
function titleOf(epic: Epic): string {
  return epic.title ?? epic.slug
}
