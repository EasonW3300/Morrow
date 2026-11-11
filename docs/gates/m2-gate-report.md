# Morrow M2 门禁报告（T7 / Issue #28）

**归档日期**：2026-11-02 ｜ **分支基线**：`integration/m0` @ b461a8d（M2-T1..T6 六张开发票 + fix(#27) browser 修复的合并态，工作树 `m2/t7-gate-closeout` 与其同源） ｜ **真机**：MacBook Pro（Mac16,8，Apple M4 Pro，24 GB，macOS 15.5 Build 24F74，Docker 29.6.1）
**参考环境**：`docs/prd/ac-baseline-m0.md`（§8 为 M2 校准注记） ｜ **格式基准**：`docs/gates/m1-gate-report.md`

M2 门槛（PRD §9）：**「缺能力→造工具→安全验证→重用」完整演示**。本报告按票 #28 验收项逐项取证；本票改动力范围 `docs/` + `apps/desktop` 接缝收尾 + `scripts/real-machine/`（runtime 产品代码零改动）。

## 1. CI 证据（integration/m0）

| 项 | 值 |
|---|---|
| 当前 tip | b461a8d（merge: M2-T5 Skill 进化与重用 #26），与 `origin/integration/m0` 一致 |
| 最新 run | [41430246519](https://github.com/EasonW3300/Morrow/actions/runs/41430246519)（push integration/m0，2026-11-02，5m37s）—— **success**（8 job 全绿，含 `sandbox tests (ubuntu, real containers)`） |
| M2 六票 CI 链 | T1 [41409038007] / T2 [41411806195] success；**T6 [41416300020] / T4 [41419710017] / T3 [41421837557] 三平台 build 腿 failure**（protocol browser 子路径入口回归，非能力缺陷）；fix(#27) [41424439464] 修复后恢复 success；T5 [41430246519] success |
| sandbox CI 腿 | `sandbox tests (ubuntu, real containers)` 自 T2 merge 起进 CI 判定（T2 [41411806195] / fix(#27) [41424439464] / T5 [41430246519] 该 job 均 success）；无 docker 的 runner 腿如实 skip 标注（T2 票面口径） |

M2 专属门禁项（AC-06 harness、AC-08 并行、沙箱本机套件、演示脚本）不在 CI 判定内，由本报告 §2 在合并态本机补齐——与 M0/M1 报告「CI 边界」同一处置。

## 2. 合并态复跑（本机，b461a8d 工作树；node v24.22.1 homebrew）

### 2.1 AC-06 前置：20 组限定需求 harness —— **桩/容器双路径 MET**

复跑方式：`pnpm --filter @morrow/runtime factory:ac06`（桩：LocalNodeRunner，esbuild + node 子进程 + preload fetch 桩模拟 network=none）与 `pnpm --filter @morrow/runtime factory:harness:container`（DockerRunner，node:22-alpine 真实容器，`--network none`）。

| 路径 | 结果 | 耗时 |
|---|---|---|
| 桩（LocalNodeRunner） | **20/20**：18 组全链路走通（proposed→Owner confirm→注册 author=ai disabled）；越权 3 组 **100% 阻断**（S18 代码越权被沙箱拦截 + S19/S20 manifest 越权在规划阶段 escalation，violations 留痕、注册无痕）；failures 0；`AC-06 threshold: MET` | 5.2s |
| 容器（DockerRunner） | **1/1 pass**（同一样例集、同一断言：≥18 组走通 + 越权 100% 阻断） | 33.6s（总 34.7s） |

失败组日志可追踪：失败样例落 `capability.factory_failed`（stage/code/detail + 逐维 violations + 逐用例 report + raw_tail），`FactoryRequestView.error` 结构化承载（harness 内 `detail` 字段逐组可读）。

### 2.2 AC-08 前置：双 Agent 隔离并行 + 资源锁 + 冲突检测 —— **6/6 PASS**

复跑方式：`node --experimental-sqlite --test --experimental-strip-types test/tasks.parallel.test.ts`（真实 git worktree 夹具，2.2s）：

1. 两个代码节点独立 worktree 并行执行、互不可见中间状态、自动合并（**AC-08 核心**）；
2. 同资源声明串行化，无冲突兄弟仍并行（锁生效）；
3. worktree 变更冲突 → 节点 pending_review + task.merge_conflict 事件 + 任务 waiting_input；
4. merge verify 失败 → 节点 failed 且主区回滚（无半合并状态）；
5. 代码节点内 sandboxed 能力调用指向节点 worktree（T2 契约）；
6. sweepResidue 清理崩溃残留但保留 pending_review 证据。

合并前有验证记录：自动合并路径在 verify 通过后才落主区（用例 1/4 断言）。

### 2.3 沙箱真实容器套件（T2 `test:sandbox`）—— **69/69 PASS**

`pnpm --filter @morrow/runtime test:sandbox`（11 套件，10.1s，本机 docker 实跑容器用例）：契约 fail-closed、探测与 install-hint、DockerRunner 真容器（network none / 资源限额 / workspace 挂载 / 超时强杀）、invoker 先权限后执行、registry 权限引擎接线、Go Worker。AC-06/08 的沙箱依赖全部由这套件锁定。

### 2.4 完整演示（PRD §9 M2 门槛）—— **可重复执行，10/10 × 2 次 PASS**

`bash scripts/real-machine/m2-demo.sh`（自启 capability-fixture——T7 接缝收尾后为**纯透明代理**，脚本打的每条路径都是真实 Runtime 端点）：缺能力（注册表无 csv.export）→ 造工具（POST /v1/capabilities/request → 真实管线 submitted/planned→built→proposed/verified）→ 安全验证（四类用例逐条 pass + privilege-escalation 阻断 + Owner 确认门 confirm → 注册默认停用）→ 重用（同需求复提 → status=reused 命中 factory-index:csv.export 0.875 不新建；Skill 链路：两次成功案例 → 自动提案 → 批准 → invoke 经真实 memory.write builtin 执行写入候选）。连续两次运行 PASS=10 FAIL=0；全文归档 **`docs/gates/m2-demo-output.md`**。

### 2.5 全 workspace 测试（合并态 + 本票接缝收尾）—— **绿**

`pnpm -r test` exit 0（先 `pnpm --filter @morrow/runtime build`）：runtime **520/520**（含 §2.1-2.3 套件）、protocol 40/40、pi-adapter 31/31、desktop 67/67（node:test）+ sidecar Rust 9/9、packaging 56/56。合计 node:test **714/714**（M1 收官 464 → M2 合并态 714）。

## 3. 接缝收尾（T6 预留，apps/desktop；runtime 产品代码零改动）

T6 的接缝清单（capability-fixture.ts 内「T3/T5 合入后整段删除」两段 mock + api.ts 两处「端点由 T3/T5 交付」注释）全部消解：

| 文件 | 收尾内容 |
|---|---|
| `apps/desktop/scripts/capability-fixture.ts` | 删除 T3 工厂 mock 段（事件流脚本/假 job/接缝路由）与 T5 Skill mock 段（静态 skills/proposals 数组 + 决策 mock）；前置伺服只剩**纯透明代理**。真实链路演示数据改为：工厂注入脚本化生成器（RuntimeOptions.capabilityGenerator 公开 seam，FakePi 同款口径）+ 本地桩 Runner；Skill 走真实案例上报端点（两次成功 → 自动晋升提案）；skillInvoker seam 注入 memory.write **真实 builtin 实现**（见 §5-2 缺口说明） |
| `apps/desktop/src/api.ts` | 工厂封装对齐 T3 真实合约：POST /v1/capabilities/request（body `description`）、GET /v1/capabilities/requests/:id、POST /v1/capabilities/:id/confirm；`FactoryRequest` 类型改为真实 FactoryRequestView 投影（status×stage 双轴 + manifest/report/error/reuse_matches）。Skill 封装不变（runtime 双路径族 `/v1/skills*` 即 T6 合约） |
| `apps/desktop/src/capability-ui.ts` | 新增 `factoryStageOf`（真实 status×stage → Owner 进度线投影）与 `describeVerification` 重写（真实 VerifyReport 逐用例按 AC-06 口径归组：越权/功能/反向故障/沙箱执行；sandbox_error 单列）；删除 mock 口径的 VerificationReportItem/verificationCategoryLabel |
| `apps/desktop/src/CapabilitiesView.tsx` | FactoryPanel 接真实视图：轮询终态按 status（proposed 等确认 / confirmed / failed / reused）、失败横幅呈现结构化 error（stage/code/detail + violations 逐维）、reused 呈现重用命中（FR-CAP-1）；删除 seamError（「端点未接入」提示随接缝消失） |
| `apps/desktop/src/capability-ui.test.ts` | §4 重写为真实投影测试（factoryStageOf 双轴映射 + describeVerification 真实报告形状/越权未全阻断/沙箱故障/无报告四态）；其余节不动 |

**浏览器级验证（真实链路）**：fixture 起动后对前置端口逐步走查（与浏览器同路径）——注册表真实数据（GET /v1/capabilities，memory.write@1.0.0 + 演示能力带 source_hash/版本历史）、grants 编辑（PUT /v1/capabilities/grants 真实生效 + capability.grants_updated 审计事件）、工厂 request→进度→验证报告→confirm→注册表出现 csv.export（§2.4 与 m2-demo-output 同链路）、Skill 提案→approve→invoke（真实执行）。desktop 测试保持绿：typecheck 通过 + node:test 67/67（删除 mock 相关断言时同步改为真实投影断言，真实端点路径按合约由真实数据通过）。

## 4. PRD §9 M2 门槛核对表

| 门槛（PRD §9 M2） | 判定 | 证据指针 |
|---|---|---|
| 「缺能力→造工具→安全验证→重用」完整演示 | **达成（FakePi/桩口径，脚本化可重复）** | §2.4：m2-demo.sh 10/10 × 2 次（缺能力→真实工厂管线→四类用例+越权阻断+确认门→检索复用 + Skill invoke 重用）；归档 `docs/gates/m2-demo-output.md` |
| AC-06 前置：20 组 ≥18 走通 + 越权 100% 阻断 | **达成（分母定版）** | §2.1：桩 20/20（18 走通 + 3 越权全阻断）+ 容器 1/1；CI ubuntu 容器腿独立证据（§1 sandbox job） |
| AC-08 前置：并行 + 锁 + 冲突检测 | **达成** | §2.2：6/6（worktree 隔离并行、同锁串行、冲突 pending_review、verify 失败回滚） |
| 沙箱/工厂/Skill 交付质量 | **达成** | §2.3：沙箱套件 69/69；T1-T5 六票 CI 链（§1）；Skill 服务/路由测试随 runtime 520 全绿 |
| AC 基线按 M2 实测更新 | **达成** | `docs/prd/ac-baseline-m0.md` §8（M2 校准注记，本次更新） |

**M2 门槛判定：主线门槛达成**（演示形态为 FakePi 生成 + 本地桩沙箱；真实 LLM 生成与声明网络工具的容器执行保持开放，见 §5）。

## 5. 未达项与边界（如实标注）

1. **Skill invoke 的 runtime 缺省接线缺口（T7 发现 → 已由 #22 修复批闭合）**：SkillService 缺省 invoker = ToolInvoker，但修复前 runtime 产品代码**从未向 ToolInvoker 注册任何工具**（builtin 实现留在会话层工厂、sandboxed 能力注册也只进能力注册表）——缺省 `POST /v1/capabilities/skills/:id/invoke` 必然 `unknown_tool`；T5 的演示链路测试经 `skillInvoker` 注入 FakeInvoker 通过，真实 Runtime 上不成立。**修复批（分支 `fix/ci-build-legs`）已闭合**：启动时把注册表全部 enabled 能力登记进 ToolInvoker（builtin → `sandbox.type=process` 进程内执行条目、工厂产物 → 最近确认请求的容器执行条目），enable/disable/rollback 生命周期事件经 `PermissionEngine.onLifecycle` 驱动注册表增删改（disable 后 invoke 404 unknown_tool，测试断言）；新增 `POST /v1/capabilities/:id/invoke` 与 Skill invoke 共用同一执行链（权限复核在链上），错误码按 `invocation-errors.ts` 契约表统一映射 HTTP 状态（503+install-hint / 403 / 400 / 504 / 502 / 404），`capability.used` / `skill.invoked` 审计先落账本后返回；能力注册表增 verified 标记（GLOSSARY「已验证」），Skill 引用校验升级为 enabled AND verified。证据：`apps/runtime/test/capabilities.invoke.test.ts`（缺省链路 e2e + 逐错误码断言）。
2. **声明网络的合法工具 v1 无法过验证（fail-closed by design）**：沙箱契约 v1 只支持 `network: none`（`contract.ts:101` fail-closed 拒绝其它取值）——manifest 声明 `network: restricted` 的合法工具（如演示能力 web.fetch）无法经工厂验证/容器执行；网络放行面（restricted 的 egress 白名单实现）v1 未建。**保持开放**。
3. **Skill 多步组合的提案边界**：自动晋升仅覆盖单能力组合（同能力连续成功 streak）；多步声明式组合（steps 多能力 + arg_mapping）只能经手动提案端点 `POST /v1/capabilities/skills` 成立（悬空引用 409、invoke 逐步执行已实现并有测试），但无 UI 入口、也无从经验自动组合多步的路径。**保持开放**（组合生成属后续票）。
4. **真实 LLM 生成冒烟未跑**：工厂生成器默认经 PiAdapter 一次 prompt（生产路径已实现），全部证据用脚本化生成器（FakePi 同款口径，零网络）——与 M0/M1 同一边界：真实模型行为待 Owner 密钥（ac-baseline §4）。`smoke-real-provider.ts` 同样未执行。**保持开放**。
5. **桌面 UI 人工点击走查未做**：本报告的「浏览器级验证」为前置端口 HTTP 逐步走查（与 UI 同路径）+ UI 纯逻辑测试；「人工点击」形态属 M6 全量验收（承 M1 §5-5）。**保持开放**。
6. **CI 中途三平台 build 腿回归（已修复）**：T6/T4/T3 三次 merge 触发 protocol browser 子路径入口回归（三平台 build 腿 failure），fix(#27) b461a8d 前一提交修复恢复；期间 skillRoutes/factoryRoutes 等能力域功能测试未受影响。已闭环，登记备查。
7. **keyring 平台边界 / node 版本约束（承 M1，未变化）**：Windows/Linux keyring 后端未实测；node ≥22.16（FTS5）约束继续有效。**保持开放**。

## 6. 结论

**M2 门禁：通过**（PRD §9 主线门槛「缺能力→造工具→安全验证→重用」以可重复脚本达成并归档；AC-06/08 前置证据齐档，测试规模 714 node:test 全绿）。保持开放的外部依赖待办：声明网络工具的沙箱网络放行（§5-2）、Skill 多步组合（§5-3）、真实 LLM 生成冒烟（待密钥）、桌面 UI 人工走查（M6）。修复批（`fix/ci-build-legs`）已闭合 §5-1 调用路径缺口与 #23 测试套件守卫（docker 探测/辅助调用全部有界 + 容器套件「探测超时 → 诚实 skip」），见 §7 修复批记录。

## 7. M2 code-review 修复批（分支 `fix/ci-build-legs`，2026-11-02）

双轴修复（调用路径缺口 A + 套件健壮性 B + 文档 C）在独立分支交付，基线 fa98f9a、已合并 integration/m0（e47ed74，up to date）。逐项与提交：

| 项 | 内容 | 提交 |
|---|---|---|
| A1 (#22) | FR-CAP-5 调用路径做真：启动时把注册表全部 enabled 能力登记进 ToolInvoker（builtin → `sandbox.type=process` 进程内执行条目、工厂产物 → 最近确认请求的容器条目、无实现跳过并告警）；enable/disable/rollback 生命周期事件经 `PermissionEngine.onLifecycle` 驱动注册表增删改（disable 后 invoke 404 unknown_tool，e2e 断言） | 65ec302 |
| A2 (#22) | `POST /v1/capabilities/:id/invoke`（body=input、`?session_id=` 归属）——经 ToolInvoker 统一执行链（权限复核在链上），与 Skill steps 同链；工具自报失败 502 结构化返回 | 65ec302 |
| A3 (#22) | 错误码表落地：`invocation-errors.ts` 单源映射（sandbox/runner.ts 头部契约表的 HTTP 半边）——sandbox_unavailable/image_pull_failed→503+install-hint、permission_denied→403、invalid_sandbox_contract/tool_package_unsupported/capability_escalation→400、tool_timeout→504、tool_build_failed→500、工具自身失败→502、unknown_tool→404；`handleSkillError` 裸 throw 替换 | 65ec302 |
| A4 (#22/#26) | 审计贯通：`capability.used`（invoke 直呼 path=direct + Skill 步级 path=skill）与 `skill.invoked`（ok/steps/executed/failed_step/duration_ms）先落账本后返回 | 65ec302 + 9a359c7 |
| A5 (#22/#26) | verified 语义（GLOSSARY「已验证」）：capabilities/capability_versions 增 verified 列（pragma 补列迁移）；工厂确认/builtin=true、human 按 tests 非空、直注 ai=false；Skill 引用校验升级 enabled AND verified（提案与批准双道） | 65ec302 + 9a359c7 |
| B6 (#23) | 默认测试链 docker 挂起防线：`detectContainerRuntime` 增 timeoutMs 有界探测 + probeTimedOut 标记；DockerRunner 辅助调用（inspect/pull/kill/rm）全经超时 race（aux 10s / pull 300s）；容器套件「探测超时 → skip(理由)」守卫（本机 wedged-docker 实测两套件 ~10s 诚实 skip）；修复存量缺陷——harness 测试曾只计算 SKIP_REASON 未挂载。守卫逻辑全部以注入桩证明 | ecf3076 |
| B7 (#22) | CapabilityStore manifest 字段串（Data Clumps）收敛为 CapabilityManifestFields + identity/content/currentUpdate 绑定 helper（并修复 updateCurrent 绑定序错位） | 65ec302 |
| C8 (#22) | 越权消息构造单源：escalationMessage（engine 注册预检与工厂 plan 预检共用） | 65ec302 |
| C9 (#23) | classifyRun/classify 同构分类器收敛为 classify.ts 的 classifyToolRun（协议差异参数化，两 Runner 薄包装，文案逐字不变） | ecf3076 |
| C10 (#21) | 本报告 §5-1 闭合标注 + §7 修复批记录；README 增能力域端点表与调用错误码表（单源指向 invocation-errors.ts） | 本提交 |

**测试规模**：runtime 531/531（本机，排除两个真实容器套件；较合并态同口径 +21——新增 capabilities.invoke e2e ×8、invocation-errors 映射表 ×3、invoker 进程内 ×5、detect 有界探测 ×2、DockerRunner 有界辅助 ×2、verified 标记 ×1；真实容器套件本机探测超时诚实 skip，由 CI ubuntu 腿验证）；protocol 40/40、pi-adapter 31/31、desktop 67/67 + sidecar Rust 9/9、packaging 56/56 全绿。node 24.22.1。

**判定**：§5-1 调用路径缺口**已闭合**（缺省接线为真 + 端点 + 错误码 + 审计 + verified，测试锁定）；§5-2/5-3/5-4/5-5 保持开放不变。
