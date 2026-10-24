#!/bin/sh
#
# warhead-cli installer.
#
# Installs `warhead-cli` plus its application-local REA MCP dependencies. No
# global package install is required; npm ci populates the private runtime tree.
#
#   ./install.sh                                  # latest release -> ~/.local
#   ./install.sh --prefix /usr/local              # system-wide (needs write access)
#   ./install.sh --version 0.1.0-rc.3             # pin a release
#   ./install.sh --from ./warhead-0.1.0-rc.3.tgz  # install a local tarball
#   ./install.sh --from .                         # install this checkout, as-is
#   ./install.sh --dry-run                        # report what would happen
#   ./install.sh uninstall                        # remove the executable
#   ./install.sh uninstall --purge                # ...and config + transcripts
#
# Environment overrides: WARHEAD_PREFIX, WARHEAD_VERSION.
#
# POSIX sh only, no bashisms: the tool itself is POSIX-only, so the installer
# should not raise the floor for installing it.

set -eu

REPO="BrokenPorkMachine/warhead"
PACKAGE="warhead"

PREFIX="${WARHEAD_PREFIX:-${HOME}/.local}"
VERSION="${WARHEAD_VERSION:-}"
FROM=""
PURGE=0
VERIFY=1
DRYRUN=0
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
                    (default: $HOME/.local, or $WARHEAD_PREFIX)
  --version TAG     install a specific release tag (default: newest release)
  --from PATH       install from a local .tgz, or from a source directory with .
                    Bypasses the network; this is what CI and local testing use.
  --dry-run         resolve and report what would happen; change nothing
  --purge           with uninstall, also delete config and transcripts (IRREVERSIBLE)
  --no-verify       skip the post-install "warhead-cli --version" check
  -h, --help        this message

Environment
  WARHEAD_PREFIX    same as --prefix
  WARHEAD_VERSION   same as --version

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
    --dry-run) DRYRUN=1 ;;
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
  command -v node >/dev/null 2>&1 || return 1
  command -v node
}

node_supported() {
  node -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number);process.exit((major===22&&minor>=19)||(major===24&&minor>=11)||major>=26?0:1)' 2>/dev/null
}

require_node() {
  find_node >/dev/null 2>&1 || die "node not found on PATH. Install Node 22.19+, 24.11+, or 26+: https://nodejs.org"
}

require_npm() {
  command -v npm >/dev/null 2>&1 || die "npm not found on PATH. Warhead's bundled REA MCP runtime needs its application dependencies installed with npm."
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

# Single HTTP entry point, so proxy/CA/retry flags are stated once rather than
# per call site. Writes to stdout; returns non-zero on any failure.
http_get() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O- "$1"
  else
    die "neither curl nor wget is available; install one, or fetch the tarball by hand and use --from"
  fi
}

fetch_to() {
  # fetch_to <url> <destination> — required asset, failure is fatal.
  http_get "$1" >"$2" || die "download failed: $1"
}

fetch_optional() {
  # fetch_optional <url> <destination> — best-effort asset, failure is silent.
  #
  # This must NOT reuse fetch_to. fetch_to calls die on failure, and die exits,
  # so `fetch_to ... || true` can never rescue it: the script is already gone by
  # the time || sees a status. A release that ships no .sha256 sidecar would
  # fail to install over a file that was only ever optional.
  http_get "$1" >"$2" 2>/dev/null || { rm -f "$2"; return 1; }
  return 0
}

# Picks the release to install.
#
# Deliberately uses the *list* endpoint, not /releases/latest: GitHub excludes
# prereleases from "latest", so on a project whose only releases are RCs — which
# is what this one is — /releases/latest 404s and there is no latest to find.
# The list includes prereleases; drafts are skipped and the newest by publish
# date wins.
#
# Kept separate from fetching so a local --from install never touches the
# network at all.
resolve_version() {
  if [ -n "$VERSION" ]; then
    printf '%s' "$VERSION"
    return 0
  fi

  api="https://api.github.com/repos/$REPO/releases?per_page=20"

  # Fetched without curl's -f, unlike http_get. A 404 here means "this repo has
  # no releases yet", which is a normal state for a project that has not shipped
  # one — and the body says exactly that. -f would collapse it into "could not
  # reach", sending the user off to debug their network instead. The empty-body
  # check below then still catches a genuinely unreachable API.
  if command -v curl >/dev/null 2>&1; then
    json="$(curl -sSL --retry 3 --retry-delay 2 "$api" 2>/dev/null || true)"
  elif command -v wget >/dev/null 2>&1; then
    json="$(wget -q -O- "$api" 2>/dev/null || true)"
  else
    json=""
  fi

  [ -n "$json" ] || die "could not reach the GitHub API to find the latest release.
  Check your network, or pin a version explicitly:
    ./install.sh --version <tag>
  or install a tarball you already have:
    ./install.sh --from ./$PACKAGE-<tag>.tgz"

  # Parsed with node rather than sed: node is already a hard requirement, and
  # walking JSON with tr/sed cannot tell a draft from a published release.
  tag="$(printf '%s' "$json" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      let r;
      try { r = JSON.parse(s) } catch { process.exit(1) }
      const all = Array.isArray(r) ? r : [r];
      const live = all.filter(x => x && x.tag_name && !x.draft);
      live.sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
      if (live[0]) process.stdout.write(live[0].tag_name);
    });
  ' 2>/dev/null || true)"

  [ -n "$tag" ] || die "no published release found for $REPO.
  The API may be rate-limited, or no release has been published yet.
  Pin a version explicitly:
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
  if command -v sha256sum >/dev/null 2>&1; then
    want="$(awk '{print $1; exit}' "$sums")"
    got="$(sha256sum "$tarball" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    want="$(awk '{print $1; exit}' "$sums")"
    got="$(shasum -a 256 "$tarball" | awk '{print $1}')"
  else
    info "no sha256sum/shasum available; skipping checksum verification"
    return 0
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
# directory, so one extraction path covers both. The second attempt handles a
# tarball built without that prefix, where stripping a component would eat a
# real directory name.
unpack_into() {
  tarball="$1"; dest="$2"
  mkdir -p "$dest"
  tar -xzf "$tarball" -C "$dest" --strip-components=1 2>/dev/null \
    || tar -xzf "$tarball" -C "$dest" 2>/dev/null \
    || die "could not unpack $tarball"
}

# The launcher prefers dist/ and falls back to the TypeScript sources, so the
# real runtime floor depends on whether the build shipped.
check_runtime_floor() {
  root="$1"
  why="bundled REA MCP runtime"
  if ! node_supported; then
    die "Node $(node -v 2>/dev/null || echo unknown) is too old.
  Warhead bundles REA, which requires Node 22.19+, 24.11+, or 26+."
  fi
  info "node $(node -v 2>/dev/null) ok (running $why)"
}

# Best-effort read of an installed version, for upgrade reporting. Prints
# nothing rather than failing when there is no readable install.
installed_version() {
  [ -f "$LIBDIR/package.json" ] || return 0
  node -p "require('$LIBDIR/package.json').version" 2>/dev/null || true
}

link_exe() {
  target="$1"
  mkdir -p "$BINDIR"
  rm -f "$EXE"
  # A symlink is enough: Node resolves it, so the launcher still derives its own
  # root from lib/warhead and finds dist/ and src/ correctly.
  if ln -s "$target" "$EXE" 2>/dev/null; then
    chmod +x "$target" 2>/dev/null || true
    return 0
  fi
  # Fallback where symlinks are unavailable or refused. Exec the target rather
  # than `node <target>`: the target carries a `#!/usr/bin/env node` shebang, so
  # node is resolved from PATH at run time. Baking in the absolute path of
  # whatever node happened to be installed today leaves a wrapper that breaks
  # silently after a version-manager or homebrew upgrade.
  cat > "$EXE" <<EOF
#!/bin/sh
exec "$target" "\$@"
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

  step "resolving release"
  if [ -n "$FROM" ]; then
    [ -e "$FROM" ] || die "--from path does not exist: $FROM"
    case "$FROM" in
      *.tgz|*.tar.gz)
        PAYLOAD="$FROM"
        info "using local tarball $(basename "$PAYLOAD")"
        # Verify a sidecar if one sits beside the tarball. A tarball passed by
        # hand is exactly as trustworthy as wherever it was downloaded from, so
        # this closes the same gap the network path closes.
        sidecar="$PAYLOAD.sha256"
        if [ -f "$sidecar" ]; then
          verify_checksum "$PAYLOAD" "$sidecar"
        else
          info "no .sha256 sidecar beside the tarball; skipping verification"
        fi
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
    if [ "$DRYRUN" -eq 1 ]; then
      info "would download $base/$ASSET"
      info "would verify  $base/$ASSET.sha256 (if published)"
    else
      # Stage on the installation filesystem: /tmp can have a separate quota
      # even when the destination has ample space for the release.
      mkdir -p "$PREFIX/lib"
      TMPDIR_="$(mktemp -d "$PREFIX/lib/.warhead-download.XXXXXX")" \
        || die "could not create temporary storage under $PREFIX/lib"
      PAYLOAD="$TMPDIR_/$ASSET"
      fetch_to "$base/$ASSET" "$PAYLOAD"
      if fetch_optional "$base/$ASSET.sha256" "$TMPDIR_/$ASSET.sha256"; then
        verify_checksum "$PAYLOAD" "$TMPDIR_/$ASSET.sha256"
      else
        info "no checksum published for this release; skipping verification"
      fi
    fi
  fi

  step "installing to $PREFIX"
  OLD="$(installed_version)"
  if [ -n "$OLD" ]; then
    info "replacing installed version $OLD"
  fi

  if [ "$DRYRUN" -eq 1 ]; then
    info "would install runtime to $LIBDIR"
    info "would install application dependencies with npm install"
    info "would link executable  $EXE"
    check_path
    step "dry run"
    printf '  Nothing was changed.\n'
    return 0
  fi

  # Replace wholesale rather than merging: a half-overwritten tree is how stale
  # modules survive an upgrade and then get loaded.
  rm -rf "$LIBDIR"
  if [ -n "$PAYLOAD" ]; then
    unpack_into "$PAYLOAD" "$LIBDIR"
  else
    src="$(cd "$FROM" && pwd)"
    mkdir -p "$LIBDIR"
    for item in bin dist src rea native package.json README.md LICENSE; do
      [ -e "$src/$item" ] || continue
      cp -R "$src/$item" "$LIBDIR/"
    done
    # A checkout can carry caches, a nested REA git repository, and a native
    # .build tied to the old absolute path. None of that belongs in an install;
    # the release tarball omits it already, so this is a no-op there.
    rm -rf "$LIBDIR/rea/node_modules" "$LIBDIR/rea/.git" "$LIBDIR/rea/.turbo" \
      "$LIBDIR/rea/.cache" "$LIBDIR/native/warhead-runtime/.build"
  fi

  [ -f "$LIBDIR/package.json" ] || die "payload has no package.json — not a warhead package"
  [ -f "$LIBDIR/bin/$PACKAGE-cli.js" ] || die "payload is missing bin/$PACKAGE-cli.js"
  require_npm
  step "installing application dependencies"
  (cd "$LIBDIR" && HUSKY=0 npm install --omit=dev --package-lock=false --no-audit --no-fund) || die "could not install Warhead's application dependencies"

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
    if [ -n "$OLD" ] && [ "$OLD" != "$INSTALLED_VERSION" ]; then
      printf '  warhead-cli upgraded %s -> %s.\n\n' "$OLD" "$INSTALLED_VERSION"
    else
      printf '  warhead-cli %s installed.\n\n' "$INSTALLED_VERSION"
    fi
  else
    printf '  warhead-cli installed.\n\n'
  fi
  check_path
  printf '  Start it with:  %s\n' "$PACKAGE-cli"
  printf '  Configure a local MLX or GGUF model with WARHEAD_MODEL; see README.md.\n'
}

if [ "$ACTION" = "uninstall" ]; then
  do_uninstall
else
  do_install
fi
