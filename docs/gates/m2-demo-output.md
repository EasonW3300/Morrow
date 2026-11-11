# M2 门槛演示归档：「缺能力 → 造工具 → 安全验证 → 重用」（Issue #28）

**归档日期**：2026-11-02 ｜ **脚本**：`scripts/real-machine/m2-demo.sh`（可重复执行；本文件为其一次真实运行的 stdout 全文）
**基线**：`integration/m0` @ b461a8d + 本票接缝收尾工作树 ｜ **环境**：MacBook Pro（Mac16,8, Apple M4 Pro）、macOS 15.5、node v24.22.1（homebrew）、Docker 29.6.1（演示走本地桩 Runner，容器路径见门禁报告 §2.1）
**链路口径**：capability-fixture 自 T7 接缝收尾后为**纯透明代理**——脚本打的每条路径都是真实 Runtime 端点（工厂管线、注册表、Skill 服务）；生成器为夹具注入的脚本化实现（FakePi 同款口径，零 LLM——真实 LLM 生成待密钥，见门禁报告 §5）；Skill invoke 经 `skillInvoker` seam 注入 memory.write 的真实 builtin 实现（runtime 缺省 ToolInvoker 未注册任何工具的缺口见门禁报告 §5-2）。

连续两次运行均 PASS=10 FAIL=0（可重复性成立）；以下为第二次运行的完整输出。

```
== [0/7] 启动 capability-fixture（纯透明代理 → 真实 Runtime）==
  front=http://127.0.0.1:50149

== [1/7] 缺能力：注册表无 CSV 能力（GET /v1/capabilities）==
  注册表：memory.write@1.0.0 (enabled),web.fetch@1.0.0 (enabled),report.render@1.1.0 (enabled),log.archive@0.2.0 (disabled)
  ✓ csv.export 尚不存在（缺能力前提）

== [2/7] 造工具：提交需求（POST /v1/capabilities/request）==
  ✓ request_id 受理（201）
  初始：submitted/retrieved

== [3/7] 进度轮询（GET /v1/capabilities/requests/:id）——检索→规划→构建→沙箱验证 ==
  poll 1: submitted/built
  poll 2: proposed/verified
  ✓ 到达 proposed/verified（待 Owner 确认）
  候选 manifest：csv.export@0.1.0 sandbox={'type': 'container', 'network': 'none', 'filesystem': 'workspace-only'}
  验证报告（真实 VerifyReport）：
    positive             pass=True  ok
    negative             pass=True  negative blocked/failed as expected: empty rows: nothing to export
    privilege-escalation pass=True  privilege-escalation blocked/failed as expected: refused: unexpected f
    fault                pass=True  fault blocked/failed as expected: fault: input must be an object
  ✓ 四类用例全过
  ✓ 越权用例阻断（privilege-escalation pass = 企图被拒）

== [4/7] 安全验证门：Owner 确认注册（POST /v1/capabilities/:id/confirm）==
  ✓ csv.export 注册（author=ai 默认停用）
  注册事件：01a19be8-052d-7853-8aa3-598c5cc7b7e4

== [5/7] 重用：再次提交同需求 → 检索命中，不新建（FR-CAP-1）==
  ✓ status=reused（重用路径而非新建）
  命中：factory-index:csv.export score=0.875

== [6/7] Skill 进化：两次经验 → 提案 → 批准 ==
  ✓ 达标自动产生提案（skill.proposed）
  提案：memory.write（自动晋升：memory.write 连续成功 2 次（案例沉淀））
  ✓ Owner 批准（approved）

== [7/7] 重用调用：invoke 经真实 builtin 执行（POST /v1/capabilities/skills/:id/invoke）==
  ✓ invoke ok（memory.write 真实执行）
  执行结果：memory saved (candidate 01a19be8-0787-7987-a07d-d72c91320772, sensitivity private)

== SUMMARY ==
PASS=10 FAIL=0 front=http://127.0.0.1:50149
```

**门槛对应（PRD §9 M2）**：[1] 缺能力 → [2][3] 造工具（真实工厂管线）→ [3][4] 安全验证（四类用例 + 越权阻断 + Owner 确认门）→ [5][7] 重用（检索复用不新建 + Skill invoke 重用）；[6] Skill 链路（两次经验 → 提案 → 批准）。
