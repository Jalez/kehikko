# Kehikko host — notes for agents

## Where data lives

- Project data goes **only** under `<project>/.kehikot/<module>/`, built with the
  protocol helpers (`KEHIKOT_DIR`, `kehikotDir`, `moduleDir`, `moduleFile` from
  `roadmap-module-protocol`). Never `join(ROOT|HERE|import.meta.dir|process.cwd()|__dirname, 'data', …)`,
  never `homedir()` for storage. The roadmap's epics/state are
  `<project>/.kehikot/roadmap/{epics,state}/` (spelled once in `server/roadmapData.ts`).
- Machine-level state only where the allowlist in `dev/storage-boundary.ts`
  says so (module registry `~/.roadmap/modules`, `~/.roadmap/frame.sqlite`,
  `~/.claude*`, `~/Library/LaunchAgents|Logs`, the roadmap service marker, temp
  dirs), each with a one-line reason. A one-off exception needs
  `// kehikot-storage: allow <reason>` on the line.
- Run `bun run check:storage` before finishing; it scans this host, the roadmap,
  the protocol and every registered module, and fails on violations.
