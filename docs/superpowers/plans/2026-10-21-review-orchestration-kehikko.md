# Review orchestration: kehikko host (C3)

> Task plan for this repository. Master plan: Jalez/kehikko-review
> `docs/superpowers/plans/2026-10-21-review-orchestration.md`, contract **C3**
> (fills **C2**, protocol 2.7.0). Implement test-first.

**Goal:** the tracker reading fills the 2.7.0 row fields — reviewers, author
and assignee logins, the person's roles, discussion counts, last push — for
GitHub and GitLab; `read_tracker` shows them; the machine directory gains
`keys/` for Review's Factory key (C4).

**Read-only.** Every call added is a read: GraphQL queries, `gh api user`,
`glab api user`. Tests use fake runners; the real APIs were checked by hand
with read-only queries (GitHub `cli/cli`, GitLab `gitlab-org/cli` anonymously).

## Decisions

- **GitHub**: the pull request query gains
  `reviewRequests(first: 32) { nodes { requestedReviewer { ... on User { login name } ... on Bot { login } ... on Mannequin { login } } } }`,
  `latestReviews(first: 32) { nodes { state author { login ... on User { name } } } }`,
  `reviewThreads(first: 100) { totalCount nodes { isResolved } }`, and
  `committedDate` on the last commit. Team reviewers are not asked for (that
  needs `read:org`); a team request is skipped. `pushedDate` is always null now,
  so `lastPushAt` is the last commit's `committedDate`. Discussions are given
  only when every thread was read (`nodes.length === totalCount`).
  - A login both requested and reviewed is `requested` (asked again).
  - Review states: `APPROVED` → approved, `CHANGES_REQUESTED` → changes,
    `COMMENTED`/`DISMISSED` → commented, `PENDING` skipped.
- **GitLab**: the by-iid merge request query gains
  `reviewers(first: 32) { nodes { username name mergeRequestInteraction { approved reviewState } } }`,
  `approvedBy(first: 32) { nodes { username name } }`,
  `resolvableDiscussionsCount resolvedDiscussionsCount`,
  `commits(first: 1) { nodes { committedDate } }` and `headPipeline { createdAt }`.
  `lastPushAt` is the later of the newest commit and the head pipeline's
  creation. An approver who is not a reviewer is listed as `approved`. Open
  merge requests from the REST listing get these through the GraphQL re-read
  already there; closed/merged ones from REST carry logins only.
  - `approved` → approved; `REQUESTED_CHANGES` → changes; `REVIEWED` → commented;
    anything else → requested.
  - An older GitLab without these fields refuses the query ("Field … doesn't
    exist on type …"): the batch is asked again without them, the refusal is
    remembered per host for `SCOPE_RECHECK_MS`, and the read says one sentence.
- **Me**: `Adapter.me?(host)` — `gh api user` (`--hostname` off github.com),
  `glab api --hostname <host> user` — cached in `Trackers` per tracker+host,
  12 h when known, `SCOPE_RECHECK_MS` when not. Unknown me → rows keep no
  `myRoles` (absent, never guessed), and the read says one sentence.
- **Roles** (`server/trackers/roles.ts`, pure): `rolesFor(row, me)` — author,
  assignee, reviewer-asked (`requested`), reviewer-done (any other state);
  logins compared case-insensitively; `withRoles(row, me)` sets `myRoles` (may
  be `[]`). Applied over the whole reading on every read.
- **One sentence**: `TrackerListing.peopleNote` (beside `boardsNote`), said in
  the panel and in `listingText`.
- **read_tracker**: each line adds `reviewers:login(state),…`, `my roles:…`,
  `threads:N unresolved, M resolved`, `pushed:<iso>` when present.
- **Machine directory**: `keysDir()` and `factoryDir()` in `server/machineDirs.ts`
  (`KEHIKOT_KEYS_DIR`, `KEHIKOT_FACTORY_DIR` override), both in `test/setup.ts`
  `LOCATIONS`; `ALLOW` in `dev/storage-boundary.ts` gains `keys`
  (`KEHIKOT_KEYS_DIR`, `review-factory.key`) and `factory-rules`
  (`KEHIKOT_FACTORY_DIR`, `author-rules.json`: Factory's per-author re-review
  rules, shared across projects); `CLAUDE.md` lists both and their variables.
- **GitLab complexity**, measured on gitlab.com with `queryComplexity`: one issue
  and one merge request score 96, 12 + 12 score 144, 25 + 25 score 201 —
  under the authenticated limit of 250; the existing halving covers a lower one.
- Protocol pinned to `#v2.7.0`.

## Files

- `package.json`, `bun.lock`: protocol `#v2.7.0`.
- `server/trackers/roles.ts` (new): `rolesFor`, `withRoles`, `sameLogin`.
- `server/trackers/common.ts`: `login(v)`, `logins(v)`; `Read.people?`; `Adapter.me?`; `Me` type.
- `server/trackers/github.ts`: `reviewersOf`, `discussionsOf`, `lastPushOf`; `PULL_GRAPH`; `issueRow`/`pullRow` logins; `me`.
- `server/trackers/gitlab.ts`: `reviewersOf`, `discussionsOf`, `lastPushOf`; `refsQuery(source, issues, merges, people = true)`; fallback; rows' logins; `me`; `OLD_GITLAB_PEOPLE`.
- `server/trackers/reading.ts`: `#me` cache, `#whoAmI`, roles over the reading, `peopleNotes`, `listing().peopleNote`.
- `src/host/trackerSources.ts`: `peopleNote`; `listingText` says it.
- `src/canvas/TrackerReading.tsx`: shows `peopleNote` like `boardsNote`.
- `server/mcp.ts`: `trackerLine(row)` exported, with the new fields.
- `server/machineDirs.ts`: `keysDir`. `test/setup.ts`: LOCATIONS. `dev/storage-boundary.ts`: ALLOW.
- Tests: `test/review-roles.test.ts` (new); `test/machineDirs.test.ts`; `test/storage-boundary.test.ts`.

## Tasks (each: failing test, then code, then green)

1. **Roles.** `rolesFor` for author / assignee / asked / done / none / case;
   `withRoles` with `[]`.
2. **GitHub rows.** A PR node with requests, reviews, threads, commit date →
   `reviewers`, `authorLogin`, `assigneeLogins`, `discussions`, `lastPushAt`;
   requested wins over a review; a team request skipped; partial threads → no
   discussions; an issue gets logins only. The query carries the new fields
   and no `Team`.
3. **GitLab rows.** A GraphQL MR node → the same fields; approver-not-reviewer
   listed; REST rows carry logins. The query carries the new fields with
   `first:`. An older GitLab's refusal → asked again without people, rows
   still read, `people.unreadable` said; remembered per host.
4. **Me and the reading.** `Trackers` asks `me` once per host (cached), rows
   carry `myRoles`; a failed `me` leaves `myRoles` absent and `peopleNote`
   says so; the reading still parses with `trackerReadingResult`.
5. **read_tracker** line shows the new fields.
6. **Machine directory.** `keysDir` default and override; setup LOCATIONS;
   scanner allows `KEHIKOT_KEYS_DIR` / `review-factory.key`.
7. Checks: `tsc --noEmit`, `bun test`, `bun run check:storage`, `bun run build:sidecar`.
8. PR "Tracker reading: reviewers, my roles, discussions, last push".
