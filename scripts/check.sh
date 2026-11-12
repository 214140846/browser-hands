#!/bin/sh
# 每个单测文件单独起进程：有的模块导入时就往全局 chrome 上挂监听，同进程会互相干扰
# 用法：sh scripts/check.sh [文件...]（不传则跑全部）；全部跑完再汇总
cd "$(dirname "$0")/.."
files=${*:-test/unit/*.test.ts}
fail=0
mkdir -p "${THUNDERMCP_TEST_TMP:-/tmp/thundermcp-test}"
for f in $files; do
  log=${THUNDERMCP_TEST_TMP:-/tmp/thundermcp-test}/check-$$-$(basename "$f").log
  if bun test "$f" >"$log" 2>&1; then echo "ok    $f  $(grep -Eo '[0-9]+ pass' "$log")"; else echo "FAIL  $f  $(grep -Eo '[0-9]+ (pass|fail)' "$log" | tr '\n' ' ')"; fail=1; fi
done
exit $fail
