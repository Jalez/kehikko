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
  `frame.sqlite`, `versions/` and `installed/` — `~/.claude*`, `~/Library/LaunchAgents|Logs`, the old service
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
  `KEHIKOT_INSTALLS_DIR`, `KEHIKOT_LOGS_DIR`, `KEHIKOT_ORIGIN`,
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

- `modules.json` is the list of modules this host vouches for, versioned with
  it (`server/official.ts`). Adding a module to the app's list is adding an
  entry there: id, name, `owner/repo`, first port, summary, tags.
- Installing one (`server/installs.ts`) clones it under the machine
  directory's `installed/<id>/`, runs `bun install --frozen-lockfile` and writes
  its registration. The repository and paths come from the list, never from a
  request. After that it is an ordinary registered module.
- A registered module not on the list can be proposed for it
  (`server/proposals.ts`), which files an issue here through the person's `gh`.
