#!/bin/sh
#
# warhead-cli installer.
#
# Installs the `warhead-cli` executable without requiring a global npm install.
# The package has zero runtime dependencies and ships plain JS in dist/, so an
# install is just: fetch a tarball, unpack it under a prefix, link the launcher.
#
#   ./install.sh                                  # latest release -> ~/.local
#   ./install.sh --prefix /usr/local              # system-wide (needs write access)
#   ./install.sh --version 0.1.0-rc.3             # pin a release
#   ./install.sh --from ./warhead-0.1.0-rc.3.tgz  # install a local tarball
#   ./install.sh --from .                         # install this checkout, as-is
#   ./install.sh uninstall                        # remove the executable
#   ./install.sh uninstall --purge                # ...and config + transcripts
#
# POSIX sh only, no bashisms: the tool itself is POSIX-only, so the installer
# should not raise the floor for installing it.

set -eu

REPO="BrokenPorkMachine/warhead"
PACKAGE="warhead"

PREFIX="${HOME}/.local"
VERSION=""
FROM=""
PURGE=0
VERIFY=1
ACTION="install"

# Where the payload lands. Keeping the runtime out of bin/ means `bin/` holds
# exactly one file, so uninstall cannot leave a half-removed tree behind and
# PATH stays tidy.
LIBDIR_REL="lib/warhead"

die() { printf '%s: %s\n' "$0" "$1" >&2; exit 1; }
info() { printf '  %s\n' "$1"; }
step() { printf '\n%s\n' "$1"; }

usage() {
  cat <<'EOF'
warhead-cli installer

Usage
  install.sh [options]              install (default)
  install.sh uninstall [options]    remove the installed executable

Options
  --prefix DIR      install root; executable at DIR/bin, runtime at DIR/lib/warhead
                    (default: $HOME/.local)
  --version TAG     install a specific release tag (default: latest release)
  --from PATH       install from a local .tgz, or from a source directory with .
                    Bypasses the network; this is what CI and local testing use.
  --purge           with uninstall, also delete config and transcripts (IRREVERSIBLE)
  --no-verify       skip the post-install "warhead-cli --version" check
  -h, --help        this message

Uninstall never touches ~/.config/warhead or ~/.local/state/warhead unless
--purge is given: those hold your config and conversation transcripts.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    install)   ACTION="install" ;;
    uninstall) ACTION="uninstall" ;;
    --prefix)  [ $# -ge 2 ] || die "--prefix needs a value"; PREFIX="$2"; shift ;;
    --prefix=*) PREFIX="${1#*=}" ;;
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift ;;
    --version=*) VERSION="${1#*=}" ;;
    --from)    [ $# -ge 2 ] || die "--from needs a value"; FROM="$2"; shift ;;
    --from=*)  FROM="${1#*=}" ;;
    --purge)   PURGE=1 ;;
    --no-verify) VERIFY=0 ;;
    -h|--help) usage; exit 0 ;;
    *)         die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

case "$PREFIX" in
  /*) ;;
  *) PREFIX="$(cd "$(dirname "$PREFIX")" 2>/dev/null && pwd)/$(basename "$PREFIX")" \
       || die "--prefix must be an absolute path: $PREFIX" ;;
esac

BINDIR="$PREFIX/bin"
LIBDIR="$PREFIX/$LIBDIR_REL"
EXE="$BINDIR/$PACKAGE-cli"

# ---------------------------------------------------------------- node check

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

node_major() {
  # "v26.10.0" -> 26. Anything unparseable yields 0, which fails the gate below
  # rather than silently proceeding on an unknown runtime.
  node -e 'const m=process.versions.node.match(/^(\d+)/);process.stdout.write(m?m[1]:"0")' 2>/dev/null || echo 0
}

require_node() {
  # The floor depends on what the payload contains, and that is not known until
  # it is unpacked. See check_runtime_floor.
  find_node >/dev/null 2>&1 || die "node not found on PATH. Install Node 20 or newer: https://nodejs.org"
}

# ------------------------------------------------------------------ fetching

TMPDIR_=""
cleanup() {
  # Must return 0 unconditionally. This runs from the EXIT trap, and a trap that
  # exits non-zero becomes the script's exit status — so a `[ -n "$TMPDIR_" ]`
  # that is false on the uninstall path (which never makes a temp dir) would
  # silently turn a successful uninstall into a failure.
  if [ -n "$TMPDIR_" ]; then
    rm -rf "$TMPDIR_"
  fi
  return 0
}
trap cleanup EXIT INT TERM

fetch_to() {
  # fetch_to <url> <destination>
  url="$1"; dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url" \
      || die "download failed: $url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url" || die "download failed: $url"
  else
    die "neither curl nor wget is available; fetch $url by hand and use --from"
  fi
}

# Resolves the tag to install. Kept separate from fetching so a local --from
# install never touches the network at all.
resolve_version() {
  if [ -n "$VERSION" ]; then
    printf '%s' "$VERSION"
    return 0
  fi
  find_node >/dev/null 2>&1 || die "resolving the latest release needs node (or pass --version)"

  api="https://api.github.com/repos/$REPO/releases/latest"
  json=""
  if command -v curl >/dev/null 2>&1; then
    json="$(curl -fsSL --retry 3 --retry-delay 2 "$api" 2>/dev/null || true)"
  elif command -v wget >/dev/null 2>&1; then
    json="$(wget -q -O- "$api" 2>/dev/null || true)"
  fi

  # No jq dependency. Pull "tag_name" out of the JSON with sed; the releases API
  # returns one object, so the first match is the one.
  tag="$(printf '%s' "$json" \
    | tr ',' '\n' \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)"

  [ -n "$tag" ] || die "could not determine the latest release.
  The GitHub API may be rate-limited or unreachable. Pin a version explicitly:
    ./install.sh --version <tag>
  or install a tarball you already have:
    ./install.sh --from ./$PACKAGE-<tag>.tgz"
  printf '%s' "$tag"
}

# Best-effort integrity check. A release that ships a sidecar is verified; one
# that does not still installs, loudly, rather than failing a user mid-upgrade.
verify_checksum() {
  tarball="$1"; sums="$2"
  [ -f "$sums" ] || return 0
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || return 0
  if command -v sha256sum >/dev/null 2>&1; then
    want="$(awk '{print $1; exit}' "$sums")"
    got="$(sha256sum "$tarball" | awk '{print $1}')"
  else
    want="$(awk '{print $1; exit}' "$sums")"
    got="$(shasum -a 256 "$tarball" | awk '{print $1}')"
  fi
  [ -n "$want" ] || return 0
  if [ "$want" != "$got" ]; then
    die "checksum mismatch for the downloaded tarball.
  expected $want
  got      $got
  Refusing to install."
  fi
  info "checksum verified"
}

# ----------------------------------------------------------------- unpacking

# npm tarballs and release tarballs both use a single top-level `package/`
# directory. Normalising to that shape here means one extraction path for both.
unpack_into() {
  tarball="$1"; dest="$2"
  mkdir -p "$dest"
  # Strip exactly one leading path component. GNU and bsdtar both support this.
  tar -xzf "$tarball" -C "$dest" --strip-components=1 2>/dev/null \
    || tar -xzf "$tarball" -C "$dest" 2>/dev/null \
    || die "could not unpack $tarball"
}

# The launcher prefers dist/ and falls back to the TypeScript sources, so the
# real runtime floor depends on whether the build shipped.
check_runtime_floor() {
  root="$1"
  major="$(node_major)"
  if [ -f "$root/dist/cli/repl.js" ]; then
    need=20
    why="dist/ (plain JS)"
  else
    need=22
    why="src/ (Node's native TypeScript stripping, needs >= 22.6)"
  fi
  if [ "$major" -lt "$need" ]; then
    die "Node $(node -v 2>/dev/null || echo "$major") is too old.
  This build runs from $why and needs Node >= $need."
  fi
  info "node $(node -v 2>/dev/null) ok (running $why)"
}

link_exe() {
  target="$1"
  mkdir -p "$BINDIR"
  rm -f "$EXE"
  # A symlink is enough: Node resolves it, so the launcher still derives its own
  # root from lib/warhead and finds dist/ and src/ correctly. Fall back to a
  # wrapper where symlinks are unavailable or refused.
  if ln -s "$target" "$EXE" 2>/dev/null; then
    chmod +x "$target" 2>/dev/null || true
    return 0
  fi
  cat > "$EXE" <<EOF
#!/bin/sh
exec "$(command -v node)" "$target" "\$@"
EOF
  chmod +x "$EXE"
}

check_path() {
  case ":${PATH}:" in
    *":$BINDIR:"*) return 0 ;;
  esac
  printf '\n  %s is not on your PATH.\n' "$BINDIR"
  printf '  Add this to your shell profile:\n\n'
  printf '    export PATH="%s:$PATH"\n\n' "$BINDIR"
  return 0
}

# ----------------------------------------------------------------- uninstall

do_uninstall() {
  removed=0
  if [ -e "$EXE" ] || [ -L "$EXE" ]; then
    rm -f "$EXE"
    info "removed $EXE"
    removed=1
  fi
  if [ -d "$LIBDIR" ]; then
    rm -rf "$LIBDIR"
    info "removed $LIBDIR"
    removed=1
  fi
  # rmdir refuses to act on a non-empty directory, which is exactly the safety
  # property needed here: --prefix /usr/local must never lose its other contents.
  # These only ever come out if we emptied them.
  rmdir "$(dirname "$LIBDIR")" 2>/dev/null || true
  rmdir "$BINDIR" 2>/dev/null || true
  rmdir "$PREFIX" 2>/dev/null || true
  if [ "$PURGE" -eq 1 ]; then
    # Both paths are overridable in config.ts; purge only what actually exists.
    for d in "${XDG_CONFIG_HOME:-$HOME/.config}/$PACKAGE" \
             "${XDG_STATE_HOME:-$HOME/.local/state}/$PACKAGE"; do
      if [ -d "$d" ]; then
        rm -rf "$d"
        info "removed $d"
        removed=1
      fi
    done
    printf '\n  config and transcripts deleted — this cannot be undone.\n'
  fi
  [ "$removed" -eq 1 ] || info "nothing installed under $PREFIX; nothing to do"
  printf '\n  uninstalled.\n'
}

# ------------------------------------------------------------------- install

do_install() {
  require_node

  TMPDIR_="$(mktemp -d 2>/dev/null || mktemp -d -t warhead)" \
    || die "could not create a temporary directory"

  step "resolving release"
  if [ -n "$FROM" ]; then
    [ -e "$FROM" ] || die "--from path does not exist: $FROM"
    case "$FROM" in
      *.tgz|*.tar.gz)
        PAYLOAD="$FROM"
        info "using local tarball $(basename "$PAYLOAD")"
        ;;
      *)
        # A directory is installed as-is. Useful for `npm run build` workflows
        # and for testing the installer against a working tree.
        PAYLOAD=""
        info "installing from directory $(cd "$FROM" && pwd)"
        ;;
    esac
  else
    TAG="$(resolve_version)"
    info "release $TAG"
    # Git tags conventionally carry a leading "v"; `npm pack` does not. The tag
    # is the release's URL path but the asset name must match the tarball npm
    # actually produced, so strip it here rather than requiring one convention
    # of the person cutting the release.
    ASSET="$PACKAGE-${TAG#v}.tgz"
    base="https://github.com/$REPO/releases/download/$TAG"
    PAYLOAD="$TMPDIR_/$ASSET"
    fetch_to "$base/$ASSET" "$PAYLOAD"
    fetch_to "$base/$ASSET.sha256" "$TMPDIR_/$ASSET.sha256" 2>/dev/null || true
    [ -f "$TMPDIR_/$ASSET.sha256" ] \
      && verify_checksum "$PAYLOAD" "$TMPDIR_/$ASSET.sha256"
  fi

  step "installing to $PREFIX"
  # Replace wholesale rather than merging: a half-overwritten tree is how stale
  # modules survive an upgrade and then get loaded.
  rm -rf "$LIBDIR"
  if [ -n "$PAYLOAD" ]; then
    unpack_into "$PAYLOAD" "$LIBDIR"
  else
    src="$(cd "$FROM" && pwd)"
    mkdir -p "$LIBDIR"
    for item in bin dist src package.json README.md LICENSE; do
      [ -e "$src/$item" ] || continue
      cp -R "$src/$item" "$LIBDIR/"
    done
  fi

  [ -f "$LIBDIR/package.json" ] || die "payload has no package.json — not a warhead package"
  [ -f "$LIBDIR/bin/$PACKAGE-cli.js" ] || die "payload is missing bin/$PACKAGE-cli.js"

  chmod +x "$LIBDIR/bin/$PACKAGE-cli.js" 2>/dev/null || true
  check_runtime_floor "$LIBDIR"

  step "linking executable"
  link_exe "$LIBDIR/bin/$PACKAGE-cli.js"
  info "$EXE -> $LIBDIR/bin/$PACKAGE-cli.js"

  INSTALLED_VERSION=""
  if [ "$VERIFY" -eq 1 ]; then
    step "verifying"
    INSTALLED_VERSION="$("$EXE" --version 2>/dev/null || true)"
    if [ -n "$INSTALLED_VERSION" ]; then
      info "warhead-cli $INSTALLED_VERSION"
    else
      die "installed, but 'warhead-cli --version' failed.
  Try running $EXE by hand to see the error."
    fi
  fi

  step "done"
  if [ -n "$INSTALLED_VERSION" ]; then
    printf '  warhead-cli %s installed.\n\n' "$INSTALLED_VERSION"
  else
    printf '  warhead-cli installed.\n\n'
  fi
  check_path
  printf '  Start it with:  %s\n' "$PACKAGE-cli"
  printf '  It needs an Ollama model that emits tool calls; see README.md.\n'
}

if [ "$ACTION" = "uninstall" ]; then
  do_uninstall
else
  do_install
fi
