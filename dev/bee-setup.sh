#!/usr/bin/env bash
# One-time setup of bee for the browser tests, from this Mac. Idempotent: run
# it again after the pinned bun or Playwright changes.
#
#     dev/bee-setup.sh
#
# On bee's Ubuntu, under `~/kehikko-ci/` only:
#   - bun $BUN_VERSION, from the official installer at bun.sh, in
#     `~/kehikko-ci/bun` (the installer is told no shell, so it edits no rc file);
#   - Playwright's Chromium (with its headless shell) and WebKit, at the version
#     package.json pins, in `~/kehikko-ci/ms-playwright`.
# And system-wide, only what `playwright install --with-deps` installs: the
# apt packages those browsers need (through sudo).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/bee.sh"
pw="$(playwright_version "$here/..")"
[ -n "$pw" ] || { echo "no playwright-core version in package.json" >&2; exit 1; }

{
  bee_preamble
  printf 'BUN_VERSION=%q\nPW=%q\n' "$BUN_VERSION" "$pw"
  cat <<'EOF'
export TMPDIR="$CI/tmp"
if [ "$("$BUN_INSTALL/bin/bun" --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  echo "installing bun $BUN_VERSION into $BUN_INSTALL"
  curl -fsSL https://bun.sh/install | SHELL=/bin/sh bash -s "bun-v$BUN_VERSION"
fi
echo "bun $(bun --version) at $(command -v bun)"
echo "installing Playwright $PW's chromium and webkit into $PLAYWRIGHT_BROWSERS_PATH"
bunx "playwright-core@$PW" install --with-deps chromium webkit
ls "$PLAYWRIGHT_BROWSERS_PATH"
EOF
} | on_bee
