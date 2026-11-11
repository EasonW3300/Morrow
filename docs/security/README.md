# Morrow 安全验证汇总（M6）

**用途**：把散落在 M0–M4 的安全断言收敛成**一个可复跑入口 + 一页结论**。本目录只做汇总与缺口登记，不新增功能域（M6 规格 #51）。

**入口**：

```bash
export PATH="/opt/homebrew/bin:$PATH"
node --experimental-strip-types scripts/real-machine/security-suite.ts
# 可选：落一份机器可读证据
node --experimental-strip-types scripts/real-machine/security-suite.ts --json docs/gates/m6-security-summary.json
```

- 退出码 `0` = 六域全 PASS；`1` = 任一域失败（或测试计数无法解析）。
- 边界：**零真实网络**（仅 `127.0.0.1` 回环，测试用随机端口）；**零真实密钥**（内存 `SecretStore` / 平台协议桩 / FakePi；子进程环境剥离 `MORROW_PROVIDER_*`，`MORROW_SECRET_BACKEND=memory`）。
- 口径：每个域直接 `spawn node --test` 跑既有测试文件，**不重写断言**；唯一新增检查是域 2 的运行期日志字节扫描（既有套件未覆盖日志面）。
- 断言数 = `node:test` 叶用例 + 内联检查。`pairing.test.ts`（域 3/5）与 `notifications.service.test.ts`（域 2/5）被复用，**总数 264 为按域重复计数、非去重**。

## 域 → 断言 → 复跑 → 最近证据

最近一次运行：2026-11-11（node v24.22.1 / darwin-arm64），六域 **264/264 PASS**。完整结果与未覆盖项见 [`docs/gates/m6-security-summary.md`](../gates/m6-security-summary.md)。

| # | 域 | 断言 | 通过 | 复跑（apps/runtime 下） | 最近证据 |
|---|----|------|------|--------------------------|----------|
| 1 | 越权 | 41 | 41 | `node --experimental-sqlite --experimental-strip-types --test test/contacts.permissions.test.ts test/channels.contact-authorization.test.ts test/capabilities.engine.test.ts test/capabilities.api.test.ts test/capabilities.invoke.test.ts` | 本轮 41/41；M4 门禁报告 §2.3-A（越权 100/100 阻断）；M2 门禁报告 §2.1（工厂越权 3 组 100% 阻断） |
| 2 | 密钥泄漏 | 61 | 61 | `node --experimental-sqlite --experimental-strip-types --test test/providers.test.ts test/providers.api.test.ts test/keyring.test.ts test/channels.secrets.api.test.ts test/notifications.service.test.ts` + 套件内日志扫描 | 本轮 60 测试 + 1 检查全过；威胁模型域 1；M0 门禁报告 §5-1（凭据库残余风险） |
| 3 | CSRF / 来源 | 20 | 20 | `node --experimental-sqlite --experimental-strip-types --test test/cors.test.ts test/pairing.test.ts` | 本轮 20/20；M1 门禁报告 §7 B6（`readJsonBody` 含 CSRF content-type 强制单源） |
| 4 | 沙箱 | 75 | 75 | `node --experimental-sqlite --experimental-strip-types --test test/sandbox.contract.test.ts test/sandbox.detect.test.ts test/sandbox.permission.test.ts test/sandbox.invoker.test.ts test/sandbox.runner-units.test.ts test/sandbox.docker-runner.test.ts test/sandbox.wiring.test.ts test/invocation-errors.test.ts test/capabilities.invoke.test.ts` | 本轮 75/75；M2 门禁报告 §2.3（真实容器套件 69/69）、§2.1（容器 1/1） |
| 5 | 同步安全 | 44 | 44 | `node --experimental-sqlite --experimental-strip-types --test test/sync.memory.test.ts test/sync.engine.test.ts test/sync.api.test.ts test/pairing.test.ts test/notifications.service.test.ts` | 本轮 44/44；M3 门禁报告 §2.2（删除不复活）、§6-1/§6-3（租约互斥、bearer + 撤销）；M4 §2.3-C（通知日志不打印正文） |
| 6 | 租约 | 23 | 23 | `node --experimental-sqlite --experimental-strip-types --test test/lease.test.ts test/lease.api.test.ts test/lease.scheduler.test.ts test/lease.fencing-sync.test.ts test/lease.preacquire.test.ts` | 本轮 23/23；M3 门禁报告 §4/§6-1/§7（fencing token 跨副本单调、双持有冻结） |

## 每域锁定的具体断言

### 1. 越权（可信联系人五类 + 能力注册五维）

- `test/contacts.permissions.test.ts` —「all five unauthorized contact actions are blocked and audited through PermissionEngine」：private 记忆 / 文件 / 开发工具 / 未授权能力 / 他人会话五类各 `allowed=false` 且 reason 可辨，`contact.permission_denied` 五条审计；public 记忆对照组放行。
- `test/capabilities.engine.test.ts` —「checkPermissionsWithinGrants：五维越权各产出一条含维与项的 violation」：filesystem / network / shell / channels / credentials 各一条 violation。
- `test/capabilities.api.test.ts` —「注册越权：五维各一条负样例 100% 拒绝（400 escalation，逐维逐项指明超界）」。
- `test/channels.contact-authorization.test.ts` — 入站授权：任务执行拒绝留痕、public 记忆放行、private 拒绝、工具收窄。
- `test/capabilities.invoke.test.ts` — 权限桩错误码：`permission_denied` 403 / `capability_escalation` 400。

### 2. 密钥泄漏（配置 / API / 账本 / 日志）

- `test/providers.test.ts` —「元数据写入 `<dataDir>/providers.json`；文件内容不含 api_key」：对落盘文件做原始字符串扫描。
- `test/providers.api.test.ts` —「密钥全链路不泄漏：`/v1/events` 账本、`/v1/sessions` 投影、错误响应均无密钥」：注册、重复注册 409、key 轮换后逐个端点原始响应扫描。
- `test/keyring.test.ts` — `SecretStore` 三后端契约（macOS 真实 Keychain 用例仅 darwin 跑；Windows/Linux 为 exec 桩），Linux `secret-tool` 密钥走 stdin 不进 argv。
- `test/channels.secrets.api.test.ts` —「渠道凭据端点：投影只报 configured、写入不回显」。
- `test/notifications.service.test.ts` —「内容裁剪…凭据被裁剪」：渠道正文与外发载荷均不含 `sk-live-*`。
- 套件内联检查 —「运行期日志字节扫描」：同进程捕获 `console.log/warn/error`，触发注册 / 重复注册 409 / 未知 Provider 404 / key 轮换路径，断言日志字节不含密钥。本轮捕获 0 行（运行期这些路径无日志输出），见残余风险。

### 3. CSRF / 来源

- `test/cors.test.ts` —「simple POST with text/plain (CSRF vector) is rejected 415 even with a valid JSON body」；「non-local origins get no CORS grant」；本地 preflight 204 + 来源回显；`tauri://localhost` 放行；无 Origin 放行。
- `test/pairing.test.ts` —「鉴权策略：回环豁免；非回环无令牌 401、有效令牌放行、撤销后 403」：`isLoopbackAddress` 仅精确 `127.0.0.1` / `::1`（IPv4-mapped 与 zone 归一），非回环 401，撤销设备 403 `device_revoked`。

### 4. 沙箱

- `test/sandbox.detect.test.ts` — 三 OS 探测口径 + install-hint（Docker Desktop / OrbStack / Docker Engine / WSL2）；探测超时有界归类。
- `test/sandbox.docker-runner.test.ts` —「探测桩报告无容器运行时 → 抛 `SandboxError` code=`sandbox_unavailable` 且带 install-hint」；镜像 inspect/pull 挂起有界失败。
- `test/sandbox.invoker.test.ts` —「复核拒绝 → `PermissionDeniedError` 且 runner 未执行（先权限后执行，fail-closed）」；「sandboxed 调用被拒：`sandbox_unavailable` + install-hint」。
- `test/sandbox.permission.test.ts` — 越界文件路径 / network 矛盾 / 嵌套输入递归扫描全部执行前拒绝；builtin 同样过复核。
- `test/sandbox.runner-units.test.ts` — `--network none`、`--read-only`、资源限额、`--pids-limit`、`no-new-privileges` 等加固旗标。
- `test/invocation-errors.test.ts` + `test/capabilities.invoke.test.ts` — `sandbox_unavailable` → 503 + install-hint；错误码表逐码落 HTTP。

### 5. 同步安全

- `test/sync.memory.test.ts` —「删除跨副本传播且不复活：A 删除 / B 离线旧修订被跳过；反向同理」；locked 事实跨设备永不自动覆盖。
- `test/sync.engine.test.ts` / `test/sync.api.test.ts` — `integrity_hash` 不符拒绝整批；批内 sequence 缺口 409 `sync_gap`；按 `event_id` 幂等。
- `test/pairing.test.ts` — 撤销设备后同一 token 403（撤销清空 `token_hash`）。
- `test/notifications.service.test.ts` —「内容裁剪…」：private 记忆、绝对文件路径、`api_key=` 凭据在渠道接收者正文/Outbox 载荷/平台侧实发三处均被裁剪，桌面保留全文。

### 6. 租约

- `test/lease.test.ts` —「fencing guard 在租约被抢占后拒绝旧 token 的副作用提交」；「ToolInvoker 写操作前置校验：旧 token 在能力执行前被拒，执行体不运行」。
- `test/lease.fencing-sync.test.ts` — A token=1 → 转移声明 next=2 → 同步后 B acquire=2、`B.validate(1)=false`。
- `test/lease.preacquire.test.ts` —「近同时 acquire（双持有）→ 立即 needs_reconcile，释放本地租约且不执行」；远端持租约时 acquire 被拒；500ms 拉取节流。
- `test/lease.api.test.ts` / `test/lease.scheduler.test.ts` — 双端独立执行 → reconcile/detect 冻结 + Owner 裁决；租约丢失中止在跑节点。

## 未覆盖项与残余风险

不在本入口内、但必须如实登记的项（详细说明见 [`docs/gates/m6-security-summary.md`](../gates/m6-security-summary.md) §3）：

1. 真实容器隔离（`sandbox.docker.test.ts` / `capability-factory.harness.container.test.ts`）不在本入口；证据由 M2 门禁 §2.3（69/69）与 CI ubuntu 容器腿承载。
2. 真实非回环网络 / 双机 Tailscale 未测；认证链路只有回环 + 纯策略函数证据（M3 §6-8、M4 §6-8）。
3. Windows / Linux 真实 OS 凭据库未实测（M0 §5-1、M1 §5-4）。
4. 账本 `integrity_hash` 无签名；macOS `security` CLI 写入密钥经 argv 暴露；系统性日志脱敏未实现（无结构化 logger）。
5. 通知裁剪是内容特征匹配（private 清单 + 路径/凭据正则），不是完整 DLP；DSN/自定义密钥格式等未枚举。

## 加一个新域？

在 `scripts/real-machine/security-suite.ts` 的 `DOMAINS` 增加一项：`files` 指向既有测试文件，`checks` 放少量既有套件确实无法表达的补充断言（优先写回归测试，而不是在脚本里堆逻辑）。失败必须打印到具体测试名或检查名。
