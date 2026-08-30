import { ChevronRight, CornerLeftUp, FolderGit2, FolderOpen, FolderPlus, Layers } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { fetchFolders, type Entry, type Listing, type Project } from '@/host/projects.ts'
import { Hint } from './Hint.tsx'

/**
 * The project: which one you are in, and how to open another.
 *
 * First control in the strip, before the epic and before the kehikko, because
 * that is the order the things themselves nest in. A project is a folder; the
 * epics are inside it; the kehikot are layouts over it. Reading the header left
 * to right is reading the hierarchy outward-in, and a person who changes the
 * leftmost control expects everything to its right to change with it — which is
 * exactly what happens.
 *
 * ## The add button is at the end of the list, because that is where it was asked for
 *
 * The user's words: *"you should have an add a project button at the end of the
 * list of projects."* Not a separate icon in the strip. The list of projects IS
 * the place a person goes when they want a different project, and "the one I
 * want is not here" is answered where the question was asked — one press, in
 * the menu already open, below the last entry.
 */
export function Projects({
  projects,
  open,
  onOpen,
  onAdd,
}: {
  projects: readonly Project[]
  open: Project | null
  onOpen(id: number): void
  /** Given an absolute folder. The server decides whether it is a project. */
  onAdd(path: string): void
}) {
  const [browsing, setBrowsing] = useState(false)

  return (
    <div className="flex shrink-0 items-center">
      <DropdownMenu>
        <Hint
          label={
            open
              ? `project — ${open.path}${open.epics ? '' : ' (no data/epics here)'}`
              : 'no project is open'
          }
          align="start"
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="switch project"
              className="text-foreground h-6 max-w-44 gap-1 px-1.5 text-xs font-medium"
            >
              <FolderOpen className="text-muted-foreground size-3 shrink-0" />
              {/*
               * `min-w-0` and `truncate`, and this is the trap the house rules
               * name. A project's PATH is exactly the sort of long unbreakable
               * string that has already set an eleven-hundred pixel min-content
               * floor under a narrow pane elsewhere here. The name is short and
               * the path is in the tooltip, where there is room for it.
               */}
              <span className="min-w-0 truncate">{open?.name ?? 'no project'}</span>
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>projects</DropdownMenuLabel>
          {projects.map((project) => (
            <DropdownMenuItem key={project.id} onSelect={() => onOpen(project.id)}>
              <DropdownMenuCheck checked={project.id === open?.id} />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {/* Whether a kehikko here would have epics to pick. Said in the
                  list rather than only after switching, because "this project
                  has none" is the difference between a picker worth opening and
                  one that looks broken. */}
              {project.epics ? (
                <Layers className="text-muted-foreground size-3 shrink-0" />
              ) : (
                <span className="text-muted-foreground shrink-0 text-[10px]">no epics</span>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {/* At the end of the list of projects, which is where it was asked
              for and where the question it answers gets asked. */}
          <DropdownMenuItem onSelect={() => setBrowsing(true)}>
            <FolderPlus className="text-muted-foreground size-3 shrink-0" />
            <span className="flex-1">add a project…</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Browser
        open={browsing}
        onOpenChange={setBrowsing}
        start={open?.path ?? null}
        onPick={(path) => {
          setBrowsing(false)
          onAdd(path)
        }}
      />
    </div>
  )
}

/**
 * The folder browser, which is server-backed, and that is not a shortcut.
 *
 * A browser cannot hand a page a real filesystem path. `showDirectoryPicker()`
 * returns an opaque handle: the page may read files THROUGH it and can never
 * learn where it points. What this host needs is the string
 * `/Users/somebody/Projects/roadmap`, because that string becomes
 * `roadmap.context.projectPath` and every module joins its own subdirectory
 * onto it. A handle cannot be turned into that, by any means, on purpose.
 *
 * So the server lists directory NAMES and this draws them. Every refusal lives
 * on that side — see the four rules at the top of `server/folders.ts` — and
 * this component decides nothing about where it may look. It walks down from
 * home, it walks up as far as the roots allow, and when the server says no it
 * shows the sentence the server gave.
 *
 * ## What a folder is, shown rather than assumed
 *
 * Repository, worktree, has-epics. The last is the one that changes what a
 * kehikko there can do, and showing it before the project is added is what
 * stops somebody adding one and then wondering why the epic picker is empty.
 */
function Browser({
  open,
  onOpenChange,
  start,
  onPick,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** Where to start walking. The open project's folder, or the server's default. */
  start: string | null
  onPick(path: string): void
}) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [at, setAt] = useState<string | null>(null)

  /* The dialog opens where the person already is. Starting at home every time
     would make "add the folder next to this one" a walk down from the top, and
     the commonest second project is a sibling of the first. */
  useEffect(() => {
    if (open) setAt(start)
  }, [open, start])

  const walk = useCallback((path: string | null) => {
    setAt(path)
  }, [])

  useEffect(() => {
    if (!open) return
    const stop = new AbortController()
    void (async () => {
      try {
        setListing(await fetchFolders(at, stop.signal))
        setTrouble(null)
      } catch (error) {
        if (stop.signal.aborted) return
        /* The server's own sentence. "That folder is outside the places this
           host will list" is something a person can act on; 403 is not. */
        setTrouble((error as Error).message)
      }
    })()
    return () => stop.abort()
  }, [open, at])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription>
            A project is a folder — a repository, a git worktree, or any directory with work in it. Epics
            come from <span className="font-mono">data/epics</span> under it, and a project that has none is
            still a project.
          </DialogDescription>
        </DialogHeader>

        {/* The path this dialog is standing in. `break-all` and its own row,
            because a path is the long unbreakable string that sets a
            min-content floor under everything sharing a line with it. */}
        <p className="text-muted-foreground font-mono text-[11px] break-all">
          {listing?.path ?? at ?? 'your home folder'}
        </p>

        {trouble ? <p className="text-destructive text-xs">{trouble}</p> : null}

        <div className="max-h-[50vh] overflow-auto rounded-md border">
          <ul className="divide-y">
            {listing?.parent ? (
              <li>
                <button
                  type="button"
                  className="hover:bg-accent flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
                  onClick={() => walk(listing.parent)}
                >
                  <CornerLeftUp className="text-muted-foreground size-3 shrink-0" />
                  <span className="text-muted-foreground">up one</span>
                </button>
              </li>
            ) : null}
            {(listing?.entries ?? []).map((entry) => (
              <Row key={entry.path} entry={entry} onEnter={() => walk(entry.path)} onPick={onPick} />
            ))}
            {listing && !listing.entries.length && !trouble ? (
              <li className="text-muted-foreground px-3 py-3 text-xs">
                No folders in here. This one can still be added.
              </li>
            ) : null}
          </ul>
          {/* Said out loud rather than silently clipped: a list that quietly
              ends is a list somebody believes is the whole of it. */}
          {listing?.more ? (
            <p className="text-muted-foreground border-t px-3 py-2 text-[11px]">
              {listing.more} more folder{listing.more === 1 ? '' : 's'} in here are not listed.
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          {/* Adding the folder you are STANDING in, not one you highlighted.
              A walk has an obvious current place and a selection would be a
              second piece of state saying the same thing — and disagreeing with
              it the moment somebody walks without re-picking. */}
          <Button size="sm" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
            add this folder
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Row({
  entry,
  onEnter,
  onPick,
}: {
  entry: Entry
  onEnter(): void
  onPick(path: string): void
}) {
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        className="hover:bg-accent flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs"
        onClick={onEnter}
      >
        <ChevronRight className="text-muted-foreground size-3 shrink-0" />
        <span className="min-w-0 truncate">{entry.name}</span>
        {/* Plain words rather than badges. A shadcn `Badge` is
            `whitespace-nowrap` in its base, and a nowrap child sets a
            min-content floor under everything above it — which has already
            given a two-hundred pixel pane an eleven-hundred pixel floor once in
            this codebase. Nothing here needs to be a badge. */}
        {entry.git ? (
          <span className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5 text-[10px]">
            <FolderGit2 className="size-3" /> repo
          </span>
        ) : null}
        {entry.worktree ? (
          <span className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5 text-[10px]">
            <FolderGit2 className="size-3" /> worktree
          </span>
        ) : null}
        {entry.epics ? (
          <span className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5 text-[10px]">
            <Layers className="size-3" /> epics
          </span>
        ) : null}
      </button>
      <Hint label={`add ${entry.name} as a project`} side="left">
        <Button
          variant="ghost"
          size="sm"
          className="mr-1 h-6 shrink-0 px-2 text-[11px]"
          onClick={() => onPick(entry.path)}
        >
          add
        </Button>
      </Hint>
    </li>
  )
}
