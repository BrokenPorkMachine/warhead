#!/bin/sh
#
# Release-path smoke test for the installer.
#
# Unit tests all run against the source tree, so they cannot catch the two
# failure modes that actually break an install: a `bin` rename that leaves the
# launcher pointing at a file that is no longer there, and a `files` list that
# silently omits dist/ from the tarball. Both ship fine and fail on a user's
# machine. This packs a real tarball, installs it into a throwaway prefix, and
# runs the result.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${TMPDIR:-/tmp}/warhead-install-test.$$"
VERSION="$(node -p "require('$ROOT/package.json').version")"

fail() { printf 'install test FAILED: %s\n' "$1" >&2; exit 1; }

cleanup() {
  rm -rf "$PREFIX"
}
trap cleanup EXIT INT TERM

echo "· packing $VERSION"
mkdir -p "$PREFIX/pack"
# --pack-destination keeps the tarball out of the project root, which would
# otherwise be gitignored build litter.
TARBALL_NAME="$(cd "$ROOT" && npm pack --pack-destination "$PREFIX/pack" --silent)"
[ -f "$PREFIX/pack/$TARBALL_NAME" ] || fail "npm pack produced no $TARBALL_NAME"

# The tarball is what users download; anything missing from it is missing from
# the install. Checking here gives a better message than a failed run later.
echo "· checking tarball contents"
tar -tzf "$PREFIX/pack/$TARBALL_NAME" | grep -q '^package/bin/warhead-cli\.js$' \
  || fail "tarball is missing package/bin/warhead-cli.js"
tar -tzf "$PREFIX/pack/$TARBALL_NAME" | grep -q '^package/dist/cli/repl\.js$' \
  || fail "tarball is missing package/dist/cli/repl.js (run npm run build first)"
tar -tzf "$PREFIX/pack/$TARBALL_NAME" | grep -q '^package/install\.sh$' \
  || fail "tarball is missing package/install.sh"

echo "· installing into $PREFIX"
sh "$ROOT/install.sh" --from "$PREFIX/pack/$TARBALL_NAME" --prefix "$PREFIX/prefix" \
  >"$PREFIX/install.log" 2>&1 || { cat "$PREFIX/install.log"; fail "install.sh exited non-zero"; }

EXE="$PREFIX/prefix/bin/warhead-cli"
[ -x "$EXE" ] || fail "no executable at $EXE"

echo "· running the installed executable"
GOT="$("$EXE" --version)"
[ "$GOT" = "$VERSION" ] || fail "--version reported '$GOT', expected '$VERSION'"

# --help must work with no model reachable: the installer itself depends on it,
# so a boot that required Ollama would make verification unreliable.
"$EXE" --help >/dev/null || fail "--help exited non-zero"

echo "· uninstalling"
sh "$ROOT/install.sh" uninstall --prefix "$PREFIX/prefix" >/dev/null 2>&1 \
  || fail "uninstall exited non-zero"
[ ! -e "$EXE" ] || fail "uninstall left the executable behind"
[ ! -d "$PREFIX/prefix/lib/warhead" ] || fail "uninstall left the runtime behind"

printf '\ninstall test passed (%s)\n' "$VERSION"
