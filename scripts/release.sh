#!/bin/sh
# 产出 GitHub Release 资产到 release/：thundermcp.mjs、extension.tar.gz、install.sh
set -eu
cd "$(dirname "$0")/.."
rm -rf release && mkdir release
bun run build
cp dist/thundermcp.mjs release/
# Smoke test: the bundle must start on its own, with no sibling files
smoke=$(mktemp -d "${TMPDIR:-/tmp}/thundermcp-smoke.XXXXXX")
cp release/thundermcp.mjs "$smoke/"
( cd "$smoke" && printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | node thundermcp.mjs mcp > out.log 2>&1 ) &
sleep 3; kill $! 2>/dev/null || true
grep -q '"serverInfo"' "$smoke/out.log" \
  || { echo "smoke test failed: bundle does not start standalone" >&2; cat "$smoke/out.log" >&2; rm -rf "$smoke"; exit 1; }
rm -rf "$smoke"
tar -czf release/extension.tar.gz -C extension .
cp install.sh release/
( cd release && shasum -a 256 * > SHA256SUMS )
ls -l release
