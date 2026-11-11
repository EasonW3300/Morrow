#!/usr/bin/env bash
# 服务器形态冒烟（票 M3-T5 / Issue #34，ADR-0003/0004）：
# 1) 静态校验 deploy/systemd/morrow.service 关键指令与 deploy/morrow.env.example 默认值；
# 2) 按 systemd 的 EnvironmentFile 语义前台拉起 Runtime（不改代码、不 daemonize）→ health → 优雅退出。
# 真实 systemd 启动（systemctl/systemd-run）无法在 macOS 或普通容器里安全验证，脚本会打印
# “待 Owner 机器验证”；在 Ubuntu 主机上用 install-ubuntu.sh 安装后执行 systemctl status morrow。
#
# 用法：scripts/deploy/smoke-server.sh [--binary <path>] [--keep]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

NODE_BIN="${NODE:-node}"
if ! command -v "${NODE_BIN}" >/dev/null 2>&1; then
  echo "[smoke-server] node not found in PATH" >&2
  exit 1
fi

exec "${NODE_BIN}" --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types "${SCRIPT_DIR}/lib/smoke.ts" --mode server "$@"
