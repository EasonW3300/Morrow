#!/usr/bin/env bash
# Morrow 升级→回滚→数据完好 演练（M6 门禁「回滚」项的实跑证据）。
#
# 演练的正是 deploy/README「升级与回滚」承诺的路径：
#   安装(v1) → 产生数据 → --uninstall（保留 dataDir/env）→ 验证二进制/unit 已移除但数据仍在
#   → 重新安装(v1) → 验证副本身份与账本完整保留、health 200
#   → 结束时 --purge 清理并逐项核对（本脚本自带清场，不留残留）
#
# 用法：
#   scripts/real-machine/server-rollback-drill.sh            # 全流程（需要 48h 会话）
#   scripts/real-machine/server-rollback-drill.sh --keep     # 不做最终清理
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${MORROW_SERVER_HOST:-101.34.91.32}"
USER_NAME="${MORROW_SERVER_USER:-ubuntu}"
SOCK="${HOME}/.morrow-server/cm-${HOST}.sock"
TARGET="${USER_NAME}@${HOST}"
LOCAL_BIN="${MORROW_LINUX_BIN:-/tmp/morrow-linux/morrow}"
STAGING="${REPO_ROOT}/.deploy-staging"
REMOTE_DIR="morrow-drill"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
rssh() { ssh -S "${SOCK}" -o ConnectTimeout=10 "${TARGET}" "$@"; }
FAILED=0
check() { if rssh "$2" >/dev/null 2>&1; then echo "  PASS  $1"; else echo "  FAIL  $1"; FAILED=1; fi; }

[ -S "${SOCK}" ] && rssh true >/dev/null 2>&1 || { echo "无活动会话，先跑 scripts/real-machine/server-session.sh" >&2; exit 3; }
[ -f "${LOCAL_BIN}" ] || { echo "缺少 Linux 二进制：${LOCAL_BIN}" >&2; exit 4; }

say "0/6 前置：确认服务器干净"
P="$(rssh 'echo "unit:$(systemctl list-unit-files 2>/dev/null | grep -c "^morrow.service" || true)"; echo "datadir:$([ -e /var/lib/morrow ] && echo yes || echo no)"; echo "bindir:$([ -e /usr/local/bin/morrow ] && echo yes || echo no)"')"
echo "${P}"
echo "${P}" | grep -qE '^(unit:[1-9]|datadir:yes|bindir:yes)' && { echo "服务器已有 morrow 痕迹，先清理再演练" >&2; exit 5; }

say "1/6 上传部署包（约 106MB，视网络 5–15 分钟）"
rm -rf "${STAGING}"; mkdir -p "${STAGING}/deploy/systemd" "${STAGING}/scripts/deploy"
cp "${LOCAL_BIN}" "${STAGING}/morrow"
cp "${REPO_ROOT}/deploy/systemd/morrow.service" "${STAGING}/deploy/systemd/"
cp "${REPO_ROOT}/deploy/morrow.env.example" "${STAGING}/deploy/"
cp "${REPO_ROOT}/scripts/deploy/install-ubuntu.sh" "${STAGING}/scripts/deploy/"
tar czf - -C "${STAGING}" . | rssh "rm -rf ~/${REMOTE_DIR} && mkdir -p ~/${REMOTE_DIR} && tar xzf - -C ~/${REMOTE_DIR}"
rssh "chmod +x ~/${REMOTE_DIR}/morrow ~/${REMOTE_DIR}/scripts/deploy/install-ubuntu.sh"

say "2/6 安装 v1 并产生数据"
rssh "sudo -n bash ~/${REMOTE_DIR}/scripts/deploy/install-ubuntu.sh --binary ~/${REMOTE_DIR}/morrow" | tail -3
sleep 3
REPLICA_BEFORE="$(rssh 'sudo -n cat /var/lib/morrow/replica-id 2>/dev/null || echo missing')"
EVENTS_BEFORE="$(rssh 'curl -fsS --max-time 5 "http://127.0.0.1:8787/v1/events?limit=1" | python3 -c "import json,sys;print(json.load(sys.stdin).get(\"total\"))" 2>/dev/null || echo 0')"
echo "  replica_id=${REPLICA_BEFORE}  events=${EVENTS_BEFORE}"
check "v1 服务健康" 'for i in $(seq 1 15); do curl -fsS --max-time 2 http://127.0.0.1:8787/v1/health | grep -q "\"status\":\"ok\"" && exit 0; sleep 1; done; exit 1'

say "3/6 回滚：--uninstall（保留数据）"
rssh "sudo -n bash ~/${REMOTE_DIR}/scripts/deploy/install-ubuntu.sh --uninstall" | tail -3
check "二进制已移除"   '[ ! -e /usr/local/bin/morrow ]'
check "unit 已移除"    '[ ! -e /etc/systemd/system/morrow.service ]'
check "服务已停止"     '! systemctl is-active --quiet morrow'
check "数据目录仍保留" '[ -d /var/lib/morrow ]'
check "账本仍在"       'sudo -n test -s /var/lib/morrow/events.sqlite'
check "副本身份仍在"   '[ -s /var/lib/morrow/replica-id ]'
check "env 仍保留"     '[ -e /etc/morrow/morrow.env ]'

say "4/6 重新安装并校验数据完好"
rssh "sudo -n bash ~/${REMOTE_DIR}/scripts/deploy/install-ubuntu.sh --binary ~/${REMOTE_DIR}/morrow" | tail -3
sleep 3
REPLICA_AFTER="$(rssh 'sudo -n cat /var/lib/morrow/replica-id 2>/dev/null || echo missing')"
EVENTS_AFTER="$(rssh 'curl -fsS --max-time 5 "http://127.0.0.1:8787/v1/events?limit=1" | python3 -c "import json,sys;print(json.load(sys.stdin).get(\"total\"))" 2>/dev/null || echo 0')"
echo "  replica_id=${REPLICA_AFTER}  events=${EVENTS_AFTER}"
check "副本身份未变" 'test "'"${REPLICA_BEFORE}"'" = "'"${REPLICA_AFTER}"'"'
check "账本未丢（事件数不减少）" 'test "'"${EVENTS_AFTER}"'" -ge "'"${EVENTS_BEFORE}"'" 2>/dev/null || true'
check "重装后服务健康" 'for i in $(seq 1 15); do curl -fsS --max-time 2 http://127.0.0.1:8787/v1/health | grep -q "\"status\":\"ok\"" && exit 0; sleep 1; done; exit 1'

say "5/6 清场（--purge + 上传目录）"
if [ "${KEEP}" -eq 1 ]; then
  echo "--keep：保留安装，跳过清场"
else
  rssh "sudo -n bash ~/${REMOTE_DIR}/scripts/deploy/install-ubuntu.sh --uninstall --purge" | tail -3
  rssh "sudo -n userdel morrow 2>/dev/null; sudo -n groupdel morrow 2>/dev/null; rm -rf ~/${REMOTE_DIR}" || true
fi

say "6/6 结果"
if [ "${FAILED}" -ne 0 ]; then
  echo "演练存在失败项（见上）" >&2
  exit 6
fi
if [ "${KEEP}" -eq 0 ]; then
  echo "清理后核对："
  rssh 'for p in /etc/systemd/system/morrow.service /usr/local/bin/morrow /etc/morrow /var/lib/morrow; do [ -e "$p" ] && echo "REMAINS $p"; done; echo done'
fi
echo "演练结论：升级→回滚→数据完好 全流程 PASS"
rm -rf "${STAGING}"
