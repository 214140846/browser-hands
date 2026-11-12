#!/bin/sh
# ThunderMCP installer (macOS + Linux, POSIX sh).
#
#   curl -fsSL https://github.com/214140846/thundermcp/releases/latest/download/install.sh | sh
#   sh install.sh [--dry-run] [--browser chrome|chromium|chrome-for-testing] [--dir DIR] [--uninstall]
#
# What it does:
#   1. checks for Node.js 18+
#   2. puts thundermcp.mjs and the extension/ folder under ~/.thundermcp
#   3. runs `node thundermcp.mjs setup` (registers the Chrome native messaging host)
#   4. registers the MCP server with Claude Code if the `claude` CLI exists
#   5. prints the remaining manual steps (load the extension, other MCP clients)
# Safe to re-run.

# --- Placeholders: replace both before publishing a release -----------------
# Base URL that serves the release assets: thundermcp.mjs and extension.tar.gz
INSTALL_URL="${THUNDERMCP_INSTALL_URL:-https://github.com/214140846/thundermcp/releases/latest/download}"
# Source repository (shown in messages)
REPO_URL="https://github.com/214140846/thundermcp"
# -----------------------------------------------------------------------------

set -eu

DEST="${THUNDERMCP_HOME:-$HOME/.thundermcp}"
BROWSER="chrome"
HOST_DIR=""
DRY=0
UNINSTALL=0

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
# Run a command, or only print it with --dry-run.
run() {
  if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --browser) [ $# -ge 2 ] || die "--browser needs a value"; BROWSER="$2"; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; HOST_DIR="$2"; shift ;;
    -h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# --- Platform ----------------------------------------------------------------
case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  *) die "unsupported OS '$(uname -s)'. ThunderMCP supports macOS and Linux." ;;
esac

# Native messaging host directory. The bundled `setup` command only knows macOS
# paths, so on Linux we pass --dir explicitly.
if [ -z "$HOST_DIR" ] && [ "$OS" = linux ]; then
  case "$BROWSER" in
    chrome) HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts" ;;
    chromium) HOST_DIR="$HOME/.config/chromium/NativeMessagingHosts" ;;
    *) die "on Linux, pass --dir for browser '$BROWSER'" ;;
  esac
fi

# --- Dependencies ------------------------------------------------------------
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  if [ "$DRY" = 1 ]; then
    say "[dry-run] warning: node not found; a real run would stop here"
    NODE="node"
  else
    die "Node.js 18+ is required but 'node' was not found. Install it from https://nodejs.org and re-run."
  fi
else
  NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node.js 18+ is required (found $("$NODE" -v)). Please upgrade."
fi

SETUP_ARGS="--browser $BROWSER"
[ -n "$HOST_DIR" ] && SETUP_ARGS="$SETUP_ARGS --dir $HOST_DIR"

# --- Uninstall ---------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  if [ -f "$DEST/thundermcp.mjs" ]; then
    # shellcheck disable=SC2086
    run "$NODE" "$DEST/thundermcp.mjs" setup --uninstall $SETUP_ARGS
  fi
  if command -v claude >/dev/null 2>&1; then
    if [ "$DRY" = 1 ]; then say "[dry-run] claude mcp remove thundermcp -s user"; else claude mcp remove thundermcp -s user >/dev/null 2>&1 || true; fi
  fi
  run rm -rf "$DEST"
  say "ThunderMCP removed. Remove the extension from chrome://extensions manually."
  exit 0
fi

# --- Fetch or copy files -----------------------------------------------------
# If this script sits in a built source checkout, use it; otherwise download.
SELF_DIR=""
case "$0" in */*) SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)" ;; esac

say "Installing ThunderMCP into $DEST"
run mkdir -p "$DEST"

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/dist/thundermcp.mjs" ] && [ -f "$SELF_DIR/extension/manifest.json" ]; then
  say "Using local build from $SELF_DIR"
  run cp "$SELF_DIR/dist/thundermcp.mjs" "$DEST/thundermcp.mjs"
  run rm -rf "$DEST/extension"
  run cp -R "$SELF_DIR/extension" "$DEST/extension"
else
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || { [ "$DRY" = 1 ] || die "curl or wget is required to download ThunderMCP."; }
  command -v tar >/dev/null 2>&1 || { [ "$DRY" = 1 ] || die "tar is required."; }
  TMP="${TMPDIR:-/tmp}/thundermcp-install.$$"
  trap 'rm -rf "$TMP"' EXIT INT TERM
  fetch() { # fetch URL OUT
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -q "$1" -O "$2"; fi
  }
  if [ "$DRY" = 1 ]; then
    say "[dry-run] download $INSTALL_URL/thundermcp.mjs -> $DEST/thundermcp.mjs"
    say "[dry-run] download $INSTALL_URL/extension.tar.gz and unpack to $DEST/extension"
  else
    mkdir -p "$TMP"
    fetch "$INSTALL_URL/thundermcp.mjs" "$TMP/thundermcp.mjs" || die "could not download $INSTALL_URL/thundermcp.mjs. Check your network, or build from source: $REPO_URL"
    fetch "$INSTALL_URL/extension.tar.gz" "$TMP/extension.tar.gz" || die "could not download $INSTALL_URL/extension.tar.gz"
    mkdir -p "$TMP/ext"
    tar -xzf "$TMP/extension.tar.gz" -C "$TMP/ext" || die "extension archive is corrupt"
    [ -f "$TMP/ext/manifest.json" ] || die "extension archive must contain manifest.json at its top level"
    cp "$TMP/thundermcp.mjs" "$DEST/thundermcp.mjs"
    rm -rf "$DEST/extension"
    cp -R "$TMP/ext" "$DEST/extension"
  fi
fi

# --- Native messaging host ---------------------------------------------------
say "Registering the Chrome native messaging host ($BROWSER)"
# shellcheck disable=SC2086
run "$NODE" "$DEST/thundermcp.mjs" setup $SETUP_ARGS

# --- MCP client registration -------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  say "Registering with Claude Code"
  if [ "$DRY" = 1 ]; then
    say "[dry-run] claude mcp remove thundermcp -s user   # ignore errors; keeps re-runs idempotent"
    say "[dry-run] claude mcp add thundermcp -s user -- \"$NODE\" \"$DEST/thundermcp.mjs\" mcp"
  else
    claude mcp remove thundermcp -s user >/dev/null 2>&1 || true
    claude mcp add thundermcp -s user -- "$NODE" "$DEST/thundermcp.mjs" mcp \
      || die "'claude mcp add' failed. Run it manually: claude mcp add thundermcp -s user -- \"$NODE\" \"$DEST/thundermcp.mjs\" mcp"
  fi
else
  say ""
  say "Claude Code CLI not found. For Claude Code, install it and run:"
  say "  claude mcp add thundermcp -s user -- \"$NODE\" \"$DEST/thundermcp.mjs\" mcp"
fi

say ""
say "For other MCP clients (Cursor, Codex, ...), add this server to their config:"
cat <<JSON
  { "mcpServers": { "thundermcp": { "command": "$NODE", "args": ["$DEST/thundermcp.mjs", "mcp"] } } }
JSON

say ""
say "Last step: load the extension in Chrome"
say "  1. Open chrome://extensions"
say "  2. Turn on \"Developer mode\" (top right)"
say "  3. Click \"Load unpacked\" and choose: $DEST/extension"
say "  4. Restart your MCP client so it picks up the new server."
say ""
if [ "$DRY" = 1 ]; then say "Dry run finished. Nothing was changed."; else say "Done. Docs: $REPO_URL"; fi
