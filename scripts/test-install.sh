#!/bin/sh
#
# Release-path tests for the installer.
#
# Every other test in this repo runs against the source tree, so none of them
# can see the failure modes that only exist once a tarball is built and
# installed: a `bin` rename that leaves the launcher dangling, a `files` list
# that silently dropped dist/, or an installer bug in a branch the happy path
# never reaches. Those ship green and fail on a user's machine.
#
# Deliberately hermetic: no network, no Ollama, no real prefix. Everything here
# runs in seconds.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$(node -p "require('$ROOT/package.json').name")"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NAME="$PKG-$VERSION.tgz"

# mktemp -d, not a predictable path under /tmp: this creates and removes trees
# recursively, and a predictable name is both a collision risk and a symlink
# target for anything else on the box.
WORK="$(mktemp -d 2>/dev/null || mktemp -d -t warhead-test)"
PACK="$WORK/pack"

checks=0

cleanup() {
  rm -rf "$WORK"
  return 0
}
trap cleanup EXIT INT TERM

ok() {
  checks=$((checks + 1))
  printf '  ok  %s\n' "$1"
}

fail() {
  printf '\n  FAIL  %s\n' "$1" >&2
  exit 1
}

# Runs install.sh and captures output, without letting a non-zero exit abort.
try_install() {
  sh "$ROOT/install.sh" "$@" >"$WORK/out.log" 2>&1 && return 0 || return 1
}

# ---------------------------------------------------------------- pack

printf '\n· packing %s\n' "$VERSION"
mkdir -p "$PACK"
TARBALL="$(cd "$ROOT" && npm pack --pack-destination "$PACK" --silent)"
[ -f "$PACK/$TARBALL" ] || fail "npm pack produced no $TARBALL"
TARBALL="$PACK/$TARBALL"

printf '\n· tarball contents\n'
# Anything absent here is absent from every install.
tar -tzf "$TARBALL" | grep -q '^package/bin/warhead-cli\.js$' \
  || fail "tarball is missing package/bin/warhead-cli.js"
ok "ships bin/warhead-cli.js"
tar -tzf "$TARBALL" | grep -q '^package/dist/cli/repl\.js$' \
  || fail "tarball is missing package/dist/cli/repl.js (run npm run build first)"
ok "ships dist/cli/repl.js"
tar -tzf "$TARBALL" | grep -q '^package/install\.sh$' \
  || fail "tarball is missing package/install.sh"
ok "ships install.sh"

# ------------------------------------------------------------- happy path

printf '\n· install from the tarball\n'
try_install --from "$TARBALL" --prefix "$WORK/prefix" || { cat "$WORK/out.log"; fail "install exited non-zero"; }
EXE="$WORK/prefix/bin/warhead-cli"
[ -x "$EXE" ] || fail "no executable at $EXE"
ok "linked $EXE"

GOT="$("$EXE" --version)"
[ "$GOT" = "$VERSION" ] || fail "--version reported '$GOT', expected '$VERSION'"
ok "--version reports $VERSION"

# Bare, unpolluted, and complete through a pipe: the installer reads exactly
# this output, so a stray progress line or a truncated write would break it.
"$EXE" --help >"$WORK/help.txt" || fail "--help exited non-zero"
grep -q 'See README.md' "$WORK/help.txt" || fail "--help output is truncated"
grep -q 'warhead-cli rea' "$WORK/help.txt" || fail "--help does not mention the REA subcommand"
ok "--help survives a pipe intact"

# The bundled REA CLI is a separate runtime. Proving it executes from the
# installed tree catches a tarball that dropped rea/, or an npm install that
# failed to link its dependencies — neither of which the version check sees.
REA_VERSION="$(node -p "require('$ROOT/rea/package.json').version")"
GOT_REA="$("$EXE" rea --version)"
[ "$GOT_REA" = "$REA_VERSION" ] || fail "rea --version reported '$GOT_REA', expected '$REA_VERSION'"
ok "bundled REA runs from the installed tree ($REA_VERSION)"

# The executable must resolve back into lib/, or the launcher derives the wrong
# root and cannot find dist/ or src/. Which of the two shapes install.sh produced
# depends on whether symlinks were available, so accept either — but check the
# one it actually made.
LINK_TARGET="$(readlink "$EXE" 2>/dev/null || true)"
if [ -n "$LINK_TARGET" ]; then
  case "$LINK_TARGET" in
    "$WORK/prefix/lib/warhead/"*) ok "symlink resolves into lib/warhead" ;;
    *) fail "symlink points at $LINK_TARGET, not into lib/warhead" ;;
  esac
else
  # Wrapper fallback. It must exec the launcher itself, so node is resolved from
  # PATH at run time via the launcher's own shebang — not a node path frozen in
  # at install time, which breaks silently after a node upgrade.
  grep -q "$WORK/prefix/lib/warhead/bin/warhead-cli.js" "$EXE" \
    || fail "wrapper does not reference the installed launcher"
  case "$(cat "$EXE")" in
    *'/usr/'*'/bin/node'*) fail "wrapper pins an absolute node path" ;;
  esac
  ok "wrapper execs the launcher without pinning node"
fi

# --------------------------------------------------------- checksum verify

printf '\n· checksum sidecar\n'
SIDECAR_DIR="$WORK/sidecar"
mkdir -p "$SIDECAR_DIR"
cp "$TARBALL" "$SIDECAR_DIR/$NAME"
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$SIDECAR_DIR" && sha256sum "$NAME" >"$NAME.sha256" )
else
  ( cd "$SIDECAR_DIR" && shasum -a 256 "$NAME" >"$NAME.sha256" )
fi

try_install --from "$SIDECAR_DIR/$NAME" --prefix "$WORK/prefix-ok" \
  || { cat "$WORK/out.log"; fail "install with a valid sidecar failed"; }
grep -q 'checksum verified' "$WORK/out.log" || fail "a valid sidecar was not verified"
ok "valid sidecar verifies"

# A corrupt tarball with its ORIGINAL checksum must be refused. This is the
# whole point of the sidecar, and it is the failure mode that silently produces
# a broken install if verification is skipped.
cp "$TARBALL" "$SIDECAR_DIR/tampered.tgz"
cp "$SIDECAR_DIR/$NAME.sha256" "$SIDECAR_DIR/tampered.tgz.sha256"
printf 'corruption' >>"$SIDECAR_DIR/tampered.tgz"
if try_install --from "$SIDECAR_DIR/tampered.tgz" --prefix "$WORK/prefix-bad"; then
  fail "install accepted a tarball that failed checksum verification"
fi
grep -q 'checksum mismatch' "$WORK/out.log" || fail "wrong error for a bad checksum"
[ ! -e "$WORK/prefix-bad/bin/warhead-cli" ] || fail "a rejected tarball still linked an executable"
ok "tampered tarball refused, nothing installed"

# No sidecar must install, not abort — a missing checksum is not a bad one.
mkdir -p "$WORK/nosidecar"
cp "$TARBALL" "$WORK/nosidecar/$NAME"
try_install --from "$WORK/nosidecar/$NAME" --prefix "$WORK/prefix-nosum" \
  || { cat "$WORK/out.log"; fail "install failed with no sidecar present"; }
grep -q 'skipping verification' "$WORK/out.log" || fail "missing sidecar was not reported"
ok "absent sidecar is skipped, not fatal"

# ------------------------------------------------------------- bad payloads

printf '\n· malformed payloads\n'
printf 'this is not a gzip stream' >"$WORK/garbage.tgz"
if try_install --from "$WORK/garbage.tgz" --prefix "$WORK/prefix-junk"; then
  fail "install accepted a file that is not a tarball"
fi
ok "non-tarball rejected"

# A real tarball that is not a warhead package must fail with the reason, not
# install a broken tree.
mkdir -p "$WORK/notwarhead/package"
printf '{"name":"something-else"}' >"$WORK/notwarhead/package/package.json"
( cd "$WORK/notwarhead" && tar -czf "$WORK/notwarhead.tgz" package )
if try_install --from "$WORK/notwarhead.tgz" --prefix "$WORK/prefix-nw"; then
  fail "install accepted a tarball that is not a warhead package"
fi
grep -q 'missing bin/warhead-cli.js' "$WORK/out.log" || fail "wrong error for a foreign tarball"
ok "foreign tarball rejected with a reason"

# ---------------------------------------------------------------- dry run

printf '\n· dry run\n'
try_install --from "$TARBALL" --prefix "$WORK/prefix-dry" --dry-run \
  || { cat "$WORK/out.log"; fail "--dry-run exited non-zero"; }
[ ! -e "$WORK/prefix-dry" ] || fail "--dry-run created $WORK/prefix-dry"
grep -q 'Nothing was changed' "$WORK/out.log" || fail "--dry-run did not say it changed nothing"
ok "changes nothing on disk"

# ------------------------------------------------------------- re-install

printf '\n· re-install over an existing install\n'
try_install --from "$TARBALL" --prefix "$WORK/prefix" \
  || { cat "$WORK/out.log"; fail "re-install exited non-zero"; }
[ "$("$WORK/prefix/bin/warhead-cli" --version)" = "$VERSION" ] \
  || fail "re-install produced a broken executable"
ok "idempotent"

# ------------------------------------------------------------- uninstall

printf '\n· uninstall\n'
try_install uninstall --prefix "$WORK/prefix" || fail "uninstall exited non-zero"
[ ! -e "$EXE" ] || fail "uninstall left the executable behind"
[ ! -d "$WORK/prefix/lib/warhead" ] || fail "uninstall left the runtime behind"
ok "removes executable and runtime"

# Idempotent, and specifically must not report failure just because there was
# nothing to remove — an EXIT trap returning non-zero once made every
# successful uninstall look like a failure.
try_install uninstall --prefix "$WORK/prefix" || fail "second uninstall exited non-zero"
grep -q 'nothing installed' "$WORK/out.log" || fail "second uninstall did not report a no-op"
ok "second uninstall is a clean no-op"

# Must not disturb anything else living in the prefix.
FOREIGN="$WORK/shared"
mkdir -p "$FOREIGN/bin"
: >"$FOREIGN/bin/some-other-tool"
try_install --from "$TARBALL" --prefix "$FOREIGN" || fail "install into a shared prefix failed"
try_install uninstall --prefix "$FOREIGN" || fail "uninstall from a shared prefix failed"
[ -f "$FOREIGN/bin/some-other-tool" ] || fail "uninstall deleted an unrelated file"
[ -d "$FOREIGN/bin" ] || fail "uninstall removed a non-empty bin directory"
ok "leaves unrelated files in a shared prefix alone"

# ------------------------------------------------- config is never touched

printf '\n· uninstall does not eat user data\n'
FAKE_CFG="$WORK/cfg/warhead"
FAKE_STATE="$WORK/state/warhead"
mkdir -p "$FAKE_CFG" "$FAKE_STATE"
printf '{"model":{}}' >"$FAKE_CFG/config.json"
printf '{}\n' >"$FAKE_STATE/session.jsonl"
try_install --from "$TARBALL" --prefix "$WORK/prefix-purge" || fail "install failed"
if XDG_CONFIG_HOME="$WORK/cfg" XDG_STATE_HOME="$WORK/state" \
   try_install uninstall --prefix "$WORK/prefix-purge"; then
  : # expected to succeed
else
  fail "uninstall exited non-zero"
fi
[ -f "$FAKE_CFG/config.json" ] || fail "uninstall deleted config without --purge"
[ -f "$FAKE_STATE/session.jsonl" ] || fail "uninstall deleted transcripts without --purge"
ok "config and transcripts survive a plain uninstall"

if XDG_CONFIG_HOME="$WORK/cfg" XDG_STATE_HOME="$WORK/state" \
   try_install uninstall --prefix "$WORK/prefix-purge" --purge; then
  [ ! -d "$FAKE_CFG" ] || fail "--purge left config behind"
  [ ! -d "$FAKE_STATE" ] || fail "--purge left transcripts behind"
  ok "--purge removes config and transcripts"
else
  fail "--purge exited non-zero"
fi

# ------------------------------------------------------------ arg handling

printf '\n· argument handling\n'
if try_install --nonsense; then fail "an unknown option was accepted"; fi
grep -q 'unknown option' "$WORK/out.log" || fail "wrong error for an unknown option"
ok "unknown option rejected"

if try_install --from "$WORK/does-not-exist.tgz" --prefix "$WORK/x"; then
  fail "a nonexistent --from path was accepted"
fi
ok "nonexistent --from path rejected"

try_install --help || fail "--help exited non-zero"
ok "--help works"

printf '\n%d checks passed (%s)\n' "$checks" "$VERSION"
