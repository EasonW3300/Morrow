# 真机门禁项脚本（T10 / Issue #11）

CI runner 无音频设备与 GUI 会话，冒烟门清单 #4 的真机项在本机执行；本目录放可重复执行的探针。

## M6 安全与故障注入汇总（Issue #52）

```bash
export PATH="/opt/homebrew/bin:$PATH"
node --experimental-strip-types scripts/real-machine/security-suite.ts
# 可选：机器可读证据
node --experimental-strip-types scripts/real-machine/security-suite.ts --json docs/gates/m6-security-summary.json
```

- 一个命令跑六个安全域（越权 / 密钥泄漏 / CSRF 来源 / 沙箱 / 同步安全 / 租约），输出 PASS/FAIL 总表，退出码 0/1；
- 聚合调用既有 `apps/runtime/test/*` 断言，不重写断言；唯一补充检查是运行期日志字节扫描；
- 零真实网络（仅 127.0.0.1 回环）、零真实密钥（内存 SecretStore / 平台桩 / FakePi）；
- 域→断言映射与未覆盖项：`docs/security/README.md`、`docs/gates/m6-security-summary.md`。

## M4 门禁脚本（Issue #46）

全部为**平台协议桩**口径（真实适配器 + `ChannelTestServer` / `registerQqTestStub` / `StubLocalBridge`，零真实网络）；真实平台层证据单列在 `docs/gates/m4-qq-live-evidence.md`，未达项见 `docs/gates/m4-gate-report.md` §3/§6。

```bash
export PATH="/opt/homebrew/bin:$PATH"
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac09-feishu.ts --out docs/gates
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac10-qq.ts --out docs/gates
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac13-notifications-permissions.ts --out docs/gates
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac15-wechat.ts --out docs/gates
bash scripts/real-machine/m4-demo.sh --out docs/gates/m4-demo-output.md
# 等价：node --experimental-sqlite --experimental-strip-types scripts/real-machine/m4-demo.ts --out docs/gates/m4-demo-output.md
```

| 脚本 | 覆盖 | 合并态结果 |
|---|---|---|
| `ac09-feishu.ts` | AC-09 五面 × 20 轮（私聊/群 @/可信联系人/外发审计/任务关联） | 20/20 × 5（80 条外发审计） |
| `ac10-qq.ts` | AC-10 群 @ 与私聊 × 20 轮 + 主动消息受限拒绝 + token 刷新 | 20/20 × 2（40 条） |
| `ac13-notifications-permissions.ts` | 五类越权 × 20 = 100 次阻断 + 四类通知 × 2 目标去重 | 100/100 阻断；160 送达/160 去重 |
| `ac15-wechat.ts` | 配置/风险确认/白名单收发/健康/日志/关闭 | 20/20 收发，20/20 非白名单阻断 |
| `m4-demo.ts` | AC-14 端到端两轮 × 10 项 | 20/20（语音段标注 M5） |

## m3-demo.sh（M3 门槛演示：两轮 × 10 项断言，Issue #36）

```bash
bash scripts/real-machine/m3-demo.sh [--out docs/gates/m3-demo-output.md] [--keep]
```

- 每轮起两个独立 Runtime（独立 dataDir/SQLite + 随机端口），走真实 HTTP 接缝：
  `POST /v1/pairing/join` 配对 → `POST /v1/sync/run` 双向同步 → 删除传播（A 删/B 不复活）
  → 冲突分类（preference 自动合并 / locked 待审核）→ 任务执行权转移 → needs_reconcile
  检测与 Owner 裁决；
- 两轮独立执行，每轮 10 项断言；退出码 0 = 20/20；
- 归档输出：`docs/gates/m3-demo-output.md`；口径与边界见 `docs/gates/m3-gate-report.md`。

## ac04-sync.ts（AC-04 合并态复跑 + p95，Issue #36）

```bash
export PATH="/opt/homebrew/bin:$PATH"
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac04-sync.ts --out docs/gates
```

- 两实例经 join 配对 → A/B 各离线 50 条 `session.created` → 双向 `sync/run` → 逐项对账
  （无丢失/无重复/顺序一致）；
- 100 个样本：每轮 1 条 ≤1KB 小事件 → 一次 `sync/run` 的墙钟 p95（**回环基线**，真实网络待校准）；
- 输出 `m3-ac04-sync.json` + `m3-ac04-sync.md`。

## ac05-conflicts.ts（AC-05 合并态复跑，Issue #36）

```bash
export PATH="/opt/homebrew/bin:$PATH"
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac05-conflicts.ts --out docs/gates
```

- 20 个竞争事实（6 preference 自动合并 + 14 待审核：locked 3 / sensitivity_change 5 /
  fact_conflict 6）分类，与 M1 巩固器同口径；
- 删除不复活双向证据（A 删/B 离线改、B 删/A 离线改）；
- 输出 `m3-ac05-conflicts.json` + `.md`；重放缺陷见门禁报告 §6-5。

## qq-live-smoke.ts（QQ 官方 Bot WebSocket 真机联调，Issue #41）

```bash
export PATH="/opt/homebrew/bin:$PATH"
node --experimental-strip-types scripts/real-machine/qq-live-smoke.ts [--reply "文本"] [--seconds 60]
```

- 从 macOS Keychain（`channel:qq` / `app_id`、`app_secret`）读凭据，走官方 WebSocket
  网关（Hello → Identify → Dispatch），打印 READY 与每个群 @ / 单聊事件的摘要（不打印 token）；
- `--reply`：收到**群 @ 消息**时用回复 API 回一条，验证完整回环；缺省只观察；
- `--seconds N`：超时退出（默认 60），退出打印事件/拒绝计数与 `health()`；
- 需机器人已入群，且有人在 QQ 里 **@ 机器人**（未 @ 的群消息平台不投递）。

## m2-demo.sh（M2 门槛演示：「缺能力 → 造工具 → 安全验证 → 重用」，Issue #28）

```bash
bash scripts/real-machine/m2-demo.sh
```

- 自启 capability-fixture（纯透明代理 → 真实 Runtime）后逐步走查：缺能力（注册表）→
  造工具（工厂 request→进度→验证报告）→ 安全验证（四类用例 + 越权阻断 + Owner 确认门）
  → 重用（检索命中不新建 + Skill 两次经验→提案→批准→invoke 真实执行）；
- 逐步 JSON + 结尾 `PASS=n FAIL=0`；退出码 0 = 全过；每次运行全新临时 dataDir，可重复执行；
- 归档输出：`docs/gates/m2-demo-output.md`；口径与边界见 `docs/gates/m2-gate-report.md`。

## mic-probe.swift（麦克风捕获探针，AC-11 前置）

```bash
swift scripts/real-machine/mic-probe.swift [--timeout <secs>]   # 默认 60s
```

- 列出音频输入设备 → 检查/请求麦克风权限（TCC）→ 授权后 AVAudioEngine 请求级捕获 1 秒；
- 末行输出单行 JSON：`{"probe":"mic-capture","status":"pass|denied|prompt-timeout|error",...}`；
- 退出码：0 pass / 1 error（含零采样）/ 2 denied / 3 prompt-timeout——**不伪造通过**。

### 授权说明（自动化上下文的已知限制）

从无 GUI 会话归属的进程（如 agent/CI 驱动的 shell）运行时，macOS 会**静默拒绝**授权请求
（`requestAccess` 回调 false 且状态停留 `notDetermined`，系统不弹窗）——2026-10-29 本机实测如此。
手动授权一次的步骤：

1. 系统设置 → 隐私与安全性 → 麦克风 → 为**宿主应用**（探针归因到其责任进程，本机为 ZCode.app；
   从终端跑则归因 Terminal/iTerm）开启麦克风；
2. 重跑本探针，末行应为 `status:"pass"` 且 `frames_captured ≥ 采样率 × 1s`。

授权一次后可重复执行（授权挂在宿主 App 名下，不随探针重跑失效）。
