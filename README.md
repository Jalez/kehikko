# Kehikot

**A local-first workbench where you and your coding agent look at the same
project through the same containers.**

You arrange small independent programs — a paper reader, a checklist, a diff, a
real terminal — on a canvas. Each one shows you something. Each one also serves
an MCP server, so the agent in your terminal can use it. Putting a module on the
canvas tells both of you what this work is about.

Each program sits in a **container**: a box with a thin header (its name, and
the controls to pin, fold or remove it) and the program's own page filling the
rest. A canvas is an arrangement of containers, and you can have several
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
  > ticked. — `roadmap.checklist`

So a canvas is a statement of scope, not decoration.

**This is probably for you if** you work with Claude Code or a similar agent on
a long project, you already keep notes and checklists somewhere, and you want
them where the agent can reach them without you pasting.

**It is probably not for you if** you want a hosted product, a team tool with
accounts, or something that works without your reading a little of how it fits
together. This is a workbench, and it assumes you are willing to open the
drawers.

## Status

Working and used daily by its author; not packaged for strangers yet. Twelve
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
bun run register               # writes ~/.roadmap/modules/roadmap.checklist.json
./run.sh                       # serves on its own port
```

Reload the host and it is there. The host sweeps that registry directory —
nothing has a module list compiled into it.

Then **add a project**: the button at the end of the project list opens a folder
browser. Point it at a repository you work in.

## The model

```
project  (a repository or worktree — a folder on disk)
  ├── epics    (<project>/data/epics, when it has any)
  └── kehikot  (many; one per purpose)
```

A **project** is the container. A **kehikko** is one named canvas inside it:
which containers, arranged where, and what they are about. An **epic** is what a
kehikko is currently about. Not every
project has epics, and one that does not says so rather than showing an empty
picker.

Modules keep their data in `<project>/.kehikot/<module>/` as plain JSON — beside
the work it describes rather than inside somebody's app, so it is readable,
greppable and hand-editable. That folder is gitignored by default, because it is
one person's working material and not the project's. Remove the line to share
it.

## An epic can be retitled here, and cannot be re-slugged

"Rename this epic" names two operations, and the picker offers one of them. The
pencil that appears on a row in the epic menu changes the epic's **title** —
what it is called — in `data/epics/<slug>.json`, and the form says while you are
typing that the slug is staying where it is.

The **slug** is the identity, and everything that has ever pointed at an epic
points at it by that string: the `epic` column on a canvas, the
`roadmap.context.epic` every framed module is told, `data/state/<slug>.json`
written by a tracker refresh, a record keyed by slug in
`.kehikot/journeys/journeys.json`, a file per epic under `.kehikot/checklist/`,
and a whole directory under `.kehikot/paper/`. Renaming the epic's own file and
stopping there would file a project's papers, journeys, checklists and questions
under a name nothing asks for again — silently, because each of those readers
answers "nothing here" for an unknown slug rather than failing. That is a
migration across six programs, four of which this host does not own, and it does
not go behind a pencil in a dropdown. So the control does not say "rename".

It is the only write this host makes into a project's `data/`, and it changes
one field: the file is read, one span of text is replaced, and every other byte
is written back exactly as it was. These are documents somebody wrote by hand,
under their own name in that repository's history, and a host that reformatted
one while changing a label would put a hundred-line diff in front of a person
who changed six characters. `retitleEpic` in `server/holdings.ts` has the
argument, and `withTitle` beside it has the reason a regular expression will not
do — `"title"` is also the key on every step in these files.

## The filter a module offers and the host draws

Modules kept building the same control. Five of them had a toggle inside their
own page — `hide resolved`, `show 3 ignored`, `hide preamble comments`, `all /
this kehikko / no kehikko` — each spelled its own way, each taking a row of
chrome in a column that is often 220 pixels wide and under 300 tall. None of
them could put it anywhere else, because the strip around a module belongs to
the host.

So a module can hand over the values instead. It sends `roadmap.filters` with
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

## Picking a module out, and the host's own door for an agent

Every container header has a checkbox. Ticking it picks that container out as a
target on this kehikko — the container grows a ring, so which ones are picked is
legible from across a canvas of eight. It is a fact about the arrangement and
nothing else: no program is told, started, stopped or asked anything, and the
selection is stored with the layout, so it is still there tomorrow.

The host answers MCP on its own API port, at `http://127.0.0.1:4180/mcp`, with
two tools:

| tool | what it does |
|---|---|
| `read_canvas` | what is arranged on a kehikko: the containers, which are picked out, the project folder and the epic |
| `select_modules` | pick containers out, replacing what was picked before |

Both take an optional `kehikko` id and, without one, act on the kehikko a page
of this host says it has open — refusing, with the list, when no page has said
or when two browser windows have two different ones open. Neither tool can add,
remove or move anything: the arrangement belongs to the person looking at it.

A tool call is visible immediately on the page, without a refresh — the server
says a kehikko changed over `/host/watch` and the page re-reads.

Tell your agent about it with:

```
claude mcp add kehikko --transport http http://127.0.0.1:4180/mcp
```

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

1. `/.well-known/roadmap-module.json` — a manifest describing itself
2. a page the host frames
3. optionally, an MCP server

The contract is [`roadmap-module-protocol`](https://github.com/Jalez/kehikko-protocol):
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
variable: modules read `ROADMAP_ORIGIN` to decide who may frame them, and a
Tauri window is `tauri://localhost` rather than the browser default. The desktop
shell sets it on the host it launches; passing the environment through is all
that has to happen for every module the host starts to be framed correctly.
Nothing here names the variable.

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

**Start it with `./run.sh`.** Anything else loses `KEHIKKO_ROADMAP_DIR`, which
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
