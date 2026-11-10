#!/usr/bin/env bash
# Morrow Ubuntu 安装脚本（票 M3-T5 / Issue #34；ADR-0003 单二进制 + systemd）。
#
# 幂等：重复执行只更新二进制/unit，保留已有 /etc/morrow/morrow.env 与数据目录。
# 默认安装位置：二进制 /usr/local/bin/morrow、unit /etc/systemd/system/morrow.service、
# 环境文件 /etc/morrow/morrow.env、数据 /var/lib/morrow。
#
# 用法：
#   sudo scripts/deploy/install-ubuntu.sh --binary path/to/morrow-runtime-linux-x64
#   scripts/deploy/install-ubuntu.sh --dry-run --binary ./morrow      # 只打印将执行的命令
#   sudo scripts/deploy/install-ubuntu.sh --no-start --binary ...     # 只安装不启动
#   sudo scripts/deploy/install-ubuntu.sh --uninstall                 # 停用并移除 unit/二进制
#   sudo scripts/deploy/install-ubuntu.sh --uninstall --purge         # 连数据与 env 一起删
#
# 卸载默认**保留** /var/lib/morrow（账本/记忆）与 /etc/morrow/morrow.env；重新安装即可
# 原样恢复。确认不再需要后再用 --purge，或手工删除这两个目录。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SERVICE_NAME="morrow"
SERVICE_USER="morrow"
SERVICE_GROUP="morrow"
BIN_DEST="/usr/local/bin/morrow"
UNIT_DEST="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_DIR="/etc/morrow"
ENV_DEST="${ENV_DIR}/morrow.env"
DATA_DIR="/var/lib/morrow"
UNIT_SRC="${REPO_ROOT}/deploy/systemd/morrow.service"
ENV_SRC="${REPO_ROOT}/deploy/morrow.env.example"

BINARY=""
DRY_RUN=0
DO_START=1
UNINSTALL=0
PURGE=0

usage() {
  cat <<'EOF'
Morrow Ubuntu 安装脚本（票 M3-T5 / Issue #34；ADR-0003 单二进制 + systemd）。

幂等：重复执行只更新二进制/unit，保留已有 /etc/morrow/morrow.env 与数据目录。
默认安装位置：二进制 /usr/local/bin/morrow、unit /etc/systemd/system/morrow.service、
环境文件 /etc/morrow/morrow.env、数据 /var/lib/morrow。

用法：
  sudo scripts/deploy/install-ubuntu.sh --binary path/to/morrow-runtime-linux-x64
  scripts/deploy/install-ubuntu.sh --dry-run --binary ./morrow      # 只打印将执行的命令
  sudo scripts/deploy/install-ubuntu.sh --no-start --binary ...     # 只安装不启动
  sudo scripts/deploy/install-ubuntu.sh --uninstall                 # 停用并移除 unit/二进制
  sudo scripts/deploy/install-ubuntu.sh --uninstall --purge         # 连数据与 env 一起删

卸载默认保留 /var/lib/morrow（账本/记忆）与 /etc/morrow/morrow.env；重新安装即可
原样恢复。确认不再需要后再用 --purge，或手工删除这两个目录。
EOF
}

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] error: %s\n' "$*" >&2; exit 1; }

# run：dry-run 下只打印（带引号的可复制形式），否则执行
run() {
  if [ "${DRY_RUN}" -eq 1 ]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

# 可能失败但不致命的命令（卸载时服务可能本来就不存在）
run_soft() {
  if [ "${DRY_RUN}" -eq 1 ]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@" || true
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --binary)
      [ "$#" -ge 2 ] || die "--binary requires a path"
      BINARY="$2"
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-start) DO_START=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$(uname -s)" in
  Linux) ;;
  *)
    [ "${DRY_RUN}" -eq 1 ] || die "this installer targets Ubuntu/Linux (use --dry-run to preview on $(uname -s))"
    ;;
esac

if [ "${DRY_RUN}" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  die "must run as root (sudo)"
fi

command -v systemctl >/dev/null 2>&1 || [ "${DRY_RUN}" -eq 1 ] || die "systemctl not found (is this a systemd host?)"

# --- 卸载路径 -----------------------------------------------------------------
if [ "${UNINSTALL}" -eq 1 ]; then
  log "uninstalling ${SERVICE_NAME}"
  run_soft systemctl disable --now "${SERVICE_NAME}"
  run rm -f "${UNIT_DEST}"
  run rm -f "${BIN_DEST}"
  run_soft systemctl daemon-reload
  if [ "${PURGE}" -eq 1 ]; then
    run rm -rf "${DATA_DIR}" "${ENV_DIR}"
    log "purged ${DATA_DIR} and ${ENV_DIR}"
  else
    log "kept ${DATA_DIR} (data) and ${ENV_DEST} (config); remove them with --purge if no longer needed"
  fi
  exit 0
fi

# --- 预检 ---------------------------------------------------------------------
[ -f "${UNIT_SRC}" ] || die "unit template missing: ${UNIT_SRC}"
[ -f "${ENV_SRC}" ] || die "env template missing: ${ENV_SRC}"

if [ -z "${BINARY}" ]; then
  # 默认找本仓库打包产物（pnpm pack:runtime 的输出目录）
  for candidate in "${REPO_ROOT}"/scripts/packaging/dist/morrow-runtime-*; do
    if [ -f "${candidate}" ]; then BINARY="${candidate}"; break; fi
  done
fi
if [ -z "${BINARY}" ]; then
  if [ "${DRY_RUN}" -eq 1 ]; then
    BINARY="/path/to/morrow-runtime-linux-x64"
    log "warning: no binary given/found; dry-run continues with placeholder ${BINARY}"
  else
    die "runtime binary not found; pass --binary <path> (build with: pnpm pack:runtime)"
  fi
fi
[ -f "${BINARY}" ] || [ "${DRY_RUN}" -eq 1 ] || die "binary not found: ${BINARY}"

# --- 用户与目录 ---------------------------------------------------------------
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
    run groupadd --system "${SERVICE_GROUP}"
  fi
  run useradd --system --gid "${SERVICE_GROUP}" --home-dir "${DATA_DIR}" \
    --shell /usr/sbin/nologin --no-create-home "${SERVICE_USER}"
  log "created system user ${SERVICE_USER}"
else
  log "system user ${SERVICE_USER} already exists (kept)"
fi

run install -d -m 0750 -o root -g "${SERVICE_GROUP}" "${ENV_DIR}"
run install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${DATA_DIR}"

# --- 二进制 / unit / env -------------------------------------------------------
run install -m 0755 -o root -g root "${BINARY}" "${BIN_DEST}"
run install -m 0644 -o root -g root "${UNIT_SRC}" "${UNIT_DEST}"

if [ -f "${ENV_DEST}" ]; then
  log "keeping existing ${ENV_DEST} (edit it, then: sudo systemctl restart ${SERVICE_NAME})"
else
  run install -m 0640 -o root -g "${SERVICE_GROUP}" "${ENV_SRC}" "${ENV_DEST}"
  log "installed ${ENV_DEST} from template — HOST defaults to 127.0.0.1."
  log "for private-network access set MORROW_HOST=<tailscale ip -4> (never 0.0.0.0), then restart."
fi

# --- 启停 ---------------------------------------------------------------------
run systemctl daemon-reload
run systemctl enable "${SERVICE_NAME}"
if [ "${DO_START}" -eq 1 ]; then
  # restart 同时覆盖首次启动与升级后的重新加载（enable --now 对已运行服务是 no-op）
  run systemctl restart "${SERVICE_NAME}"
  if [ "${DRY_RUN}" -eq 0 ]; then
    run_soft systemctl --no-pager --lines=5 status "${SERVICE_NAME}"
    log "logs: journalctl -u ${SERVICE_NAME} -f"
  fi
else
  log "installed without starting (--no-start); start with: sudo systemctl start ${SERVICE_NAME}"
fi
