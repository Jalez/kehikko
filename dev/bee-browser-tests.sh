#!/usr/bin/env bash
# Run the host's browser tests on bee, from this Mac. Browsers never start on
# the Mac; this is where they run.
#
#     dev/bee-browser-tests.sh <git-ref> [test/<file> ...]
#
# <git-ref> is a branch, tag or sha already pushed to Jalez/kehikko. On bee's
# Ubuntu it is fetched into a fresh `~/kehikko-ci/runs/<sha>-<time>-<pid>/`,
# installed with `bun install --frozen-lockfile`, and its browser tests run with
# `KEHIKOT_BROWSER_TESTS=1` — every test file that spawns a `dev/` drive or
# imports Playwright, or only the files named. The output streams back here
# and this exits with the tests' status. On a failure, the drives' screenshots
# and every scratch host's logs are copied to a directory on this Mac, which
# is named at the end.
#
# Each run has its own directory, its own HOME and TMPDIR inside it, and each
# drive boots its own scratch host on its own ports, so runs can go at once.
# Afterwards the run's checkout and scratch are removed; the last three runs'
# logs are kept, older ones removed (never one still running).
#
# Needs `dev/bee-setup.sh` once. Environment:
#   BEE_FULL=1      the whole suite, browser tests included, not only them
#   BEE_TIMEOUT=s   give up after this many seconds (default 1800)
#   BEE_REPO=url    fetch from here instead of Jalez/kehikko
#   BEE_OUT=dir     where failures are copied (default $TMPDIR/kehikko-bee)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/bee.sh"

ref="${1:-}"
[ -n "$ref" ] || { echo "usage: dev/bee-browser-tests.sh <git-ref> [test/<file> ...]" >&2; exit 2; }
shift
[[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "not a ref: $ref" >&2; exit 2; }
for file in "$@"; do
  [[ "$file" =~ ^test/[A-Za-z0-9._/-]+$ ]] || { echo "not a test file: $file" >&2; exit 2; }
done
repo="${BEE_REPO:-https://github.com/Jalez/kehikko.git}"

# The sha, so the run directory says what was tested.
if [[ "$ref" =~ ^[0-9a-f]{7,40}$ ]]; then
  sha="$(git -C "$here" rev-parse --verify -q "$ref^{commit}" 2>/dev/null || echo "$ref")"
else
  sha="$(git ls-remote "$repo" "refs/heads/$ref" "refs/tags/$ref" | head -1 | cut -f1)"
  [ -n "$sha" ] || { echo "$ref is not on $repo; push it first" >&2; exit 2; }
fi
run_id="${sha:0:12}-$(date +%Y%m%d-%H%M%S)-$$"
echo "bee: $ref ($sha) in ~/kehikko-ci/runs/$run_id"

remote() {
  bee_preamble
  printf 'RUN_ID=%q\nREF=%q\nSHA=%q\nREPO=%q\nFULL=%q\nLIMIT=%q\n' \
    "$run_id" "$ref" "$sha" "$repo" "${BEE_FULL:-0}" "${BEE_TIMEOUT:-1800}"
  printf 'FILES=('
  [ "$#" -gt 0 ] && printf '%q ' "$@"
  printf ')\n'
  cat <<'EOF'
RUN="$CI/runs/$RUN_ID"
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/artifacts/shots"
exec 9>"$RUN/.lock"
flock 9

# Keep the newest three runs that are finished; a run still going holds its lock.
prune() {
  local kept=0 dir
  for dir in $(ls -1dt "$CI"/runs/*/ 2>/dev/null); do
    dir="${dir%/}"
    [ "$dir" = "$RUN" ] && continue
    if ! flock -n "$dir/.lock" true 2>/dev/null; then continue; fi
    kept=$((kept + 1))
    [ "$kept" -ge 3 ] && rm -rf "$dir"
  done
  return 0
}
prune

# The host's scratch hosts already put every KEHIKOT_* location and HOME in a
# directory of their own; the run itself gets a home and a temp of its own too.
export HOME="$RUN/home" TMPDIR="$RUN/tmp"
cd "$RUN"
git init -q src
cd src
git fetch -q --depth 1 "$REPO" "$SHA" 2>/dev/null || git fetch -q --depth 1 "$REPO" "$REF"
git checkout -q FETCH_HEAD
echo "bee: at $(git rev-parse HEAD) — $(git log -1 --format=%s)"
bun install --frozen-lockfile 2>&1 | tail -1
# The browsers this checkout's Playwright wants; nothing to do when setup put them there.
node_modules/.bin/playwright-core install chromium webkit >/dev/null

if [ "${#FILES[@]}" -eq 0 ] && [ "$FULL" != 1 ]; then
  mapfile -t FILES < <(grep -lE "spawn.*dev/[^'\"]*\.mjs|from ['\"]playwright|import\(['\"]playwright|from ['\"]\./browser-gate" test/*.test.ts test/*.test.tsx 2>/dev/null | grep -v '^test/browser-gate\.test\.ts$' | sort)
  [ "${#FILES[@]}" -gt 0 ] || { echo "bee: no browser tests in this checkout"; exit 1; }
fi
echo "bee: bun test ${FILES[*]:-(the whole suite)}"

set +e
KEHIKOT_BROWSER_TESTS=1 KEEP=1 SHOTS="$RUN/artifacts/shots" \
  timeout -k 30 "$LIMIT" bun test "${FILES[@]}" 2>&1 | tee "$RUN/run.log"
status=${PIPESTATUS[0]}
set -e
echo "bee: exit $status"

# Every scratch host's logs, for a failure; then what is no longer needed.
if [ "$status" -ne 0 ]; then
  for dir in "$TMPDIR"/*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    mkdir -p "$RUN/artifacts/hosts/$name"
    find "$dir" -maxdepth 1 -name '*.log' -exec cp {} "$RUN/artifacts/hosts/$name/" \;
  done
fi
rm -rf "$RUN/src" "$RUN/tmp" "$RUN/home"
[ "$status" -eq 0 ] && rm -rf "$RUN/artifacts"
prune
exit "$status"
EOF
}

set +e
remote "$@" | on_bee
status=${PIPESTATUS[1]}
set -e

if [ "$status" -ne 0 ]; then
  out="${BEE_OUT:-${TMPDIR:-/tmp}/kehikko-bee}/$run_id"
  mkdir -p "$out"
  {
    printf 'RUN="$HOME/kehikko-ci/runs/%s"\n' "$run_id"
    cat <<'EOF'
[ -d "$RUN" ] || exit 0
tar -C "$RUN" -czf - run.log artifacts 2>/dev/null | base64 -w0
rm -rf "$RUN/artifacts"
EOF
  } | on_bee | base64 -d | tar -C "$out" -xzf - 2>/dev/null || true
  echo "bee: failed ($status); the run's log, screenshots and scratch host logs are in $out"
fi
exit "$status"
