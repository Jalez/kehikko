# Kehikko host — notes for agents

## Where data lives

- Project data goes **only** under `<project>/.kehikot/<module>/`, built with the
  protocol helpers (`KEHIKOT_DIR`, `kehikotDir`, `moduleDir`, `moduleFile` from
  `kehikot-module-protocol`). Never `join(ROOT|HERE|import.meta.dir|process.cwd()|__dirname, 'data', …)`,
  never `homedir()` for storage. The host's own epics/state are
  `<project>/.kehikot/kehikko/{epics,state}/` (spelled once in `server/hostData.ts`;
  the pre-rename `.kehikot/roadmap/` is copied over on start and read as a
  fallback, never written).
- Machine-level state only where the allowlist in `dev/storage-boundary.ts`
  says so (`~/Library/Application Support/Kehikot/` — `modules/` registry,
  `frame.sqlite`, `versions/`, `installed/` and `official-modules.json` — `~/.claude*`, `~/Library/LaunchAgents|Logs`, the old service
  marker, temp dirs), each with a one-line reason. A one-off exception needs
  `// kehikot-storage: allow <reason>` on the line.
- The machine directory is spelled once, in `server/machineDirs.ts`; use its
  helpers. The retired `~/.roadmap` is only ever READ (copied once at startup
  by `migrateMachineData`, and `~/.roadmap/modules` read as a registry fallback
  by `readRegistrations`) — never write to it. The protocol package (1.0.0)
  no longer reads `~/.roadmap` at all, so these two are the only things
  standing between an install that has not migrated and an empty app: keep
  them, and their tests in `test/machineDirs.test.ts`.
- Environment: `KEHIKOT_FRAME_DB`, `KEHIKOT_MODULES_DIR`, `KEHIKOT_VERSIONS_DIR`,
  `KEHIKOT_INSTALLS_DIR`, `KEHIKOT_OFFICIAL_CACHE`, `KEHIKOT_LOGS_DIR`, `KEHIKOT_ORIGIN`,
  `KEHIKOT_ORIGINS` (the list passed to modules the host starts),
  `KEHIKOT_SEED_PROJECT`. The HOST still reads the old `ROADMAP_FRAME_DB`,
  `ROADMAP_MODULES_DIR`, `ROADMAP_ORIGIN` and `KEHIKKO_ROADMAP_DIR` as
  fallbacks for its own settings; the protocol and the modules do not, so
  always set the `KEHIKOT_` name. Process plumbing between the desktop shell and this host
  (`KEHIKKO_RESTART_FILE`, and the shell's own `KEHIKKO_HOST_DIR`,
  `KEHIKKO_PORT`, `KEHIKKO_API_PORT`) keeps its `KEHIKKO_` name.
- Run `bun run check:storage` before finishing; it scans this host,
  the protocol and every registered module, and fails on violations.
- Tests never reach the real machine: `test/setup.ts` (preloaded through
  `bunfig.toml`) points every location above, and `CLAUDE_CONFIG`, at a scratch
  directory and fails a test that leaves one resolving under the real home. A
  test that moves one of those variables restores what it found — never
  `delete`. A new machine-level location goes in that file's `LOCATIONS`.

## The rename from "roadmap"

- The app was called "roadmap" before it was Kehikot. Module ids are
  `kehikot.<name>`; a `roadmap.<name>` id from a registration, a manifest, a
  database row, a `kehikot.json` or an MCP call is the SAME module — pass it
  through `canonicalModuleId` (protocol) wherever a module id comes in.
- That respelling is the HOST's job since protocol 1.0.0: the protocol's
  schemas carry an id as written, and the canvases database is respelled on
  open (`renameModuleIds` in `server/canvases.ts`, which writes the old
  `'roadmap.'` prefix out itself). `roadmap.<name>.json` in the registry
  registers `kehikot.<name>`.
- The old DIALECT is gone (protocol 1.0.0): a module built against the
  protocol before 0.25 (`roadmap.module` at `/.well-known/roadmap-module.json`,
  `roadmap.*` messages) is not asked for and not greeted. There is one
  spelling of the wire; `Conversation` posts a message as built.
- A manifest must say how the module relates to the parts of an epic
  (`reacts: ['parts']` or a `partless` sentence, not both); the protocol's
  schema refuses one that does not. `look` in `server/discover.ts` marks that
  presence `refused`, and the modules list says the protocol's sentence and
  "Update the module to use it." (`attention` in `src/host/moduleMenu.ts`).

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
