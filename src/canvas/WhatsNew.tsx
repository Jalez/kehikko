import { ExternalLink, GitBranch, LoaderCircle, Newspaper } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Label } from '@/components/ui/label.tsx'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import { Separator } from '@/components/ui/separator.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { APP_REPO, fetchNotes, fetchReleases, openExternal, releasePage } from '@/host/releaseNotes.ts'
import {
  ackFor,
  announceShow,
  appRange,
  APP_ITEM,
  fetchWhatsNew,
  FOLLOWING_MAIN,
  headerSaid,
  mergeItems,
  newsItems,
  noticeSaid,
  onOpenWhatsNew,
  onPoke,
  onShowChanged,
  postWhatsNew,
  rangeSaid,
  releasesSaid,
  type NewsItem,
  type WhatsNewAnswer,
} from '@/host/whatsNew.ts'
import { useShownVersion } from './AppVersion.tsx'
import { Hint } from './Hint.tsx'
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
 * floor. Otherwise, when anything is news, it raises the bar's notice
 * (`WhatsNewNotice`, drawn by `Bar.tsx`) at once: no waiting for a quiet
 * moment, no waiting for GitHub — Kehikot's release list, which only fills
 * the dialog's notes, is read in the background after. It never opens the
 * dialog by itself, and the notice takes no focus, so nobody typing in a
 * module is interrupted.
 *
 * Pressing the notice opens the dialog and acknowledges what it shows; the
 * notice goes. A module still updating on the server is a "Preparing…" row
 * that fills in once its update is done — the Updates menu tells of that
 * (`pokeWhatsNew`), and while a row is preparing the host is asked again every
 * `pollMs` — and until the dialog is open the notice only counts it. A module
 * whose update failed is left out. Notes read in the Updates menu's own
 * "What's new" count as read (`readInUpdates`). With "Don't show this after
 * updates" there is no notice: what moved is acknowledged as it is.
 *
 * ## The dialog
 *
 * shadcn parts throughout: a Dialog, Tabs (a list on the left, a strip on top
 * under 640 pixels), a ScrollArea of notes drawn by `ReleaseSections` — the
 * Markdown-only drawing every release note uses — a Checkbox, and "Got it".
 * Opening it from the notice and closing it any way both acknowledge what it
 * showed, but a "Preparing…" row; the checkbox turns the setting off ("Show
 * What's new after updates" in Settings → About turns it back on).
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
          <aside className="bg-muted/40 flex min-w-0 shrink-0 flex-col border-b sm:min-h-0 sm:w-60 sm:border-r sm:border-b-0">
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
              className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none bg-transparent px-2 pb-2 sm:min-h-0 sm:flex-1 sm:flex-col sm:items-stretch sm:overflow-x-hidden sm:overflow-y-auto sm:overscroll-contain"
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
                  <span className="text-muted-foreground pl-5.5 font-mono text-[11px] font-normal" data-preparing={item.preparing ? '' : undefined}>
                    {item.preparing ? <span className="font-sans">Preparing…</span> : item.follows === 'main' || item.follows === 'ahead' ? `main · ${item.to}` : rangeSaid(item)}
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
  const [date, setDate] = useState<string | null>(null)
  if (item.preparing) return <Preparing item={item} />
  const repo = item.kind === 'app' ? APP_REPO : item.repo
  const onMain = item.follows === 'main' || item.follows === 'ahead'
  const count = item.news ? releasesSaid(item.tags.length) : null
  const single = item.tags.length === 1
  const onDate = useCallback((_tag: string, said: string | null) => setDate(said), [])
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
            {single && date ? <span data-testid="whats-new-date">{date}</span> : null}
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
          <ReleaseSections repo={repo} name={item.name} tags={item.tags} works={item.works} load={load} oneTrouble headings={!single} onDate={single ? onDate : undefined} />
        )}
      </div>
    </>
  )
}

/** A module whose update is still running: its notes come once it has finished. */
function Preparing({ item }: { item: NewsItem }) {
  return (
    <>
      <header className="flex min-w-0 items-start gap-2 sm:pr-8">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <ModuleIcon id={item.id} name={item.name} className="size-4" />
          {item.name}
        </h3>
      </header>
      <Separator className="my-3" />
      <div className="bg-muted/50 flex items-start gap-3 rounded-lg px-4 py-3" data-testid="whats-new-preparing">
        <LoaderCircle className="text-muted-foreground mt-0.5 size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="text-sm">Preparing…</p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {item.name} is still being updated. Its release notes appear here once the update has finished.
          </p>
        </div>
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
  /** The running app's version: undefined while not known yet, null outside the app. */
  app?: string | null
  /** How often the host is asked again while a "Preparing…" row stands. */
  pollMs?: number
}

/* ---- the notice: what the host holds, the bar draws ---- */

interface Notice {
  items: readonly NewsItem[]
  open(): void
}

let notice: Notice | null = null
const noticeListeners = new Set<() => void>()

function setNotice(next: Notice | null) {
  notice = next
  for (const listener of [...noticeListeners]) listener()
}

function subscribeNotice(listener: () => void) {
  noticeListeners.add(listener)
  return () => noticeListeners.delete(listener)
}

/**
 * The bar's "What's new" notice: there while anything is news and the dialog
 * is shut, gone once it has been pressed. A dot and words, never colour
 * alone; it takes no focus when it appears. In a narrow bar it says "What's
 * new" (1100 pixels and under), then only its icon (under 900; Tailwind’s `max-[…]` is `width <`): measured on the
 * scratch host, so that the project's, the epic's and the kehikko's names
 * keep the room they had without it. The tooltip and the accessible name
 * always say the whole of it.
 */
export function WhatsNewNotice() {
  const now = useSyncExternalStore(subscribeNotice, () => notice, () => null)
  const said = now ? noticeSaid(now.items) : null
  if (!now || !said) return null
  return (
    <Hint label={said.label} align="end">
      <Button
        variant="outline"
        size="sm"
        aria-label={said.label}
        data-testid="whats-new-notice"
        className="text-foreground h-6 shrink-0 gap-1.5 rounded-full px-2 text-[11px] font-normal shadow-none max-[900px]:size-6 max-[900px]:px-0"
        onClick={() => now.open()}
      >
        <span aria-hidden className="bg-primary size-1.5 shrink-0 rounded-full max-[900px]:hidden" data-notice-dot />
        <Newspaper aria-hidden className="hidden size-3 max-[900px]:block" />
        <span className="max-[1100px]:hidden" data-notice-text>
          {said.text}
        </span>
        <span className="hidden max-[1100px]:inline max-[900px]:hidden" data-notice-short>
          What’s new
        </span>
      </Button>
    </Hint>
  )
}

/** Mounted once by the page. */
export function WhatsNewHost(props: WhatsNewDeps = {}) {
  const { shown } = useShownVersion()
  /* Inside the app its version; elsewhere there is no Kehikot release to tell of. */
  const app = 'app' in props ? props.app : shown === null ? undefined : shown.kind === 'app' ? shown.version : null
  return app === undefined ? null : <Host {...props} app={app} />
}

/** Kehikot's row given the releases since the acknowledged version, once GitHub's list is read. */
function withAppTags(items: readonly NewsItem[], tags: readonly string[] | null): NewsItem[] {
  if (!tags?.length) return [...items]
  return items.map((one) => (one.kind === 'app' && one.news ? { ...one, tags: [...tags] } : one))
}

function Host({
  app,
  load = fetchWhatsNew,
  save = postWhatsNew,
  notes = fetchNotes,
  releases = fetchReleases,
  pollMs = 2000,
}: WhatsNewDeps & { app: string | null }) {
  /** What is news now and not acknowledged: the notice's. */
  const [news, setNews] = useState<NewsItem[]>([])
  /** The dialog's rows. */
  const [items, setItems] = useState<NewsItem[]>([])
  const [open, setOpen] = useState(false)
  const [show, setShow] = useState(true)
  const openRef = useRef(false)
  openRef.current = open
  const itemsRef = useRef(items)
  itemsRef.current = items
  const newsRef = useRef(news)
  newsRef.current = news
  /** Opened on demand: every installed module is a row, not only the news. */
  const allRef = useRef(false)
  const failed = useRef(new Set<string>())
  /** Kehikot's releases since the acknowledged version, by the range they were read for. */
  const appTags = useRef<{ range: string; tags: string[] | null } | null>(null)
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  /** The answer, with what the record does not know yet recorded first. */
  const read = useCallback(async (fresh = true): Promise<WhatsNewAnswer | null> => {
    const answer = await load(undefined, fresh)
    if (!answer) return null
    const record = answer.record
    if (!record || (!record.app && app) || answer.modules.some((one) => !Object.hasOwn(record.modules, one.id))) {
      const next = await save({ baseline: { app } })
      if (!record) return { ...answer, record: null }
      return next ? { ...answer, record: next } : answer
    }
    return answer
  }, [app, load, save])

  /**
   * Kehikot's release list, for the notes of every release since the
   * acknowledged one — read in the background, never before the notice.
   * Until it answers (or offline) Kehikot's row has the running release alone.
   */
  const readAppTags = useCallback(
    (answer: WhatsNewAnswer) => {
      const from = answer.record?.app
      if (!app || !from || compareVersions(app, from) <= 0) return
      const range = `${from}→${app}`
      if (appTags.current?.range === range) return
      appTags.current = { range, tags: null }
      void (async () => {
        let tags: string[] | null = null
        try {
          const list = await releases(APP_REPO)
          tags = appRange(
            list.filter((one) => !one.prerelease).map((one) => one.tag),
            from,
            app,
          )
        } catch {
          tags = null
        }
        if (!alive.current || appTags.current?.range !== range) return
        appTags.current = { range, tags }
        setNews((was) => withAppTags(was, tags))
        setItems((was) => withAppTags(was, tags))
      })()
    },
    [app, releases],
  )

  const itemsOf = useCallback(
    (answer: WhatsNewAnswer, all: boolean): NewsItem[] =>
      newsItems({ answer, app, appTags: appTags.current?.tags ?? null, failed: failed.current, all }),
    [app],
  )

  /** Read again: the notice's news, and the open dialog's rows. */
  const tell = useRef<(given?: WhatsNewAnswer) => Promise<void>>(async () => {})
  tell.current = async (given?: WhatsNewAnswer) => {
    const answer = given ?? (await read())
    if (!alive.current || !answer?.record) return
    setShow(answer.record.show)
    const next = itemsOf(answer, false).filter((one) => one.news)
    if (poll.current) clearTimeout(poll.current)
    poll.current = null
    if (next.some((one) => one.preparing)) {
      /* A "Preparing…" row fills in once its update is done: asked again until then. */
      poll.current = setTimeout(() => {
        poll.current = null
        void tell.current()
      }, pollMs)
    }
    if (openRef.current) {
      const rows = allRef.current ? itemsOf(answer, true) : next
      setItems((was) => mergeItems(was, rows))
    }
    if (!answer.record.show) {
      /* Not wanted: what moved is acknowledged as it is, so turning it back on tells only what comes after. */
      const done = next.filter((one) => !one.preparing)
      if (done.length) void save({ acknowledge: ackFor(done) })
      setNews([])
      return
    }
    setNews(next)
    readAppTags(answer)
  }

  /* At start: the first run records and stops; otherwise the notice, at once. */
  useEffect(() => {
    alive.current = true
    void (async () => {
      /* Shared with a read already out: StrictMode mounts this twice in development. */
      const first = await read(false)
      if (!alive.current || !first?.record) return
      /* The first read is the notice's: one request at load, not a second to say the same. */
      await tell.current(first)
    })()
    return () => {
      alive.current = false
      if (poll.current) clearTimeout(poll.current)
      poll.current = null
    }
  }, [read])

  useEffect(
    () =>
      onPoke((poke) => {
        if ('failed' in poke) failed.current.add(poke.failed)
        else failed.current.delete(poke.updated)
        void tell.current()
      }),
    [],
  )

  useEffect(
    () =>
      onShowChanged((on) => {
        setShow(on)
        void tell.current()
      }),
    [],
  )

  /** The notice pressed: the dialog, with what is news, acknowledged as it is shown. */
  const openNews = useCallback(() => {
    const shown = newsRef.current
    if (!shown.length) return
    allRef.current = false
    setItems(shown)
    setOpen(true)
    const ack = ackFor(shown)
    if (ack.app || ack.modules) void save({ acknowledge: ack })
  }, [save])

  /* The bar draws the notice while there is news, the setting is on and the dialog is shut. */
  useEffect(() => {
    setNotice(show && !open && news.length ? { items: news, open: openNews } : null)
  }, [news, open, openNews, show])
  useEffect(() => () => setNotice(null), [])

  /* On demand: Settings → About, the Updates menu. Everything installed, news first. */
  useEffect(
    () =>
      onOpenWhatsNew(() => {
        void (async () => {
          const answer = await read()
          if (!answer || !alive.current) return
          if (answer.record) setShow(answer.record.show)
          const all = itemsOf(answer.record ? answer : { ...answer, record: { app, modules: {}, show: true } }, true)
          allRef.current = true
          setItems(openRef.current ? mergeItems(itemsRef.current, all) : all)
          setOpen(true)
          readAppTags(answer)
        })()
      }),
    [app, itemsOf, read, readAppTags],
  )

  const close = (dontShow: boolean) => {
    setOpen(false)
    const shown = itemsRef.current
    void (async () => {
      const ack = ackFor(shown)
      if (ack.app || ack.modules) await save({ acknowledge: ack })
      if (dontShow === show) {
        const record = await save({ show: !dontShow })
        if (record) {
          setShow(record.show)
          announceShow(record.show)
        }
      }
      /* What is still news — a row that was preparing — is the notice's again. */
      await tell.current()
    })()
  }

  return <WhatsNewDialog open={open} items={items} show={show} onClose={close} load={notes} />
}
