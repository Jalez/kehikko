import { useEffect, useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { appEngine, watchApp, type AppUpdateStatus } from '@/host/appUpdate.ts'
import {
  APP_NAME,
  APP_REPO,
  appReleaseRows,
  fetchHostVersion,
  fetchReleaseList,
  NotesTrouble,
  openExternal,
  releaseDate,
  releasePage,
  versionHintFor,
  versionShown,
  type AppReleaseRow,
  type ReleaseSummary,
  type VersionShown,
} from '@/host/releaseNotes.ts'
import { Hint } from './Hint.tsx'
import { NotesButton, useReleaseNotes } from './ReleaseNotes.tsx'

/**
 * The version as the strip shows it, and the app's updater status: the one
 * reading both the strip and Settings' About say.
 */
export function useShownVersion(): { app: AppUpdateStatus | null; shown: VersionShown | null } {
  const [app, setApp] = useState<AppUpdateStatus | null>(null)
  const [engine] = useState(() => appEngine() !== null)
  const [settled, setSettled] = useState(!engine)
  const [host, setHost] = useState<string | null>(null)

  useEffect(() => {
    const link = watchApp((status) => {
      setApp(status)
      setSettled(true)
    })
    /* An app that does not answer (a refused command) leaves the host's version. */
    void link.engine?.status().then(() => setSettled(true))
    return () => link.stop()
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    fetchHostVersion(abort.signal).then(setHost, () => {})
    return () => abort.abort()
  }, [])

  return { app, shown: versionShown({ app, engine, settled, host }) }
}

/**
 * The version beside "Kehikot" in the strip, as a module's version sits
 * beside its name: small, grey, monospaced, and the first thing the strip lets
 * go of when it is short of room (under 800 pixels; the word "Kehikot" goes at
 * 640 and the mark at 480).
 *
 * Inside the desktop app it is the app's version, from its updater; anywhere
 * else it is the host's own, written "host 0.1.0" so it never reads as an app
 * release (`versionShown`).
 *
 * Pressed, it lists Kehikot's releases, newest first — the desktop app's
 * GitHub releases, through the host (`/host/releases`) — with the installed
 * one and an update on its way marked, and a notes button on each. It is
 * history to read: nothing here installs or goes back to a version, because
 * the app updates itself.
 */
export function AppVersion() {
  const { app, shown } = useShownVersion()
  const [open, setOpen] = useState(false)

  if (!shown) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label={versionHintFor(shown)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="app-version"
            data-kind={shown.kind}
            aria-label={shown.kind === 'app' ? `${APP_NAME} ${shown.version}: releases and what's new` : `host ${shown.version}: ${APP_NAME} releases`}
            className="text-muted-foreground hover:text-foreground shrink-0 cursor-default font-mono text-[10px] font-normal max-[800px]:hidden"
          >
            {shown.text}
          </button>
        </PopoverTrigger>
      </Hint>
      {open ? <AppReleases app={app} host={shown.kind === 'host' ? shown.version : null} /> : null}
    </Popover>
  )
}

const WAITING_RETRY_MS = 5000

/** The popover's content: Kehikot's releases, read when it opens. */
function AppReleases({ app, host }: { app: AppUpdateStatus | null; host: string | null }) {
  const [releases, setReleases] = useState<ReleaseSummary[] | null>(null)
  const [old, setOld] = useState<string | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  /** Bumped by Retry. */
  const [attempt, setAttempt] = useState(0)
  const notes = useReleaseNotes()

  useEffect(() => {
    const abort = new AbortController()
    let retry: ReturnType<typeof setTimeout> | null = null
    setTrouble(null)
    fetchReleaseList(APP_REPO, abort.signal).then(
      (got) => {
        if (abort.signal.aborted) return
        setReleases(got.releases)
        setOld(got.old)
      },
      (error: Error) => {
        if (abort.signal.aborted) return
        setTrouble(error.message)
        /* Short of GitHub budget, not failed: it is asked again by itself. */
        if (error instanceof NotesTrouble && error.waiting) retry = setTimeout(() => setAttempt((n) => n + 1), WAITING_RETRY_MS)
      },
    )
    return () => {
      abort.abort()
      if (retry) clearTimeout(retry)
    }
  }, [attempt])

  return (
    <PopoverContent
      align="start"
      className="w-72 p-1"
      aria-label={`${APP_NAME} releases`}
      onFocusOutside={(event) => {
        if (notes.open) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (notes.open) event.preventDefault()
      }}
    >
      <div className="px-2 pt-1.5 pb-1">
        <p className="text-xs font-medium">{APP_NAME} releases</p>
        <p className="text-muted-foreground text-[11px] leading-snug">
          {host
            ? `This page is served by a development host (${host}), not an app release.`
            : 'What each version brought. The app updates itself; nothing here installs one.'}
        </p>
      </div>
      {releases ? (
        <>
          {old ? (
            <p className="text-muted-foreground px-2 py-1 text-[11px] leading-snug" data-testid="app-releases-old">
              {old} Showing the last list that was read.{' '}
              <button type="button" className="underline-offset-2 hover:underline" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            </p>
          ) : null}
          <AppReleaseList
            rows={appReleaseRows(releases, app)}
            onNotes={(row, opener) => notes.show({ repo: APP_REPO, tag: row.tag, name: APP_NAME, version: row.version, opener })}
          />
        </>
      ) : trouble ? (
        <div className="px-2 py-1.5 text-xs" data-testid="app-releases-trouble">
          <p className="text-destructive">{trouble}</p>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Retry
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
              onClick={() => openExternal(releasePage(APP_REPO))}
            >
              Open the releases on GitHub
            </button>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground px-2 py-1.5 text-xs">Reading {APP_NAME}'s releases…</p>
      )}
      {notes.dialog}
    </PopoverContent>
  )
}

const MARK_WORDS: Record<NonNullable<AppReleaseRow['mark']>, string> = {
  installed: 'installed',
  downloading: 'downloading',
  ready: 'ready to install',
}

/** The list itself, with no popover around it — what the tests render. Read-only rows. */
export function AppReleaseList({
  rows,
  onNotes,
}: {
  rows: readonly AppReleaseRow[]
  onNotes(row: AppReleaseRow, opener: HTMLElement): void
}) {
  if (rows.length === 0) return <p className="text-muted-foreground px-2 py-1.5 text-xs">No releases are published yet.</p>
  return (
    <ul aria-label={`${APP_NAME} releases`} className="flex max-h-72 flex-col overflow-auto" data-testid="app-releases">
      {rows.map((row) => (
        <li
          key={row.tag}
          data-release={row.tag}
          data-mark={row.mark ?? undefined}
          className="flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs"
        >
          <span className={`font-mono ${row.mark === 'installed' ? 'font-medium' : ''}`}>{row.version}</span>
          {row.mark ? (
            <span
              className={`shrink-0 text-[10px] ${row.mark === 'installed' ? 'text-foreground' : 'text-amber-700 dark:text-amber-300'}`}
            >
              {MARK_WORDS[row.mark]}
            </span>
          ) : null}
          {row.prerelease ? <span className="text-muted-foreground shrink-0 text-[10px]">pre-release</span> : null}
          <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">{releaseDate(row.publishedAt)}</span>
          <NotesButton version={row.version} onShow={(opener) => onNotes(row, opener)} />
        </li>
      ))}
    </ul>
  )
}
