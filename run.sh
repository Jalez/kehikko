#!/usr/bin/env sh
#
# Start the host: its small server, and Vite serving the page beside it.
#
# No arguments. `PORT` from the environment, or 4180.
#
# This script STAYS, and does not `exec`. It used to, on the argument that the
# process whoever started this is holding should be the process that serves —
# "a script that forked and returned would leave them with a pid that stops
# nothing". The goal was right and `exec` was the wrong way to it: the API is
# started in the background just below, so `exec` replaced this shell with Vite
# and left the API with no parent at all. Holding that pid stopped the page and
# orphaned the server.
#
# Worse, `exec` discards traps. The trap below says it fires "however we leave"
# and, with an `exec` after it, it could never fire once — a comment describing
# a fix the code did not perform.
#
# What that produced was a half of a host: an API answering on 4180 with
# nothing serving the page on 4181, so a browser pointed at it showed a white
# screen. And `server/claim.ts` then found a Kehikot API on the port and said
# "already running", which made this script refuse to start the very thing that
# was missing. Both halves are checked now (see `claimPair`), and this end of it
# is fixed here: one script, holding both, leaving with both.
#
# ## Why there is no build here any more, and no `dist`
#
# There used to be. The page was built once into `dist/` and the small server
# served it off disk, with a guard that skipped the build when `dist` already
# existed. That is the shape of a deployment, and this program is not deployed:
# it runs on the machine of the person editing it.
#
# What the deployment shape actually bought us was a stale page. `dist` existed,
# so the build was skipped, so the server answered 200 with the previous
# bundle — every symptom of a working system and none of the changes. It cost an
# hour twice before anybody suspected the build rather than the code.
#
# So Vite serves the page, as Vite is for: no build step, no artifact in the
# tree, an edit visible on save. `vite.config.ts` already proxies `/host` to the
# small server, so the page talks to one origin either way and nothing about the
# arrangement changes when it is not being edited.
set -eu
cd "$(dirname "$0")"

# Where this host goes, decided before anything binds anything.
#
# Three parties can start this program -- the desktop app, a person, an agent
# doing something else -- and until now nothing arbitrated between them. Two
# hosts racing for 4180 produced a half-started pair: an API with no page, or a
# page proxying to somebody else's API and reading their canvases. And a person
# running this while their app was up got a stack trace rather than the address
# of the host they already had.
#
# `server/claim.ts` asks who is on the ports first and answers in its exit code:
#
#   0  it claimed a pair, printed on stdout as "<api> <page>"
#   3  a host is already running; it printed where, and there is nothing to do
#   4  nowhere free to put one
#
# 3 is a success as far as a person is concerned, so this exits 0 on it. They
# asked for a host and there is one.
CLAIMED="$(bun run server/claim.ts)" || {
  code=$?
  [ "$code" = "3" ] && exit 0
  exit "$code"
}

PORT="${CLAIMED% *}"
PAGE="${CLAIMED#* }"
export PORT

# The port Vite proxies `/host` to, which is this API's.
#
# It is exported separately because `vite.config.ts` reads this name, and until
# it was exported the two agreed only by coincidence: the config fell back to
# 4180, `PORT` defaulted to 4180, and everything worked until somebody ran a
# second host on another port — at which point that page proxied its calls to
# the FIRST host's server and read a registry and a set of canvases belonging to
# a process it had nothing to do with. Nothing failed; the answers were just
# somebody else's.
HOST_PORT="$PORT"
export HOST_PORT

if [ ! -d node_modules ]; then
  echo "installing…" >&2
  bun install >&2
fi

# ---------------------------------------------------------------------------
# Where the roadmap's own data lives — and, since projects, what that means now.
#
# ## It is a SEED, and only a seed
#
# It used to be the answer: `server/holdings.ts` read `$KEHIKKO_ROADMAP_DIR/
# data/epics` on every call, so this one variable decided what every module was
# told about epics for the life of the process.
#
# That is no longer where epics come from. A kehikko belongs to a PROJECT, a
# project is a folder, and epics are read from `<project>/data/epics` — so a
# person with two projects open gets two different answers, which is the whole
# point. See `server/projects.ts`.
#
# What this variable does now is seed the FIRST project, on a database that has
# none: `adopt()` reads it once at startup, makes a project out of it, and files
# every kehikko written before projects existed into it. On every start after
# that the projects table already has rows and this variable is not read at all.
#
# It is kept rather than dropped because an existing setup has to keep starting.
# A person who upgrades into this and finds no projects and no epics has met a
# regression before they have met the feature, and the epics they are looking
# for are exactly the ones this variable names.
#
# The old failure mode is worth keeping in the record, because the default below
# is what fixed it:
#
# A host that holds nothing is a real and ordinary state rather than an error,
# so an unset variable used to mean an honest empty list. That honesty had a
# failure mode and it happened: the host was
# restarted by something that did not know this variable existed, the holdings
# lookup returned null, and Atlas drew "the host answered: it has no epics yet". Which
# was TRUE. Thirteen epics were sitting on disk the whole time, and every part of
# the system reported correctly — the module said what the host said, and the
# host said what its environment told it. Nothing was broken and nothing could be
# grepped for.
#
# So the default lives here, in the script that starts this host, rather than in
# whoever's shell happens to run it. An explicit `KEHIKKO_ROADMAP_DIR` still
# wins; this only fills in the silence.
#
# Note this is the OPPOSITE of the rule `kehikko-orchestrator/scope.ts` argues
# for, which refuses to default a directory at all — and the difference is what
# the directory is FOR. There, a guessed path is an agent editing the wrong
# repository: a write, and an irreversible one. Here it is a read of a roadmap's
# own epics, where a wrong guess shows the wrong list and a missing guess shows
# no list, and only one of those two announces itself.
if [ -z "${KEHIKKO_ROADMAP_DIR:-}" ] && [ -d "$HOME/Projects/roadmap/data/epics" ]; then
  KEHIKKO_ROADMAP_DIR="$HOME/Projects/roadmap"
fi
export KEHIKKO_ROADMAP_DIR

if [ -n "${KEHIKKO_ROADMAP_DIR:-}" ] && [ -d "$KEHIKKO_ROADMAP_DIR/data/epics" ]; then
  echo "kehikko: epics from $KEHIKKO_ROADMAP_DIR/data/epics" >&2
  echo "kehikko: that path seeds the FIRST project only; after that, epics come from <project>/data/epics" >&2
else
  # Said out loud, at start, in the terminal somebody is looking at — because
  # the alternative is finding out from a module drawing an empty map twenty
  # minutes later and blaming the module. It is now a warning about the FIRST
  # run only: a host whose projects are already in its database reads its epics
  # from those folders and never from here.
  echo "kehikko: KEHIKKO_ROADMAP_DIR names no data/epics directory. If this host has no projects yet it will seed one from your home folder, which holds none — add a project from the header." >&2
fi

# What the server itself then prints is the fact that matters, and it prints it
# from the database rather than from this script:
#
#   projects are folders; the first is roadmap at /Users/…/Projects/roadmap
#   3 kehikko(t) written before projects existed were filed under it
#
# The second line appears once, on the run that migrates. A host that had
# already migrated prints only the first.

# The API first, in the background, because Vite's proxy has nowhere to send
# `/host` until it is up. Stopping this script stops both: the trap fires on the
# way out however we leave, so a Ctrl-C does not leave an orphan holding 4180 —
# which is its own afternoon of "address already in use" for anybody who has met
# it once.
#
# ## Started in one place, because it is now started more than once
#
# This used to be two lines in the middle of the script. It is a function
# because the API is started AGAIN when it dies, and a second copy of the start
# would be a second place for the command, or for the bookkeeping below, to
# drift out of step with the first.
#
# `API_UP_AT` is when this attempt began. It is the whole of how the supervisor
# at the bottom tells a crash loop from bad luck.
start_api() {
  bun run server/server.ts &
  API=$!
  API_UP_AT="$(date +%s)"
}

start_api

# A sleep this script can be interrupted during.
#
# A FOREGROUND `sleep` would re-create, exactly, the bug the essay below records
# about a foreground Vite: a shell blocked on a foreground child does not act on
# a trapped signal until that child ends, so a TERM aimed at this script would
# sit queued behind a nap. Backgrounded and `wait`ed on, the trap runs at once —
# `wait` is the one thing here that is interruptible, which is why the whole of
# this script is built around it.
nap() {
  sleep "$1" &
  NAP=$!
  wait "$NAP" 2>/dev/null || true
}

# How long the API has to stay up before its previous death stops counting.
#
# Below this it is a crash loop — a broken import, a port it cannot bind — and
# the wait between attempts doubles so a permanently broken build does not fill
# the terminal. Above it, the death was an event rather than a pattern (somebody
# killed it, something crashed once) and the next one starts from one second
# again, because that is the case where coming straight back is the whole point.
API_HEALTHY_FOR=20

# The ceiling on that doubling. Half a minute is long enough to be quiet and
# short enough that somebody who has just FIXED the broken import gets their
# server back without touching anything.
API_BACKOFF_MAX=30

# `$PAGE` rather than `$((PORT + 1))`, because the pair was claimed together and
# this is the half that was checked to be free. `--strictPort` stays: the page
# moving on its own would put it on a port the API's claim never covered, which
# is the desync the pair exists to prevent.
#
# Both halves in the background, and this shell waiting on the page.
#
# Not `exec`, and not a foreground Vite either — both were tried and both leave
# half a host behind.
#
# `exec` replaced this shell with Vite, so the API had no parent and no trap
# could run: killing the pid somebody was holding stopped the page and orphaned
# the server on 4180.
#
# Running Vite in the FOREGROUND fixed the parent and broke the signal. A shell
# blocked on a foreground child does not act on a trapped signal until that
# child ends, so a TERM aimed at this script sat queued behind the very process
# it was meant to stop. Measured: `kill` on the script's own pid left the
# script, the API and the page all running.
#
# So the page goes to the background too and this shell `wait`s on it, which is
# interruptible. A signal reaches the trap immediately, the trap takes both
# halves down, and there is no state where one is serving without the other.
bunx vite --host 127.0.0.1 --port "$PAGE" --strictPort &
PAGE_PID=$!

# Whichever way this ends -- Ctrl-C, a TERM from whoever started it, or Vite
# exiting on its own -- both processes go. An orphan holding 4180 is its own
# afternoon of "address already in use" for anybody who has met it once, and a
# live API with a dead page is a white screen that `claim.ts` used to describe
# as "already running".
trap 'kill $API $PAGE_PID 2>/dev/null; exit 143' INT TERM
trap 'kill $API 2>/dev/null' EXIT

# ---------------------------------------------------------------------------
# The supervisor: nothing was holding the API up, and it showed.
#
# ## The half of the host that could die alone
#
# `server/ports.ts` already has a word for an API answering with no page behind
# it — `half` — and an essay about the white screen it caused. This is the
# MIRROR of that state, it is the one people actually meet, and until now
# nothing in this script had noticed it was possible.
#
# The old tail of this file was `wait $PAGE_PID`. If the API exited, this shell
# was blocked on the PAGE and never heard about it. Vite carried on serving a
# perfectly good document; every `/host/*` call it proxied was refused; and the
# canvas sat there saying the host's own server was not answering until somebody
# restarted the whole thing by hand — which destroys every module's document to
# fix a process that takes a second to start. `Frames.tsx` exists in the shape
# it does specifically to avoid losing those documents, and the recommended cure
# for this fault was to lose them all.
#
# It is not a rare state. Reproduced on the first attempt while this was being
# written: a file in `server/` imported a name its dependency no longer
# exported, `bun` printed a `SyntaxError` and exited before binding anything,
# and this script went straight on to start Vite as though nothing had happened.
# An agent editing server code and an agent killing something on 4180 both land
# here, and the second is already recorded in `ports.ts` as something that has
# happened.
#
# ## Why a poll and not `wait -n`
#
# `wait -n` — wake when ANY child ends — is exactly this loop in one builtin,
# and it is bash 4.3 and later. This file is `#!/usr/bin/env sh` and is run by
# whatever that is on somebody's machine. A two-second poll of two pids costs a
# `sleep` and two `kill -0`s, which is nothing, and it works everywhere.
#
# The poll interval is not what decides how fast a signal is honoured: naps are
# `wait`ed on, so the trap runs the instant a TERM arrives. It only decides how
# long a dead API stays dead, and two seconds is under the page's own first
# retry.
#
# ## Why the page is not restarted the same way
#
# Because Vite dying is a different fact. The API is a process this host can
# have again for nothing — it holds no browser state, and a page whose `/host`
# calls are refused for a second is a page that retries. The PAGE is the
# document somebody is looking at, with every module's frame inside it; a
# restarted Vite is a browser that must reload, and a reload is the loss this
# whole arrangement is built to prevent. So the page ending still ends the host,
# and whoever started it finds out, which is the rule this script already had.
API_BACKOFF=1
API_DEATHS=0

while :; do
  # The page ending ends the host. Checked first, so a host being shut down does
  # not spend a nap resurrecting an API on its way out.
  if ! kill -0 "$PAGE_PID" 2>/dev/null; then
    break
  fi

  if ! kill -0 "$API" 2>/dev/null; then
    # Reaped, for its status. `|| API_STATUS=$?` rather than a bare `wait`,
    # because `set -e` would take a non-zero exit here as this script's own
    # failure — and a crashed API is precisely the case this loop is for.
    API_STATUS=0
    wait "$API" 2>/dev/null || API_STATUS=$?

    LIVED=$(( $(date +%s) - API_UP_AT ))
    if [ "$LIVED" -ge "$API_HEALTHY_FOR" ]; then
      # It had been up and working. Whatever ended it was an event, not a
      # pattern, so the next attempt is immediate-ish and the count starts over.
      API_BACKOFF=1
      API_DEATHS=0
    fi
    API_DEATHS=$(( API_DEATHS + 1 ))

    echo "kehikko: the API exited ($API_STATUS) after ${LIVED}s. The page is untouched; starting the API again in ${API_BACKOFF}s." >&2
    if [ "$API_DEATHS" -ge 3 ]; then
      # Said only once it is a pattern, because saying it on a single crash
      # would be this script diagnosing a fault it has not seen twice.
      echo "kehikko: that is $API_DEATHS in a row. The same error repeating above is the reason — it is being restarted into code that does not load. Fix it and it will come back on its own." >&2
    fi

    nap "$API_BACKOFF"
    if [ "$API_BACKOFF" -lt "$API_BACKOFF_MAX" ]; then
      API_BACKOFF=$(( API_BACKOFF * 2 ))
      if [ "$API_BACKOFF" -gt "$API_BACKOFF_MAX" ]; then
        API_BACKOFF="$API_BACKOFF_MAX"
      fi
    fi

    # Only if the page is still there. A TERM that arrived during the nap took
    # the page down through the trap, and starting an API for a page that has
    # gone is the orphan on 4180 this script's traps exist to prevent.
    if kill -0 "$PAGE_PID" 2>/dev/null; then
      start_api
    fi
    continue
  fi

  nap 2
done

PAGE_STATUS=0
wait "$PAGE_PID" 2>/dev/null || PAGE_STATUS=$?

# Exiting with the page's own status keeps whoever started this able to tell a
# clean stop from a crash.
exit $PAGE_STATUS
