# M6 安全与故障注入汇总（T1 / Issue #52）

- 父规格：M6 #51（只汇总与缺口修复，不新增功能域）
- 分支 / 基线：`m6/t1`，基于 `integration/m0` @ `0236012`
- 运行日期：2026-11-11
- 入口：`scripts/real-machine/security-suite.ts`（Node 24 + `--experimental-strip-types`，零外部依赖）
- 断言映射与逐文件复跑命令：`docs/security/README.md`
- 机器可读证据：`docs/gates/m6-security-summary.json`

## 1. 口径与边界

```bash
export PATH="/opt/homebrew/bin:$PATH"
node --experimental-strip-types scripts/real-machine/security-suite.ts
# 本次归档同时生成 JSON：
node --experimental-strip-types scripts/real-machine/security-suite.ts \
  --json docs/gates/m6-security-summary.json
```

- **一个命令跑六个域**：每个域 `spawn node --test` 调既有测试文件（聚合调用，不重写断言），脚本输出 Markdown PASS/FAIL 总表；退出码 `0`/`1`。
- **零真实网络**：只使用 `127.0.0.1` 回环与随机端口；无外部端点。
- **零真实密钥**：内存 `SecretStore`、平台协议桩、FakePi；子进程环境剥离 `MORROW_PROVIDER_*` / `MORROW_DATA_DIR` 等宿主变量，并强制 `MORROW_SECRET_BACKEND=memory`。
- **计数口径**：断言 = `node:test` 叶用例 + 内联检查；域间复用文件（`pairing.test.ts`、`notifications.service.test.ts`）按域重复计数，**总计 264 非去重**。
- 未纳入本入口的真实容器套件：`sandbox.docker.test.ts`、`capability-factory.harness.container.test.ts`（需 Docker-in-Docker / 平台容器；证据见 M2 门禁 §2.3）。

## 2. 本次运行结果（六域总表）

| # | 安全域 | 断言 | 通过 | 失败 | 跳过 | 结论 |
|---|--------|------|------|------|------|------|
| 1 | 越权（可信联系人五类 + 能力注册五维） | 41 | 41 | 0 | 0 | **PASS** |
| 2 | 密钥泄漏（配置 / API / 账本 / 日志） | 61 | 61 | 0 | 0 | **PASS** |
| 3 | CSRF / 来源（415、CORS、回环精确豁免） | 20 | 20 | 0 | 0 | **PASS** |
| 4 | 沙箱（不可用拒绝 + 权限不越界） | 75 | 75 | 0 | 0 | **PASS** |
| 5 | 同步安全（tombstone / 撤销设备 / 通知裁剪） | 44 | 44 | 0 | 0 | **PASS** |
| 6 | 租约（fencing token / 双持有冻结） | 23 | 23 | 0 | 0 | **PASS** |
| | **合计** | **264** | **264** | **0** | **0** | **全 PASS** |

环境：node `v24.22.1` / `darwin-arm64`。域 2 的 61 = 60 个既有测试 + 1 个内联日志字节扫描（捕获 0 行 / 0 字节，密钥命中 0）。

## 3. 逐域结论与可引用证据

> 完整「域 → 断言 → 复跑命令」见 `docs/security/README.md`；以下只列判定与关键测试名。

1. **越权 — PASS（41/41）**
   可信联系人五类越权（private 记忆 / 文件 / 开发工具 / 未授权能力 / 他人会话）在 `PermissionEngine` 单一入口全部 `allowed=false` 且 reason 可辨、五条 `contact.permission_denied` 审计；能力注册五维（filesystem/network/shell/channels/credentials）各一条 violation 并 400 escalation。证据：`contacts.permissions.test.ts`「all five unauthorized contact actions…」、`capabilities.engine.test.ts`「checkPermissionsWithinGrants：五维…」、`capabilities.api.test.ts`「注册越权：五维各一条负样例 100% 拒绝」。里程碑对照：M4 门禁 §2.3-A（100/100 阻断）、M2 门禁 §2.1（工厂越权 3 组 100% 阻断）。
2. **密钥泄漏 — PASS（61/61）**
   `providers.json` 原文无 `api_key`；`/v1/providers`、`/v1/events`、`/v1/sessions`、`/v1/health` 及 409/404/轮换错误路径响应无密钥；渠道凭据写入不回显；通知渠道正文 / Outbox 载荷 / 平台实发载荷不含凭据；日志捕获路径无命中。证据：`providers.test.ts`「providers.json 不得含密钥」、`providers.api.test.ts`「密钥全链路不泄漏…」、`channels.secrets.api.test.ts`「投影只报 configured、写入不回显」、`notifications.service.test.ts`「内容裁剪…凭据被裁剪」。里程碑对照：威胁模型域 1；M0 门禁 §5-1。
3. **CSRF / 来源 — PASS（20/20）**
   `text/plain` simple POST 携带合法 JSON 仍 415；缺 content-type 415；非本地来源无 CORS 授权；本地 preflight 204；回环豁免仅精确 `127.0.0.1` / `::1`（IPv4-mapped 与 zone 归一）；非回环无令牌 401、撤销设备 403 `device_revoked`。证据：`cors.test.ts` 9 例、`pairing.test.ts`「鉴权策略…」。里程碑对照：M1 门禁 §7-B6（`readJsonBody` CSRF content-type 强制单源）。
4. **沙箱 — PASS（75/75）**
   无容器运行时 → `sandbox_unavailable` + install-hint（503）；镜像 inspect/pull 挂起有界失败；越界文件路径、network 矛盾、嵌套输入递归扫描均在执行前拒绝；builtin 不免检；runner 加固旗标（network none / read-only / cpus / memory / pids-limit / no-new-privileges）；invoker 先权限后执行 fail-closed。证据：`sandbox.docker-runner.test.ts`、`sandbox.permission.test.ts`、`sandbox.invoker.test.ts`、`sandbox.runner-units.test.ts`、`invocation-errors.test.ts`、`capabilities.invoke.test.ts` 错误码表。里程碑对照：M2 门禁 §2.3（真实容器 69/69）、§2.1（容器 1/1）。
5. **同步安全 — PASS（44/44）**
   tombstone 双向不复活（A 删/B 离线旧修订被跳过；反向同理）；`integrity_hash` 不符拒绝整批、sequence 缺口 409；跨设备冲突 locked 不自动覆盖；撤销设备后同一 token 403；渠道通知正文按接收者裁剪（private 记忆 / 绝对路径 / 凭据），桌面保留全文。证据：`sync.memory.test.ts`「删除跨副本传播且不复活…反向同理」、`sync.engine.test.ts`、`sync.api.test.ts`、`pairing.test.ts`、`notifications.service.test.ts`。里程碑对照：M3 门禁 §2.2（双向删除不复活）、§6-1/§6-3；M4 门禁 §2.3-B/C。
6. **租约 — PASS（23/23）**
   旧 fencing token 在副作用提交前被拒；跨副本同步后 `B.validate(1)=false`；双持有 → `needs_reconcile` 冻结且不执行；远端持租约时 acquire 被拒；租约丢失中止在跑节点。证据：`lease.test.ts`「fencing guard…」、`lease.fencing-sync.test.ts`、`lease.preacquire.test.ts`、`lease.api.test.ts`、`lease.scheduler.test.ts`。里程碑对照：M3 门禁 §4、§6-1、§7。

## 4. 未覆盖项（如实登记）

| # | 未覆盖项 | 现状与替代证据 |
|---|----------|----------------|
| U1 | 真实容器隔离（network none / 资源限额 / workspace 挂载 / 超时强杀） | 本入口排除 `sandbox.docker.test.ts` 与 `capability-factory.harness.container.test.ts`；替代证据 M2 门禁 §2.3（69/69，本机 Docker）与 CI ubuntu 容器腿 |
| U2 | 真实跨机 / 非回环网络（Tailscale、LAN、双机时钟） | 全部证据为 `127.0.0.1` 双副本回环基线；M3 §6-8、M4 §6-8 已登记 |
| U3 | Windows / Linux 真实 OS 凭据库 | 仅 macOS Keychain 实测；Windows `cmdkey`/CredRead 与 Linux `secret-tool` 为 exec 桩（M0 §5-1、M1 §5-4） |
| U4 | 「全部 API 响应」的穷举扫描 | 覆盖 providers/events/sessions/health、渠道凭据、通知正文/Outbox；未对每个路由 × 每个错误分支做穷举 fuzz |
| U5 | 供应链与依赖漏洞扫描 | 威胁模型明确不在范围（仅 lockfile + Pi 版本锁定）；本入口不做 CVE 扫描 |
| U6 | Docker Linux 腿的真实容器 / Go / esbuild 失败集 | 733 tests / 700 pass / 31 fail，失败集与基线 `0236012` **逐名完全一致**（见 §5-D）；属基线环境限制，非本票回归 |

## 5. 缺陷与残余风险

### 5.1 本轮发现并修复的缺陷

**无产品代码缺陷**。六个域既有断言全部通过；本轮新增的是汇总入口、日志面补充检查与证据文档，未改动 runtime 行为。对入口自身做了一处收紧：子进程环境剥离宿主 `MORROW_*` 并强制内存凭据库，避免复跑时意外继承真实密钥/数据目录。

### 5.2 残余风险（修不动或超出本票范围，逐条登记）

| # | 残余风险 | 说明 / 责任归属 |
|---|----------|-----------------|
| R1 | 账本 `integrity_hash` 无签名 | 可检出意外损坏/字节篡改，但攻击者改数据后可重算 hash；防篡改需设备签名（M3 已提，未实现）。威胁模型域 1-R3 |
| R2 | macOS `security` CLI 写密钥经 argv；Windows `cmdkey` 同样 | 短生命周期暴露于进程列表，CLI 固有限制；Linux `secret-tool` 已走 stdin。`keyring.ts` 头注已记 |
| R3 | 日志面无系统性脱敏 | 无结构化 logger / 统一 redaction；本轮日志扫描捕获 0 行（这些路径本就不打日志），未来新增日志可能泄漏，需要 code review 约束 |
| R4 | 通知裁剪是启发式而非完整 DLP | 依赖 `privateMemoryContents` 清单 + 绝对路径/`api_key=` 等正则；自定义密钥格式、编码变形、片段化敏感信息可能漏裁 |
| R5 | 回环豁免 = 本机任意进程可访问控制面 | 单主人本机设计前提（ADR-0008）；CORS 只约束浏览器读取，不阻止本机进程直连；无进程级认证 |
| R6 | 租约 `pull → acquire` 竞态窗口 | 依赖 fencing token + `needs_reconcile` Owner 裁决兜底；peer 不可达时只能本地判断（M3 §6-1） |
| R7 | 同步/租约测试使用注入时钟、同机双副本 | 真实时钟偏移、网络分区、长延迟未测；生产需继续观察 |
| R8 | 真实平台/网络层未验证 | 与 M4 §6 同边界；不影响本票六域协议层结论 |

## 6. 最终验证

| 验证 | 结果 |
|------|------|
| `pnpm -r typecheck` | **PASS**（pi-adapter / protocol / desktop / runtime / packaging 全绿） |
| `pnpm --filter @morrow/runtime build` | **PASS**（`dist/main.js` 2.6 mb） |
| `pnpm --filter @morrow/runtime test:unit` | **PASS**：738 tests / 738 pass / 0 fail（43.9s） |
| `pnpm --filter @morrow/desktop test:ui` | **PASS**：133 tests / 133 pass / 0 fail |
| `node --experimental-strip-types scripts/real-machine/security-suite.ts` | **PASS**：6 域 / 264 断言 / 264 通过 / 0 失败，退出码 0 |
| Docker Linux 复核（node:24-alpine，排除两个真实容器套件） | tests **733** / pass **700** / fail **31**；与基线 `0236012` 的失败测试名集合 `diff` **完全一致** |

Docker 失败集的构成（基线既有，非本票引入）：DockerRunner 真容器路径（容器内无 Docker）、Go Worker（无 Go 工具链）、esbuild/factory 构建与验证路径（macOS 安装的 platform 二进制在 Linux 容器内不可用）、以及少量运行环境差异。复核命令与 `diff` 口径：

```bash
# 基线（integration @ 0236012）与 m6/t1 各跑一次，提取失败测试名后 diff
grep -E '^✖ ' docker.log | sed -E 's/ \([0-9.]+ms\)$//' | sort -u
diff baseline-failures.txt m6t1-failures.txt   # → 无输出
```

## 7. 结论

**M6-T1 达成**：六个安全域均有可复跑入口与明确结论，`264/264` 断言通过；未覆盖项与残余风险逐条登记，无隐瞒的「已验证」空话。真实容器、真实跨机网络、Windows/Linux 凭据库仍按既有里程碑边界保持开放，不计入本票通过条件。
