#!/bin/bash
# =============================================================================
# Morrow M2 完整演示脚本（票 M2-T7 / Issue #28；PRD §9 M2 门槛）
#
#   「缺能力 → 造工具 → 安全验证 → 重用」四步 + Skill 进化链路（两次经验 →
#   提案 → 批准 → invoke 重用），全部打真实 Runtime 端点——capability-fixture
#   自 T7 接缝收尾后只剩纯透明代理，浏览器与脚本面对的是同一条真实链路。
#
# 前置：repo 根目录已 pnpm install；node ≥ 22.16（FTS5）。
# 用法：bash scripts/real-machine/m2-demo.sh
# 输出：逐步 JSON 打到 stdout；结尾 SUMMARY 行（PASS/FAIL 计数）；退出码 0 = 全过。
#
# 说明：工厂生成器为夹具注入的脚本化实现（FakePi 同款口径，零 LLM/零网络——真实
# LLM 生成待 Owner 密钥，见 docs/gates/m2-gate-report.md 未达项）；沙箱用本地桩
# Runner（与 AC-06 桩路径同源）；容器路径证据见门禁报告 §2。
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$ROOT/apps/desktop/scripts/capability-fixture.ts"
LOG="$(mktemp /tmp/morrow-m2-demo-XXXXXX)"
PASS=0; FAIL=0

cleanup() { [[ -n "${FRONT_PID:-}" ]] && kill "$FRONT_PID" 2>/dev/null || true; rm -f "$LOG"; }
trap cleanup EXIT

require() { # require <desc> <expr...>  —— 断言 jq 路径非空
  if [[ "$2" == "null" || -z "$2" ]]; then echo "  ✗ $1（got: $2）"; FAIL=$((FAIL+1)); return 1; fi
  echo "  ✓ $1"; PASS=$((PASS+1))
}

echo "== [0/7] 启动 capability-fixture（纯透明代理 → 真实 Runtime）=="
node --experimental-sqlite --experimental-strip-types "$FIXTURE" > "$LOG" 2>&1 &
FRONT_PID=$!
for i in $(seq 1 30); do
  FRONT=$(python3 -c "
import json,sys
line=open('$LOG').readline().strip()
print(json.loads(line)['front'] if line.startswith('{\"ready\"') else '')" 2>/dev/null || true)
  [[ -n "$FRONT" ]] && break
  sleep 1
done
[[ -n "${FRONT:-}" ]] || { echo "fixture 启动失败："; cat "$LOG"; exit 1; }
echo "  front=$FRONT"
BASE="$FRONT"
JQ() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1" 2>/dev/null || echo "null"; }
DEMO_DESC='需要一个把 markdown 表格行转成 CSV 的能力，输入限制 1MB。'

echo
echo "== [1/7] 缺能力：注册表无 CSV 能力（GET /v1/capabilities）=="
CAPS=$(curl -sf "$BASE/v1/capabilities")
echo "  注册表：$(echo "$CAPS" | JQ "','.join(c['name']+'@'+c['version']+' ('+c['status']+')' for c in d['capabilities'])")"
require "csv.export 尚不存在（缺能力前提）" "$(echo "$CAPS" | JQ "next((c['name'] for c in d['capabilities'] if c['name']=='csv.export'), None)")" || true

echo
echo "== [2/7] 造工具：提交需求（POST /v1/capabilities/request）=="
REQ=$(curl -sf -X POST "$BASE/v1/capabilities/request" -H 'content-type: application/json' \
  -d "{\"description\": \"$DEMO_DESC\"}")
RID=$(echo "$REQ" | JQ "d['request_id']")
require "request_id 受理（201）" "$RID"
echo "  初始：$(echo "$REQ" | JQ "str(d['status'])+'/'+str(d['stage'])")"

echo
echo "== [3/7] 进度轮询（GET /v1/capabilities/requests/:id）——检索→规划→构建→沙箱验证 =="
FINAL=""
for i in $(seq 1 40); do
  VIEW=$(curl -sf "$BASE/v1/capabilities/requests/$RID")
  ST=$(echo "$VIEW" | JQ "str(d['status'])+'/'+str(d['stage'])")
  echo "  poll $i: $ST"
  case "$ST" in proposed/*|failed/*|reused/*|confirmed/*) FINAL="$VIEW"; break ;; esac
  sleep 1.5
done
[[ -n "$FINAL" ]] || { echo "  ✗ 工厂轮询超时"; exit 1; }
require "到达 proposed/verified（待 Owner 确认）" "$(echo "$FINAL" | JQ "d['status']=='proposed' and d['stage']=='verified' and 'yes' or 'no'")"
echo "  候选 manifest：$(echo "$FINAL" | JQ "d['manifest']['name']+'@'+d['manifest']['version']+' sandbox='+str(d['manifest']['sandbox'])")"
echo "  验证报告（真实 VerifyReport）："
echo "$FINAL" | JQ "'\n'.join('    '+c['kind'].ljust(20)+' pass='+str(c['pass']).ljust(5)+' '+c['detail'][:70] for c in d['report']['cases'])"
require "四类用例全过" "$(echo "$FINAL" | JQ "all(c['pass'] for c in d['report']['cases']) and 'yes' or 'no'")"
require "越权用例阻断（privilege-escalation pass = 企图被拒）" "$(echo "$FINAL" | JQ "(next(c for c in d['report']['cases'] if c['kind']=='privilege-escalation'))['pass'] and 'yes' or 'no'")"

echo
echo "== [4/7] 安全验证门：Owner 确认注册（POST /v1/capabilities/:id/confirm）=="
CONF=$(curl -sf -X POST "$BASE/v1/capabilities/$RID/confirm")
require "csv.export 注册（author=ai 默认停用）" "$(echo "$CONF" | JQ "d['capability']['name']=='csv.export' and d['capability']['status']=='disabled' and 'yes' or 'no'")"
echo "  注册事件：$(echo "$CONF" | JQ "d['event_id']")"

echo
echo "== [5/7] 重用：再次提交同需求 → 检索命中，不新建（FR-CAP-1）=="
REQ2=$(curl -sf -X POST "$BASE/v1/capabilities/request" -H 'content-type: application/json' \
  -d "{\"description\": \"$DEMO_DESC\"}")
RID2=$(echo "$REQ2" | JQ "d['request_id']")
VIEW2=$(curl -sf "$BASE/v1/capabilities/requests/$RID2")
require "status=reused（重用路径而非新建）" "$(echo "$VIEW2" | JQ "d['status']=='reused' and 'yes' or 'no'")"
echo "  命中：$(echo "$VIEW2" | JQ "','.join(m['source']+':'+m.get('name','?')+' score='+str(m['score']) for m in d.get('reuse_matches', []))")"

echo
echo "== [6/7] Skill 进化：两次经验 → 提案 → 批准 =="
for i in 1 2; do
  curl -sf -X POST "$BASE/v1/capabilities/skills/cases" -H 'content-type: application/json' \
    -d "{\"capability\": \"memory.write\", \"outcome\": \"success\", \"source_event_id\": \"m2-demo-$i\", \"occurred_at\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}" > /dev/null
done
PROPS=$(curl -sf "$BASE/v1/skills/proposals")
PID=$(echo "$PROPS" | JQ "next((p['proposal_id'] for p in d['proposals'] if p['status']=='pending'), None)")
require "达标自动产生提案（skill.proposed）" "$PID"
echo "  提案：$(echo "$PROPS" | JQ "next((p['title']+'（'+p['description']+'）' for p in d['proposals'] if p['status']=='pending'), None)")"
APPR=$(curl -sf -X POST "$BASE/v1/skills/proposals/$PID/approve")
require "Owner 批准（approved）" "$(echo "$APPR" | JQ "d['status']=='approved' and 'yes' or 'no'")"

echo
echo "== [7/7] 重用调用：invoke 经真实 builtin 执行（POST /v1/capabilities/skills/:id/invoke）=="
INV=$(curl -sf -X POST "$BASE/v1/capabilities/skills/$PID/invoke" -H 'content-type: application/json' \
  -d '{"params": {"content": "M2 演示：经 Skill 重用调用写入的事实（m2-demo.sh）"}}')
require "invoke ok（memory.write 真实执行）" "$(echo "$INV" | JQ "d['ok'] and 'yes' or 'no'")"
echo "  执行结果：$(echo "$INV" | JQ "d['steps'][0].get('result',{}).get('text', d['steps'][0].get('error'))")"

echo
echo "== SUMMARY =="
echo "PASS=$PASS FAIL=$FAIL front=$BASE"
[[ "$FAIL" -eq 0 ]] || exit 1
