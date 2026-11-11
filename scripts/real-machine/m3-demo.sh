#!/usr/bin/env bash
# =============================================================================
# Morrow M3 端到端演示（票 M3-T7 / Issue #36；PRD §9 M3 门槛）
#
#   两轮独立执行，每轮 10 项断言：
#     配对（POST /v1/pairing/join）→ 双向同步 → 删除传播（A 删、B 不复活）
#     → 冲突分类（preference 自动合并 / locked 待审核）→ 任务执行权转移
#     → needs_reconcile 检测与 Owner 裁决。
#
# 前置：repo 根目录已 pnpm install；node ≥ 22.16（FTS5）；本机回环，零真实网络/LLM。
# 用法：bash scripts/real-machine/m3-demo.sh [--out <md>] [--keep]
# 输出：默认写 docs/gates/m3-demo-output.md；stdout 同时打印 JSON 与 Markdown；
#       退出码 0 = 两轮全部 10/10。
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="${NODE:-node}"
if ! command -v "${NODE_BIN}" >/dev/null 2>&1; then
  echo "[m3-demo] node not found in PATH" >&2
  exit 1
fi
exec "${NODE_BIN}" --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-sqlite --experimental-strip-types \
  "${ROOT}/scripts/real-machine/m3-demo.ts" "$@"
