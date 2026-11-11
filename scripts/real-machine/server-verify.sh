#!/usr/bin/env bash
# Morrow 服务器部署验证（Issue #34 / M3-T5 的真实 Ubuntu 验证；M6 门禁项）。
#
# 做的事（一个脚本走完，每步都有明确门槛）：
#   1. 检查/建立可复用 SSH 会话（调用 server-session.sh，弹窗一次）
#   2. 本地交叉编译 linux-x64 单二进制（bun --target=bun-linux-x64-baseline）
#   3. 上传最小部署包（二进制 + deploy/ + scripts/deploy/）
#   4. 服务器预检：无既有 morrow 服务 / 无既有数据目录 / 端口 8787 空闲（发现即中止，不覆盖）
#   5. --dry-run 预演 → 正式安装（systemd enable --now）
#   6. 验证：服务 active/enabled、health 200、账本落盘、重启后仍健康、--probe 自检
#   7. 全部通过后清理：--uninstall --purge + 删除上传目录 + 「本项目相关文件」逐项核对
#
# 安全边界：
#   - 不重启服务器；不修改 sshd 配置；不安装额外系统包；
#   - 只碰安装脚本声明的路径（/usr/local/bin/morrow、/etc/systemd/system/morrow.service、
#     /etc/morrow、/var/lib/morrow、系统用户 morrow）与本次上传目录；
#   - 清理前列出精确路径；任一验证失败则默认 **不清理**（保留现场便于诊断，--force-clean 可强制）。
#
# 用法：
#   scripts/real-machine/server-verify.sh                 # 全流程（构建+部署+测试+清理）
#   scripts/real-machine/server-verify.sh --keep          # 测完保留安装（便于手工看）
#   scripts/real-machine/server-verify.sh --no-build      # 复用已有 /tmp/morrow-linux/morrow
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${MORROW_SERVER_HOST:-101.34.91.32}"
USER_NAME="${MORROW_SERVER_USER:-ubuntu}"
STATE_DIR="${HOME}/.morrow-server"
SOCK="${STATE_DIR}/cm-${HOST}.sock"
TARGET="${USER_NAME}@${HOST}"
STAGING="${REPO_ROOT}/.deploy-staging"
LOCAL_BIN="${MORROW_LINUX_BIN:-/tmp/morrow-linux/morrow}"
REMOTE_DIR="morrow-deploy"

DO_BUILD=1
DO_CLEAN=1
for arg in "$@"; do
  case "${arg}" in
    --no-build) DO_BUILD=0 ;;
    --keep) DO_CLEAN=0 ;;
    --force-clean) DO_CLEAN=2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：${arg}" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
rssh() { ssh -S "${SOCK}" -o ConnectTimeout=10 "${TARGET}" "$@"; }

# --- 1) 会话 --------------------------------------------------------------------------
say "1/7 会话"
if ! ssh -S "${SOCK}" -o ConnectTimeout=5 -O check "${TARGET}" >/dev/null 2>&1; then
  "${REPO_ROOT}/scripts/real-machine/server-session.sh"
fi
rssh 'uname -srm; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"'
if ! rssh 'sudo -n true' >/dev/null 2>&1; then
  echo "服务器 ubuntu 用户没有免密 sudo，安装无法继续。请先配置 NOPASSWD 或手工部署。" >&2
  exit 3
fi

# --- 2) 交叉编译 ----------------------------------------------------------------------
say "2/7 构建 linux-x64 单二进制"
if [ "${DO_BUILD}" -eq 1 ]; then
  mkdir -p "$(dirname "${LOCAL_BIN}")"
  BUN="${HOME}/.bun/bin/bun"
  [ -x "${BUN}" ] || { echo "未找到 bun（${BUN}）" >&2; exit 4; }
  ( cd "${REPO_ROOT}" && "${BUN}" build --compile \
      --target=bun-linux-x64-baseline \
      --no-compile-autoload-bunfig \
      --no-compile-autoload-dotenv \
      scripts/packaging/src/entry.ts \
      --outfile "${LOCAL_BIN}" )
fi
[ -f "${LOCAL_BIN}" ] || { echo "缺少二进制：${LOCAL_BIN}" >&2; exit 4; }
ls -lh "${LOCAL_BIN}"

# --- 3) 上传最小包 --------------------------------------------------------------------
say "3/7 上传部署包"
rm -rf "${STAGING}"
mkdir -p "${STAGING}/deploy/systemd" "${STAGING}/scripts/deploy"
cp "${LOCAL_BIN}" "${STAGING}/morrow"
cp "${REPO_ROOT}/deploy/systemd/morrow.service" "${STAGING}/deploy/systemd/"
cp "${REPO_ROOT}/deploy/morrow.env.example" "${STAGING}/deploy/"
cp "${REPO_ROOT}/scripts/deploy/install-ubuntu.sh" "${STAGING}/scripts/deploy/"

tar czf - -C "${STAGING}" . | rssh "rm -rf ~/${REMOTE_DIR} && mkdir -p ~/${REMOTE_DIR} && tar xzf - -C ~/${REMOTE_DIR}"
rssh "chmod +x ~/${REMOTE_DIR}/morrow ~/${REMOTE_DIR}/scripts/deploy/install-ubuntu.sh; ls -l ~/${REMOTE_DIR}"

# --- 4) 预检（发现既有安装/数据/端口占用即中止，绝不覆盖）-----------------------------
say "4/7 服务器预检"
PREFLIGHT="$(rssh 'set -e
  echo "unit:$(systemctl list-unit-files 2>/dev/null | grep -c "^morrow.service" || true)"
  echo "bindir:$([ -e /usr/local/bin/morrow ] && echo yes || echo no)"
  echo "envdir:$([ -e /etc/morrow ] && echo yes || echo no)"
  echo "datadir:$([ -e /var/lib/morrow ] && echo yes || echo no)"
  echo "user:$(id -u morrow >/dev/null 2>&1 && echo yes || echo no)"
  echo "port8787:$( (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | grep -c ":8787 " || true)"
')"
echo "${PREFLIGHT}"
if echo "${PREFLIGHT}" | grep -qE '^(unit:[1-9]|bindir:yes|envdir:yes|datadir:yes|port8787:[1-9])'; then
  echo "预检未通过：服务器已有 morrow 痕迹或 8787 被占用。为安全起见中止（不覆盖任何现有文件）。" >&2
  echo "如确认可以覆盖，请先在服务器上清理，或改用其它端口（MORROW_PORT）。" >&2
  exit 5
fi

# --- 5) 安装 --------------------------------------------------------------------------
say "5/7 dry-run 预演"
rssh "bash ~/${REMOTE_DIR}/scripts/deploy/install-ubuntu.sh --dry-run --binary ~/${REMOTE_DIR}/morrow" | tail -20

say "5/7 正式安装（systemd enable --now）"
rssh "sudo -n bash ~/${REMOTE_DIR}/scripts/deploy/install-ubuntu.sh --binary ~/${REMOTE_DIR}/morrow" | tail -20

# --- 6) 验证 --------------------------------------------------------------------------
say "6/7 验证"
FAILED=0
check() { # check <描述> <命令>
  if rssh "$2" >/dev/null 2>&1; then
    echo "  PASS  $1"
  else
    echo "  FAIL  $1"
    FAILED=1
  fi
}

check "服务 active"        'systemctl is-active --quiet morrow'
check "服务 enabled"       'systemctl is-enabled --quiet morrow'
check "health 200"         'curl -fsS --max-time 5 http://127.0.0.1:8787/v1/health | grep -q "\"status\":\"ok\""'
check "数据目录归属 morrow" 'test "$(stat -c %U /var/lib/morrow)" = "morrow"'
check "账本已落盘"          'sudo -n test -s /var/lib/morrow/events.sqlite'
# 走控制面 API 查账本（服务器不保证装 sqlite3；API 是权威读路径）
check "审计事件含 runtime.started" 'curl -fsS --max-time 5 "http://127.0.0.1:8787/v1/events?limit=20" | grep -q "runtime.started"'

echo "  -- 重启后仍健康 --"
rssh 'sudo -n systemctl restart morrow'
sleep 4
check "重启后 health 200" 'curl -fsS --max-time 8 http://127.0.0.1:8787/v1/health | grep -q "\"status\":\"ok\""'
check "重启后账本完整"     'sudo -n test -s /var/lib/morrow/events.sqlite'

echo "  -- 单二进制自检（--probe：health + sqlite + 真实 PiAdapter 对话）--"
# 探针的对话段要求 MORROW_PROBE_LLM_BASE_URL（打包流程里由本地 mock 提供）。服务器上临时
# 起一个最小 SSE mock（python3 标准库，零安装），跑完即清理——这样在 Linux 上验证的是
# 完整 PiAdapter 链路，而不是只验 health。
rssh 'cat > /tmp/morrow-mock-openai.py <<"MOCKPY"
import json, time
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        def chunk(delta, finish=None):
            body = {"id":"mock","object":"chat.completion.chunk","created":int(time.time()),
                    "model":"mock-model","choices":[{"index":0,"delta":delta,"finish_reason":finish}]}
            self.wfile.write(b"data: " + json.dumps(body).encode() + b"\n\n")
            self.wfile.flush()
        chunk({"role":"assistant","content":"探针正常"})
        chunk({}, "stop")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", 18080), H).serve_forever()
MOCKPY
nohup python3 /tmp/morrow-mock-openai.py >/tmp/morrow-mock.log 2>&1 &
sleep 1'
if rssh 'cd /tmp && sudo -n -u morrow env MORROW_PORT=0 MORROW_DATA_DIR=/tmp/morrow-probe MORROW_PROBE_LLM_BASE_URL=http://127.0.0.1:18080/v1 /usr/local/bin/morrow --probe' 2>&1 | tee /tmp/morrow-probe.out | grep -q '"probe":"pass"'; then
  echo "  PASS  --probe 自检（health + sqlite + 真实 PiAdapter 对话）"
else
  echo "  FAIL  --probe 自检（输出见 /tmp/morrow-probe.out）"
  FAILED=1
fi
# 注意：pkill 的模式不能直接写 "mock-openai.py"——远端命令行里含有该字符串，pkill 会
# 连同执行它的 shell 一起杀掉（实测过，表现为 ssh 无声退出 255）。方括号技巧让模式
# 匹配 "mock-openai.py" 而不匹配命令行里的字面量。
rssh 'pkill -f "mock-openai[.]py" 2>/dev/null || true; rm -f /tmp/morrow-mock-openai.py /tmp/morrow-mock.log; sudo -n rm -rf /tmp/morrow-probe /tmp/morrow-probe2' || true

echo "  -- 日志（最近 8 行）--"
rssh 'sudo -n journalctl -u morrow --no-pager -n 8' || true

# --- 7) 清理 --------------------------------------------------------------------------
say "7/7 清理"
if [ "${FAILED}" -ne 0 ] && [ "${DO_CLEAN}" -ne 2 ]; then
  echo "有验证项失败：默认保留现场（便于诊断）。确认要清理请加 --force-clean。" >&2
  echo "现场：服务器 ~/${REMOTE_DIR}、/usr/local/bin/morrow、/etc/morrow、/var/lib/morrow、用户 morrow"
  exit 6
fi

if [ "${DO_CLEAN}" -eq 0 ]; then
  echo "--keep：保留安装。卸载命令："
  echo "  ssh -S \"${SOCK}\" ${TARGET} 'sudo -n bash ~/${REMOTE_DIR}/scripts/deploy/install-ubuntu.sh --uninstall --purge'"
  exit 0
fi

echo "将删除以下本项目相关路径（逐项核对）："
cat <<'EOF'
  /etc/systemd/system/morrow.service        (systemd unit)
  /usr/local/bin/morrow                     (单二进制)
  /etc/morrow/                              (环境文件)
  /var/lib/morrow/                          (账本/记忆/工作区数据)
  系统用户与组 morrow
  ~ubuntu/morrow-deploy/                    (本次上传的部署包)
  /tmp/morrow-probe/                        (probe 临时数据)
EOF

rssh "sudo -n bash ~/${REMOTE_DIR}/scripts/deploy/install-ubuntu.sh --uninstall --purge" | tail -10 || true
rssh 'sudo -n userdel morrow 2>/dev/null || true; sudo -n groupdel morrow 2>/dev/null || true' || true
rssh "rm -rf ~/${REMOTE_DIR} && sudo -n rm -rf /tmp/morrow-probe" || true

say "清理后核对（应全部为 no）"
rssh 'set -e
  echo "unit:$([ -e /etc/systemd/system/morrow.service ] && echo yes || echo no)"
  echo "bindir:$([ -e /usr/local/bin/morrow ] && echo yes || echo no)"
  echo "envdir:$([ -e /etc/morrow ] && echo yes || echo no)"
  echo "datadir:$([ -e /var/lib/morrow ] && echo yes || echo no)"
  echo "user:$(id -u morrow >/dev/null 2>&1 && echo yes || echo no)"
  echo "upload:$([ -e ~/morrow-deploy ] && echo yes || echo no)"
'
rm -rf "${STAGING}"

say "完成"
echo "会话仍保持（可复用）。关闭：scripts/real-machine/server-session.sh --close"
