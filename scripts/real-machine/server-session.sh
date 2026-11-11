#!/usr/bin/env bash
# Morrow 服务器会话（一次性密码弹窗 + ControlMaster 长连接复用）。
#
# 用途：在 macOS 上弹出系统对话框输入 SSH 密码，建立一条 **可复用** 的 SSH 主连接
# （ControlMaster + ControlPersist，默认 48 小时）。之后所有 ssh/scp 只要带
# `-S "$SOCK"` 就不再需要密码，也不需要把密码留在磁盘上。
#
# 为什么不用 sshpass：它会把密码放进程参数（ps 可见），且 macOS 默认没装。
# 这里走 OpenSSH 的 SSH_ASKPASS + SSH_ASKPASS_REQUIRE=force（9.9p2 支持）：
# 密码只经文件读入 askpass 助手，连接建立后 **立即删除** 密码与助手文件。
#
# 用法：
#   scripts/real-machine/server-session.sh              # 建立/检查会话（弹窗一次）
#   scripts/real-machine/server-session.sh --status     # 只看状态
#   scripts/real-machine/server-session.sh --close      # 提前关闭（不等 48h）
#
# 环境变量覆盖：
#   MORROW_SERVER_HOST（默认 101.34.91.32）
#   MORROW_SERVER_USER（默认 ubuntu）
#   MORROW_SESSION_HOURS（默认 48）
set -euo pipefail

HOST="${MORROW_SERVER_HOST:-101.34.91.32}"
USER_NAME="${MORROW_SERVER_USER:-ubuntu}"
HOURS="${MORROW_SESSION_HOURS:-48}"
STATE_DIR="${HOME}/.morrow-server"
SOCK="${STATE_DIR}/cm-${HOST}.sock"
SECRET="${STATE_DIR}/secret-${HOST}"
ASKPASS="${STATE_DIR}/askpass-${HOST}.sh"
TARGET="${USER_NAME}@${HOST}"

mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_DIR}"

session_alive() {
  [ -S "${SOCK}" ] && ssh -S "${SOCK}" -o ConnectTimeout=5 -O check "${TARGET}" >/dev/null 2>&1
}

case "${1:-connect}" in
  --status)
    if session_alive; then
      echo "会话在线：${TARGET}（socket: ${SOCK}）"
      ssh -S "${SOCK}" -o ConnectTimeout=5 "${TARGET}" 'echo "  host: $(hostname)  uptime: $(uptime -p 2>/dev/null || true)"'
      echo "  剩余有效期由 ControlPersist(${HOURS}h) 与网络稳定性决定；--close 可提前关闭"
    else
      echo "无活动会话：${TARGET}"
      exit 1
    fi
    exit 0
    ;;
  --close)
    if session_alive; then
      ssh -S "${SOCK}" -O exit "${TARGET}" >/dev/null 2>&1 || true
      echo "已关闭会话：${TARGET}"
    else
      echo "没有可关闭的会话"
    fi
    rm -f "${SECRET}" "${ASKPASS}"
    exit 0
    ;;
  connect) ;;
  *)
    echo "未知参数：$1（可用：--status / --close）" >&2
    exit 2
    ;;
esac

if session_alive; then
  echo "会话已存在，直接复用：${TARGET}"
  exit 0
fi

# --- 1) 弹窗取密码（隐藏输入；只写 600 文件，不进 argv/history）----------------------
APPLESCRIPT="$(mktemp)"
cat > "${APPLESCRIPT}" <<APPLESCRIPT_EOF
display dialog "请输入 ${TARGET} 的 SSH 密码（用于建立 ${HOURS} 小时可复用的会话）" default answer "" with hidden answer buttons {"取消", "连接"} default button "连接" with title "Morrow 服务器部署" with icon caution
text returned of result
APPLESCRIPT_EOF

if ! PASSWORD="$(osascript "${APPLESCRIPT}" 2>/dev/null)"; then
  rm -f "${APPLESCRIPT}"
  echo "已取消（未获取密码）" >&2
  exit 3
fi
rm -f "${APPLESCRIPT}"

if [ -z "${PASSWORD}" ]; then
  echo "密码为空，退出" >&2
  exit 3
fi

umask 077
printf '%s' "${PASSWORD}" > "${SECRET}"
unset PASSWORD

# askpass 助手：只把 secret 文件内容原样输出给 ssh
cat > "${ASKPASS}" <<'ASKPASS_EOF'
#!/bin/sh
exec cat "${MORROW_SSH_SECRET_FILE}"
ASKPASS_EOF
chmod 700 "${ASKPASS}"
export MORROW_SSH_SECRET_FILE="${SECRET}"

# --- 2) 建立主连接（-M 主控 + ControlPersist）----------------------------------------
export SSH_ASKPASS="${ASKPASS}"
export SSH_ASKPASS_REQUIRE=force
export DISPLAY="${DISPLAY:-:0}"

echo "正在连接 ${TARGET} …"
if ! ssh -M -S "${SOCK}" \
      -o ControlPersist="${HOURS}h" \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=6 \
      -o StrictHostKeyChecking=accept-new \
      -o PreferredAuthentications=password,keyboard-interactive \
      -o PubkeyAuthentication=no \
      -o NumberOfPasswordPrompts=1 \
      -f -N "${TARGET}"; then
  rm -f "${SECRET}" "${ASKPASS}"
  echo "连接失败：请检查密码、网络、或服务器是否允许密码登录（/etc/ssh/sshd_config）" >&2
  exit 4
fi

# --- 3) 连接建立后立即销毁密码文件（主连接已持有认证，后续不再需要）-----------------
rm -f "${SECRET}" "${ASKPASS}"

# --- 4) 自检 -------------------------------------------------------------------------
if ! session_alive; then
  echo "主连接未就绪（socket 检查失败）" >&2
  exit 5
fi

echo "会话已建立：${TARGET}"
ssh -S "${SOCK}" -o ConnectTimeout=5 "${TARGET}" '
  echo "  host: $(hostname)"
  echo "  os:   $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -srm)"
  echo "  arch: $(uname -m)"
  systemctl --version >/dev/null 2>&1 && echo "  systemd: $(systemctl --version | head -1)" || echo "  systemd: 未检测到"
  if sudo -n true 2>/dev/null; then echo "  sudo: 免密可用"; else echo "  sudo: 需要密码（部署脚本会失败，请先配置 NOPASSWD）"; fi
'
echo
echo "后续使用：ssh -S \"${SOCK}\" ${TARGET} '命令'"
echo "查看状态：scripts/real-machine/server-session.sh --status"
echo "提前关闭：scripts/real-machine/server-session.sh --close"
