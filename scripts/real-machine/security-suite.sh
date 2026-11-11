#!/usr/bin/env bash
# 安全汇总套件的环境前置检查（2026-11-11）。
#
# 为什么需要 shell 包装：`security-suite.ts` 静态 import 了 runtime 模块，而 runtime
# 在 import 期就会加载 `node:sqlite`。Node 版本不达标时会在到达文件内的版本守卫之前
# 就抛 `ERR_UNKNOWN_BUILTIN_MODULE`——报错位置在深层依赖里，看不出是环境问题。
# 这里在**启动 node 之前**判定，给出可执行指引，而不是让人对着一行 builtin 报错猜。
#
# 用法：
#   pnpm security:suite                    # 推荐（自动选对 node）
#   bash scripts/real-machine/security-suite.sh --out docs/gates/m6-security-summary.md
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 优先用 PATH 里的 node；若过旧且存在 homebrew node 24，则自动切过去
pick_node() {
  local candidate
  for candidate in "$(command -v node || true)" /opt/homebrew/bin/node ~/.homebrew/bin/node; do
    [ -n "${candidate}" ] && [ -x "${candidate}" ] || continue
    local version major minor
    version="$("${candidate}" --version 2>/dev/null | sed 's/^v//')"
    major="${version%%.*}"
    minor="$(printf '%s' "${version}" | cut -d. -f2)"
    if [ "${major:-0}" -gt 22 ] || { [ "${major:-0}" -eq 22 ] && [ "${minor:-0}" -ge 16 ]; }; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(pick_node || true)"
if [ -z "${NODE_BIN}" ]; then
  cat >&2 <<'EOF'
[security-suite] 运行环境不满足要求：需要 Node >= 22.16（内建 SQLite 含 FTS5）。

当前 node：$(node --version 2>/dev/null || echo 未安装)
可选处理：
  1) 用 homebrew 的 node 24：PATH="/opt/homebrew/bin:$PATH" pnpm security:suite
  2) 升级系统 node 到 >= 22.16
注意：Node 22.13–22.15 即使带 --experimental-sqlite 也没有 FTS5，记忆相关域必然失败——
那是环境不达标，不是产品缺陷。
EOF
  exit 2
fi

echo "[security-suite] node: ${NODE_BIN} ($("${NODE_BIN}" --version))"
exec "${NODE_BIN}" --experimental-sqlite --experimental-strip-types "${DIR}/security-suite.ts" "$@"
