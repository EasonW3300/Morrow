#!/usr/bin/env bash
# 纯本地形态冒烟（票 M3-T5 / Issue #34，FR-DEP-1）：
# 临时 dataDir 起 Runtime → /v1/health → 一次真实对话（本地 OpenAI mock Provider）→ 优雅退出。
# 不触碰 OS 凭据库（MORROW_SECRET_BACKEND=memory），不需要真实网络/真实 LLM。
#
# 用法：scripts/deploy/smoke-local.sh [--binary <path>] [--keep]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# 优先当前 Node（本机 24；CI 22+ 均可跑 --experimental-strip-types）
NODE_BIN="${NODE:-node}"
if ! command -v "${NODE_BIN}" >/dev/null 2>&1; then
  echo "[smoke-local] node not found in PATH" >&2
  exit 1
fi

exec "${NODE_BIN}" --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types "${SCRIPT_DIR}/lib/smoke.ts" --mode local "$@"
