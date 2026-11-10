#!/bin/bash
# =============================================================================
# M4 端到端演示入口（票 M4-T9 / Issue #46；PRD §9 M4 / AC-14）
#
# 薄包装：调用 scripts/real-machine/m4-demo.ts（两轮 × 10 项断言）。
# 口径与边界见 docs/gates/m4-gate-report.md / docs/gates/m4-demo-output.md。
#
# 用法：
#   bash scripts/real-machine/m4-demo.sh [--out docs/gates/m4-demo-output.md] [--rounds 2] [--keep]
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="/opt/homebrew/bin:$PATH"
exec node --experimental-sqlite --experimental-strip-types "$ROOT/scripts/real-machine/m4-demo.ts" "$@"
