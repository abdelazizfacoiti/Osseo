#!/bin/sh
# AgentHost one-line installer (Linux x86_64).
#   curl -fsSL <url>/install.sh | sh
#   sh install.sh [--dry-run] [--help]
# Archive source, first match wins:
#   AGENTHOST_ARCHIVE      local archive path (the .sha256 file sits next to it)
#   AGENTHOST_ARCHIVE_URL  archive URL (the .sha256 file is at the same URL plus .sha256)
#   otherwise              latest GitHub release of abdelazizfacoiti/AgentHost
# Installs under ~/.local/share/agenthost and ~/.local/bin only. Never uses sudo.

REPO="abdelazizfacoiti/AgentHost"
ASSET="agenthost-linux-x64.tar.gz"

say() { printf '%s\n' "$*"; }
die() { printf 'agenthost install: %s\n' "$*" >&2; exit 1; }

usage() {
  say "Usage: sh install.sh [--dry-run] [--help]"
  say "Installs AgentHost into ~/.local/share/agenthost and ~/.local/bin/agenthost."
  say "Environment: AGENTHOST_ARCHIVE (local archive path), AGENTHOST_ARCHIVE_URL (archive URL)."
  say "The SHA-256 is always checked against the .sha256 file next to the archive."
}

agenthost_install() {
  dry=0
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry=1 ;;
      --help|-h) usage; return 0 ;;
      *) usage >&2; die "unknown option: $arg" ;;
    esac
  done

  [ "$(uname -s)" = "Linux" ] || die "Linux is required."
  case "$(uname -m)" in x86_64|amd64) ;; *) die "x86_64 is required." ;; esac
  command -v node >/dev/null 2>&1 || die "node is missing. Install Node 20 or newer."
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || node_major=0
  case "$node_major" in ''|*[!0-9]*) node_major=0 ;; esac
  [ "$node_major" -ge 20 ] || die "Node 20 or newer is required (found $(node -v 2>/dev/null))."
  command -v tar >/dev/null 2>&1 || die "tar is missing."
  command -v sha256sum >/dev/null 2>&1 || die "sha256sum is missing."
  if command -v curl >/dev/null 2>&1; then dl=curl
  elif command -v wget >/dev/null 2>&1; then dl=wget
  else die "curl or wget is required."; fi
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not set to a directory."
  case "$HOME" in *[\"\\]*) die "HOME contains a quote or backslash." ;; esac

  if [ -n "${AGENTHOST_ARCHIVE:-}" ]; then
    source_kind=file; source_ref=$AGENTHOST_ARCHIVE
    [ -f "$source_ref" ] || die "AGENTHOST_ARCHIVE not found: $source_ref"
    [ -f "$source_ref.sha256" ] || die "checksum file missing: $source_ref.sha256"
  elif [ -n "${AGENTHOST_ARCHIVE_URL:-}" ]; then
    source_kind=url; source_ref=$AGENTHOST_ARCHIVE_URL
  else
    source_kind=url; source_ref="https://github.com/$REPO/releases/latest/download/$ASSET"
  fi

  share="$HOME/.local/share/agenthost"
  bin="$HOME/.local/bin"

  if [ "$dry" -eq 1 ]; then
    say "Dry run. Nothing will be changed."
    say "Archive: $source_ref"
    say "Check SHA-256 against: $source_ref.sha256"
    say "Install to: $share/current"
    say "Write launcher: $bin/agenthost"
    return 0
  fi

  work=$(mktemp -d "${TMPDIR:-/tmp}/agenthost-install.XXXXXX") || die "cannot create a temporary directory."
  trap 'rm -rf "$work"' EXIT
  trap 'exit 1' HUP INT TERM
  mkdir "$work/dl" "$work/x" || die "cannot create a temporary directory."

  archive="$work/dl/$ASSET"
  if [ "$source_kind" = file ]; then
    cp "$source_ref" "$archive" || die "cannot copy the archive."
    cp "$source_ref.sha256" "$archive.sha256" || die "cannot copy the checksum file."
  else
    fetch "$dl" "$source_ref" "$archive" || die "download failed: $source_ref"
    fetch "$dl" "$source_ref.sha256" "$archive.sha256" || die "checksum file missing: $source_ref.sha256"
  fi

  expected=$(sed -n '1s/^[[:space:]]*\([0-9a-fA-F]\{64\}\)\([[:space:]].*\)\{0,1\}$/\1/p' "$archive.sha256" | tr 'A-F' 'a-f')
  [ -n "$expected" ] || die "checksum file is not a SHA-256 digest."
  actual=$(sha256sum "$archive" | cut -d ' ' -f 1)
  [ "$expected" = "$actual" ] || die "SHA-256 mismatch. Nothing was installed."

  tar -tzf "$archive" >"$work/list" 2>/dev/null || die "the archive cannot be read."
  if grep -q -e '^/' -e '\.\./' "$work/list"; then die "the archive has unsafe paths."; fi
  tar -xzf "$archive" -C "$work/x" || die "cannot unpack the archive."
  top=$(find "$work/x" -mindepth 1 -maxdepth 1 -type d)
  [ -n "$top" ] && [ "$(printf '%s\n' "$top" | wc -l)" -eq 1 ] || die "unexpected archive layout."
  [ -f "$top/version.json" ] && [ -f "$top/bin/agenthost.mjs" ] || die "the archive is not an AgentHost release."
  version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([0-9A-Za-z.-]*\)".*/\1/p' "$top/version.json" | head -n 1)
  [ -n "$version" ] || die "cannot read the release version."

  current="$share/current"
  installed=""
  if [ -f "$current/version.json" ]; then
    installed=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([0-9A-Za-z.-]*\)".*/\1/p' "$current/version.json" | head -n 1)
  fi
  if [ "$installed" = "$version" ] && [ -x "$bin/agenthost" ]; then
    say "AgentHost $version is already installed in $current."
  else
    # The release's own updater does the checksum check again, unpacks to
    # releases/<version>, switches `current` and keeps `current.previous`.
    node "$top/bin/agenthost.mjs" update --archive "$archive" --sha256 "$actual" --apply >"$work/update.log" 2>&1 \
      || { cat "$work/update.log" >&2; die "the release updater failed."; }
    [ -f "$current/bin/agenthost.mjs" ] || die "install did not produce $current."
    write_launcher "$bin" "$current"
    if [ -n "$installed" ]; then say "Upgraded AgentHost $installed to $version in $current."
    else say "Installed AgentHost $version in $current."; fi
  fi

  case ":${PATH:-}:" in
    *":$bin:"*) say "$bin is on your PATH." ;;
    *) say "$bin is not on your PATH. Add this line to your shell profile:"
       say "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
  say "Next: agenthost integrations <client> add --apply   (opencode, claude, codex, copilot, copilot-cli, cursor)"
}

# fetch <curl|wget> <url> <file>
fetch() {
  if [ "$1" = curl ]; then curl -fsSL -o "$3" "$2"; else wget -q -O "$3" "$2"; fi
}

# Same launcher that scripts/install-release.mjs writes.
write_launcher() {
  mkdir -p "$1" || die "cannot create $1."
  chmod 700 "$1" 2>/dev/null || true
  tmp="$1/.agenthost.$$"
  {
    printf '#!/usr/bin/env node\n'
    printf 'process.env.AGENTHOST_RELEASE_ROOT="%s";\n' "$2"
    printf 'await import("%s");\n' "$2/bin/agenthost.mjs"
  } >"$tmp" || die "cannot write the launcher."
  chmod 700 "$tmp" && mv -f "$tmp" "$1/agenthost" || die "cannot install the launcher."
}

agenthost_install "$@"
