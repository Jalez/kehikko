# Kehikko host — notes for agents

## The app names no module and no vendor

- The whole app is module agnostic and vendor agnostic, not only the Inbox:
  no text a person or an agent reads — MCP door instructions and tool
  descriptions, the skills the host ships, the intro and tour, settings,
  notices, errors — names a specific module (Journeys, Flows, Factory, Test
  runs…) or an agent vendor (Claude, Codex, OpenAI…). Modules come and go and
  agent modules will come from more vendors. Say "a module that shows steps",
  "every container that follows a walk", "an agent session", "your agent"; a
  module's name reaches the screen only from data (its registration,
  `modules.json`, its manifest). Comments that say which module does something
  say "a module" too, unless they document code that handles one by id.
- Nor does CODE decide by a module's id: what a module is to the host (opens
  files, holds live sessions, an event's sound, installs skills for its agent,
  shows steps) is a manifest declaration. `test/module-agnostic-ids.test.ts`
  fails on an official module id in any string in `server/` or `src/`; its
  allowlist holds only compatibility fallbacks (each commented with when it
  goes) and examples in MCP tool descriptions.
- `test/module-agnostic-text.test.ts` scans every string, template and JSX text
  in `server/`, `src/host/`, `src/canvas/` and `src/App.tsx`, and
  `skills/*/SKILL.md`, for the names in `modules.json` and the vendors. A word
  that is genuinely data goes in its `ALLOWED` list with a reason; never a
  sentence.

## Where data lives

- Project data goes **only** under `<project>/.kehikot/<module>/`, built with the
  protocol helpers (`KEHIKOT_DIR`, `kehikotDir`, `moduleDir`, `moduleFile` from
  `kehikot-module-protocol`). Never `join(ROOT|HERE|import.meta.dir|process.cwd()|__dirname, 'data', …)`,
  never `homedir()` for storage.
- The host's own folder is `<project>/.kehikot/host/` (protocol 2.2.0:
  `HOST_FOLDER`, `hostDir`, `hostFile`): epics/state, `kehikot.json`,
  `trackers.json`, the tracker reading, dispositions, `data-versions.json`,
  `settings.json` (the project's base branch; `server/baseBranch.ts` is its
  one writer, `POST /host/base-branch` in `PAGE_ONLY`, and it travels; it writes
  only where `projectWritable` says, so the home fallback never gets one, and
  older hosts ignore the file).
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
  `KEHIKOT_APP_PROTOCOLS` (`off` reads no app tags; the suite sets it), `KEHIKOT_MY_MODULES`, `KEHIKOT_LAYOUTS_DIR`, `KEHIKOT_SOUNDS_DIR`, `KEHIKOT_ONBOARDING` (`off`: the introduction counts as seen), `KEHIKOT_LOGS_DIR`, `KEHIKOT_BROWSER_PROFILE`, `KEHIKOT_KEYS_DIR`, `KEHIKOT_FACTORY_DIR`, `KEHIKOT_ORIGIN`,
  `KEHIKOT_ORIGINS` (the list passed to modules the host starts),
  `KEHIKOT_HOST_PATH` (the folders the host put first on an installed module's
  `PATH`, its own `bun`; a module takes them off with the protocol's `personEnv`
  for what it starts on the person's behalf),
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

## Browser tests run on bee

- Browsers (Playwright's Chromium, its headless shell, WebKit) start only on bee,
  our CI machine — never on this Mac, by an agent, a test or a drive. A test
  that launches Playwright or spawns a `dev/` drive is declared with
  `browserTest` (`test/browser-gate.ts`): it runs when `KEHIKOT_BROWSER_TESTS=1`
  and is skipped otherwise, so a plain `bun test` here starts no browser.
  `test/browser-gate.test.ts` fails a test file that reaches a browser any
  other way.
- Run them with `dev/bee-browser-tests.sh <ref>` from this Mac, on a branch or
  sha already pushed: it fetches that ref into a fresh run directory on bee,
  installs, runs the browser tests, streams the output and exits with their
  status; on a failure the log, screenshots and scratch host logs are copied
  to `$TMPDIR/kehikko-bee/<run>/`. `BEE_FULL=1` runs the whole suite there.
  Runs can go at once. `dev/bee-setup.sh` installs the pinned bun and browsers
  (once, idempotent).
- Every agent changing UI behaviour runs the browser tests on bee before its
  PR, and says the result in it.
- Everything on bee is under `~/kehikko-ci/` of its WSL user, which also runs
  another project's GitHub Actions runner: that runner, `~/.bun` and
  `~/.cache/ms-playwright` are not ours. Kehikko gets no self-hosted runner —
  the repository is public, and one would run strangers' PR code on bee.
- A drive waits on the condition it means, with a ceiling for a loaded machine,
  and reads a module page from the driver (`inPage` in
  `dev/pages-take-input.drive.mjs`): WebKit holds back a cross-origin frame's
  own timers and animation frames by seconds.

## The shared layout and the person's view

- `<project>/.kehikot/host/kehikot.json` is the LAYOUT and travels with the
  project: kehikot, names, and every container's module, rectangle, wish,
  grow, pin, prompt, interval and version (`PORTABLE_PLACEMENT_FIELDS`).
  `view.json` beside it is the person's VIEW: the epic, "All epics", picked
  parts and refs, and each container's `collapsed`, `selected` and `filters`
  (`PERSONAL_PLACEMENT_FIELDS`, `PERSONAL_SUBJECT_FIELDS`; `server/view.ts`).
  The host folder's `.gitignore` names `view.json`. A new `Placement` field
  goes on one list or the build fails.
- `kehikot.json` stays `"version": 2`, and a file written since the 56-row
  canvas also carries `"rows": 56`. A host before 56 rows refuses such a file
  ("field this host does not know (rows)") and keeps its own canvases without
  writing over it — the owner accepted that break: a teammate on an older host
  sees layout changes once they update. A file without `rows` is 28 rows and
  is read doubled; it gains `rows` on its next write, never on a read.
  Columns the same way: a file written since the 24-column canvas carries
  `"cols": 24`, one without it is 12 columns and has `x` and `w` read doubled,
  a host before 24 columns refuses it ("(cols)"), and the database marks each
  placement (`placements.cols`, `finerColumns`). Layout files are version 3
  (24 columns); `modules.json` keeps its `layouts` at version 2 so released
  apps still read the published list, and this host doubles them on read. The
  pre-split reader in `test/fixtures/pre-split/reader.ts` is frozen — never
  edit it to pass a test; it confirms the refusal. Legacy personal fields in it are read into
  `view.json` only when there is none, and dropped on the next write. Folds
  are written unfolded (`shared`), so a fold is no diff.

## Suggested layouts, the introduction and the tour

- Layouts: built in (data: `modules.json`'s `layouts`, read by
  `readBuiltInLayouts` into `BUILT_IN_LAYOUTS`, and as published on `main` over
  them by `officialSource.layouts()` — whole or not at all; never module ids in
  code), the project's
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
  Restart tour starts from the first step not done.
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
  desktop release, which is automatic (next section).

## How the host reaches the app (automatic releases)

- Nobody bumps, writes notes or tags by hand. Every host pull request carries a
  `## Release note` section (`.github/pull_request_template.md`): one line for
  the app's release page (`**Short bold lead.** One plain sentence.`), or
  `none` when nothing changes for the person. The `release note` check
  (`.github/workflows/release-note.yml`) fails a PR without it, or whose line
  names a module or a vendor.
- kehikko-desktop's `auto-release.yml` runs hourly from its `main`: it compares
  this repository's `main` with the commit the latest app release was built from
  ("Built from Jalez/kehikko@…"), collects the release-note lines of the PRs
  merged in between (skipping `none`), checks them with `dev/module-agnostic.ts`
  as it is at that commit, and when any are left tags the next patch version
  and builds the app from exactly that commit.
- Each push to this repository's `main` starts that run at once
  (`.github/workflows/start-app-release.yml`, with the `DESKTOP_RELEASE_TOKEN`
  secret: a fine-grained token for kehikko-desktop only, "Actions: Read and
  write"). Without the secret it does nothing and the hourly schedule stays the
  only trigger. GitHub can delay that schedule by hours.
- A line refused there fails the release and opens one issue in
  kehikko-desktop. Fix the line by editing the merged PR's description, then
  close the issue; the next hourly run tries again.
- `dev/module-agnostic.ts` is the one list of names the host never says
  (`modules.json`, the unlisted modules, the vendors) and the matcher; the
  source scan in `test/module-agnostic-text.test.ts` imports it. Change it
  there, never in a copy.

## Which Kehikot a release works with

- The app→protocol map comes from `app-v*` tags, read at most daily
  (`server/appProtocols.ts`), so the newest apps may be missing. The RUNNING
  host is always part of the answer (`withRunningHost`): a release whose need
  this host's protocol meets is "Works with Kehikot X and later" (X when the
  map knows it, else "this Kehikot") and is never "Needs a newer Kehikot".
- A check sends the running app's version (`?app=`); when it is newer than the
  newest tag read, the map is read again inside the day, at most once an hour.

## Installed modules are built once, here

- A module that adopted the protocol's `/build` and `/run` (2.17.0) has a
  `build` script that compiles its page into `dist/` and stamps
  `dist/.kehikot-built` with the commit; its `run.sh` serves that build when
  the stamp is `HEAD`, and Vite otherwise. Modules are installed as SOURCE at
  their release tag and built on this machine — nothing is downloaded. All of
  it is `server/moduleBuilds.ts`; the words are `src/host/moduleBuilds.ts`.
- ADOPTION decides whether a copy is built at all (`adoptedReadyBuilt`): it has
  a `build` script AND a `run.sh` that checks the stamp (`dist/.kehikot-built`,
  `STAMP_FILE`) — the protocol template's `run.sh`, which Terminal and Claude
  have. A module with only an old, unrelated `build` (a plain `vite build`, its
  own production path) is NOT built, has no status line and no failure record,
  and its details say "Running from source". The record is in memory, so a
  start drops what 0.1.55 said; `backfill` also drops it for non-adopters.
  Never widen this to "has a `build` script".
- Built after `bun install` at install (`installs.ts`, before the registration
  is written) and after every update (`Place.build`, called by `update()` — so
  the Update press, `ReleaseWaits.apply` and a restart that takes a release).
  Skipped when the stamp already names `HEAD`. A start NEVER builds.
- After the host's own `bun install --frozen-lockfile` in an installed copy
  (install and update; an installed copy's update is frozen too), it writes
  the marker the module's `run.sh` writes, `node_modules/.kehikot-installed`
  (`markInstalled`: empty, as `touch` makes it, newer than `bun.lock` and
  `package.json`), so the first start does not install again.
- One build at a time (`ModuleBuilds` queue; a person's before the background
  pass), never under a running module: one that is running is marked and
  built when it next stops (`whileStopped` in `server.ts`). While a module's
  own build runs, `begin` does not start it. A ready-built copy is restarted
  on any change by an update (`restartDecision(…, ready)`).
- Only installed copies (`isInstalled`/`isUnder`). A checkout somebody
  registered from their own folder is never built and keeps Vite.
- Failure is never fatal: no script, a failed or timed-out build (3 min), or no
  stamp → it runs from source by its own `run.sh`. The output goes to the
  module's log (`readyLog`, a `--- kehikko built this at` header, not a run's),
  and the host says once per commit that it runs from source.
- Copies installed before this are built once per host start, in the
  background, `nice`d, after the open kehikko's modules are up (`openUp`) or
  two minutes in, skipping anything wanted or running (`backfill`).
- The build runs on the host's own Bun: inside the app, the compiled host with
  `BUN_BE_BUN=1` and a `bun` link to it first on the build's `PATH`
  (`buildBun`). A ready-built module needs Bun `READY_BUILT_BUN` (1.4.0,
  `Bun.spawn({ terminal })`): `whyNoBuilds` checks this Bun and the `bun` on
  the `PATH` modules run with, and `build:sidecar` refuses an older Bun.
- Every `bun install` the host runs for an installed copy (install, update,
  auto-update and `ReleaseWaits.apply` through `update()`, My modules through
  the same install, a pinned version's tree) uses `buildBun()`'s binary and env,
  never the `bun` on the PATH: the modules' `bun.lock` is written by the host's
  Bun, and another Bun can read it as "needs changes" and fail a frozen install.
  A module START of an installed copy gets the same shim first on its PATH
  (`withOwnBun`), so its `run.sh` installs and runs on that Bun too. A checkout
  somebody edits keeps their toolchain. A frozen install that still fails says
  which Bun and keeps the output in the log; it never falls back to a non-frozen
  install.
- The Updates menu says "Preparing Terminal…" while it builds and "Terminal
  runs from source; its build didn't finish (see log)" after a failure
  (`builds` on `/host/updates`, phase `preparing`); a module's details say
  "Ready-built" or "Running from source", with the build's log
  (`build` on `/host/module-release`). That describes what is RUNNING: for a
  process the host started, the line the protocol's `run` prints at its start
  (`<id> serves its built page on … (<sha7>)`, read by `servedAs` from
  `startOfRun` of the module's log); only for a module the host did not start
  is it the stamp on disk (`seen: 'disk'`).

## Modules keep themselves up to date

- "Keep modules up to date automatically": machine-wide, `module-updates` in
  `settings` (`server/autoUpdates.ts`), on by default for new and existing
  installs; `{ updates: { auto } }` on `POST /host/settings`, shown in
  Settings › Modules and at the top of the Updates menu. Off is exactly the
  behaviour before it. The rule (`decide`) and every word are
  `src/host/autoUpdates.ts`; test the table there.
- No check of its own: `AutoUpdates.found` is handed what the existing checks
  read (`GET /host/updates?fetch=1`, quiet or Check now, and the check beside a
  start in `releaseWait.ts`). Never add a check or a timer for it.
- It applies through `updateModule` (the press's path: `update()`, install,
  build, restart rules), one at a time, with `progress` set so the menu and
  What's new show "Preparing…". Not running → now; running off screen → now
  (restarted); running on screen → when off screen (`moved`, from `act`) or at
  the next start; `holdsShells` (its manifest says `holds: ['live-sessions']`,
  protocol 2.33.0; `HELD_SESSIONS_BEFORE_2_33` only for copies that say nothing) or `keep` and running
  → when it stops. Never: pinned containers, only releases needing a newer
  Kehikot (`needsNewer`), a checkout somebody edits, a copy following `main`,
  one `update` refuses. A failure waits for the next check (`RETRY_AFTER_MS`).
  A major jump is applied and marked (`major`), never asked.
- At host start, with the switch on, the first sweep reads every installed
  copy's own tags (`bootAutoUpdates`; no network) and puts waiting releases in
  place before those modules first start, so the app's "Restart to update"
  brings them along. `auto.pending` holds a queued module back in `begin`.
- `{ updates: true }` on `/host/watch` (`wakes.updatesChanged`) tells pages to
  re-read the menu and What's new. What's new tells an install from before the
  switch once (`NOTES`, `record.told`; a first run records them as told).

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
- The host tells the pages the moment its wait for a module it started ends,
  up or given up on (`untilAnswered`), with the reading; the page does not
  poll while modules start (see "Asking once").
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

## Where a new container lands

- `place()` in `src/host/canvases.ts` is the ONE rule, for the page's add flow,
  `place_modules` (`server/mcp.ts`) and anything else that adds a single module:
  the first free rectangle in reading order that holds 6x10 on the grid as it is
  DRAWN (`arranged`, so a gap vertical compaction would close is not a gap); else
  the first gap of at least `GAP_MIN_W`x`GAP_MIN_H` (4x6) at its own size, capped
  at 6x10; else beside the last on the bottom row, or a new row. Not a search for
  the best fit: it is the first hole you would see reading the canvas. Layouts
  (`src/host/layouts.ts`) keep their own explicit placements.
- A container that appears on the open kehikko is ringed and scrolled into view
  (`showLanded` in `src/App.tsx`, `[data-landed]` in `index.css`), never focused.
  `dev/place-in-gaps.drive.mjs` (run by `test/place-in-gaps.test.ts`, on bee) checks it.

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
- An agent may jump the person's view when the person asks for it (or step by
  step through a walkthrough they started): `jump { project?, kehikko?, epic?,
  parts?, step? }` (`server/mcp.ts`), the ONE door tool that switches project,
  kehikko or epic. What it leaves out stays. The server resolves names strictly
  and refuses an unknown one with what exists, paces jumps (`paceRefusal`) and
  logs one line; the page on screen plans it again (`planJump`, which ignores a
  jump to where the person is), goes as the person's own pickers go (`goPlace`
  in `App.tsx`: `onProject`, the calm switch, then `gotoHere`), walks a step
  (`kehikot.goto`) and marks it with Go back, which restores project, kehikko,
  epic, parts and step exactly (`JumpMark.tsx`). It never moves `my_place`.
  Every rule is in `src/host/jump.ts`. A module's `view.goto { epic, step }`
  walks the other containers the same way. `/kehikko-jump` (`skills/`) is the
  skill that says when to use it.
- An order to a page (`Wakes.press`) goes to that page's streams only. Every
  other kind of news on `/host/watch` goes to everyone and says only that there
  is something to re-read — except where it carries the small thing itself
  (`tracker`, `content`) and `{ registry: true, modules }`, the `/host/modules`
  reading the host just made at the end of a start wait.

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

## A module's settings (protocol 2.15.0)

- A module declares its settings (`declares.settings`) and is the ONLY writer
  of its files. The host draws one form per module
  (`src/canvas/ModuleSettings.tsx`; rules and words `src/host/moduleSettings.ts`)
  and reads and changes values at the module's door (`settings.get` /
  `settings.set`, `SETTINGS_PATH`) through `server/moduleSettings.ts`. Never
  write into `.kehikot/<module>/`; "Open the file" only reads it (in a module
  whose manifest says `opens: ['file']`, protocol 2.33.0 — one on the kehikko,
  else an answering one placed there for the press (`fileOpenerFor`); the host
  points the canvas at it as `kehikko` — else in a read-only dialog), and only
  a file inside that module's own folder.
- Reached from the gear in a container's header (220 px and wider, folded or
  not; under 220 it is "Settings…" in the module's "⋯", `settingsPlaceFor`),
  the Frame menu's "Settings…" (every width) and Settings › Modules. Every
  module on a kehikko has the gear and the Frame row, settings or not: its window
  always has "Providers & Consumers" (see "Connections between modules").
- A change is the person's only through a PASS: minted by `Passes.issue` in
  the desk's `set`, reached only by `POST /host/module-settings/set`
  (`PAGE_ONLY`, with `/host/module-settings`, `/list` and `/file`), one
  module, key and project, 30 s, spent by the one answer at
  `GET /host/settings-pass`. Never mint one anywhere else.
- `module_settings` (`server/mcp.ts`) only reads. No MCP tool or program route
  of this host changes a setting: an agent changes a non-`personOnly` one at
  the module's own door.

## A module's scope

- What a module's content belongs to (protocol 2.29.0): This computer, Project,
  Epic, Part or Kehikko. The module lists the scopes it can work at as `modes`,
  its default first. Every rule is in `src/host/scope.ts` (`scopeOfContainer`,
  `scopeToKeep`, `scopeToTell`, `coveredForScope`); `src/canvas/Scope.tsx` only
  draws it (header label, modules-menu chip, the settings window's control).
- The person picks among the module's own scopes, per container, in its settings
  window. The pick is `scope` on the placement, shared in `kehikot.json`, and
  written only when it is not the default (an older host's strict schema refuses
  the field). The module is told in `context.scope`. Agents read it in
  `read_canvas`; no MCP tool changes it. Never offer a scope the module does not
  list, and never add a second switch for it: a module's own "this epic / all
  epics" toggle is this setting.
- In the header the scope is the first thing to give way (`scopeText` in
  `src/host/headerFit.ts`), to its icon, which keeps the tooltip; it is also a
  row in the Frame menu at every width.

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

## Steps, and what a module provides (protocol 2.21.0)

- An epic's steps are the union of every module's `steps.json` (`server/plans.ts`,
  read through `epicOf` in `server/holdings.ts`, the one reader). Journeys'
  `journeys.json` is a fallback provider only while `.kehikot/journeys/steps.json`
  does not exist. Never read another module's file for steps.
- What a module provides and whether it loads skills into its agent sessions is
  its manifest's (`declares.provides`, `declares.agentSessions`), read by
  `src/host/providers.ts`. The only modules read as saying it without saying it
  are Journeys (steps) and Claude (loads skills), and only while their manifests
  predate 2.21.0 (`BEFORE_2_21`). Never add another, and never route by id.
- A skill's `needs` are matched against the manifests on the kehikko
  (`missingNeeds` over `asRead`) in `modulesOn` (`server/placeRoutes.ts`).
  Kehikko-bound skills go only to a session posted by a module that loads skills.

## Connections between modules

- How the modules on a kehikko affect each other is DERIVED from their manifests, never written
  by hand: `connectionsOf` in `src/host/connections.ts` (pure; page, server and file share it).
  Kinds: passage, selection, location (A `*:set`, B `reacts`), address (A `address:open`, B
  `reacts: address`), steps (A provides steps, B `steps:read`), extension (A emits, B consumes),
  skill (B's skill `needs`, met by A), agent (B runs agent sessions, A has an MCP door), parts
  (Kehikot's bar pick → B `reacts: parts`; A `parts:set` → B drawn only), tracker and inbox
  (Kehikot as a node; drawn only). A connection is FROM what provides TO what takes it.
- The person switches one off, or chooses which providers a consumer takes a kind from (`off`,
  `only`), FOR ONE KEHIKKO. `delivered` is the one rule; every enforcement asks it, and an off
  connection is as if the provider were not on the kehikko — never an error for the module:
  - context fields: `receiverContext` (`src/host/connectionContext.ts`) gives that module a context
    of its own (`contextsFor` in `App.tsx` → `Frames`); everyone else gets the shared one;
  - extensions: `EventBus.holds`; addresses: `readersFor` before `handed` (no reader left → an
    offer); steps: `CanvasControls.withhold` (`stepsWithheld`) on the page's answers;
  - skills: `meetingSkill` in `modulesOn`; agents: `doorsHanded` in `POST /host/place`.
  A module's SERVER asking (`/host/server-ask`) is not on a kehikko and is not held back.
- Stored with the kehikko's arrangement: `connections` on a kehikko in `kehikot.json` (SHARED,
  travels; `PORTABLE_CANVAS_FIELDS`), and `canvases.connections` in `frame.sqlite` as the cache.
  Written only when not automatic, so an untouched kehikko is the same file; a host before this
  refuses a file that carries it ("field this host does not know (connections)") — accepted, as for
  `rows`.
- Only the person changes them: `POST /host/connections` (`PAGE_ONLY`), never the canvas PATCH and
  never an MCP tool. `read_canvas` lists each connection and whether it is on.
- Drawn in each module's settings window (the header gear, now on EVERY module): the "Providers &
  Consumers" tab (`src/canvas/Connections.tsx`), beside "Settings" when the module declared any;
  "See all on this kehikko" lists every module, searchable. Words, never colour alone: an off
  connection says "off" and its off sentence.

## A module's server asking (protocol 2.19.0)

- `POST /host/server-ask` (`SERVER_ASK_PATH`, `server/serverAsk.ts`) answers a
  module's SERVER what its page would be answered — `SERVER_METHODS` only
  (`tracker.get`, `tracker.columns`, the traffic methods, and since 2.21.0
  `epics.list`, `epic.get`, `steps.list`, `parts.get`, `dispositions.get`) — so
  its MCP door reads with no page open. The protocol's `askHost` asks it.
- In this order, never another: the module is registered; the module at its
  REGISTERED origin vouches for the question's pass (`SERVER_PASS_PATH`, spent by
  the asking — never trust an origin from the question); `hold` against the
  manifest the last sweep read (a module that did not declare the capability gets
  nothing); the folder is a project here and not the unpicked home fallback.
  Then the page's own `answer()` in `answers.ts`, so the two cannot differ.
- It reads the stored reading: no tracker request a page's question would not
  make. Never add a write method to the list, and never let it answer a program
  the module did not vouch for.
- `tracker.get { epic, parts: true }`: the epic's refs and its parts' refs
  (`partRefsOf`, what `context.parts[].refs` carries) in one answer, through
  `Scope`'s `also`.

## A web address on the canvas

- `address.open` (protocol 2.16.0, capability `address:open`) hands a page to the open
  kehikko. All of it is `src/host/address.ts` (pure; `test/address.test.ts` is its table):
  a container whose module says `reacts: ['address']` (the Browser) is a READER, and the
  address goes into `context.address` stamped with `by` (from the registration, never the
  frame) and `at`, answered `shown`. With no reader the person gets an OFFER
  (`AddressOffer`: open in their own browser, https only, or add a module that shows
  pages), answered `offered`; nothing leaves the canvas before a press. An agent's
  `open_address` is held tighter: a reader or `declined`, never an offer.
- The address lives in the page's memory by kehikko id. Never `kehikot.json`, the canvases
  database or `sessionStorage`: opening a page is a request made once.
- A placed Browser that is still starting counts as a reader. `noteReacts` reads what a
  module that is not answering is known to react to (`Presence.reactsKnown`: the last
  manifest it served, kept in `known_modules.reacts`, else `reacts` on its entry in
  `modules.json`), so the address waits in the context for its greeting instead of the
  person being told nothing shows pages. What a module says while answering wins.
  A new module that shows pages gets `reacts` on its official entry.
- A module's title and address are text, never markup or a link; do not widen the rule
  for a module that hands many.

## The order of the bar's pickers

- The project, epic and kehikko dropdowns each carry a two-part switch, "A–Z" and
  "Recent" (`src/canvas/SortSwitch.tsx`, made of the menu's own radio items so
  the keyboard reaches it and the menu stays open). Each picker keeps its own
  choice; defaults are epics A–Z (the host already lists them so), projects and
  kehikot Recent (they were in the order made). The rules are pure, in
  `src/host/pickerOrder.ts`: never-visited after visited, A–Z among themselves;
  "All epics" and "no epic" are not in the ordered list and stay where they are.
- The choice is a row of `settings` in `frame.sqlite` (`{ picker: { epics: 'recent' } }`
  on `POST /host/settings`); visit times are rows of `visits` in the same file
  (`server/pickerOrder.ts`, `POST /host/visits`, `PAGE_ONLY`). Never in browser
  storage, never in a project's `.kehikot/`. The page's copy is `src/host/pickerStore.ts`.
- A visit is recorded in ONE place: `App.tsx` asks `visitFor` of the place the page
  shows, so every way of arriving (picker, pinned place, Inbox Open, agent jump,
  Go back, a jump into another project) counts. Do not record one at a call site.

## The Inbox

- ONE record of what modules need, are doing and have said: `src/host/inbox.ts`
  (pure, shared by the page and the server) and `server/inbox.ts` (the store, in
  `frame.sqlite`, per project id; never in the project). The dots, the bar
  control, the panel (`src/canvas/Inbox.tsx`), the log and `read_canvas` /
  `read_inbox` all read it. Do not add a second set of items, a seen set in
  browser storage, or a derived-notice set: a transition is a row in
  `inbox_moves`, and what was told is what the record already holds.
- Nothing outlives the module's word for it (#195). An entry closes, and `how`
  says why: `listed` (its latest whole list drops it), `silent` (not answering,
  or on no kehikko of the project), `unreported` (its new page — restart,
  update, reload — sent no list within `REREPORT_GRACE_MS` of its greeting;
  `greeted` in `useInbox`), `gone` (`retire`: module not installed, or its
  kehikko or epic no longer in the project; a list naming a gone place is not
  held). The host's own lists (`isHostModule`: `kehikko`, `kehikko.*`) are
  never closed for having no container.
- The page posts a module's whole list (`/host/inbox/report`), a legacy notice
  (`/host/inbox/notice`) and the person's acts (`/host/inbox/act`: seen,
  dismiss, forget). All four POSTs are in `PAGE_ONLY` (`server/guard.ts`) — a
  new write here gets the same. No MCP tool may see, dismiss or forget.
- The host names no module and no vendor: the by-line is the module's registered
  name, the label is its claim. Never colour alone; no standing rows.
- A module's named event (protocol 2.31.0, `events` in its manifest, `event` on an
  item) is a case of a state, never a kind of its own: `applyList` keeps it as
  `named` only when the manifest declares it for the item's state. Its sound is
  `chimeFor` in `src/host/chime.ts` (the person's choice, else the built-in
  sound the module's manifest names for the event — `events[].sound`, protocol
  2.33.0, `declaredSound` — else the kind's). The host keeps no table of event
  ids: the module picks ("Answer", formerly `research`, is still read).
- **The same item** is one (project, module, item id) in one `state` since one
  `entered` (the module's `since`): `sameItem` in `src/canvas/useInbox.ts`. A
  re-report of it is never news — no toast, no chime, seen stays seen — through
  a re-send, a close and return, a module restart, a page reload and a host
  restart. Only a new state or a new `since` is news. The host trusts `since`;
  a module that re-stamps it on every re-send makes each one news (Claude and
  Codex did, before 1.13.0 and 0.5.0). Do not add a host-side rule that guesses
  around `since`.
- Open (an Inbox row, a toast, Next) sees a `done` item and, once the host is
  at its place with the module's container on the kehikko, tells the module
  which item (`kehikot.opened`, protocol 2.35.0: `arrived` in `useGoToPlace`,
  `Conversation.sendOpened`). `attention` still ends only by the module's word;
  the message is how a module learns the person came for it.
- Next that needs me is `Alt+Shift+N` (`src/App.tsx`). Do not take that chord.
- Tracker notices are the host's own items (`kehikko.trackers`, by-line Kehikot):
  `server/trackerNotices.ts` compares each landed tracker reading with the facts
  it last saw (`tracker_seen` in `frame.sqlite`, per project; the first reading
  is silent) and reports ONE item per ref through `Inbox.report`. The rules and
  words are `src/host/trackerNotices.ts`; the setting is `tracker-notices` in
  `settings`, changed only through `POST /host/settings` (`{ notices }`). Whether
  the person put an item away is read from the Inbox's record, never kept twice.
- The chime is derived from that record, never kept beside it: `useInbox`'s
  `notify` (what entered attention or done as news, minus a place that is on
  screen) and a legacy notice line feed `useChime`, which collapses a burst to
  one sound (most urgent kind wins: urgent, needs you, finished, notice) and
  lets only the window used last play. The rules are `src/host/chime.ts`; the
  choices (mute, a sound per kind, a sound per module, My chime) are the host's
  `inbox-chime` setting through `POST /host/settings` (`{ chime }`), never
  browser storage. The person's own clips are in `soundsDir()`
  (`KEHIKOT_SOUNDS_DIR`), served only by id at `GET /host/sounds/<id>`; their
  writes are in `PAGE_ONLY`. No MCP tool plays, mutes or picks a sound.
- The Inbox is the only place a line goes. A module that still emits a legacy
  `kehikot.notifications@1` line (`events.emit`) lands in it through
  `/host/inbox/notice`; nothing forwards a line to a module, and no old module
  file is imported.
- A module the official list retires (`retired` in `modules.json`, read with the
  list: `server/officialSource.ts`, acted on by `server/retired.ts`) is taken off
  the machine: its containers off every kehikko (`editCanvas`), its process
  stopped, its registration and its `installed/<id>/` copy deleted, and each
  project's Inbox told once as the host. A registration naming another directory
  is somebody's own checkout and is left whole. Nothing under a project's
  `.kehikot/<module>/` is ever touched. The host names no module: ids and words
  come from the list. Retiring is published by merging `modules.json` to `main`.

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
- An issue's linked branches (`branches`, protocol 2.19.0) come with the reads
  already made, never a request per issue: GitHub's `linkedBranches` in the same
  GraphQL query (asked again without it, and believed `SCOPE_RECHECK_MS`, on a
  GitHub Enterprise Server without the field); GitLab's related branches
  (`<iid>-…`, `relatedBranches`) from one listing of the source's branch names per
  whole read (`BRANCH_PAGES`), kept in the reading and applied wherever a row was
  read (`withBranches`). Absent means not read, `[]` read and none.

## Pinned places

- A place is what the bar's breadcrumb shows: project, kehikko, epic (or All
  epics) and picked parts. The person pins one with the Pin button after the
  breadcrumb (or `Alt+Shift+P`) and goes back from the Pinned menu beside it.
  Rules and words: `src/host/pinnedPlaces.ts`; the menu and button:
  `src/canvas/PinnedPlaces.tsx`; the store: `server/pinnedPlaces.ts`, the
  `pinned_places` table in `frame.sqlite` (pins span projects, never in one).
- Picking a pin goes by `goPlace` in `App.tsx` — the path the pickers, an
  agent's `jump` and Go back share. Never a second navigator.
- A pin whose project, kehikko, epic or every part is gone is greyed with the
  reason and can still be unpinned; some parts gone keeps the rest and says so
  (`resolvePin`). The row is never rewritten for it.
- `POST /host/pinned-places` (pin, unpin, order) is in `PAGE_ONLY`. `my_place`
  lists the pins read-only; no MCP tool pins or unpins.
- On the bar the word "Pinned" goes under 900 px; the menu's icon and the Pin
  button stay at every width (`dev/header-fit.drive.mjs` measures it on bee).

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
- It never opens by itself. When anything is news, the bar's notice
  (`WhatsNewNotice`, drawn in `Bar.tsx`; words by `noticeSaid`: "What's new in
  0.1.61", "What's new · 3 modules", "What's new" at 1100 px, its icon at 900)
  stands at once — never gated on GitHub's release list, which is read in the
  background for the notes — takes no focus, and shows with focus in a module.
  Pressing it opens the dialog and acknowledges what it shows; closing
  acknowledges again. Do not bring back a quiet-moment or first-run gate.
- A module the server is still updating (`updating`) is a "Preparing…" row,
  counted by the notice, never acknowledged, filled in on `pokeWhatsNew` or
  the re-read every `pollMs` while one stands (`mergeItems` drops one whose
  update came to nothing). A failed update is left out. `show: false` means no
  notice: what moved is acknowledged as it is. Settings → About and the
  Updates menu open it by hand (`openWhatsNew`), everything installed listed.
- The Updates menu reports notes read there (`readInUpdates`), which count as
  acknowledged.
- Notes are drawn by `ReleaseSections` (`ReleaseNotes.tsx`), the same
  Markdown-only drawing; a failure that hit every release is said once.

## You're mentioned in What's new

- When the notes of a release the person gets (What's new's news rows, plus the
  app version the desktop app is downloading) mention their GitHub login as
  `@login` (any case, whole handle), the Inbox says so once: the host's own list
  `kehikko.whatsnew` (by-line "Kehikot"), one `done` item per release and handle
  (`mentionId`). Rules and words: `src/host/whatsNewMentions.ts`; the store side:
  `server/whatsNewMentions.ts`. "Told" is the Inbox's record (`Inbox.holds`, any
  project, open or closed) — never a second set, never browser storage.
- The page names releases (`POST /host/whats-new/mentions`, `PAGE_ONLY`); the
  server resolves each to the app's repository or an installed module's release
  repository, never one the page names, and reads notes through `releaseNotes`.
- The login: `server/forgeLogins.ts`, `forge_logins` in `frame.sqlite`, per
  `tracker|host`. Tracker reads feed it (`learned`); otherwise asked once through
  `Trackers.me` (the adapters' `gh api user` / `glab api user`), used for
  `FRESH_MS`, a failure not retried within `RETRY_MS`. Never read a credential.
- Pressing the item opens What's new at that release (`openWhatsNew(at)`), the
  handle in a `<mark>` (`markedPieces`), text only. Handles are never linked.
- In the open project, only this list is news on a read (`refresh` in `useInbox`),
  so a mention toasts and chimes like a module's item. The other host lists
  (tracker notices, settings) stay quiet there: do not widen it.

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
- `POST /host/place` answers `modules` beside `doors`: every container on the
  token's kehikko (name, the module's one line, its door's name, the skills that
  work there — `modulesOn`). It is what a session is told of its kehikko at its
  start and, asked again with the same token, how the module hears that the
  kehikko changed. Additive: a module that does not read it gets the doors as before.
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

## Switching kehikko, project or epic

- Module pages must take a real click, typing and the wheel, in WebKit (the
  app's engine) and Chromium. `dev/pages-take-input.drive.mjs` proves it with
  `page.mouse`/`page.keyboard` at coordinates and `elementFromPoint`, and
  `test/pages-take-input.test.ts` runs it on bee (see "Browser tests run on bee").
  0.1.54–0.1.55 shipped a full-canvas wrapper over the pages that took every
  click: any layer over the pages is `pointer-events: none`, and a test that
  uses `locator.click()` or a dispatched event cannot see a layer in the way.
- A switch ends by a hard deadline (`deadline`, `preparingMs`): the canvas
  takes input and the pages are told their new context within `capMs`
  (300 ms) of the press, whatever the layout readings do.
- The look: what is left fades out with a light blur, the incoming chrome
  comes into focus, the pages arriving fade in sharp. A filter only ever on a
  layer that takes no input, and at rest NO `filter`, `will-change` or
  transition on any layer (`layerStyle`). Reduced motion: a plain short
  crossfade. The underlay (`canvas/Underlay.tsx`) keeps the moment between
  two pages a panel, not the black canvas; `dev/switch-frames.drive.mjs`
  records each switch and fails on a dark flash or a page left unsharp.
- An epic switch (`changeSubject` with `movesEpic`) goes through the same
  switch, and the pages being left keep their context while they fade.
- A switch must not fidget: `host/switching.ts` holds the rule and the
  measurements, `canvas/useCalmSwitch.ts` drives it, and
  `dev/calm-switch.drive.mjs` measures it in a browser (visible moves per
  painted frame; zero after the switch is shown, on a revisit).
- Change the open kehikko through `setOpenId` in `App.tsx`, never the raw
  `setOpenIdNow`: it keeps a still copy of the kehikko being left on screen
  while the next is drawn out of sight. The raw setter is only for inside a
  state updater.
- The grid animates only with `in-motion` (`index.css`): a drag or resize in
  hand, the glide after it, and a fold. Never turn transitions on for a
  switch, a load or a module's height. The grid is TOLD its width (`useRects`);
  do not bring back `WidthProvider`, which renders every new grid at 1280 px.

## A module's jump into another project (protocol 2.28.0)

- `view.goto { project, show }`: every rule is `src/host/navigate.ts` (`planJump`; its table is
  `test/navigate.test.ts`); `App.tsx` carries it out with `onProject` (the person's own switch, the
  calm switch) and then the in-project goto (`gotoHere`) once that project's epics are read
  (`jumping`, `goElsewhere`'s rule). The answer waits for the arrival, at most `ARRIVAL_WAIT_MS`.
- Answered only for a module whose manifest says it (`declares.navigates`). A project is found by
  its id, else its folder now; one the host does not hold is `declined` with a sentence naming no
  project. Never list the projects to a module.
- A switch of project is a PERSON's: only from a container on the kehikko on screen, with the page
  focused, and never within `AGENT_PRESS_HOLD_MS` of an agent's press handed to that module
  (`agentPressedAt`, noted in `orderedRef` before the press is sent). An agent switches project
  only through the door's `jump`, which the person asked for and which is marked with Go back
  (`src/host/jump.ts`); do not let `press_item` around that.
- `context.show` goes only to the containers on the kehikko the move ended on whose manifests say
  `shows` the subject (`showReceivers`, through `contextsFor`). In memory by kehikko id, like an
  address; never stored. The host names no module.
- `dev/cross-project-jump.drive.mjs` (`test/cross-project-jump.test.ts`, on bee) presses it in a
  stand-in's page (`STANDIN_JUMP`, `STANDIN_SHOWS`).

## The record of traffic (protocol 2.20.0)

- ONE record of the calls this host makes and receives, the calls modules note
  and the connections it sees on their processes: `server/traffic.ts`
  (`TrafficRecord`, the last `LIMITS.TRAFFIC_KEPT` rows, in memory only — never
  in a project, never on disk) and `server/trafficProcesses.ts` (the sampler).
  Read by `traffic.read`, held to `traffic:read` like every method, for the
  Monitor and no other module; `traffic.note` (`traffic:report`) files a
  module's own calls under it, sanitized again (`takeNotes`).
- Recorded at the two choke points, put in place first thing in `server.ts`
  (`recordThisProcess`): the global `fetch` and `Bun.spawn`/`spawnSync`
  (`trafficCommand` decides which runs went over the network). A new call site
  needs nothing here — only a reason. Give one with `because(reason, work)`
  around the work (a short phrase from a fixed vocabulary: "release tags",
  "tracker read: <folder> (whole project)"); a route's reason is
  `routeReason` (`ROUTE_REASONS`, a path under a route is that route's, the
  desktop app's page files are "the page loads Kehikot"), and the innermost
  wins. Anything without one is shown as "no reason given". A new route gets an
  entry (`test/traffic-reasons.test.ts` fails without one); work started by a
  timer, a socket event or another module's poke (`agentSync`, the tethers, the
  backfill, auto-update's first look) carries its own `because`. Sanitize with the protocol's `trafficTarget`/`trafficPath`,
  never by hand; never record a body, a header or a query value.
- Every request this host answers is a row `in` (`receivedRow`, around
  `answerRequest`): the page by its origin, a module relayed by `/host/call`
  (`tag`), a module's server by a `module` query or the port the sampler saw.
  The traffic methods themselves, and the vouching for their passes, are not
  recorded (`tag({ skip })`, `untraced`): a reader polling every second would
  fill the record with itself.
- The sampler runs only while a `traffic.read` with `sample: true` came in the
  last `WANTED_MS`: `ps`, then `nettop -L 1 -n -x -J bytes_in,bytes_out -p …`
  (no root needed; `lsof -i` without bytes when it fails). A module is its
  process group and everything under it (`attribute`), from the `Nursery` pid
  or the process listening on its registered port. It cannot see a connection
  that opened and closed between looks, or DNS (macOS resolves it in
  `mDNSResponder`).

## Kehikot's share of the person's GitHub limit

- Every `gh` run goes through `account.run` (`server/githubAccount.ts`), never
  `spawnRunner` directly: the trackers, the gateway's `gh`, feedback, proposals,
  My modules. A new caller of `gh` takes `account.run`. Only github.com is
  budgeted; GitLab's limit is only reported (`RateLimit-*` headers of `glab api`
  REST calls already made).
- The rules are `decide`, pure, and what to test: a SHARE of 20% of each hourly
  limit (REST `core`, GraphQL points), counted in the account's own window; a
  FLOOR of 10% left, whoever spent it; and a wait when GitHub says so (403/429
  with nothing remaining → that limit until its reset; `retry-after` or a
  secondary limit's words → everything, a minute doubling). Background reads
  obey share and floor; a person's press (`pressed`, routes in
  `pressedRequest`: Refresh, Check now, Update, feedback, proposals, My
  modules) may pass the share, never the floor; a write (`gh issue create`)
  only waits for GitHub. A held run is not run: `held: true` with the sentence
  in `err`, said as is by `trouble`/`ghTrouble`, and a `refused` row "held: …"
  in the record of traffic (`noteHeld`).
- The account is read with `gh api rate_limit` (free) at most once a minute,
  only while a Monitor reads traffic (`watch`), near the floor, stale, or before
  the first call. Otherwise from the answers: `gh api` runs with `--include`
  and the headers are taken off before the caller sees the output; a GraphQL
  query asks its own `rateLimit { cost }` (`withCost`), taken out of the answer.
  Never read an answer's data for limit words — only a failure's.
- What the share spent and any wait are kept in `github-account.json`
  (`githubAccountFile`). `traffic.read` says it in `limits` (protocol 2.24.0)
  and, for older readers, as rows in `budgets` (`budgetRows`: the anonymous
  budget only when it was used or there is no account).

## Asking once (fewer repeated calls)

- A sweep reads each module's kept manifest (`ManifestCache`, `server/manifests.ts`):
  kept `MANIFEST_FRESH_MS` for a module that answered, `UNANSWERED_MS` (1.5 s) for one
  that did not. A module the host started is asked by its start wait alone
  (`manifests.wait`, from `untilAnswered`): every read meanwhile is what the wait last
  found, and the answer that ends it is kept. The sweep after a wait reads what is
  kept however old (`sweep({ kept: true })`) — only that module changed.
  Forget it (`manifests.forget`) wherever the process changes — `run`, `halt`,
  `ended`, the liveness check seeing it go, come back or answer from another build.
  `sweep(true)` / `/host/modules?fresh=1` is for a person's press only. Never add a
  `look()` to a path a page reaches on load, focus or a report.
- The liveness check asks a module's health door (`probe`, the `x-module-build`
  header), not its manifest. A tether's idle close is put back before anything
  is asked; only a reconnect that fails asks.
- `/host/open` answers `started`; the page sweeps after a report only when it is
  true (`arrive`). After that the page looks only on news: no timer while modules
  start (once 33 reads of `/host/modules` in 9.1 s). `{ registry: true, modules }`
  is taken as a look's answer (`registryIn`), never over a newer one (`swept`,
  `newerReading`); one look after `MISSED_NEWS_MS` if a reading still says
  something is moving. `reportOpen` sends the same report once (focus, `pageshow`,
  StrictMode); `{ again: true }` after the stream reopened.
- The page reads its host endpoints through `hostRead` (`src/host/hostRead.ts`):
  one read shared per page load, `fresh` on a person's act, `keepRead` with a
  write's answer, `forgetRead` on news. A new endpoint read at load goes through it.
- The automatic update check is `fetch=1&quiet=1`: `git ls-remote` compared with
  the local upstream (`readCheckout(…, 'compare')`), a fetch only for an installed
  copy whose remote moved, and a checkout somebody edits is never fetched — it
  says `waiting` until Check now.
- `dev/traffic-counts.drive.mjs` counts it from the record of traffic;
  `test/traffic-counts.test.ts` (on bee) fails a page load that asks an endpoint twice.
  That is a steady load. A COLD start — six modules the host starts, some slow — is
  `dev/cold-start.drive.mjs` (plain HTTP, the page's requests made as `App.tsx` makes
  them; `test/cold-start.test.ts`) and `dev/cold-start-page.drive.mjs` (the real page,
  on bee): besides its start wait, a manifest at most once before the page arrives
  (the first sweep) and once after (the page's first look), `/host/modules` at most
  twice, no row of Kehikot's own without a reason. Change the page's start-up and
  change the plain drive's `aPage` with it.

## Skills for an agent other than Claude Code

- A module that installs skills itself (`declares.agentSessions.installsSkills`, protocol 2.23.0:
  Codex) declares skills written for ITS agent. None is installed or updated in
  `~/.claude/skills` — not by a press (`agentRefusal` in `server/skills.ts`), not by the Settings
  sync (`skillsFor` in `server/agentSync.ts`, which removes an untouched one an older host put
  there). The Skills window and Settings say `agent` ("Kept by its module", `agentSays`).
- Such a module is told, in the answer to `POST /host/place`, `everywhere`: the skills the Settings
  sync keeps installed for every conversation (`everywhereFor`: the host's own and each automatic
  module's, never kehikko-bound, never another agent module's), each with its origin. It keeps
  them where its own agent reads skills. The host never writes an agent's folder other than Claude
  Code's.

