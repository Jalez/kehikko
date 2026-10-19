# Kehikko host — notes for agents

## Where data lives

- Project data goes **only** under `<project>/.kehikot/<module>/`, built with the
  protocol helpers (`KEHIKOT_DIR`, `kehikotDir`, `moduleDir`, `moduleFile` from
  `kehikot-module-protocol`). Never `join(ROOT|HERE|import.meta.dir|process.cwd()|__dirname, 'data', …)`,
  never `homedir()` for storage.
- The host's own folder is `<project>/.kehikot/host/` (protocol 2.2.0:
  `HOST_FOLDER`, `hostDir`, `hostFile`): epics/state, `kehikot.json`,
  `trackers.json`, the tracker reading, dispositions, `data-versions.json`.
  Reach it only through `hostRoot`/`hostPath`/`epicsDir`/`stateDir` in
  `server/hostData.ts`; never `moduleFile(…, HOST_ID, …)`. `HOST_ID` stays
  `kehikko` — the host's name on the wire and its MCP door — only the folder
  changed. It was `.kehikot/kehikko/` before; `server/hostFolderMove.ts`
  renames it once (at start and when a project is added; both there → keep
  `host/`, leave `kehikko/`, log). Until moved (a read-only project) `hostRoot`
  answers the old folder; nothing ever creates `.kehikot/kehikko/`. Hosts
  ≤0.1.25 find no data after the move — accepted.
- The ONE exception: `<project>/.kehikot/project.json` (protocol 2.1.0,
  `projectFile`), the project's permanent id, written only by the host
  (`server/projectIdentity.ts`; `identify` in `server/projects.ts`) and kept
  out of git with `withProjectFileIgnored`. Never in the home folder; a
  read-only folder keeps its id in `projects.uid` only. Nothing else goes at
  the top of `.kehikot/`. A project is its id: `projects.uid` beside the path,
  a moved folder is relinked (`relinkProject`, "Locate…"), and the paths it had
  are in `project_paths`.
- A folder renamed or moved on the same volume is followed by itself:
  `projects.bookmark` (frame.sqlite, a machine-level cache) holds macOS
  bookmark data minted through `bun:ffi` in `server/bookmarks.ts`;
  `followProjects` resolves it at start, every few seconds for a missing
  project and on `GET /host/projects`, and relinks only to a folder carrying
  the project's own id (never one in the Trash, never home, never another
  project's). The page says it once (`followed`, `src/canvas/Followed.tsx`).
  Off macOS it is a no-op and "Locate…" is the way back.
- Machine-level state only where the allowlist in `dev/storage-boundary.ts`
  says so (`~/Library/Application Support/Kehikot/` — `modules/` registry,
  `frame.sqlite`, `versions/`, `installed/`, `official-modules.json` and the Browser module's `browser-profile/` — `~/.claude*`, `~/Library/Logs/Kehikot`, temp dirs), each with a one-line reason. A one-off exception needs
  `// kehikot-storage: allow <reason>` on the line.
- The machine directory is spelled once, in `server/machineDirs.ts`; use its
  helpers.
- Environment: `KEHIKOT_FRAME_DB`, `KEHIKOT_MODULES_DIR`, `KEHIKOT_VERSIONS_DIR`,
  `KEHIKOT_INSTALLS_DIR`, `KEHIKOT_OFFICIAL_CACHE`, `KEHIKOT_LOGS_DIR`, `KEHIKOT_ORIGIN`,
  `KEHIKOT_ORIGINS` (the list passed to modules the host starts),
  `KEHIKOT_SEED_PROJECT`. Process plumbing between the desktop shell and this host
  (`KEHIKKO_RESTART_FILE`, and the shell's own `KEHIKKO_HOST_DIR`,
  `KEHIKKO_PORT`, `KEHIKKO_API_PORT`) keeps its `KEHIKKO_` name.
- Run `bun run check:storage` before finishing; it scans this host,
  the protocol and every registered module, and fails on violations.
- Tests never reach the real machine: `test/setup.ts` (preloaded through
  `bunfig.toml`) points every location above, and `CLAUDE_CONFIG`, at a scratch
  directory and fails a test that leaves one resolving under the real home. A
  test that moves one of those variables restores what it found — never
  `delete`. A new machine-level location goes in that file's `LOCATIONS`.

## Manifests

- A manifest must say how the module relates to the parts of an epic
  (`reacts: ['parts']` or a `partless` sentence, not both); the protocol's
  schema refuses one that does not. `look` in `server/discover.ts` marks that
  presence `refused`, and the modules list says the protocol's sentence and
  "Update the module to use it." (`attention` in `src/host/moduleMenu.ts`).

## Modules run from main

- The app runs every module from its installed copy under
  `~/Library/Application Support/Kehikot/installed/<id>/` (`installsDir`), which
  the host brings level with the repository's main branch before starting it
  (`level` in `server/server.ts`; never while it runs). A registration never
  names a working checkout or a worktree.
- Every container's header shows the branch its module is running from, after
  the version: quiet on `main`, an amber chip with the reason otherwise (another
  branch, behind or ahead, uncommitted changes, not the registered folder). It
  reads the folder the RUNNING process is in (`server/source.ts`), so a module
  somebody started by hand is caught too. `bun dev/source.probe.ts` prints the
  same for every module.
- An agent changing a module works in a git worktree of that module's
  repository and opens a PR; it never edits the installed copy and never runs
  `bun run register`. To see a change running it starts its own dev server from
  the worktree on a spare port (`PORT=… ./run.sh`) — protocol 2.0.0's `serves()`
  will not take over the app's registration from another folder — and stops it
  by pid when done.
- What reaches the app is what is merged to main; the host itself reaches
  people only through a desktop release (kehikko-desktop: bump the version,
  push a `vX.Y.Z` tag).

## The official module list

- `modules.json` is the list of modules this host vouches for
  (`server/official.ts`). Adding a module to the app's list is adding an
  entry there: id, name, `owner/repo`, first port, summary, tags, and
  optionally `protocol` — the oldest protocol package (`major.minor.patch`)
  that can run it.
- The list is NOT fixed at build time. A host has the copy it was built with
  and, over it, `modules.json` as published on this repository's `main`
  (`server/officialSource.ts`): fetched entries win, built-in-only entries
  stay, a bad or unreachable list is ignored whole, the last good one is
  cached in the machine directory. So merging an entry to `main` PUBLISHES the
  module to every installed app, with no release — whoever can push to `main`
  decides what Install clones. Give an entry a `protocol` when the module
  needs a newer protocol package than released apps have; they then show it as
  needing a newer app instead of installing it.
- `KEHIKOT_OFFICIAL_LIST` is a URL to read the list from instead, or `off`
  for the built-in list only (the test suite sets `off`).
- Installing one (`server/installs.ts`) clones it under the machine
  directory's `installed/<id>/`, runs `bun install --frozen-lockfile` and writes
  its registration. The repository and paths come from the list, never from a
  request. After that it is an ordinary registered module.
- A registered module not on the list can be proposed for it
  (`server/proposals.ts`), which files an issue here through the person's `gh`.

## A module's header menus, and an agent's press

- A module declares its header (`kehikot.header`, protocol 1.1.0) and the host
  draws it: `src/canvas/HeaderMenus.tsx` draws, `src/host/header.ts` holds every
  rule (which menu, what is sent, what is refused) and is what to test. The
  module owns all the state — the page holds the latest list per module and
  nothing else. Never add host-side state for a switch, a toggle or a run.
- A module's strings are text. Never render a label, group, result or reason as
  markup or a link, and never open a URL from one. `icon` is a key in
  `HEADER_ICONS`; add a name there (and to `docs/README.md`), never a path.
- Where focus goes when a menu closes is `focusAfter` in `src/host/header.ts`:
  the module's page after a press that was sent, the trigger after Escape or a
  press that was not taken, and nowhere when focus already left for a module.
  Focus returned to a trigger never raises its tooltip.
- The header is one row. Anything added to it has to fit at 380, 280 and 200
  pixels and folded; a module's menus are words, then icons under 300, then one
  "⋯" under 220 (`modeFor`).
- `press_item` (`server/mcp.ts`) presses only an item marked `agents: true`,
  never a `confirm` run, and refuses an item with `tool` by naming it. The
  server judges against what the page posted (`server/headers.ts`); the page
  judges again against what the frame declared (`orderedRef` in `src/App.tsx`).
  Keep both. `/host/headers` and `/host/pressed` answer only this host's own
  page (`fromThePage` in `server/anyway.ts`); a new route a page posts state to
  gets the same check.
- An order to a page (`Wakes.press`) goes to that page's streams only. Every
  other kind of news on `/host/watch` goes to everyone and says only that there
  is something to re-read.

## What a module may ask

- Every method is held to the capability the protocol files it under
  (`METHODS`): a module whose manifest does not list it in `declares.uses` is
  not answered. The rule is `hold` in `src/host/grants.ts`, used by the server
  for what it answers (`Grants` in `server/answers.ts`) and by the canvas for
  what it answers (`makeAsk` in `src/host/ask.ts`). A new method needs nothing
  here; a refusal is the method's `declined` outcome where it has one.
- A module that is live and calls a method it did not declare goes in
  `ANSWERED_UNDECLARED` (answered, one log line per call) until its manifest is
  fixed. Never widen the rule instead.

## The Inbox

- ONE record of what modules need, are doing and have said: `src/host/inbox.ts`
  (pure, shared by the page and the server) and `server/inbox.ts` (the store, in
  `frame.sqlite`, per project id; never in the project). The dots, the bar
  control, the panel (`src/canvas/Inbox.tsx`), the log and `read_canvas` /
  `read_inbox` all read it. Do not add a second set of items, a seen set in
  browser storage, or a derived-notice set: a transition is a row in
  `inbox_moves`, and what was told is what the record already holds.
- The page posts a module's whole list (`/host/inbox/report`), a legacy notice
  (`/host/inbox/notice`) and the person's acts (`/host/inbox/act`: seen,
  dismiss, forget). All four POSTs are in `PAGE_ONLY` (`server/guard.ts`) — a
  new write here gets the same. No MCP tool may see, dismiss or forget.
- The host names no module and no vendor: the by-line is the module's registered
  name, the label is its claim. Never colour alone; no standing rows.
- Next that needs me is `Alt+Shift+N` (`src/App.tsx`). Do not take that chord.
- The Notifications module still receives the lines (`noticeFor`), and its own
  `.kehikot/notifications/notifications.json` is imported once and never written.

## Tracker sources

- A project's sources are its git remotes plus `<project>/.kehikot/host/trackers.json`.
  The ONE writer of that file is `editTrackers` in `server/trackers/edit.ts`
  (one edit per call, whole file kept, no change → no write); the page reaches it
  at `POST /host/trackers` (`PAGE_ONLY`) and agents through `set_tracker_source`.
  Never hand-write the file from another code path.
- `off: true` on a `sources` entry means "do not read this repository even though a
  remote names it"; `sourcesOf` skips it everywhere (remote, entry, named ref).
  Older hosts strip the key and read the repository: additive, not breaking.
- The words a person is told about a source (`rolesOf`, `readSaid`) live in
  `src/host/trackerSources.ts`, shared by the panel and the MCP tools.

## Release notes

- The version beside "Kehikot" is the app's (`update_status.current`) inside
  the desktop app and "host <version>" anywhere else (`versionShown` in
  `src/host/releaseNotes.ts`). It is the first thing the strip hides.
- Notes are read by `server/releaseNotes.ts` (`/host/release-notes`,
  `/host/releases`), unauthenticated, cached in memory, and only for
  repositories the host knows: the app's, the official list's, and registered
  modules' own remotes. Never widen that to a repository the page names.
- Notes are untrusted text: drawn only through `src/host/markdown.ts` and
  `Markdown` in `src/canvas/ReleaseNotes.tsx`, never as HTML; links are
  `https:` only and open through `openExternal` (the desktop shell hands a
  new-window request to the default browser).
