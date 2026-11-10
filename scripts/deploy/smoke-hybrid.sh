#!/usr/bin/env bash
# 混合形态冒烟（票 M3-T5 / Issue #34，FR-DEP-1..3）：
# 起两个 Runtime 进程 A(本地)/B(服务器) → 生成配对码 + 双端 claim（指纹核对）→
# A/B 各自“离线”写入会话事件（5/3 条，互不可见）→ 重连后经 /v1/sync/{pull,push} 双向增量同步 →
# 幂等重推 + 逐项对账（对方事件全部到达、各恰好一次，配对审计互传）。
# 两个实例都在 127.0.0.1 上跑随机端口、临时 dataDir，不依赖 Tailscale/真实网络；
# 设备私钥只在进程内存（MORROW_SECRET_BACKEND=memory），不写 OS 凭据库。
#
# 用法：scripts/deploy/smoke-hybrid.sh [--binary <path>] [--keep]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

NODE_BIN="${NODE:-node}"
if ! command -v "${NODE_BIN}" >/dev/null 2>&1; then
  echo "[smoke-hybrid] node not found in PATH" >&2
  exit 1
fi

exec "${NODE_BIN}" --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types "${SCRIPT_DIR}/lib/smoke.ts" --mode hybrid "$@"
