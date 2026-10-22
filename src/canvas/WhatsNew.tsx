import { ExternalLink, GitBranch } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Label } from '@/components/ui/label.tsx'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import { Separator } from '@/components/ui/separator.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { fetchOnboarding, introDue } from '@/host/onboarding.ts'
import { APP_REPO, fetchNotes, fetchReleases, openExternal, releasePage } from '@/host/releaseNotes.ts'
import {
  ackFor,
  announceShow,
  appRange,
  APP_ITEM,
  fetchWhatsNew,
  firstRunSettled,
  FOLLOWING_MAIN,
  headerSaid,
  mergeItems,
  newsItems,
  onOpenWhatsNew,
  onPoke,
  onShowChanged,
  postWhatsNew,
  QUIET_MS,
  rangeSaid,
  releasesSaid,
  whenQuiet,
  type NewsItem,
  type WhatsNewAnswer,
} from '@/host/whatsNew.ts'
import { useShownVersion } from './AppVersion.tsx'
import { KehikkoMark } from './Mark.tsx'
import { ModuleIcon } from './ModuleIcon.tsx'
import { ReleaseSections } from './ReleaseNotes.tsx'
import { compareVersions } from '@/host/worksWith.ts'

/**
 * "What's new in Kehikot": after the app or its modules update, one dialog
 * for all of it — Kehikot first, then each module that moved, each with the
 * notes of every release since the one the person last acknowledged.
 *
 * ## The host
 *
 * `WhatsNewHost` is mounted once beside the other windows. On start it reads
 * what was acknowledged (`/host/whats-new`); on the very first run there is
 * nothing, and what is here is recorded instead — the introduction has the
 * floor. Otherwise, once Settings' one-time question and the introduction are
 * done (`firstRunSettled`), and the page is quiet (`whenQuiet`: nothing open,
 * nobody typing, no update batch running), it opens when anything is news.
 *
 * The Updates menu tells it when a module's update lands or fails
 * (`pokeWhatsNew`). Those are gathered until the menu has closed and the page
 * is quiet again, then shown in one dialog; one that lands while the dialog
 * stands is added to its list. A module still updating, or whose update
 * failed, is left out. Notes read in the Updates menu's own "What's new" count
 * as read (`readInUpdates`).
 *
 * ## The dialog
 *
 * shadcn parts throughout: a Dialog, Tabs (a list on the left, a strip on top
 * under 640 pixels), a ScrollArea of notes drawn by `ReleaseSections` — the
 * Markdown-only drawing every release note uses — a Checkbox, and "Got it".
 * Closing it any way acknowledges what it showed; the checkbox turns the
 * setting off ("Show What's new after updates" in Settings → About turns it
 * back on).
 */

export function WhatsNewDialog({
  open,
  items,
  show,
  onClose,
  load = fetchNotes,
}: {
  open: boolean
  items: readonly NewsItem[]
  /** The setting as it stands: the checkbox starts as its opposite. */
  show: boolean
  /** Closed, with whether "Don't show this after updates" is ticked. */
  onClose(dontShow: boolean): void
  load?: typeof fetchNotes
}) {
  const [selected, setSelected] = useState<string>(items[0]?.id ?? APP_ITEM)
  const [dontShow, setDontShow] = useState(!show)
  const box = useId()
  useEffect(() => {
    if (open) setDontShow(!show)
  }, [open, show])
  useEffect(() => {
    if (!items.some((one) => one.id === selected) && items[0]) setSelected(items[0].id)
  }, [items, selected])

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose(dontShow)}>
      <DialogContent
        className="flex h-[min(620px,calc(100dvh-2rem))] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        data-whats-new
        onOpenAutoFocus={(event) => {
          /* "Got it" is what most people press: Enter takes it, Tab walks back to the list. */
          const got = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[data-testid="whats-new-got-it"]')
          if (!got) return
          event.preventDefault()
          got.focus()
        }}
      >
        <Tabs
          value={selected}
          onValueChange={setSelected}
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-col gap-0 sm:flex-row"
        >
          <aside className="bg-muted/40 flex min-w-0 shrink-0 flex-col border-b sm:w-60 sm:border-r sm:border-b-0">
            <DialogHeader className="gap-0.5 px-4 pt-4 pb-2 pr-12 sm:pr-4 sm:pb-3">
              <DialogTitle className="flex items-center gap-2 text-sm">
                <KehikkoMark working={false} className="text-muted-foreground size-4" />
                What’s new in Kehikot
              </DialogTitle>
              <DialogDescription className="text-xs tabular-nums" data-testid="whats-new-range">
                {headerSaid(items)}
              </DialogDescription>
            </DialogHeader>
            <TabsList
              aria-label="What changed"
              className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none bg-transparent px-2 pb-2 sm:flex-col sm:items-stretch sm:overflow-visible"
            >
              {items.map((item) => (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  data-item={item.id}
                  className="text-muted-foreground hover:text-foreground data-[state=active]:text-foreground h-auto flex-none flex-col items-start gap-0.5 px-2.5 py-1.5 text-left text-[13px] font-normal data-[state=active]:font-medium"
                >
                  <span className="flex w-full min-w-0 items-center gap-2">
                    {item.kind === 'app' ? (
                      <KehikkoMark working={false} className="size-3.5 shrink-0" />
                    ) : (
                      <ModuleIcon id={item.id} name={item.name} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.news && item.tags.length > 1 ? (
                      <Badge variant="secondary" className="h-4 rounded-full px-1.5 text-[10px] font-normal tabular-nums max-sm:hidden" data-count>
                        {item.tags.length}
                        <span className="sr-only"> releases</span>
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground pl-5.5 font-mono text-[11px] font-normal">
                    {item.follows === 'main' || item.follows === 'ahead' ? `main · ${item.to}` : rangeSaid(item)}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              {items.map((item) => (
                <TabsContent key={item.id} value={item.id} className="flex min-w-0 flex-col px-5 py-4 sm:px-6" data-pane={item.id}>
                  <Pane item={item} load={load} />
                </TabsContent>
              ))}
            </ScrollArea>
            <footer className="bg-background flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 sm:px-6">
              <div className="flex min-w-0 items-center gap-2">
                <Checkbox
                  id={box}
                  checked={dontShow}
                  onCheckedChange={(on) => setDontShow(on === true)}
                  className="size-4"
                  data-testid="whats-new-dont-show"
                />
                <Label htmlFor={box} className="text-muted-foreground text-xs font-normal">
                  Don’t show this after updates
                </Label>
              </div>
              <Button size="sm" onClick={() => onClose(dontShow)} data-testid="whats-new-got-it">
                Got it
              </Button>
            </footer>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

/** One row's notes: its name and versions, then every release, newest first. */
function Pane({ item, load }: { item: NewsItem; load: typeof fetchNotes }) {
  const repo = item.kind === 'app' ? APP_REPO : item.repo
  const onMain = item.follows === 'main' || item.follows === 'ahead'
  const count = item.news ? releasesSaid(item.tags.length) : null
  return (
    <>
      {/* `sm:pr-8`: the dialog's ✕ sits in this corner from 640 pixels up. */}
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 sm:pr-8">
        <div className="min-w-0 space-y-1">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            {item.kind === 'app' ? <KehikkoMark working={false} className="size-4 shrink-0" /> : <ModuleIcon id={item.id} name={item.name} className="size-4" />}
            {item.name}
          </h3>
          <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono" data-testid="whats-new-versions">
              {onMain ? `main · ${rangeSaid(item)}` : rangeSaid(item)}
            </span>
            {count ? (
              <Badge variant="outline" className="h-5 rounded-full px-2 text-[11px] font-normal">
                {count}
              </Badge>
            ) : null}
            {!item.news ? (
              <Badge variant="outline" className="h-5 rounded-full px-2 text-[11px] font-normal">
                installed
              </Badge>
            ) : null}
          </p>
        </div>
        {repo ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            data-testid="whats-new-github"
            data-href={releasePage(repo)}
            onClick={() => openExternal(releasePage(repo))}
          >
            <ExternalLink className="size-3" aria-hidden />
            All releases on GitHub
          </Button>
        ) : null}
      </header>
      <Separator className="my-3" />
      <div className="min-w-0 text-sm">
        {onMain ? (
          <div className="bg-muted/50 flex items-start gap-3 rounded-lg px-4 py-3" data-testid="whats-new-main">
            <GitBranch className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 space-y-1">
              <p className="text-sm">{FOLLOWING_MAIN}</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {item.name} has no releases yet, so its copy follows main and there are no notes to show.
                {item.from && item.from !== item.to ? ` It moved from ${item.from} to ${item.to}.` : ''}
              </p>
            </div>
          </div>
        ) : !repo ? (
          <p className="text-muted-foreground text-xs" data-testid="whats-new-no-repo">
            {item.name}’s repository is not on GitHub, so there are no release notes to read here.
          </p>
        ) : (
          <ReleaseSections repo={repo} name={item.name} tags={item.tags} works={item.works} load={load} oneTrouble headings />
        )}
      </div>
    </>
  )
}

/** What the host needs from outside, all replaceable in a test. */
export interface WhatsNewDeps {
  load?: typeof fetchWhatsNew
  save?: typeof postWhatsNew
  notes?: typeof fetchNotes
  releases?: typeof fetchReleases
  /** Resolves once Settings' question and the introduction are done with. */
  settled?: (signal: AbortSignal) => Promise<void>
  /** The running app's version: undefined while not known yet, null outside the app. */
  app?: string | null
  quietMs?: number
  /** How often a module still updating on the server is asked after. */
  pollMs?: number
}

const defaultSettled = (signal: AbortSignal) =>
  firstRunSettled({ introDue: async () => introDue(await fetchOnboarding()) }, signal)

/** Mounted once by the page. */
export function WhatsNewHost(props: WhatsNewDeps = {}) {
  const { shown } = useShownVersion()
  /* Inside the app its version; elsewhere there is no Kehikot release to tell of. */
  const app = 'app' in props ? props.app : shown === null ? undefined : shown.kind === 'app' ? shown.version : null
  return app === undefined ? null : <Host {...props} app={app} />
}

function Host({
  app,
  load = fetchWhatsNew,
  save = postWhatsNew,
  notes = fetchNotes,
  releases = fetchReleases,
  settled = defaultSettled,
  quietMs = QUIET_MS,
  pollMs = 2000,
}: WhatsNewDeps & { app: string | null }) {
  const [items, setItems] = useState<NewsItem[]>([])
  const [open, setOpen] = useState(false)
  const [show, setShow] = useState(true)
  const openRef = useRef(false)
  openRef.current = open
  const itemsRef = useRef(items)
  itemsRef.current = items
  const failed = useRef(new Set<string>())
  /** Past the first-run windows: automatic opening may happen. */
  const ready = useRef(false)
  /** A quiet moment is being waited for. */
  const waiting = useRef<(() => void) | null>(null)
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  /** The answer, with what the record does not know yet recorded first. */
  const read = useCallback(async (): Promise<WhatsNewAnswer | null> => {
    const answer = await load()
    if (!answer) return null
    const record = answer.record
    if (!record || (!record.app && app) || answer.modules.some((one) => !Object.hasOwn(record.modules, one.id))) {
      const next = await save({ baseline: { app } })
      if (!record) return { ...answer, record: null }
      return next ? { ...answer, record: next } : answer
    }
    return answer
  }, [app, load, save])

  const itemsOf = useCallback(
    async (answer: WhatsNewAnswer, all: boolean): Promise<NewsItem[]> => {
      const record = answer.record
      let appTags: string[] | null = null
      /* Kehikot's releases since the acknowledged one; null when they cannot be read (offline). */
      if (app && record?.app && compareVersions(app, record.app) > 0) {
        try {
          const list = await releases(APP_REPO)
          appTags = appRange(
            list.filter((one) => !one.prerelease).map((one) => one.tag),
            record.app,
            app,
          )
        } catch {
          appTags = null
        }
      }
      return newsItems({ answer, app, appTags, failed: failed.current, all })
    },
    [app, releases],
  )

  /** Read again and show what is news: into the open dialog, or a new one. */
  const tell = useCallback(async () => {
    const answer = await read()
    if (!alive.current || !answer?.record) return
    setShow(answer.record.show)
    if (answer.updating.length) {
      /* Told once it has finished; until then it is not news. */
      if (poll.current) clearTimeout(poll.current)
      poll.current = setTimeout(() => {
        poll.current = null
        schedule.current()
      }, pollMs)
    }
    const next = (await itemsOf(answer, false)).filter((one) => one.news)
    if (!alive.current) return
    if (openRef.current) {
      setItems((was) => mergeItems(was, next))
      return
    }
    if (!next.length) return
    if (!answer.record.show) {
      /* Not wanted: what moved is acknowledged as it is, so turning it back on tells only what comes after. */
      void save({ acknowledge: ackFor(next) })
      return
    }
    setItems(next)
    setOpen(true)
  }, [itemsOf, pollMs, read, save])

  /** Something may be new: when the dialog stands, add to it now; otherwise at the next quiet moment. */
  const schedule = useRef<() => void>(() => {})
  schedule.current = () => {
    if (!ready.current) return
    if (openRef.current) {
      void tell()
      return
    }
    if (waiting.current) return
    waiting.current = whenQuiet(
      () => {
        waiting.current = null
        void tell()
      },
      { idleMs: quietMs },
    )
  }

  /* At start: the first run records and stops; otherwise wait for the first-run windows. */
  useEffect(() => {
    alive.current = true
    const abort = new AbortController()
    void (async () => {
      const first = await read()
      if (!first || abort.signal.aborted) return
      if (!first.record) return
      setShow(first.record.show)
      await settled(abort.signal)
      if (abort.signal.aborted) return
      ready.current = true
      schedule.current()
    })()
    return () => {
      alive.current = false
      abort.abort()
      waiting.current?.()
      waiting.current = null
      if (poll.current) clearTimeout(poll.current)
    }
  }, [read, settled])

  useEffect(
    () =>
      onPoke((poke) => {
        if ('failed' in poke) {
          failed.current.add(poke.failed)
          return
        }
        failed.current.delete(poke.updated)
        schedule.current()
      }),
    [],
  )

  useEffect(() => onShowChanged(setShow), [])

  /* On demand: About, the Updates menu. Everything installed, news first. */
  useEffect(
    () =>
      onOpenWhatsNew(() => {
        void (async () => {
          const answer = await read()
          if (!answer || !alive.current) return
          if (answer.record) setShow(answer.record.show)
          const all = await itemsOf(answer.record ? answer : { ...answer, record: { app, modules: {}, show: true } }, true)
          if (!alive.current) return
          setItems(openRef.current ? mergeItems(itemsRef.current, all) : all)
          setOpen(true)
        })()
      }),
    [app, itemsOf, read],
  )

  const close = (dontShow: boolean) => {
    setOpen(false)
    const shown = itemsRef.current
    void (async () => {
      if (shown.length) await save({ acknowledge: ackFor(shown) })
      if (dontShow === show) {
        const record = await save({ show: !dontShow })
        if (record) {
          setShow(record.show)
          announceShow(record.show)
        }
      }
    })()
  }

  return <WhatsNewDialog open={open} items={items} show={show} onClose={close} load={notes} />
}
