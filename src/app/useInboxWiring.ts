import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { schemaFor } from 'kehikot-module-protocol'
import { useInboxColour, type InboxCountView } from '@/canvas/InboxCount.tsx'
import { useGoToPlace } from '@/canvas/useGoToPlace.ts'
import { useInbox } from '@/canvas/useInbox.ts'
import type { Namer } from '@/host/activity.ts'
import { fetchAdoption, fetchAfters, forgetAdoptions, onAdoptionsForgotten, postAdopt, postUndo, postUntrack } from '@/host/adoptClient.ts'
import { adoptWithStep } from '@/host/adoption.ts'
import { openSettings, SETTINGS_INBOX_MODULE } from '@/host/agentSettings.ts'
import type { CanvasControls, GotoAnswer, GotoCall } from '@/host/ask.ts'
import { inProject, type Canvas } from '@/host/canvases.ts'
import { isOffer, nextOf, rowKey, type Entry, type NoticeLine } from '@/host/inbox.ts'
import { INBOX_CAPABILITY, addWords, chordGoes, countLook, inboxModuleOf, needingCount, topItems, type InboxListed } from '@/host/inboxBar.ts'
import { fetchLink, fetchLog } from '@/host/inboxClient.ts'
import { answerInbox, type InboxDoor, type NextTold } from '@/host/inboxDoor.ts'
import { fetchMessages, onMessagesChanged, postMute } from '@/host/messagesClient.ts'
import { openModuleList } from '@/host/moduleList.ts'
import { fetchOfficial, installOfficial } from '@/host/official.ts'
import type { Presses } from '@/host/presses.ts'
import type { Epics as HeldEpics, Project } from '@/host/projects.ts'
import type { RegistryView } from '@/host/registry.ts'
import type { SpaceActivity } from '@/host/spaceRecency.ts'
import type { subjectOf, SubjectEdit } from '@/host/subject.ts'
import type { NoticeLink } from '@/host/trackerNotices.ts'
import { openUpdates } from '@/host/updates.ts'
import { openWhatsNew } from '@/host/whatsNew.ts'
import { MENTIONS_MODULE, parseMentionId } from '@/host/whatsNewMentions.ts'

/*
 * The Inbox, as the page wires it, in two hooks called where their parts stood
 * in `App.tsx` — on either side of the three arrival effects (an Inbox item in
 * another project, an agent's jump, a module's `view.goto`), which stay in
 * `App.tsx` in their order:
 *
 *   - `useInboxRecord`: the ONE record (`useInbox`), what reaches it from the
 *     modules and the stream, and going to an item (`goToEntry`, through
 *     `useGoToPlace`);
 *   - `useInboxWiring`: "Next that needs me" (Alt+Shift+N), the bar's count and
 *     its panel, "Messages to agents", the module that shows the Inbox told the
 *     record changed, and the Inbox answered to a module's page with its
 *     adoption.
 *
 * Moved as it was; every effect keeps its place among the page's.
 */

export interface InboxRecordInputs {
  registry: RegistryView | null
  here: readonly Canvas[]
  canvases: readonly Canvas[]
  about: ReturnType<typeof subjectOf>
  open: { key?: string } | null
  projectId: number | null
  projects: readonly Project[]
  held: HeldEpics | null
  presses: Presses
  setOpenId: (next: number | null) => void
  onProject: (id: number) => void
  setTrouble: Dispatch<SetStateAction<string | null>>
  reactsOf: (id: string) => readonly string[] | undefined
  whenShownRef: { readonly current: (then: () => void) => void }
  gotoHereRef: { readonly current: (call: GotoCall, from?: string) => GotoAnswer }
  changeSubjectRef: { readonly current: (edit: SubjectEdit) => void }
  projectRef: { readonly current: number | null }
  setSelectedByRef: { readonly current: Dispatch<SetStateAction<Record<number, string | null>>> }
  showLinkRef: { readonly current: (link: NoticeLink) => void }
  takeOfferRef: { readonly current: (entry: Entry, project: number) => void }
  kehikkoRef: { readonly current: { key?: string } | null }
  /* Assigned here: what reaches the record from a module, the stream, and a legacy notice. */
  activityRef: MutableRefObject<NonNullable<CanvasControls['activity']>>
  inboxWokeRef: MutableRefObject<((project: number, rev: number | null) => void) | null>
  legacyNoticeRef: MutableRefObject<(from: string, payload: unknown) => void>
}

/** The record, and going to an item of it. */
export function useInboxRecord({
  registry,
  here,
  canvases,
  about,
  open,
  projectId,
  projects,
  held,
  presses,
  setOpenId,
  onProject,
  setTrouble,
  reactsOf,
  whenShownRef,
  gotoHereRef,
  changeSubjectRef,
  projectRef,
  setSelectedByRef,
  showLinkRef,
  takeOfferRef,
  kehikkoRef,
  activityRef,
  inboxWokeRef,
  legacyNoticeRef,
}: InboxRecordInputs) {
  /*
   * What the modules say they are doing (`activity.set`) and the lines they
   * emit (`kehikot.notifications@1`): ONE record, the Inbox, kept by the server
   * per project (`server/inbox.ts`) and drawn as small dots on what already
   * exists plus the one control in the bar. See `host/inbox.ts`. What a module
   * had open is closed when its container is on no kehikko of the project or
   * its server stops answering, and stays in the log.
   */
  const activityAlive = useMemo(() => {
    if (!registry) return null
    const on = new Set(here.flatMap((one) => one.placements.map((p) => p.i)))
    return new Set(registry.presences.filter((p) => p.condition === 'ready' && on.has(p.id)).map((p) => p.id))
  }, [registry, here])
  const activityAt = useMemo(
    () => ({ epic: about.epic, parts: about.parts, kehikko: open?.key ?? null }),
    [about.epic, about.parts, open?.key],
  )
  const moduleName = useCallback(
    (module: string) => registry?.presences.find((p) => p.id === module)?.name ?? module,
    [registry],
  )
  const inboxProjects = useMemo(() => projects.map(({ id, name, path, uid }) => ({ id, name, path, uid: uid ?? null })), [projects])
  /* A module's page answered a greeting: it is a new page, whose list the Inbox waits for. */
  const inboxGreetedRef = useRef<(module: string) => void>(() => undefined)
  /*
   * The ONE record, kept by the server per project. Drawn by the module that shows the Inbox
   * (protocol 2.79.0, `inbox:person`) on a kehikko where the person placed it, and by the bar's
   * small count; the host sounds nothing and pops nothing up (`host/inboxBar.ts`).
   */
  const inbox = useInbox({
    project: projectId,
    projects: inboxProjects,
    alive: activityAlive,
    at: activityAt,
    nameOf: moduleName,
  })
  activityRef.current = inbox.receive
  inboxGreetedRef.current = inbox.greeted
  inboxWokeRef.current = (id, rev) => inbox.refresh(id < 0 ? undefined : id, rev)
  legacyNoticeRef.current = (from, payload) => {
    const parsed = schemaFor('kehikot.notifications@1')?.safeParse(payload)
    if (!parsed?.success) return
    inbox.notice(from, parsed.data as NoticeLine, kehikkoRef.current?.key)
  }
  const activityNames = useMemo<Namer>(
    () => ({
      epic: (slug) => {
        const row = held?.epics.find((one) => one.slug === slug)
        return row ? (row.title ?? row.slug) : null
      },
      part: (epic, id) => {
        const rows = epic === null ? [] : (held?.epics.find((one) => one.slug === epic)?.parts ?? [])
        return rows.find((part) => part.id === id)?.heading ?? null
      },
      kehikko: (key) => here.find((one) => one.key === key)?.name ?? null,
    }),
    [held, here],
  )
  /* Light a module's container on the open kehikko: after a move, once the screen has caught up. */
  const flashContainer = useCallback((module: string, later: boolean) => {
    const flash = () => {
      const element = [...document.querySelectorAll<HTMLElement>('[data-module]')].find(
        (one) => one.dataset.module === module,
      )
      if (!element) return
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      element.setAttribute('data-activity-flash', '')
      window.setTimeout(() => element.removeAttribute('data-activity-flash'), 1600)
    }
    /* Once the kehikko it is on is shown: lit while it is still being
       prepared out of sight, the light would be spent before anybody saw it. */
    const whenShown = () => whenShownRef.current(flash)
    if (later) window.setTimeout(whenShown, 300)
    else whenShown()
  }, [])
  /* Whether the Inbox's panel is open, held here so that the keyboard can open it. */
  const [inboxOpen, setInboxOpen] = useState(false)
  /*
   * An item of another project: that project is opened, and once its epics
   * have been read again — `held` goes to null on the switch and back — the
   * item is gone to as any other. Never on the epics of the project left.
   */
  const goElsewhere = useRef<{ project: number; entry: Entry; cleared: boolean } | null>(null)
  /*
   * Pressing an item goes to where it happened (`host/goToPlace.ts`): its
   * project, its kehikko by key, its epic and parts, and then its module's
   * container is lit THERE — with the pickers' own functions. Where that stops
   * short, or the item named no place, a line says so (`WentTo`).
   */
  const placeGo = useGoToPlace({
    here: { project: projectId, epic: about.epic, parts: about.parts, kehikko: open?.key ?? null },
    targetOf: (project) => ({
      project,
      kehikot: inProject(canvases, project).flatMap((one) =>
        one.key === undefined ? [] : [{ key: one.key, name: one.name, modules: one.placements.map((p) => p.i) }],
      ),
      epics: project === projectId && held ? held.epics.map((one) => one.slug) : null,
    }),
    switchProject: (project, entry) => {
      goElsewhere.current = { project, entry, cleared: false }
      onProject(project)
    },
    openKehikko: (key) => {
      const target = here.find((one) => one.key === key)
      if (target) setOpenId(target.id)
    },
    goto: (call) => gotoHereRef.current(call),
    highlight: flashContainer,
    /* The module is told which of its items the person opened (protocol 2.35.0), once it is
       there to hear it: after the place's context has gone out, on the kehikko now shown —
       `flashContainer`'s timing. A page still loading is told when it answers. */
    arrived: (entry, later) => {
      const tell = () => void presses.opened(entry.module, entry.id)
      if (later) window.setTimeout(() => whenShownRef.current(tell), 300)
      else tell()
    },
    /* A tracker notice goes to a kehikko where a module reacts to what is picked, and picks its
       ref there — the host's own pick, so nobody is its setter. */
    reactsOf,
    pick: (refs) => {
      changeSubjectRef.current({ selection: [...refs] })
      const id = projectRef.current
      if (id !== null) setSelectedByRef.current((was) => (was[id] === null ? was : { ...was, [id]: null }))
    },
    outside: (entry, project) => {
      void fetchLink(project, entry.module, entry.id).then((link) => {
        if (link) showLinkRef.current(link)
        else setTrouble(`Where ${entry.label} is could not be read yet. It is read with the next tracker reading.`)
      })
    },
  })
  const goToEntry = useCallback(
    (entry: Entry, project: number | null = projectId) => {
      if (project === null) return
      /* An agent's offer goes as its jump would, with Go back, and is closed once taken. */
      if (isOffer(entry)) {
        setInboxOpen(false)
        takeOfferRef.current(entry, project)
        return
      }
      if (entry.state === 'done') inbox.see([entry], project)
      setInboxOpen(false)
      /* The agent sync's lines have no place on a canvas: they are about Settings. */
      if (entry.module === SETTINGS_INBOX_MODULE) {
        openSettings()
        return
      }
      /* A mention in What's new has no place either: it opens What's new at that release. */
      if (entry.module === MENTIONS_MODULE) {
        const at = parseMentionId(entry.id)
        openWhatsNew(at ?? undefined)
        return
      }
      placeGo.go(entry, project)
    },
    [inbox, projectId, placeGo.go],
  )

  return { inbox, inboxGreetedRef, moduleName, activityNames, flashContainer, inboxOpen, setInboxOpen, goElsewhere, placeGo, goToEntry }
}

export interface InboxWiringInputs {
  inbox: ReturnType<typeof useInbox>
  registry: RegistryView | null
  open: { key?: string; placements: readonly { i: string }[] } | null
  projectId: number | null
  project: { name: string } | null
  projects: readonly Project[]
  about: ReturnType<typeof subjectOf>
  presses: Presses
  moduleName: (module: string) => string
  activityNames: Namer
  flashContainer: (module: string, later: boolean) => void
  inboxOpen: boolean
  setInboxOpen: Dispatch<SetStateAction<boolean>>
  goToEntry: (entry: Entry, project?: number | null) => void
  setTrouble: Dispatch<SetStateAction<string | null>>
  onPlaceRef: { readonly current: (id: string) => void }
  /* Assigned here: the Inbox answered to a module's page. */
  inboxAskRef: MutableRefObject<NonNullable<CanvasControls['inbox']>>
}

/** Next, the bar's count, the messages' mutes, and the Inbox a module's page is answered. */
export function useInboxWiring({
  inbox,
  registry,
  open,
  projectId,
  project,
  projects,
  about,
  presses,
  moduleName,
  activityNames,
  flashContainer,
  inboxOpen,
  setInboxOpen,
  goToEntry,
  setTrouble,
  onPlaceRef,
  inboxAskRef,
}: InboxWiringInputs) {
  /* "Next that needs me": the most pressing open item and, pressed again, the
     next, across kehikot, epics and parts. See `nextOf`. */
  const [lastNext, setLastNext] = useState<string | null>(null)
  const nextEntry = useMemo(() => nextOf(inbox.open, lastNext), [inbox.open, lastNext])
  /* The open project's record as the space picker reads it: every open item for when a space last saw
     activity (agent sessions, modules, tracker news alike), the live ones for its dots. */
  const spaceActivity = useMemo<SpaceActivity[]>(() => {
    const live = new Set(inbox.live)
    return inbox.all.map((one) => ({ state: one.state, ...(one.place ? { place: one.place } : {}), entered: one.entered, live: live.has(one) }))
  }, [inbox.all, inbox.live])
  /*
   * The module that shows the Inbox (protocol 2.79.0): whichever registered module declares
   * `inbox:person`, else the official list's entry whose role is `inbox` (`inboxModuleOf`). The
   * list is read only once a popover needs it and no registered module answers.
   */
  const [listed, setListed] = useState<readonly InboxListed[]>([])
  const inboxModule = useMemo(
    () =>
      inboxModuleOf(
        (registry?.presences ?? []).map((one) => ({ id: one.id, name: one.name ?? one.id, icon: one.icon ?? null, uses: one.module?.declares?.uses ?? [] })),
        listed,
      ),
    [registry, listed],
  )
  const inboxPlacedHere = inboxModule !== null && (open?.placements ?? []).some((p) => p.i === inboxModule.id)
  useEffect(() => {
    if (!inboxOpen || listed.length || (inboxModule && inboxModule.registered)) return
    let cancelled = false
    void fetchOfficial()
      .then((got) => !cancelled && setListed(got.modules.map((one) => ({ id: one.id, name: one.name, icon: one.icon ?? null, role: one.role ?? null, installed: one.installed }))))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [inboxOpen, listed.length, inboxModule])
  /* The Inbox modules on the open kehikko: who is told the record changed (`kehikot.inbox`). */
  const inboxModulesRef = useRef<readonly string[]>([])
  inboxModulesRef.current = (registry?.presences ?? [])
    .filter((one) => one.module?.declares?.uses?.includes(INBOX_CAPABILITY))
    .map((one) => one.id)
  const othersRev = useMemo(() => inbox.others.map((one) => `${one.project.id}:${one.entries.length}`).join(','), [inbox.others])
  useEffect(() => {
    for (const id of inboxModulesRef.current) presses.inbox(id, { kind: 'changed', rev: inbox.rev })
  }, [inbox.rev, othersRev, inbox.muted, nextEntry, presses])
  /* What an item offers to adopt is kept (`fetchAdoption`) until the record or the modules here change. */
  const modulesSaid = (registry?.presences ?? []).map((one) => `${one.id}@${one.module?.version ?? ''}:${one.condition}`).join(',')
  /* A change of the record reaches the Inbox modules by the press above; anything else that changes an offer is told below. */
  useEffect(() => forgetAdoptions({ tell: false }), [inbox.rev, othersRev])
  useEffect(() => forgetAdoptions(), [modulesSaid])
  /* What an item offers may differ (the modules here, the primary agent, an adoption): the Inbox modules are told, so they ask again then and never on a clock. */
  const inboxRevRef = useRef(inbox.rev)
  inboxRevRef.current = inbox.rev
  useEffect(
    () => onAdoptionsForgotten(() => {
      for (const id of inboxModulesRef.current) presses.inbox(id, { kind: 'changed', rev: inboxRevRef.current })
    }),
    [presses],
  )
  /* The last Next the host told a page: its `inbox.open` of that item is the person's press. */
  const nextToldRef = useRef<NextTold | null>(null)
  /* Go to the Inbox's container on this kehikko: lit, and the keyboard handed to it. */
  const focusInbox = useCallback(() => {
    if (!inboxModule) return
    flashContainer(inboxModule.id, false)
    presses.focus(inboxModule.id)
  }, [inboxModule, flashContainer, presses])
  const goNextRef = useRef<() => void>(() => undefined)
  goNextRef.current = () => {
    if (chordGoes(inboxPlacedHere) === 'popover' || !inboxModule) {
      setInboxOpen(true)
      return
    }
    const next = nextEntry ? { module: nextEntry.module, id: nextEntry.id } : null
    if (nextEntry) {
      setLastNext(rowKey(nextEntry))
      nextToldRef.current = { module: inboxModule.id, key: rowKey(nextEntry), at: Date.now() }
    }
    focusInbox()
    presses.inbox(inboxModule.id, { kind: 'next', rev: inbox.rev, next })
  }
  /* Alt+Shift+N. By `code`, so the Option key's dead keys on a Mac do not
     matter; not in a text field. The host keeps the chord; the Inbox module
     goes to the item (`chordGoes`). */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.code !== 'KeyN') return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      event.preventDefault()
      goNextRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  /* Whether the open project has messages between agent sessions (protocol 2.41.0): the Inbox's
     control is then there to reach them, even with nothing else in it. */
  const [, setMessageCount] = useState(0)
  /* "Messages to agents" off, per module in the open project (`host/messagesUse.ts`): read with the count. */
  const [messagesMuted, setMessagesMuted] = useState<ReadonlySet<string>>(() => new Set())
  const muteMessages = useCallback(
    (module: string, muted: boolean) => {
      if (projectId === null) return
      void postMute(projectId, module, muted).then((now) => now && setMessagesMuted(new Set(now)))
    },
    [projectId],
  )
  useEffect(() => {
    if (projectId === null) {
      setMessageCount(0)
      setMessagesMuted(new Set())
      return
    }
    let cancelled = false
    const read = () =>
      void fetchMessages(projectId, 0).then((got) => {
        if (cancelled || !got) return
        setMessageCount(got.count)
        setMessagesMuted((was) => (was.size === got.muted.length && got.muted.every((one) => was.has(one)) ? was : new Set(got.muted)))
      })
    read()
    const off = onMessagesChanged((project) => project === projectId && read())
    return () => {
      cancelled = true
      off()
    }
  }, [projectId])

  /* "Use inbox" off, named for the panel: the way back is where the muting is said. */
  const mutedModules = useMemo(
    () => [...inbox.muted].map((id) => ({ id, name: moduleName(id) })).sort((a, b) => a.name.localeCompare(b.name)),
    [inbox.muted, moduleName],
  )
  /* "Add <Inbox> to this kehikko": placed at once when it is registered, else installed from the
     list and placed when the registry has it. */
  const [placing, setPlacing] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  useEffect(() => {
    if (placing === null || !registry?.presences.some((one) => one.id === placing)) return
    if (!(open?.placements ?? []).some((p) => p.i === placing)) onPlaceRef.current(placing)
    setPlacing(null)
    setInstalling(null)
  }, [placing, registry, open?.placements])
  const [inboxColour, setInboxColour] = useInboxColour()
  const inboxCount = useMemo<InboxCountView | null>(() => {
    if (projectId === null) return null
    const needing = needingCount(inbox.open, inbox.others)
    return {
      look: countLook(needing, inboxColour),
      module: inboxModule ? { id: inboxModule.id, name: inboxModule.name, icon: inboxModule.icon } : null,
      placedHere: inboxPlacedHere,
      onFocusInbox: focusInbox,
      open: inboxOpen,
      onOpenChange: setInboxOpen,
      offer:
        inboxModule && !inboxPlacedHere && open
          ? {
              label: addWords(inboxModule.name),
              busy: installing,
              run: () => {
                setInboxOpen(false)
                if (inboxModule.registered) {
                  onPlaceRef.current(inboxModule.id)
                  return
                }
                setInstalling(`Installing ${inboxModule.name}…`)
                setPlacing(inboxModule.id)
                void installOfficial(inboxModule.id).catch((error: unknown) => {
                  setPlacing(null)
                  setInstalling(null)
                  setTrouble(error instanceof Error ? error.message : String(error))
                })
              },
            }
          : null,
      items: topItems([...inbox.open, ...inbox.others.flatMap((one) => one.entries)]),
      colour: inboxColour,
      onColour: setInboxColour,
      /* Messages between agent sessions in the open project (protocol 2.41.0): read-only, at the foot. */
      messages: { project: projectId, nameOf: moduleName, muted: messagesMuted, onMute: muteMessages },
    }
  }, [projectId, inbox.open, inbox.others, inboxColour, setInboxColour, inboxModule, inboxPlacedHere, focusInbox, inboxOpen, open, installing, moduleName, messagesMuted, muteMessages])

  /*
   * The person's Inbox, answered to a module's page that declares `inbox:person` (protocol
   * 2.79.0): from what this page holds, through the page's own routes. See `host/inboxDoor.ts`.
   */
  const inboxDoorRef = useRef<InboxDoor | null>(null)
  /* Each tracker item's line after its last adopt or untrack (protocol 2.88.0), read again with the Inbox. */
  const [afters, setAfters] = useState<ReadonlyMap<string, { said: string; undo: boolean }>>(new Map())
  useEffect(() => {
    if (projectId === null) return
    let live = true
    void fetchAfters(projectId).then((got) => live && setAfters(got))
    return () => {
      live = false
    }
  }, [projectId, inbox.rev])
  /* The adoption dialog with the person's agent for Kehikot's own tasks, when one is open. */
  const [adopting, setAdopting] = useState<{ project: number; item: { module: string; id: string } } | null>(null)
  /** What the adopt dialog closed on when an agent took the item: said for a few seconds. */
  const [handedOff, setHandedOff] = useState<string | null>(null)
  useEffect(() => {
    if (handedOff === null) return
    const timer = window.setTimeout(() => setHandedOff(null), 6000)
    return () => window.clearTimeout(timer)
  }, [handedOff])
  inboxDoorRef.current = {
    entries: () => inbox.open,
    elsewhere: () => inbox.others,
    muted: () => mutedModules,
    earlier: () => inbox.earlier,
    rev: () => inbox.rev,
    next: () => nextEntry,
    at: () => ({ epic: about.epic, kehikko: open?.key ?? null }),
    names: () => activityNames,
    projectName: () => project?.name ?? null,
    log: (scope, offset, limit) =>
      projectId === null ? Promise.resolve(null) : fetchLog(projectId, { scope, epic: about.epic, kehikko: open?.key ?? null }, offset, limit),
    act: (what, keys, scope, inProject) => inbox.act(what, keys, { scope, epic: about.epic, kehikko: open?.key ?? null }, inProject),
    answer: (entry, said, inProject) => inbox.answer(entry, said, true, inProject),
    open: (entry, inProject) => goToEntry(entry, inProject ?? projectId),
    use: (module, on) => inbox.use(module, on),
    hasProject: (id) => projects.some((one) => one.id === id),
    adopting: {
      afters: () => afters,
      /* The kehikko the person is on names the agent that would do the task: in this project only. */
      adoption: (key, inProject) => fetchAdoption(inProject ?? projectId ?? 0, key, (inProject ?? projectId) === projectId ? (open?.key ?? null) : null),
      adopt: (key, epic, parts, inProject) => postAdopt(inProject ?? projectId ?? 0, key, epic, parts, open?.key ?? null),
      adoptWith: async (key, inProject) => {
        const at = inProject ?? projectId
        if (at === null) return 'no-agent'
        /* Never a dead end (`adoptWithStep`): the agent's dialog, the choice of agent in it, the update
           the agent module needs, or the module list to add one. */
        const got = await fetchAdoption(at, key, at === projectId ? (open?.key ?? null) : null, { fresh: true })
        /* The host's server did not answer: say so in its words, not as "no agent". */
        if (got.outcome === 'declined' && got.why) return { why: got.why }
        const step = adoptWithStep(got)
        if (step.kind === 'dialog') setAdopting({ project: at, item: key })
        else if (step.kind === 'update') openUpdates(step.module)
        else if (step.kind === 'add') openModuleList()
        return step.kind === 'none' ? 'no-agent' : 'opened'
      },
      untrack: (key, inProject) => postUntrack(inProject ?? projectId ?? 0, key),
      undo: (key, inProject) => postUndo(inProject ?? projectId ?? 0, key),
    },
  }
  inboxAskRef.current = (from, method, params, pressed) => {
    const door = inboxDoorRef.current
    if (!door) return Promise.resolve({ ok: false, reason: 'failed', error: 'This canvas holds no Inbox to show.' })
    const told = nextToldRef.current && nextToldRef.current.module === from ? nextToldRef.current : null
    return answerInbox(method, params, pressed, door, told)
  }

  return { spaceActivity, inboxCount, messagesMuted, muteMessages, adopting, setAdopting, handedOff, setHandedOff }
}
