import { ExternalLink, ScrollText } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { parseMarkdown, type Block, type Inline } from '@/host/markdown.ts'
import {
  fetchNotes,
  notesLabel,
  notesTitle,
  NotesTrouble,
  openExternal,
  releaseDate,
  releasePage,
  type Release,
} from '@/host/releaseNotes.ts'

/**
 * Release notes: a small icon beside a version, and the dialog it opens.
 *
 * ## The button
 *
 * Every version in a version list — a module's picker, Kehikot's releases, the
 * app row in Updates — can carry one: a scroll icon whose tooltip and
 * accessible name are "Show release notes for v1.2.0". It shows notes and does
 * nothing else: the press stops where it is, so the row it sits in is not
 * chosen, pinned or installed. Sixteen pixels drawn, twenty-four to hit (an
 * `after:` box around it, as the Remove in the pick lists has), so the row
 * keeps its height.
 *
 * ## The dialog
 *
 * Modal and the host's own (`components/ui/dialog.tsx`), because notes are
 * longer than a menu: "What's new in Notes v1.2.0", the notes in a scrolling
 * body, and "Open on GitHub" — which opens the release page in the person's
 * browser (`openExternal`). Reading and failing are said inside it. Escape or
 * the ✕ closes it and puts focus back on the button that opened it, without
 * raising that button's tooltip: nobody asked what it is, they just used it.
 *
 * ## Untrusted text
 *
 * The notes are drawn from the tree `host/markdown.ts` makes, with React
 * elements whose children are strings. Nothing is ever set as HTML.
 */

/** A version's notes button. `onShow` gets the button, so focus can come back to it. */
export function NotesButton({ version, onShow }: { version: string; onShow(opener: HTMLElement): void }) {
  const label = notesLabel(version)
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          /* Focus handed back as the dialog closes does not raise the label. */
          if ((event.currentTarget as HTMLElement).dataset.quietFocus) event.preventDefault()
        }}
      >
        <button
          type="button"
          aria-label={label}
          data-testid="release-notes-button"
          data-notes={version}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onShow(event.currentTarget)
          }}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring relative inline-flex size-4 shrink-0 cursor-default items-center justify-center rounded-sm outline-none after:absolute after:-inset-1 after:content-[''] focus-visible:ring-2"
        >
          <ScrollText className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

interface Asked {
  repo: string
  tag: string
  name: string
  /** What the title calls it: `0.1.24`, or the tag. */
  version: string
  opener: HTMLElement | null
}

type Reading = { kind: 'reading' } | { kind: 'read'; release: Release } | { kind: 'failed'; why: string; url: string; missing: boolean }

/**
 * The dialog, and a `show` to open it. The component that owns the version
 * list renders `dialog` and passes `show` to its buttons; `open` is true while
 * it stands, so a popover around the list can keep itself open meanwhile and
 * the focus has somewhere to come back to.
 */
export function useReleaseNotes(): {
  show(asked: Asked): void
  open: boolean
  dialog: ReactNode
} {
  const [asked, setAsked] = useState<Asked | null>(null)
  const [open, setOpen] = useState(false)
  const show = useCallback((next: Asked) => {
    setAsked(next)
    setOpen(true)
  }, [])
  const dialog = asked ? (
    <ReleaseNotesDialog
      key={`${asked.repo}@${asked.tag}`}
      repo={asked.repo}
      tag={asked.tag}
      name={asked.name}
      version={asked.version}
      open={open}
      onOpenChange={setOpen}
      opener={asked.opener}
    />
  ) : null
  return { show, open, dialog }
}

export function ReleaseNotesDialog({
  repo,
  tag,
  name,
  version,
  open,
  onOpenChange,
  opener = null,
  load = fetchNotes,
}: {
  repo: string
  tag: string
  name: string
  version: string
  open: boolean
  onOpenChange(open: boolean): void
  opener?: HTMLElement | null
  load?: typeof fetchNotes
}) {
  const [reading, setReading] = useState<Reading>({ kind: 'reading' })
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    load(repo, tag, abort.signal).then(
      (release) => setReading({ kind: 'read', release }),
      (error: unknown) => {
        if (abort.signal.aborted) return
        const trouble = error instanceof NotesTrouble ? error : null
        setReading({
          kind: 'failed',
          why: (error as Error)?.message ?? 'no reason given',
          url: trouble?.url ?? releasePage(repo, tag),
          missing: trouble?.missing ?? false,
        })
      },
    )
    return () => abort.abort()
  }, [open, repo, tag, load])

  const page = reading.kind === 'read' ? reading.release.url : reading.kind === 'failed' ? reading.url : releasePage(repo, tag)
  const published = reading.kind === 'read' ? releaseDate(reading.release.publishedAt) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(40rem,85vh)] max-w-xl flex-col gap-3 p-0"
        data-testid="release-notes"
        onCloseAutoFocus={(event) => {
          /* Radix returns focus to a DialogTrigger, and this dialog has none:
             it goes back to the button that opened it, quietly. */
          event.preventDefault()
          if (!opener || !opener.isConnected) return
          opener.dataset.quietFocus = '1'
          opener.focus()
          delete opener.dataset.quietFocus
        }}
      >
        <DialogHeader className="border-b px-5 pt-4 pb-3 pr-10">
          <DialogTitle>{notesTitle(name, version)}</DialogTitle>
          <DialogDescription className="text-xs">
            {reading.kind === 'read'
              ? [reading.release.name && reading.release.name !== tag ? reading.release.name : tag, published].filter(Boolean).join(' · ')
              : `${repo} · ${tag}`}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto px-5 text-sm" data-testid="release-notes-body">
          {reading.kind === 'reading' ? (
            <p className="text-muted-foreground py-2 text-xs">Reading the release notes…</p>
          ) : reading.kind === 'failed' ? (
            <div className="py-2 text-xs" data-testid="release-notes-trouble">
              <p className="text-foreground">
                {reading.missing ? `No release notes were published for ${tag}.` : "Couldn't load the release notes — open on GitHub."}
              </p>
              {reading.missing ? null : <p className="text-muted-foreground pt-1">{reading.why}</p>}
            </div>
          ) : reading.release.body.trim() ? (
            <Markdown source={reading.release.body} />
          ) : (
            <p className="text-muted-foreground py-2 text-xs">This release has no notes.</p>
          )}
        </div>
        <div className="flex justify-end border-t px-5 py-3">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            data-testid="release-notes-github"
            data-href={page}
            onClick={() => openExternal(page)}
          >
            <ExternalLink className="size-3" />
            Open on GitHub
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Release notes drawn from the safe subset. Every leaf is a string child; nothing is set as HTML. */
export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source)
  return <div className="release-notes space-y-2 pb-3 leading-relaxed">{blocks.map((block, i) => drawBlock(block, i))}</div>
}

function drawBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const size = block.level <= 2 ? 'text-sm font-semibold' : 'text-[13px] font-semibold'
      const Tag = (`h${Math.min(6, block.level + 2)}` as 'h3' | 'h4' | 'h5' | 'h6')
      return (
        <Tag key={key} className={`${size} pt-1`}>
          {drawInline(block.children)}
        </Tag>
      )
    }
    case 'paragraph':
      return <p key={key}>{drawInline(block.children)}</p>
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul'
      return (
        <List key={key} className={`${block.ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5`}>
          {block.items.map((item, i) => (
            <li key={i}>{drawInline(item)}</li>
          ))}
        </List>
      )
    }
    case 'code':
      return (
        <pre key={key} className="bg-muted overflow-auto rounded-md p-2 font-mono text-xs">
          {block.text}
        </pre>
      )
    case 'small':
      return (
        <p key={key} className="text-muted-foreground pt-1 text-[11px]">
          {drawInline(block.children)}
        </p>
      )
    case 'rule':
      return <hr key={key} className="border-border" />
  }
}

function drawInline(nodes: readonly Inline[]): ReactNode {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={i}>{node.text}</Fragment>
      case 'strong':
        return <strong key={i}>{drawInline(node.children)}</strong>
      case 'em':
        return <em key={i}>{drawInline(node.children)}</em>
      case 'code':
        return (
          <code key={i} className="bg-muted rounded px-1 py-0.5 font-mono text-[12px]">
            {node.text}
          </code>
        )
      case 'link':
        return (
          <a
            key={i}
            href={node.href}
            rel="noreferrer noopener"
            target="_blank"
            className="text-foreground underline underline-offset-2"
            onClick={(event) => {
              event.preventDefault()
              openExternal(node.href)
            }}
          >
            {drawInline(node.children)}
          </a>
        )
    }
  })
}
