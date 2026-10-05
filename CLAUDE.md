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
  says so (`~/Library/Application Support/Kehikot/` — `modules/` registry and
  `frame.sqlite` — `~/.claude*`, `~/Library/LaunchAgents|Logs`, the old service
  marker, temp dirs), each with a one-line reason. A one-off exception needs
  `// kehikot-storage: allow <reason>` on the line.
- The machine directory is spelled once, in `server/machineDirs.ts`; use its
  helpers. The retired `~/.roadmap` is only ever READ (copied once at startup,
  and `~/.roadmap/modules` read as a registry fallback) — never write to it.
- Environment: `KEHIKOT_FRAME_DB`, `KEHIKOT_MODULES_DIR`, `KEHIKOT_ORIGIN`,
  `KEHIKOT_ORIGINS` (the list passed to modules the host starts),
  `KEHIKOT_SEED_PROJECT` (old `ROADMAP_*` / `KEHIKKO_ROADMAP_DIR` names are
  read as fallbacks). Process plumbing between the desktop shell and this host
  (`KEHIKKO_RESTART_FILE`, and the shell's own `KEHIKKO_HOST_DIR`,
  `KEHIKKO_PORT`, `KEHIKKO_API_PORT`) keeps its `KEHIKKO_` name.
- Run `bun run check:storage` before finishing; it scans this host,
  the protocol and every registered module, and fails on violations.

## The rename from "roadmap"

- The app was called "roadmap" before it was Kehikot. Module ids are
  `kehikot.<name>`; a `roadmap.<name>` id from a registration, a manifest, a
  database row, a `kehikot.json` or an MCP call is the SAME module — pass it
  through `canonicalModuleId` (protocol) wherever a module id comes in.
- Modules built against the protocol before 0.25 speak the old dialect
  (`roadmap.module` at `/.well-known/roadmap-module.json`, `roadmap.*`
  messages). The host finds them at the old path, and `Conversation` posts to
  them through `toDialect` (`FramedModule.dialect`). Never compare a raw
  message type or module id against one spelling.
