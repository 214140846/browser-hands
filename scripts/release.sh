#!/bin/sh
# 产出 GitHub Release 资产到 release/：thundermcp.mjs、extension.tar.gz、install.sh
set -eu
cd "$(dirname "$0")/.."
rm -rf release && mkdir release
bun run build
cp dist/thundermcp.mjs release/
tar -czf release/extension.tar.gz -C extension .
cp install.sh release/
( cd release && shasum -a 256 * > SHA256SUMS )
ls -l release
