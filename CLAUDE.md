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
  are in `project_paths`. `/host/is-project` (`isProjectAnswer`) answers a
  project with its `id`, and a path in `project_paths` of a project still here
  with `movedTo` and `id` (protocol 2.3.0) — only when the folder at it is not
  itself a project; never the list. A pinned container is the same project by
  `projectId` (`whileFrozen`) and is told the new path.
- A folder renamed or moved on the same volume is followed by itself:
  `projects.bookmark` (frame.sqlite, a machine-level cache) holds macOS
  bookmark data minted through `bun:ffi` in `server/bookmarks.ts`;
  `followProjects` resolves it at start, every few seconds for a missing
  project and on `GET /host/projects`, and relinks only to a folder carrying
  the project's own id (never one in the Trash, never home, never another
  project's). The page says it once (`followed`, `src/canvas/Followed.tsx`).
  Off macOS it is a no-op and "Locate…" is the way back.
- This host never creates a project's folder: every write under a project
  makes its folders through `makeUnderRoot` (`server/projectRoot.ts`), and
  `test/project-writes.test.ts` fails on any other folder-making call in
  `server/`. A folder at a project's path holding nothing but `.kehikot/` that
  the host cannot vouch for (`projects.folder`, the folder's device and inode;
  or, for an older row, born with its `.kehikot/`) is a GHOST an older host
  made: `projectRootExists` says missing, nothing is written into it, a
  bookmark is not followed into one, and "Locate…"/Add relink past it.
- Machine-level state only where the allowlist in `dev/storage-boundary.ts`
  says so (`~/Library/Application Support/Kehikot/` — `modules/` registry,
  `frame.sqlite`, `versions/`, `installed/`, `official-modules.json`, `app-protocols.json`, `my-modules.json`, the Browser module's `browser-profile/`, `keys/` (Review's Factory key), `factory/` (Factory's per-author re-review rules) and `layouts/` (the person's own suggested layouts) — `~/.claude*`, `~/Library/Logs/Kehikot`, temp dirs), each with a one-line reason. A one-off exception needs
  `// kehikot-storage: allow <reason>` on the line.
- The machine directory is spelled once, in `server/machineDirs.ts`; use its
  helpers.
- Environment: `KEHIKOT_FRAME_DB`, `KEHIKOT_MODULES_DIR`, `KEHIKOT_VERSIONS_DIR`,
  `KEHIKOT_INSTALLS_DIR`, `KEHIKOT_OFFICIAL_CACHE`, `KEHIKOT_APP_PROTOCOLS_CACHE`,
  `KEHIKOT_APP_PROTOCOLS` (`off` reads no app tags; the suite sets it), `KEHIKOT_MY_MODULES`, `KEHIKOT_LAYOUTS_DIR`, `KEHIKOT_ONBOARDING` (`off`: the introduction counts as seen), `KEHIKOT_LOGS_DIR`, `KEHIKOT_BROWSER_PROFILE`, `KEHIKOT_KEYS_DIR`, `KEHIKOT_FACTORY_DIR`, `KEHIKOT_ORIGIN`,
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

## The shared layout and the person's view

- `<project>/.kehikot/host/kehikot.json` is the LAYOUT and travels with the
  project: kehikot, names, and every container's module, rectangle, wish,
  grow, pin, prompt, interval and version (`PORTABLE_PLACEMENT_FIELDS`).
  `view.json` beside it is the person's VIEW: the epic, "All epics", picked
  parts and refs, and each container's `collapsed`, `selected` and `filters`
  (`PERSONAL_PLACEMENT_FIELDS`, `PERSONAL_SUBJECT_FIELDS`; `server/view.ts`).
  The host folder's `.gitignore` names `view.json`. A new `Placement` field
  goes on one list or the build fails.
- `kehikot.json` stays `"version": 2` on purpose: every older host reads it
  with a strict schema in which the personal fields default, so it still
  reads the file (`test/fixtures/pre-split/reader.ts` is that reader, frozen —
  never edit it to pass a test). Legacy personal fields in it are read into
  `view.json` only when there is none, and dropped on the next write. Folds
  are written unfolded (`shared`), so a fold is no diff.

## Suggested layouts, the introduction and the tour

- Layouts: built in (`BUILT_IN_LAYOUTS`, `src/host/layouts.ts`), the project's
  (`.kehikot/host/layouts/<slug>.json`, travels) and the person's own
  (`layoutsDir()`, `KEHIKOT_LAYOUTS_DIR`). Read and saved by
  `server/layouts.ts`; `POST /host/layouts` is in `PAGE_ONLY`. A layout naming
  an official module that is not here says "will install X" and installs only
  on the press in the picker's confirm step, through `/host/official/install`;
  one on no list is "not available" and left out. Never install from a card.
- The introduction (`src/canvas/Intro.tsx`) is a welcome and a pitch, not a
  manual: "Welcome to Kehikot" first, then what Kehikot brings; how controls
  work is the tour's. Each slide's picture is inline SVG animated by CSS
  (`.intro-art` in `index.css`), whose own styles are the FINAL frame, so
  `prefers-reduced-motion` / `data-motion="still"` shows a still that still
  says it. Its ✕ has a row of its own above the picture (`showClose={false}`
  on `DialogContent`). Shown once per `INTRO_VERSION` (`src/host/onboarding.ts`,
  stored in `frame.sqlite` by `server/onboarding.ts`, `POST /host/onboarding`
  in `PAGE_ONLY`), after Settings' one-time question, and again from Help →
  Introduction. `KEHIKOT_ONBOARDING=off` answers it seen and the tour finished
  — set it on a scratch host you screenshot unless you are shooting these.
- The tour (`src/host/tour.ts` rules, `src/canvas/Tour.ts` the `Guide` and its
  driver.js drawer). WAIT steps (project, epic, parts, kehikko) point at a
  control and move on only when the app's facts say it is done (`Facts`, from
  `App.tsx`; the home folder a fresh host opens by itself is not a picked
  project — `home` on a project); each has frames, most specific first, so it
  follows the person into the menu and the window they open. SHOW steps are
  the explanations after, skipped when not on screen. Waiting draws no overlay
  and leaves the page usable (`data-tour-mode="wait"`, `driver-active` taken
  off) and never takes focus. Every step has "I've got this"; it, Escape and ✕
  pause at the step and point at Help; Help → Continue tour resumes there,
  Restart tour starts from the first step not done. While the tour runs
  `<html data-tour-running>` stands (`tourStanding`), and What's new waits on it.
  A control the tour should find gets a `data-tour` and a frame.
- Layouts are in the kehikko menu (new kehikko… opens the picker) and on the
  empty canvas, never in Help. The built-ins start with Design, Research,
  Development, Review, Learning.

## Manifests

- A manifest must say how the module relates to the parts of an epic
  (`reacts: ['parts']` or a `partless` sentence, not both); the protocol's
  schema refuses one that does not. `look` in `server/discover.ts` marks that
  presence `refused`, and the modules list says the protocol's sentence and
  "Update the module to use it." (`attention` in `src/host/moduleMenu.ts`).

## Modules run from their releases

- The app runs every module from its installed copy under
  `~/Library/Application Support/Kehikot/installed/<id>/` (`installsDir`),
  checked out (detached) at the module's newest RELEASE: the newest `vX.Y.Z`
  tag, no pre-releases, whose protocol need this host meets — the
  `kehikot-module-protocol` pin in that tag's `package.json` (`protocolPin`,
  the rule `describeModule` uses) and the list entry's `protocol`. All of it is
  `server/moduleReleases.ts`; the words are `src/host/moduleReleases.ts`.
- A module release (built by the module's own release script): an annotated
  `vX.Y.Z` tag on its `main`, `package.json` at `X.Y.Z`, and a GitHub Release
  "<Module> X.Y.Z" whose body is `### What's new` + bullets + `<sub>Built from
  <sha7></sub>`. Its manifest reports the package version.
- Tags are found with `git ls-remote --tags` through the person's git (so a
  private repository works with their `gh`/ssh credentials), cached by
  `TagLister` and asked afresh at most once a minute, and only on a check: a
  reading without `fetch` uses the copy's own tags. A fresh install is put on
  the newest release before `bun install` (`settle`). A start NEVER waits for
  a release check: the copy starts as it is, and the check runs beside it (at
  most every ten minutes, `server/releaseWait.ts`). A newer release it finds
  WAITS, and is put in place (tags already fetched, `git checkout --detach
  refs/tags/<tag>`) only while the module is not running: when the reaper next
  stops it, when it is restarted, or when the person presses Update.
- A repository with no release yet: the copy follows `main` as before ("following
  main · no releases yet"), fast-forward only. A copy on `main` moves to the
  newest release that contains its commit; one AHEAD of the newest release is
  held where it is ("running main ahead of 1.6.0") and moves to the first
  release after it. Never moved back, never fast-forwarded along `main` once
  releases exist. A copy with uncommitted changes is not moved.
- A module registered from somebody's own checkout (not under `installed/`)
  follows its branch as before; only an installed copy's `Place` carries the
  follower (`placeOf` in `server/server.ts`). A registration never names a
  working checkout or a worktree.
- The Updates menu says "Journeys 1.5.0 → 1.6.0", "up to date · 1.6.0",
  "following main · no releases yet" or "running main ahead of 1.6.0"
  (`releaseSaid`), and "What's new" opens the GitHub Release notes of every
  release since the installed one, newest first (`ModuleNotesDialog`, the
  same Markdown-only drawing). `module_versions` says the installed release and
  the newest; `pin_version` pins a container to a release tag (`versions/`).
- Every container's header shows the branch its module is running from, after
  the version: quiet on `main` and on a release (the version chip then says the
  release, `releaseShown`), an amber chip with the reason otherwise (another
  branch, detached elsewhere, behind or ahead, uncommitted changes, not the
  registered folder). It reads the folder the RUNNING process is in
  (`server/source.ts`), so a module somebody started by hand is caught too.
  `bun dev/source.probe.ts` prints the same for every module.
- An agent changing a module works in a git worktree of that module's
  repository and opens a PR; it never edits the installed copy and never runs
  `bun run register`. To see a change running it starts its own dev server from
  the worktree on a spare port (`PORT=… ./run.sh`) — protocol 2.0.0's `serves()`
  will not take over the app's registration from another folder — and stops it
  by pid when done.
- Which Kehikot a release works with: `server/appProtocols.ts` reads the
  `app-v*` tags of this repository (`git ls-remote`, read-only) and each tag's
  `package.json` pin (raw.githubusercontent at the tag's commit, `gh api` when
  refused) into app version → protocol, at most daily, the last good mapping
  kept in `app-protocols.json` (`appProtocolsFile`). The release's need is the
  higher of its pin and the list entry's `protocol`; the first app on the same
  major that meets it is "Works with Kehikot 0.1.39 and later", with an upper
  bound only once an app on a higher major exists. Without the mapping it says
  "Needs protocol 2.6 or later", never a guessed app. Words and rules:
  `src/host/worksWith.ts`; per release on `ModuleRelease.works`. Shown in the
  Updates row, "What's new", a module's details (`/host/module-release`) and
  `module_versions`.
- What reaches the app is what is RELEASED (what is merged to main, for a
  module with no release yet); the host itself reaches people only through a
  desktop release (kehikko-desktop: bump the version, push a `vX.Y.Z` tag).

## Switching kehikot is warm

- A module on the open kehikko is NEEDED; one on another kehikko of a project a
  page has open is WARM (`wanted` in `server/lifecycle.ts`). Warm modules are
  started in the background once the open kehikko's own are up, `WARM_AT_ONCE`
  at a time in kehikko order (`toWarm`), and are never stopped while warm; the
  ordinary idle rule (`GRACE_MS`, `keep`, only what the host started) applies
  once the project closes. Watch and tether stay on the open kehikko's.
- Settings › Module tools › "Keep this project's modules running" (default on;
  `server/keepRunning.ts`, `{ modules: { keep } }` on `POST /host/settings`).
  Off, nothing is warm.
- The host wakes the pages the moment a module it started answers
  (`untilAnswered`), so a container does not wait for the page's 1.5 s look.
- The page keeps the pages of the open kehikko and the last `KEPT_KEHIKOT` left
  (`recentlyOpen`, `framesKept` in `src/host/canvases.ts`); a hidden page is
  `inert` (`hiddenFrame`) and is not told the open kehikko's context
  (`away`, `whileAway` in `src/host/context.ts`): its place is its own kehikko.

## A folder nobody picked is never written

- With no project and no `KEHIKOT_SEED_PROJECT`, `adopt` opens the person's home
  folder so there is a canvas. That row is the fallback (`home: true`, `picked`
  null) and `isReadOnlyRoot` (`server/projectRoot.ts`) is true for it: `makeUnderRoot`,
  `projectWritable` and the write guards in `holdings`, `trackers/edit`,
  `dispositions`, `hostData` and `shareKehikot` refuse, once per start in the log.
  Keep state in memory or the machine directory. A module is told of no project
  while the fallback is open (`context.ts`), so it writes nowhere either.
- Adding a folder through the picker (`addProject` with its default `chosen`) sets
  `picked`, home included, and lifts the rule. A new write under a project goes
  through `makeUnderRoot` or `projectWritable`, never `projectRootExists` alone.
- A scratch host (`KEHIKOT_SCRATCH=1`, or any machine-dir override under a temp
  folder: `scratchHost`, `server/machineDirs.ts`) with no `KEHIKOT_SEED_PROJECT`
  opens no project at all. Start test hosts with a scratch `HOME` and a seed.

## The official module list

- `modules.json` is the list of modules this host vouches for
  (`server/official.ts`). Adding a module to the app's list is adding an
  entry there: id, name, `owner/repo`, first port, an `icon` (see "A module's
  icon"), summary, tags, and optionally `protocol` — the oldest protocol
  package (`major.minor.patch`) that can run it.
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
  directory's `installed/<id>/`, checks out its newest release (stays on
  `main` when it has none), runs `bun install --frozen-lockfile` and writes its
  registration. The repository and paths come from the list, never from a
  request. After that it is an ordinary registered module that runs its
  releases (see "Modules run from their releases"). An entry's `protocol`
  applies to every release of it; each release's own `package.json` pin too.
- A registered module not on the list can be proposed for it
  (`server/proposals.ts`), which files an issue here through the person's `gh`.

## My modules (installing from a repository)

- A module on no official list — a private repository, one still being
  written — is installed from its repository: "Install from repository…" at
  the foot of the modules list. The list of them is `my-modules.json` in the
  machine directory (`myModulesFile`), this machine's alone: never published,
  proposed, or read by anything but `server/myModules.ts` and its wiring.
- The person adds one and nobody else: every write (`/host/mine/check`, `add`,
  `install`, `remove`, `adopt`) is in `PAGE_ONLY`, and no MCP tool may reach
  any of it — an agent that could add a repository could run any code here.
- Nothing is written before the repository is read with the person's own
  `gh`/`glab` and found to hold a module: `manifest.ts` and `package.json` are
  read AS TEXT (`describeModule`), never run. `add` checks it all again. A
  repository on the official list is installed as the official module; an id
  the official list uses is refused.
- One install path: `begin` in `server/installs.ts`, for both lists. The
  repository comes from the list entry, never a request. The same protocol
  check (`meetsProtocol`); ports from 9000 up and never an official first port
  (`minePort`, `portForMine`). Installed under `installed/<id>/`, so it runs
  its releases like any other; its tags and its release notes are read with the
  person's own credentials (git's helper; `gh api` for the notes).
- Remove (person-confirmed) stops it and deletes only what the host installed:
  `installed/<id>/` and a registration naming it. A checkout put under
  `installed/` by hand from a repository on no list is OFFERED as "Keep it as
  one of my modules" and adopted only on that press.

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

## A module's icon, and Kehikot's own mark

- A module is drawn with ONE component wherever it is listed: `ModuleIcon`
  (`src/canvas/ModuleIcon.tsx`) — the modules menu, What's new, Updates,
  Settings, the Skills and Tools windows, a container's header, the layout
  picker, Storage. Never draw a module's icon another way.
- The icon is a KEY of the protocol's `MODULE_ICONS` (2.14.0): `lucide:<name>`
  (`LUCIDE_DRAWN`) or `brand:<slug>` (`BRAND_MARKS`, path data copied from
  Simple Icons 16.33.0, CC0, `currentColor`). Never a path or URL; nothing is
  fetched. A key the protocol adds needs its entry in one of those two, which
  a test holds. A brand mark is only for a module that fronts that tool.
- Which key: the module's manifest, then what it declared when it last
  answered (`known_modules.icon`), then `icon` in its `modules.json` entry
  (`moduleIconFor`, `src/host/moduleIcon.ts`, resolved per presence in the
  sweep). Neither: the neutral frame with the name's initial. Each entry in
  `modules.json` has an icon, the same one its manifest declares, unique
  across the list (Flows, on My modules, is `lucide:workflow`).
- Kehikot itself — its row in What's new, the app in Updates, About, Settings,
  the introduction, and the id `kehikko` (its door, skills, data) — is drawn
  with `KehikkoMark`, the bar's frame. Never Sparkles, never a module icon.
- Beside its name the icon is decorative (`aria-hidden`); `alone` labels it
  with the name and gives it a tooltip. In a container's header it goes first
  under 240 pixels, so the row still fits at 200 and folded.

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
- Tracker notices are the host's own items (`kehikko.trackers`, by-line Kehikot):
  `server/trackerNotices.ts` compares each landed tracker reading with the facts
  it last saw (`tracker_seen` in `frame.sqlite`, per project; the first reading
  is silent) and reports ONE item per ref through `Inbox.report`. The rules and
  words are `src/host/trackerNotices.ts`; the setting is `tracker-notices` in
  `settings`, changed only through `POST /host/settings` (`{ notices }`). Whether
  the person put an item away is read from the Inbox's record, never kept twice.
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

## The storage overview
- What every module's data takes in every project, and Kehikot's machine data:
  measured by `server/storage.ts` (async, never at startup, a time and entry
  budget, symlinks counted and never followed, cached 30 s); shapes and words in
  `src/host/storage.ts`, shared by the page (`src/canvas/Storage.tsx`, "storage…"
  in the projects menu) and the door's read-only `storage` tool. The route is
  `POST /host/storage`, in `PAGE_ONLY`.
- Read-only. Never add a delete here: clearing data is the module's own job. A
  module offers its own storage view with a header `switch`/`go` option whose
  id is `storage` (`storageViewOf`); the view links to it.

## Release notes

- The version beside "Kehikot" is the app's (`update_status.current`) inside
  the desktop app and "host <version>" anywhere else (`versionShown` in
  `src/host/releaseNotes.ts`). It is the first thing the strip hides.
- Notes are read by `server/releaseNotes.ts` (`/host/release-notes`,
  `/host/releases`), only for repositories the host knows: the app's, the
  official list's, and registered modules' own remotes. Never widen that to a
  repository the page names.
- EVERY read of GitHub's API goes through the one gateway, `server/github.ts`:
  the person's `gh` first whenever it is logged in (5000 an hour), otherwise
  anonymously within a budget of 30 calls an hour (kept on disk, so a restart
  does not forget it), with `If-None-Match` (a 304 is free and given back) and
  the last good answers kept in `github-cache.json` (`githubCacheFile`). Short
  of budget the less important wait (`PRIORITY`: the app's releases, installed
  modules' notes, works-with, the rest; each keeps `RESERVE` calls for those
  above) and answer `waiting`: "will be read in a moment", never dropped. A new
  caller of api.github.com uses the gateway; `raw.githubusercontent.com` goes
  through `raw` (counted, outside the API's allowance). Reads are lazy: nothing
  asks at start but the daily app-tag mapping; a list is read when a picker,
  the app's releases or What's new opens.
- An empty list is a claim: "No releases are published yet" only when GitHub
  answered 200 with `[]`. For the app's own repository a 404, an error, a
  limit, a wait or a non-list says "Couldn't read Kehikot's releases from
  GitHub (…); try again in a moment." with a Retry, and the last good list is
  shown marked `old`. Empty and failed answers are held ~1 minute
  (`MISSING_MS`, `FAILED_MS`), a good one `FRESH_MS`.
- Notes are untrusted text: drawn only through `src/host/markdown.ts` and
  `Markdown` in `src/canvas/ReleaseNotes.tsx`, never as HTML; links are
  `https:` only and open through `openExternal` (the desktop shell hands a
  new-window request to the default browser).

## What's new after an update

- One dialog for Kehikot and every module that moved (`src/canvas/WhatsNew.tsx`,
  rules in `src/host/whatsNew.ts`). What was last ACKNOWLEDGED — the app
  version, each installed copy's release (or commit, on `main`) and the "Show
  What's new after updates" setting — is one `settings` row in `frame.sqlite`
  (`server/whatsNew.ts`), never browser storage. `GET /host/whats-new` reads it
  beside each copy (no network; `?only=record` for the setting alone); the
  POST (`baseline`, `acknowledge`, `read`, `show`) is in `PAGE_ONLY`.
- No record is the first run: what is here is recorded and nothing is shown.
  A module the record does not name yet is recorded the same way. Nothing is
  ever acknowledged backwards.
- It never stacks: it waits for Settings' one-time question and the
  introduction (`firstRunSettled`), then for a quiet moment (`whenQuiet` /
  `notQuiet`: no `role=dialog|alertdialog|menu|listbox` or tour standing, no
  focus in a field or a module's iframe, no Updates batch, `QUIET_MS` of it).
  A new first-run window is covered as long as it is a Radix dialog.
- The Updates menu tells it what landed (`pokeWhatsNew`), marks a batch
  (`updatesRunning`) and reports notes read there (`readInUpdates`), which
  count as acknowledged. One dialog per quiet moment: what lands while it
  stands is merged in (`mergeItems`); a module the server is still updating,
  or whose update failed, is left out.
- Notes are drawn by `ReleaseSections` (`ReleaseNotes.tsx`), the same
  Markdown-only drawing; a failure that hit every release is said once.

## A conversation's place (protocol 2.4.0)

- A conversation's place is what a RECORD says, never what is on screen and
  never a folder taken as a stand-in. Two records, one owner each: the module
  that started a conversation keeps its records (Claude's `places.json`) and
  issues a token (`POST /host/place`); the host keeps only token → issuing
  module + project id (`door_tokens`) and asks the module every time
  (`RECORDED_PLACE_PATH`, `server/placeRoutes.ts`). An MCP session with no token
  is recorded by the host (`door_sessions`) only by `set_my_place` or the
  person's press on the Inbox ask. Never add a third place that keeps a place.
- The token travels as `?kehikot-place=` on every Kehikot door URL, in a 0600
  per-session `--mcp-config` the Claude module writes. It is a pointer, not a
  credential.
- `server/mcp.ts` answers from `door.here` when there is one; a tool that used
  the person's view instead says so every time (`UNPLACED_LINE`). `my_place`
  with no record says so and how a record is made; what is on screen is said
  only as information, labelled NOT its place.
- The Inbox ask is the host's own list (module `kehikko`, ids `place-ask:`);
  the answer is `/host/place/answer`, in `PAGE_ONLY`. No MCP tool answers it.

## A module's Claude Code skills

- A module offers skills in `declares.skills` (protocol 2.5.0) and serves each
  SKILL.md at `skillPath(name)`. The PERSON installs, updates or removes them
  in the Skills window (`src/canvas/Skills.tsx`, a "Skills…" row in the Frame
  menu beside Tools); `server/skills.ts` does the work into
  `claudeSkillsDir()` (`~/.claude/skills`, beside `CLAUDE_CONFIG`).
- `syncSkill` is the one writer, and holds every rule: never overwrite or
  remove an edited install (`MARKER` sha256), never take a name that is not
  this module's Kehikot install. A later sync goes through it too.
- The text is fetched from the registration's origin, never from a request;
  a press carries the sha256 of the text the person was shown and is refused
  if the module's text changed. `POST /host/skills` is in `PAGE_ONLY`, and no
  MCP tool installs or removes a skill.
- A module no longer registered takes its skills with it: the Settings sync
  (`tidySkills` in `server/agentSync.ts`) removes, through `syncSkill`, each
  untouched install whose marker names it — whatever the settings say — and
  leaves an edited one, said once (`skill_left`). Nothing is tidied when the
  registry folder could not be read (`unreadable`), and a registration file the
  host would not use still counts as registered. Only THIS host's installs: the
  marker records the writer's resolved registry (`thisRegistry`), and a marker
  without one (written before) is tidied only by a host on the machine's own
  registry (`isMachineRegistry`), so a scratch or dev host never removes them.

## Kehikot's own skills

- The host offers skills of its own, beside the modules': each is
  `skills/<name>/SKILL.md` in this repository, imported as text, listed in
  `OWN_SKILLS` (`src/host/skills.ts`) and served at `skillPath(name)` on this
  host's origin (`server/ownSkills.ts`). The first is `/kehikot-module`, which
  builds a module with the person from the guide in the protocol repository
  (`docs/building-a-module.md`) and `Jalez/kehikko-module-template`.
- They are the host's row in the Settings sync (`seenOf`, under `HOST_ID`) and
  in the Skills window (`skillDesk`'s lookup), so they install, update and stay
  untouched when edited through `syncSkill`, like any module's. Settings ›
  Skills shows them as "Kehikot's own skills". `withHost` keeps the host in the
  registry the sync tidies against: never removed as a gone module's.
- Their text names no origin, so a development host and the app keep one
  install between them. A new one is a folder under `skills/` and an entry in
  `OWN_SKILLS`; `test/own-skills.test.ts` holds what each must say.

## Settings: a module that is not running

- The sync connects a stopped module from the door it had when it last ran:
  `known_doors` (frame.sqlite, `known.ts`) keeps its path, transport and `as`,
  never the url; the address is the path on the registration's origin as it is
  now (`rememberedMcp`). A module never seen running has none and stays "Not
  running". When it starts somewhere else, Kehikot's own entry is re-pointed.
  Its row says "Connected (not running now)" (`toolSays`).

## Settings: how it is reached

- The gear in the strip (`SettingsGear`, `src/canvas/Bar.tsx`), `⌘,` / `Ctrl+,`
  (`isSettingsChord`, listened for in `AgentSettingsHost`), "settings…" in the
  projects menu, a module's Tools or Skills window, and the sync's Inbox line.
  Do not take that chord. All of them go through `openSettings(section?)`; the
  window event `kehikot:settings` (`OPEN_EVENT`) is also the desktop shell's way
  in for an app-menu "Settings…".
