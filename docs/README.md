# Kehikot — the host, in depth

The technical guide to this repository: how the host works, how to run it from
source, and how to write a module. The product overview is the
[README](../README.md).

> **Download the app:** [Kehikot for macOS](https://github.com/Jalez/kehikko-desktop/releases/latest)
> (Apple Silicon and Intel; signed, notarized and self-updating). This repository
> is the host it bundles. Each release's host is tagged here as `app-v<version>`.

**A local-first workbench where you and your coding agent look at the same
project through the same containers.**

You arrange small independent programs — a paper reader, a checklist, a diff, a
real terminal — on a canvas. Each one shows you something. Each one also serves
an MCP server, so the agent in your terminal can use it. Putting a module on the
canvas tells both of you what this work is about.

Each program sits in a **container**: a box with a thin header (its name, the
program's own View, Go and Run menus when it has any, and the controls to fold
or remove it) and the program's own page filling the rest. A canvas is an arrangement of containers, and you can have several
canvases per project — one for writing, one for reviewing, one for code.

Everything runs on your own machine. Nothing is hosted, nothing phones home, and
your data lives in your project as plain JSON.

> *Kehikko* is Finnish for a frame. *Kehikot* are the frames — the app is named
> after the arrangement, not the things inside it, because the things inside it
> are somebody else's programs.

---

## Why you might want this

Working with a coding agent, the same problem keeps recurring: **you and the
agent are looking at different things.** You have a paper open and it does not
know; it has a checklist and you cannot see it; you both have opinions about
which issue matters and no shared surface for either.

Kehikot is that surface. A module here is not a UI panel with an API bolted on —
it answers to a person and to an agent equally:

- Its **page** is what you see, framed on the canvas.
- Its **MCP server** is what the agent calls.
- Its **`guidance`** is what its presence obliges, composed into the prompt the
  agent is handed and attributed to the module that said it:

  > Every change on this kehikko is held to a checklist, and the work is not
  > finished when the code is finished — it is finished when the items are
  > ticked. — `kehikot.checklist`

So a canvas is a statement of scope, not decoration.

**This is probably for you if** you work with Claude Code or a similar agent on
a long project, you already keep notes and checklists somewhere, and you want
them where the agent can reach them without you pasting.

**It is probably not for you if** you want a hosted product, a team tool with
accounts, or something that works without your reading a little of how it fits
together. This is a workbench, and it assumes you are willing to open the
drawers.

## Status

Working and used daily by its author; not packaged for strangers yet. Eighteen
modules, each its own repository. Expect to run a few dev servers and to edit a
path or two. The protocol between host and module is stable enough that modules
built weeks apart still interoperate; the setup story is the rough part.

## Getting started

```bash
git clone https://github.com/Jalez/kehikko
cd kehikko && bun install
./run.sh                       # API on 4180, page on 4181
```

Open <http://127.0.0.1:4181>. You will have an empty workbench: a host with no
modules. Each module is a separate repository you clone, install and register:

```bash
git clone https://github.com/Jalez/kehikko-checklist
cd kehikko-checklist && bun install
bun run register               # writes the module's registration file (see below)
./run.sh                       # serves on its own port
```

Reload the host and it is there. The host sweeps that registry directory —
nothing has a module list compiled into it.

**Where this machine's state lives.** The module registry and the canvases
cache live in `~/Library/Application Support/Kehikot/` (`modules/`,
`frame.sqlite`; `$XDG_DATA_HOME/kehikot` off macOS), spelled once in
`server/machineDirs.ts`. `KEHIKOT_MODULES_DIR` and `KEHIKOT_FRAME_DB` point
either somewhere else.

Then **add a project**: the button at the end of the project list opens a folder
browser. Point it at a repository you work in.

## The model

```
project  (a repository or worktree — a folder on disk)
  ├── epics    (<project>/.kehikot/host/epics, when it has any)
  └── kehikot  (many; one per purpose)
```

A **project** is the container. A **kehikko** is one named canvas inside it:
which containers, arranged where — a layout, and nothing more. An **epic** is
what the project is currently about, picked once per project; every kehikko in
it shows the same one. Switching kehikko never changes the epic, and switching
epic never changes the kehikko. The parts of the epic a person has focused on are
the project's too, for the same reason. Not every project has epics, and one that does
not says so rather than showing an empty picker.

Modules keep their data in `<project>/.kehikot/<module>/` as plain JSON — beside
the work it describes rather than inside somebody's app, so it is readable,
greppable and hand-editable. That folder is gitignored by default, because it is
one person's working material and not the project's. Remove the line to share
it.

## Where data lives

**A project's data goes only under `<project>/.kehikot/<module>/`**, and the
path is built with the protocol's helpers — `KEHIKOT_DIR`, `kehikotDir`,
`moduleDir`, `moduleFile` from `kehikot-module-protocol` — never spelled by hand
and never anchored at a program's own folder (`import.meta.dir`, `__dirname`,
`process.cwd()`, a repo `ROOT`) or the home directory. The host's own data is
`.kehikot/host/epics/` and `.kehikot/host/state/`, beside
`.kehikot/host/kehikot.json`; papers are `.kehikot/paper/<epic>/`. One file
of a module's is READ by the host and never written: `.kehikot/journeys/journeys.json`,
for an epic's steps, through the protocol's own reader — see the section on
whose the steps are, below. The host
brings an older layout there when it starts, adopts or adds a project
(`server/hostData.ts`): a legacy `<project>/data/epics` or `data/state` is moved.
It never overwrites, and leaves both and logs both paths if both exist.

**Machine-level state** — state that belongs to this computer rather than to a
project — is allowed only where `dev/storage-boundary.ts` lists it, each with a
reason: the module registry and canvases cache under
`~/Library/Application Support/Kehikot/`, Claude's own `~/.claude*` config,
`~/Library/Logs/Kehikot`, and temp dirs. Anything else needs a
`// kehikot-storage: allow <reason>` comment on the line, and a reviewer who
agrees.

**Check it:** `bun run check:storage` scans this host, the protocol
and every registered module, and fails on any code that
stores data outside `.kehikot/`. `bun test` runs the same scan
(`test/storage-boundary.test.ts`), and `run.sh` prints the violations loudly at
startup without refusing to start.

## An epic's steps are the Journeys module's, and the host reads them there

Every epic used to exist twice in a project: the host's file,
`.kehikot/host/epics/<slug>.json`, and the Journeys module's record in
`.kehikot/journeys/journeys.json`, which is where a step is actually edited.
Nothing kept the two in step. The host has not written steps to its own file
since it stopped being the place they are edited, so that file is a snapshot —
and in one real project it was three steps behind, nine against twelve, with
every answer correct about the copy it happened to read.

The owner decided who owns what:

| | |
|---|---|
| **Journeys** | the steps and the prose around them |
| **The host** | the epic's slug, its title, whether it exists, and its list of **parts** |

So `epicOf` in `server/holdings.ts` — the one reader, which
`test/one-reader.test.ts` holds to being one — prefers the project's journey
record for a slug, and everything the host says about an epic's steps moved
with that one function: `epic.get`, `steps.list`, the size and parts on a row
of `epics.list`, `context.parts`, and the tracker's scope.

- **With a record**, the answer is the record, whole, under the host's own slug
  and title. Whole and not merged: a field somebody deleted from the journey
  must not go on being answered out of a stale file.
- **With no record** — Journeys never installed, no journey begun for this
  epic, a file or a record that will not read — the answer is the host's own
  file, exactly as before.
- **Existence is the host's.** A record for a slug with no epic file is a
  journey nothing points at, and is not an epic. Deleting an epic removes the
  host's file and nothing of the module's.
- **The title is the host's.** A retitle writes the host's file and shows at
  once; the journey's own `title` is not what the host answers with.

The host does not parse a module's private format to do this. The shape of the
record is the protocol's (`journey.ts`), and so are `readJourneys` and
`journeyIn`, which open the file and take one record out of it; nothing in this
host spells that path.

**`steps.list` for an epic whose steps are kept elsewhere.** Some epics are
written as a paper, and their steps are the paper's sections: the record carries
`"steps": []` and a `stepsFrom`, and that array does not mean there are none.
The host never answers "no steps" for one:

```ts
{ steps: [...] }   // stored
{ steps: [] }      // nobody has written any
{ stepsFrom: { projector, where, why } }   // kept elsewhere: NO `steps` key at all
```

A module that reads `steps` finds no list to count rather than an empty one,
and a module that looks for `stepsFrom` can say where the steps are. For the
same reason the row in `epics.list` carries `stepsFrom` and **no `size`** for
such an epic — a count of what is here would be a count with the steps left out.

**A change to the journeys is announced as a change to the steps.** When
Journeys reports a write, or `.kehikot/journeys/` changes on disk, `context.content`
gains an entry for `kehikot.journeys` **and** one for `host`, in one telling, so
a module that listens only for the host's epics re-asks `steps.list` too
(`server/content.ts`).

Still open: the tracker's scope for an epic is the refs in `refs` arrays and in
`ref` / `umbrella` fields, as it always was. Journeys keeps more — `watch`,
`containers`, what blocks what, what settles what — and whether a host should
read the trackers for those as well has not been decided, so it does not.

## An epic has parts, and the project can be pointed at some of them

A large epic is divided into **parts**: one level deep, an id, a name and a
place in an order. **A part belongs to the epic and to no module**, and nothing
in this host names a module for the purpose of parts.

**The list is in the epic's own file**, and the host is its only writer:

```json
"parts": [
  { "id": "the-posting-seam", "name": "The posting seam" },
  { "id": "agents", "name": "The agent seam" }
]
```

A part's id is made once, when it is added, from the name it had then
(`partIdFor`, the protocol's), and no edit changes it: a rename changes the
name, a move the order. The id is what a step's `part`, the project's stored
focus and a module's own data hold on to.

**An epic whose file has no `parts` key yet is read as before** — its record's
`groups`, one part each, with the id written on the group or its heading as a
slug — so a project nobody has edited the parts of behaves exactly as it did.
The first edit **adopts** that list: it is written into the epic's file with
every id and name as it was read, plus the one change, and from then on only
the file is read for the list (`listedIn`, `partsHeld`, `editParts`).

**What a part holds is the modules'.** Each module keeps what it has for a part
in its own data and publishes it as `.kehikot/<module>/parts.json`; the host
reads that file from every folder under `.kehikot/` (`readHoldings`, which names
no module) and unions them: `refs`, and `documents` — project-relative paths,
whichever module keeps them. `files` is still filled for a module built before
`documents`: the documents that have a paper-relative name. What the record
says for a part — a group's `files`, and the refs of the steps filed under the
part's id — is a fallback, decided per kind and per epic: the record's
documents are read only while no module has published a document for any part
of the epic, and its refs only while none has published a ref. Once somebody
publishes a kind for the epic, what was published is the whole of it, also for
a part the publisher left out — so a chapter moved to another part is no
longer in the old one. The epics
are read again on any change to the project's material, so a module publishing
a chapter for a part is seen at once.

**The control in the bar is where parts are picked and where they are made.**
It stands directly after the epic, for every open epic. It is a list of
checkboxes, where nothing ticked means the whole epic; ticking some points
every module at those parts, and the control is filled and names what it is
narrowed to for as long as it is, with a clear button beside it. The list ends
in **+ part**, which turns into a name box; a row under the pointer or the
keyboard's focus shows, in the room its count otherwise takes, rename, move up,
move down and remove (which asks once). F2 renames, Alt+↑/↓ move, Delete
removes. An epic with no parts draws the same control, saying "no parts", and
opens straight onto the name box.

Every edit — the picker's (`POST /host/parts`), a module's **`parts.set`**
(answered by the server; declined for a module whose manifest does not ask for
`parts:set`, and for an epic that is not one of the open project's) and an
agent's **`set_parts`** at the host's door — goes through one writer,
`editParts` in `server/holdings.ts`, which changes that one field of the file
and leaves every other byte where it was.

A module built with a protocol before 1.2.0 cannot read more than 32 parts and
would drop the whole context for a longer epic, so each module is sent
`partsFor(parts, manifest.build.protocol)`: every picked part, and the rest in
order, up to what it can take (`readableBy` in `src/host/context.ts`).

The focus is the **project's**, held beside its epic and its selection
(`projects.parts`, and a top-level `"parts"` in `kehikot.json`, written only
when some are picked). It is never a kehikko's: switching layout changes
neither the epic nor what is picked out of it. Switching epic clears it.

Modules are told through `context.parts` — every part of the open epic, with
its refs, its documents and whether it is picked. Keys are absent when empty,
so a part nobody holds anything for is the same four fields it always was. See
`src/host/parts.ts`, and `docs/parts.md` in the protocol.

## All epics at once

The epic picker has **All epics** at the top. Choosing it puts the project on
every epic at once: modules are told `context.scope: 'project'` with `epic`
null and no parts (protocol 2.9.0), which is **not** "no epic". The parts
picker is not drawn — parts divide one epic. The choice is held where the epic
is, per project (`projects.scope`, and a top-level `"scope": "project"` in
`kehikot.json`, written only while it is chosen); picking an epic, or "no
epic", leaves it.

A module says it can show a whole project with `declares.scopes: ['epic',
'project']`, and then shows every epic, each item labelled with its epic. A
module that does not is still sent the context, and the host covers its
container with one sentence — "This module works on one epic at a time. Pick an
epic to use it." — while its page stays mounted and hidden underneath, as a
folded container's does, so its state is there when an epic is picked again. A
pinned container is not covered: it is still on the epic it was pinned on.
`read_canvas` and `my_place` say the scope. See `src/host/scope.ts`.

## An epic can be retitled here, and cannot be re-slugged

"Rename this epic" names two operations, and the picker offers one of them. The
pencil that appears on a row in the epic menu changes the epic's **title** —
what it is called — in `.kehikot/host/epics/<slug>.json`, and the form says while you are
typing that the slug is staying where it is.

The **slug** is the identity, and everything that has ever pointed at an epic
points at it by that string: the `epic` column on a project, the
`kehikot.context.epic` every framed module is told, `.kehikot/host/state/<slug>.json`
written by a tracker refresh, a record keyed by slug in
`.kehikot/journeys/journeys.json`, a file per epic under `.kehikot/checklist/`,
and a whole directory under `.kehikot/paper/`. Renaming the epic's own file and
stopping there would file a project's papers, journeys, checklists and questions
under a name nothing asks for again — silently, because each of those readers
answers "nothing here" for an unknown slug rather than failing. That is a
migration across six programs, four of which this host does not own, and it does
not go behind a pencil in a dropdown. So the control does not say "rename".

It is the only write this host makes into a project's `.kehikot/host/`, and it changes
one field: the file is read, one span of text is replaced, and every other byte
is written back exactly as it was. These are documents somebody wrote by hand,
under their own name in that repository's history, and a host that reformatted
one while changing a label would put a hundred-line diff in front of a person
who changed six characters. `retitleEpic` in `server/holdings.ts` has the
argument, and `withTitle` beside it has the reason a regular expression will not
do — `"title"` is also the key on every step in these files.

## One inbox, and the Notifications module is a consumer of it

A module says what it needs, is doing, or has finished with `activity.set`, and
the host keeps ONE record of it: the Inbox (`src/host/inbox.ts`, kept by
`server/inbox.ts` in the host's machine database, per project, not in the
project). An item has a life: it opens when first reported, records each state
it enters with the time, and closes when the module drops it or stops answering
(a closed item stays in the log, "Earlier", bounded to 2000 entries). A legacy
`kehikot.notifications@1` line from `events.emit` is kept as an item born closed,
attributed to the sender. The Notifications module's own file in a project is
imported once, never changed.

What a person sees: one control in the bar (a dot and the count of what needs
them) and a panel on demand — **Next**, **Needs you** (urgent first, then the
longest waiting), **Working**, **Finished**, **Earlier** (collapsed, paged) —
each row saying who said it before the claim, and where, in words. A scope
(**This kehikko** / **Everywhere**) is remembered per project; where the host
cannot tell the kehikko it says so and shows everything. Seen is for `done` only
(arriving at its place, or pressing it); dismiss hides an open item until its
state changes; forget removes a closed one from the log.

**Next that needs me** is `Alt+Shift+N` (and the first row of the panel): it goes
to the most pressing item and, pressed again, to the next, across kehikot,
epics and parts, using the item's `place`. The shortcut is read by the host's
own document; with focus inside a module's frame, use the bar control.

The entry that enters `attention` or `done` is also delivered as one
`kehikot.notifications@1` line to whatever consumes it (a Notifications module
on a canvas), as if the module had sent it — no line for `working`, none for an
item whose place is open on screen, and each `(module, id, state, since)` once:
the record, not the browser, remembers what was told. The page's old storage
(`kehikot.activity.seen.<project>`, `kehikot.activity.derived.<project>`) is
handed to the server once and removed. For an agent, `read_canvas` lists the
open items and a bounded Earlier, and `read_inbox` answers the same in words;
no tool sees, dismisses or forgets — those are the person's.

## The filter a module offers and the host draws

Modules kept building the same control. Five of them had a toggle inside their
own page — `hide resolved`, `show 3 ignored`, `hide preamble comments`, `all /
this kehikko / no kehikko` — each spelled its own way, each taking a row of
chrome in a column that is often 220 pixels wide and under 300 tall. None of
them could put it anywhere else, because the strip around a module belongs to
the host.

So a module can hand over the values instead. It sends `kehikot.filters` with
the axes it can be narrowed along, and the host draws one button in the
container header; a press comes back in `context.filters`.

- **Absent by default.** A module that offers nothing gets no control, no empty
  menu and no reserved pixels. That is most modules, and their headers are
  unchanged.
- **It is called "filter what *Notifications* shows"**, and the first word is
  load-bearing. It used to be called "what Notifications shows" — true, and
  unfindable: the person who owns this host was told there was a filter, went
  looking for one among seven unlabelled icons, and reported it missing. It was
  in front of them. The module's name stays in the string because that is what
  distinguishes six otherwise identical icon buttons from each other.
- **It is drawn at full weight whenever it exists**, unlike the pin and the fold
  beside it, which are dim when off. Those are on every container in one of two
  states, so weight is how you read the state; this one is on almost no
  containers, so its presence *is* the message — "this can be narrowed" — and a
  fifth grey icon in a row of grey icons does not deliver it. Whether anything
  is actually narrowed is said with fill instead: a hollow funnel when the
  module is showing everything, a solid one when it is not. That costs no
  pixels, which is the constraint — the header is tight at 220px.
- **The host does not know what a filter means.** An option is an id and a short
  label the module wrote. There is nowhere in this host where `resolved` differs
  from `ignored`, and there must not be.
- **The choice is remembered per container**, in this host's database, beside
  `collapsed` and `pinned` — so it survives quitting the app, restarting the
  host, and the module being stopped and started again hours later. Per
  container rather than per module, because two containers of the same module on
  two kehikot are two things you are looking at in two different ways.
- **A remembered choice cannot become a lie.** It is reconciled against what the
  module is offering right now, every time. A value naming an option a newer
  version of the module no longer has degrades to that module's own default
  instead of narrowing by something nobody can see or clear.
- **Three kinds of group.** A `choice` group is ticks, one of them on; a `text`
  group is one input; a `toggles` group is independent checkboxes — "hide
  closed changes" without also hiding closed issues — whose value is the list
  of ids switched on, with a host-worded *Clear* under it. Nothing switched on is
  the resting state and is stored as nothing; anything switched on fills the
  funnel.
- **No module string is laid out in the header.** The button is an icon. Every
  label the module wrote is inside the menu, truncated, with the whole of it in
  a `title` — a `whitespace-nowrap` element carrying a variable string once gave
  a 220-pixel container an 1187-pixel min-content floor here, and `Tools.tsx`
  has the long version.

The icon is the always-visible signal: foreground weight when something is
narrowed, muted when nothing is. It says THAT a module is showing less than
everything, not how much less — the host sees rows it does not render, in a
document it cannot read, in a frame on another origin. A module that wants the
exact number always visible should go on drawing that number in its own page.

It is not a permission and not a declaration. `declares.uses` and `reacts` are
manifest fields, read before a program runs, by somebody deciding whether to run
it. This is a running module saying what it is showing, nothing is checked
against it, and nothing is gated on it.

## The menus a module declares and the host draws

The filter was one control. Modules went on drawing the rest themselves: Source
/ PDF tabs, a Sections select, Compile, Commit, Present — a toolbar per module,
each laid out its own way, each taking a row out of a container that is often
380 pixels wide.

A module can hand those over too (protocol 1.1.0, `docs/header.md` there). It
sends `kehikot.header` with its items — the whole list, every time — and the
host draws them in the container's header as dropdown menus
(`src/canvas/HeaderMenus.tsx`, on the full shadcn `dropdown-menu`):

| kind | is | drawn as | menu |
|---|---|---|---|
| `switch` | one of several views | a radio group | **View** |
| `toggle` | on or off | a checkbox item | **View** |
| `go` | a jump to one of several places | plain items | **Go** |
| `run` | an act | an item with its `state`, `result`, `shortcut` and, when `disabled`, the reason under it | **Run** |

The kind decides the menu, so every container reads the same. A menu with
nothing in it is not drawn, and a module that declares nothing has the header
it always had. After them comes **Frame**, the host's own menu, on every
container: the module's tools (the plug), feedback to its authors, and prompts.
The checkbox, the dot and the name stay direct on the left, and fold and remove
on the right. The filter, clear and refresh buttons are unchanged.

- **The module owns all the state.** The host draws what was last declared and
  remembers nothing. Choosing an item sends `kehikot.press` with a correlation
  id; the module answers `kehikot.pressed` and declares its header again, and
  the menu that is open shows the new state. A toggle and a switch leave the
  menu open; a jump and a run close it.
- **A press is judged first.** The host asks the protocol's `pressRefusal` of
  the header as it stands at the press and sends nothing it refuses. It waits
  three seconds for `pressed` (the module's own client answers within two). A
  press that was not taken says why in the trigger's tooltip for a few seconds,
  and under the row while the menu is open — no row under the header, no toast.
- **`confirm` is the host's arm.** The first press changes what the row says
  and sends nothing; the second sends. It comes down after four seconds, when
  the menu closes, and when the item is declared differently.
- **The header does not grow a row.** Triggers are words; under 300 pixels they
  are icons; under 220 the three become one "⋯" with View, Go and Run as
  sections. Folded, the module's menus are not drawn. Labels are one line, cut
  with an ellipsis, whole in a `title`. A list of more than six options opens
  beside the menu unless its item is alone there.
- **A module's words are text.** Labels, groups, results and reasons are
  rendered as text and never as markup or a link. `icon` is a name looked up in
  a fixed table (`HEADER_ICONS`); a name that is not in it draws no icon. The
  names are lucide's: `book-open`, `bot`, `check`, `circle-stop`, `code`,
  `columns-2`, `compass`, `copy`, `download`, `external-link`, `eye`, `file`,
  `file-down`, `file-text`, `folder`, `git-commit-horizontal`, `history`,
  `image`, `layout-list`, `link`, `list`, `list-tree`, `maximize`, `monitor`,
  `monitor-play`, `panel-left`, `pencil`, `play`, `presentation`, `printer`,
  `refresh-cw`, `rows-3`, `save`, `scroll-text`, `search`, `settings`,
  `square`, `terminal`, `trash-2`, `upload`, `wrap-text`, `zap`. A run and a
  go or switch label draw one; a toggle's tick stands where its icon would.

An agent reads and presses these through the host's door — below.

## A module can ask you which project, and can never ask what projects exist

Every module here keeps its data inside the project it is about, in
`.kehikot/<module>/`. So the first thing anybody wants once they have two
projects is to move something between them — a checklist, a set of notes — and
a module cannot do it on its own: it is told one `projectPath` and may read what
this host named.

The method that would have made it easy is `projects.list`, and it is the one
that must not exist. A module holding it has been handed a listing of your disk.

So `projects.pick` is the browser's file-picker shape instead. The module asks;
this host draws a dialog out of its own projects, titled with the module's name
from the registration rather than from anything the frame said; you press a row
or you close it. What crosses back is one path, because you chose it. The module
cannot name a project, cannot filter the list, cannot write a word of what is on
that screen, and — this is the part worth stating — **cannot tell "you have no
projects" from "I would rather not"**, because both come back as `declined`. A
fourth outcome saying the shelf is empty is an enumeration with a count of zero.

One ask at a time; a second is declined rather than queued. Escape, the overlay,
the X and Cancel are all an answer, so nothing is left waiting on a dialog that
is gone. It is answered by the canvas rather than the server, for the reason
`events.emit` is: answering it requires something only this half has, and here
that thing is a person.

### A module's server can ask whether a folder is a project — one folder, yes or no

A module's server is not on the canvas. It is told a path by its own page, which
read `projectPath` off the context, and by agents; from where it stands both are
strings in a request, and a page holding its ticket could name any folder on the
disk. So it may ask this host:

```
GET <host>/host/is-project?path=<absolute folder>   →   { "ok": true, "project": true | false }
```

`<host>` is the first origin in `KEHIKOT_ORIGINS`, which this host passes to
every module it starts. Yes means the folder is one a person added here, by any
spelling of it (links and `..` are resolved). No is one word for everything
else — not a project, inside one, not there, not absolute — so the answer says
nothing about the disk. It is not the list, for the reason above. It is
answered to programs on this machine and to this host's page; a module's page
cannot ask it, and has no need to. A module started by hand has no host to ask
and keeps whatever rule it had.

## A project's base branch

A project has a base branch: the branch agents start their work from and
updates are pulled from — `development` for one project, `main` for most. It is
set under Settings › Project, kept in `<project>/.kehikot/host/settings.json`
(`{ "version": 1, "baseBranch": "development" }`), which travels with the
repository, and checked against origin before it is taken (`git ls-remote`
with the person's own credentials; origin's last fetch when origin cannot be
reached). Nothing set is origin's own default branch, `origin/HEAD`, read from
the project's git and never written down. `server/baseBranch.ts` is the one
reader and writer.

Modules are told it three ways:

- **The context.** `kehikot.context` carries `baseBranch` — the one in force —
  while the host can say one, and leaves it out otherwise. The protocol's
  `contextSchema` does not name it yet, so a module that parses the context
  with that schema does not see it until it does.
- **A module's server**, which has the `projectPath` its page was told:

  ```
  GET <host>/host/base-branch?path=<absolute folder>   →   { "ok": true, "set": "development" | null, "origin": "main" | null, "branch": "development" | null }
  ```

  Answered only for a folder that is a project here, as `/host/is-project` is;
  a 404 otherwise. Setting it (`POST`) is the page's alone.
- **An agent**: `my_place` says the base branch of the conversation's project.

## Picking a module out, and the host's own door for an agent

Every container header has a checkbox. Ticking it picks that container out as a
target on this kehikko — the container grows a ring, so which ones are picked is
legible from across a canvas of eight. It is a fact about the arrangement and
nothing else: no program is told, started, stopped or asked anything, and the
selection is stored with the layout, so it is still there tomorrow.

The host answers MCP on its own API port, at `http://127.0.0.1:4180/mcp`, with
these tools:

| tool | what it does |
|---|---|
| `read_canvas` | what is arranged on a kehikko: the containers, which are picked out, the project folder and the epic, which registered modules are not on it — and, under each container, the header items its module declared: id, kind, label, menu, state, and whether an agent may press it |
| `select_modules` | pick containers out, replacing what was picked before |
| `place_modules` | put modules on a kehikko as new containers, where the `+` would put them; nothing already there moves |
| `create_epic` | make a new epic in the project a kehikko stands in — one file, `.kehikot/host/epics/<slug>.json` — without opening it |
| `mark_disposition` | say why a closed ref closed — `done`, `wont-do`, `duplicate`, `superseded`, or `null` to take it back — in the project's `.kehikot/host/dispositions.json`, signed `agent (MCP)` |
| `read_tracker` | the project's shared tracker reading |
| `module_versions`, `pin_version` | a module's tagged versions, and which one a container runs |
| `fold_modules` | fold containers to their headers or unfold them, on a kehikko a page has open; marked on the container as an agent's doing |
| `press_item` | press one item of a module's header — `{ module, item, value? }` — through the page that has the kehikko open |

All of them take an optional `kehikko` id and, without one, act on the kehikko a
page of this host says it has open — refusing, with the list, when no page has
said or when two browser windows have two different ones open.

The door can ADD and cannot take away: no tool removes, moves or resizes a
container, switches the kehikko, or changes which epic is open. The arrangement
belongs to the person looking at it, and what an agent may add is what they
can see arrive and take off with one press — a container, or an epic in the
dropdown. `place_modules` refuses rather than squeeze a container somebody
arranged, and refuses a module this computer has no registration for.
`server/mcp.ts` has the argument, including the half of the original "cannot
add" rule that did not survive and why.

`press_item` is the one tool that reaches into a module, and it is narrow. It
presses only an item the module marked `agents: true`. A run with `confirm` is
always the person's. An item that names a `tool` is refused by naming that tool
and the module's own MCP door, so there is one way for a program to do each
thing. It is refused when no page has the kehikko open, because the press is
made by that page: the server hands it one `kehikot.press` to post, down the
`/host/watch` stream of that page alone, and waits for the page to say what
the module answered. Every refusal names what exists. The page tells the server
what its modules declared (`POST /host/headers`) and what came of a press
(`POST /host/pressed`); both answer only this host's own page — JSON, with an
`Origin` that is the page's — and the page judges an agent's press again against
what the frame itself declared, so nothing that talked the server into something
gets an item pressed. `value` is the option's id for a switch or a go item,
`true` or `false` for a toggle, and absent for a run. The answer is whether the
module took the press, not whether a run has finished; the container says
"an agent pressed Compile" for a few seconds. The arrangement is never changed
by it. `server/headers.ts` and `server/mcp.ts` have the argument.

A tool call is visible immediately on the page, without a refresh — the server
says a kehikko changed, or a project's epics did, over `/host/watch` and the
page re-reads.

Tell your agent about it from the strip: the plug at the right-hand end. A
module's own door is under **Tools…** in its container's Frame menu, whose
trigger carries a dot while no agent has been told about it. It opens a
window listing the two tools, says whether an agent has been told, and connects,
disconnects or repoints on a press — never on its own. That press runs, and the
window shows before running it:

```
claude mcp add --scope user --transport http kehikko http://127.0.0.1:4180/mcp
```

The name is `kehikko` whatever port the host is on; the address is what moves.
A host that came up on another port because 4180 was taken reads an entry
written against 4180 as stale, exactly as a module that moved port would, and
offers to repoint it. Claude Code reads its MCP configuration when a session
starts, so any of this applies to the next session and not to one already open.

## The modules

| | | |
|---|---|---|
| [references](https://github.com/Jalez/kehikko-references) | issues and changes, read from the project's own GitHub | 7820 |
| [journeys](https://github.com/Jalez/kehikko-journeys) | hand-written narrative beside the live state of the work | 7840 |
| [orchestrator](https://github.com/Jalez/kehikko-orchestrator) | starts agent sessions on what is selected | 7850 |
| [checklist](https://github.com/Jalez/kehikko-checklist) | what a change or a paper is held to | 7860 |
| [paper](https://github.com/Jalez/kehikko-paper) | the epic's paper, as A4 pages rather than markup | 7870 |
| [diff](https://github.com/Jalez/kehikko-diff) | the diff of whichever change is selected | 7890 |
| [tests](https://github.com/Jalez/kehikko-tests) | what was actually run against the change you are looking at | 7900 |
| [notifications](https://github.com/Jalez/kehikko-notifications) | what happened, and on which kehikko | 7910 |
| [terminal](https://github.com/Jalez/kehikko-terminal) | a real shell, in a container | 7920 |
| [citations](https://github.com/Jalez/kehikko-citations) | what the paper cites, and what it cites that does not exist | 7930 |
| [notes](https://github.com/Jalez/kehikko-notes) | notes anchored to a passage, including the author's own | 7940 |
| [learning](https://github.com/Jalez/kehikko-learning) | questions about what you are reading | 7950 |

## Writing your own module

A module is any program that serves three things:

1. `/.well-known/kehikot-module.json` — a manifest describing itself, which
   must say how the module relates to the parts of an epic (`reacts: ['parts']`
   or a `partless` sentence); a manifest that says neither is refused, and the
   modules list says what to add
2. a page the host frames
3. optionally, an MCP server

The contract is [`kehikot-module-protocol`](https://github.com/Jalez/kehikko-protocol):
eight messages over `postMessage`, plus one for events. The host runs its own
copy of every schema rather than trusting a module's, and the package's shapes
are a convenience for module authors, never the check.

Nothing in the protocol lets one module name another. Modules interact through
**state the host composes** — the selection, the passage being pointed at, the
subject — so no module has to know its neighbours exist. The one exception is
the event bus, where a module declares a format it emits or consumes and the
host carries the payload, stamping the sender itself so nothing can post under
another module's name.

## Why iframes and separate servers

Because the modules are genuinely independent programs. Terminal needs
`node-pty`, a native binary; Paper carries a source-mapped LaTeX parser;
References shells out to `gh`. One bundle would mean one dependency graph, one
React version, and a native crash in the terminal taking down your thesis
reader.

The sandbox is real too. A module without `declares.storage` runs on an opaque
origin and cannot reach its own cookies, let alone another module's. Terminal
holds a live shell; Notes reads your thesis.

And the boundary produced the design. Because modules *cannot* reach into each
other, they had to agree on contracts. If they shared a process the shortest
path would always have been to import the other module's store, and there would
be a tangle where there is now a protocol.

The costs are known, and one of them has been paid down. Every module used to
run whether or not a canvas was showing it — thirteen servers and a little over
a gigabyte resident, for four kehikot holding seven, five, one and zero
containers between them. See the next section. The other cost, each module
having written the same wire client by hand, is still being paid down.

## Modules start when a kehikko needs them, and stop when none does

The host starts a module when a kehikko somebody has open has it on it, and
stops one it started once no open kehikko has had it for five minutes. Nothing
starts at boot. It is the lever VS Code pulls with activation events, and the
activation event here is *"this module is on the kehikko I am looking at"*.

Five minutes because the two bounds are far apart: switching kehikko is a click
and reloading is a second, so anything above about thirty seconds never
thrashes — while an hour would mean a canvas used all morning releases nothing,
which is the eager boot again wearing a timer.

Three restraints matter more than the saving:

- **The host stops only what the host started.** Every module on a working
  machine was started by hand in a terminal, and that process is somebody's
  foreground job with a log they are reading. The host holds a pid for each
  module it spawned, and there is no other path from anything to a signal — no
  looking up a port, no killing whatever answers. A module you restart yourself
  stops belonging to the host the moment its old pid dies.
- **`keep: true` in a registration means never.** Stopping a program destroys
  what it was holding, and Terminal has a live shell in it. The exemption lives
  in the registration rather than the manifest because it says what the HOST may
  do, and a module able to exempt itself would be granting itself a permission.
  It is also, conveniently, not a protocol change.
- **A stopped module reads as asleep and not as broken.** Different sentence,
  different icon: the host says it stopped the module on purpose and will start
  it again when a kehikko with it on is opened. The start button is still there
  for silence nobody asked for, which is where all of this began.

A started module inherits the host's whole environment, which matters for one
variable: modules decide who may frame them from it, and one module is framed by
more than one host on one machine — the development page (4181), the desktop
app's page (4170), and the desktop window (`tauri://localhost`). So the host
passes `KEHIKOT_ORIGINS`, a space-separated list of all of them plus its own
page, to every module it starts (`frameOrigins` in the protocol's `/serve`
reads it), and puts the same list in `KEHIKOT_ORIGIN`: a module that reads
only the single name already puts whatever is in it straight into
`frame-ancestors`. Whatever the desktop shell set on the
host comes first in the list.

Nothing waits, either. Starting is a spawn and the answer says `starting`
immediately — a cold host with six down modules on the open kehikko answers in
under a tenth of a second and every container says what is happening.

The policy — who may be stopped, when, and what is exempt — is a pure function
in `server/lifecycle.ts`, tested without anything being spawned. What the host
started is held in memory only: a new host process holds nothing and so can stop
nothing, which is the right answer after a restart or a crash.

## Things worth knowing before changing anything

**The frames outlive the containers.** An iframe that moves in the DOM has its
document destroyed — a running terminal, a half-typed note, every scroll
position. So the frames live in their own layer under the grid and are shown or
hidden, never re-parented. Folding a container, switching kehikko and changing
project all leave the document alone; a test asserts no `load` event fires
across a fold.

**The grid is `pointer-events: none`, with parts opting back in.** The frames
layer sits under it so the module stays clickable. A control that does not opt
in will look dead.

**Start it with `./run.sh`.** Anything else loses `KEHIKOT_SEED_PROJECT`, which
seeds the first project, and `epics.list` then honestly answers with nothing — a
failure where every layer reports correctly and the map is simply empty.

**This host is two processes, and one of them can die alone.** `run.sh` starts
the API and Vite on adjacent ports, and `server/ports.ts` claims them together.
The API dying leaves the page perfectly alive with every `/host/*` call refused —
a fault a person meets as one line in the footer. It used to stay that way:
`run.sh` backgrounded the API, blocked on Vite, and never noticed it had gone.
It now supervises the API and starts it again, backing off when the same failure
repeats, so a crash costs a second rather than a hand restart that destroys every
module's document. The page says so in one sentence — `src/host/reachable.ts`,
which four files used to write for themselves — retries on a widening interval,
and offers to look again. It cannot offer to restart: the page's only route to
that server is through that server.

**The app is exactly one window tall.** A strip, a canvas, and a footer, in a
column of `h-screen` with `overflow-hidden` on it. The document never scrolls;
the *canvas* does, inside itself, when the arrangement is taller than the room
left over. That distinction is the whole point — a scrolling document carries
the footer off the bottom of the screen. `main` needs its `min-h-0` as much as
its `flex-1`: without it a flex item refuses to shrink below its content, and
the shell's `overflow-hidden` would then clip the bottom containers away rather
than let anybody scroll to them. The footer is deliberately nearly empty;
`src/canvas/Footer.tsx` has the argument, and `dev/viewport.mjs` measures it.

**Nothing keeps a module's page on its container except arithmetic.** The pages
are positioned from measured rectangles in the surface's own coordinates, with
`scrollTop` added back (`src/host/rects.ts`). A scrolling canvas is therefore
the event most likely to separate a page from the container it belongs to, and
a page drawn somewhere its container is not is this workspace's recurring bug.
`dev/viewport.mjs` scrolls to the middle and the end of the travel and asserts
every page is within zero pixels of its container's body.

**A tooltip's dismissal can be owed to an event that never arrives.** Radix
tooltips are hoverable by default, which means they close on a later
`pointermove` outside a grace area rather than on `pointerleave` — and below a
container header is the module's iframe, from which this document gets no
pointer events at all. `Hint.tsx` sets `disableHoverableContent` for that
reason; `dev/tooltips.mjs` measures it in both the pointer and keyboard cases.

**There are no modals.** The sandbox has no `allow-modals`, so `confirm()`
silently returns `false` and the button does nothing, forever, with nothing in
the console. Destructive actions use a two-press arm.

## Layout

```
server/      the API on 4180 — registry, canvases, projects, and the methods a
             module's question is relayed to
src/host/    the wire, the division of who answers what, the event bus
src/canvas/  the containers, the frames layer, the header, the footer, the dialogs
dev/         probes: browser measurements that back up an argument in a comment
```

`bun test` for the suite, `bun run typecheck` for the types.

The `dev/` probes are not part of either. They print what they found rather than
passing or failing. The browser ones need a browser and a running host, and
Playwright is deliberately not a dependency — point them at whatever copy is
already on the machine:

```
PLAYWRIGHT=/path/to/playwright/index.mjs CHROME=/path/to/chrome-headless-shell \
  node dev/viewport.mjs
```

`dev/watch.probe.ts` needs neither. It starts a whole host of its own on spare
ports, with a temporary database and a temporary registrations directory, starts
a fake module, kills it by pid, and then waits on the page's own stream to be
told the module is gone — which is the one thing no test in `test/` can say,
because the fault it is about was never in a decision but in nobody making one.
It takes about a minute, for the same reason the check itself is slow:

```
bun run dev/watch.probe.ts
```

## Prior art it borrows from, and departs from

**VS Code** — the workbench idea, and lazy activation, which this does not have
yet. But its extensions cannot render; they declare contributions and the editor
draws them. Here every module *is* a view, which is the case VS Code reaches for
a webview — an iframe. So the exception there is the rule here.

**MCP** — the reason an agent can use any of this. Each module owns its own
server rather than the host proxying, so a module's tools work whether or not
anything is framed.
