# Morrow M1 门禁报告（T7 / Issue #19）

**归档日期**：2026-11-02 ｜ **分支基线**：`integration/m0` @ c690a77（M1-T1..T6 六张开发票合并态，工作树 `m1/t7-gate-closeout` 与其同源） ｜ **真机**：MacBook Pro（Mac16,8，Apple M4 Pro，24 GB，macOS 15.5 Build 24F74）
**参考环境**：`docs/prd/ac-baseline-m0.md`（§7 为 M1 校准注记） ｜ **格式基准**：`docs/gates/m0-gate-report.md`

M1 门槛（PRD §9）：**单机复杂任务可中断恢复；记忆可回溯来源**。本报告按票 #19 验收项逐项取证；改动力范围仅 `docs/`（产品代码零改动）。

## 1. CI 证据（integration/m0）

| 项 | 值 |
|---|---|
| 当前 tip | c690a77（merge: M1-T6 人工介入与 Task 视图 #18），与 `origin/integration/m0` 一致 |
| 最新 run | [41394738851](https://github.com/EasonW3300/Morrow/actions/runs/41394738851)（push integration/m0，2026-11-02，4m40s）—— **success** |
| M1 六票 CI 链 | T1 [41382213863] / T4 [41381826374] / T2 [41388497671] / T3 [41390962999] / T5 [41391543461] / T6 [41394738851] —— 逐票 push 合并后全部 success |

M1 期间 CI 走 m0 门禁工作流（三平台冒烟门）；M1 专属门禁项（记忆回链、故障注入、人工介入覆盖）不在 CI 判定内，由本报告 §2/§3 在合并态本机补齐——与 M0 报告「CI 边界」同一处置。

## 2. 合并态复跑（本机，c690a77 工作树）

### 2.1 AC-03 前置：100 条记忆记录回链 —— **PASS**

复跑方式：`pnpm --filter @morrow/runtime memory:ac03`（`apps/runtime/scripts/memory-ac03.ts`，确定性脚本，每次全新临时 dataDir）。环境：node v24.22.1（homebrew，FTS5 可用；node 版本边界见 §5-3）。

| 步骤 | 结果 |
|---|---|
| [1/6] 写入→抽取→巩固 | 100 条记录各成一条事实，fact_created 事件齐全 |
| [2/6] Markdown 投影 | 100 个 `{fact_id}.md`；再生成幂等（0 写入 / 100 未变 / 同字节） |
| [3/6] FTS5 检索 | 100/100 命中事实（含来源回链字段） |
| [4/6] 来源回链断言 | 100/100 条 sources 非空，全部指向存在的账本事件（共 500 个事件） |
| [5/6] 账本完整性 | 500/500 事件 hash 复算通过 |
| [6/6] 抽查 | 受控导入转版本化修订（v1→v2）+ 删除 tombstone + 重投影不复活 |
| 耗时 | 全脚本 0.66s（wall clock），exit 0 |

AC-03 三个断言面：①来源全保留（[4/6]）②事实可回链（[3/6]+[4/6]）③敏感冲突不静默覆盖——由 T2 套件锁定：`memory.consolidator.test.ts`（locked 连偏好也不自动改写、sensitivity_change 双向升级、corroborate 不算改写）+ `memory.pipeline.api.test.ts:384`（端到端：locked 冲突只能经 Owner 裁决，decide 被阻断直至 resolve）。

### 2.2 AC-07 前置：故障注入 25 点 —— **25/25 PASS**（20 恢复 + 5 守卫）

复跑方式：`node --experimental-sqlite --test --experimental-strip-types apps/runtime/test/checkpoint.faults.test.ts`（T5 套件，两层注入：进程级真实 spawn + kill -9 / 进程内半写与损坏）。耗时 8.4s，`tests 25 / pass 25 / fail 0`。

**20 个恢复点（R）全过**：P1 reversible 恰好一次重放；P2 delivery_unknown 置 pending_review 不重发；P3 compensatable 重放+登记待补偿；P4 irreversible 置 pending_review 不重发；P5 pause 边界 kill 后 stale-running 收敛；P6 checkpoint 持久恢复；P7 前序不重跑、输出引用保留；P8 二次重启 attempts 诚实累计；P9 并行兄弟无节点丢失；P11 分类回卷显式 restore；P12 连续两次 kill -9 终态后账本完整性过；I13 checkpoint 行补偿无孤儿；I14 半写+attempts 膨胀单调递增；I15 反向半写不虚构事件；I17 边界竞态立即收敛；I20 waiting_input 重复 resume 幂等；I21 无漂移 restore 留痕不重放；I23 checkpoint 行丢失按活状态收敛；I24 收尾前崩溜收敛 task.failed；I25 pending_review 经 Owner 放行完成。

**5 个守卫点（G）全过**：P10 孤儿 created 任务诚实拒绝（409、账本完好）；I16 他任务 checkpoint restore 无副作用；I18 并发双 resume 恰一个受理；I19 并发双 pause 恰一个受理；I22 未知任务建 checkpoint 拒绝。

AC-07 另两个断言面（不可逆操作记录清楚 / 未知状态消息不自动重发）：P2/P4/I25 的 pending_review 事件与 `pending_side_effects` 快照字段即证据。

### 2.3 全 workspace 测试（合并态）—— **绿**

`pnpm -r test` exit 0（先 `pnpm --filter @morrow/runtime build`）：runtime **283/283**（24.2s，含 §2.2 套件）、protocol 40/40、pi-adapter 31/31、desktop 39/39（node:test）+ sidecar Rust 9/9、packaging 56/56。合计 node:test 449/449。

## 3. AC-12 前置：人工介入操作覆盖盘点（T4/T5/T6）

口径：一次「端到端用例」= 测试套件中对该操作的一次真实执行（HTTP 或服务级，FakePi 注入、零网络），成功执行与守卫拒绝分开计数——AC-12 要求的是正向端到端通过，守卫不计入正向分母。全部操作均留审计事件（§3 末）。

| 操作（票面 5 类） | 正向执行 | 守卫/负向 | 证据（测试文件:行） | 判定 |
|---|---|---|---|---|
| ① 暂停 | **12** | ≥5 | checkpoint.api 123/176（HTTP 200 + FR-TASK-5 字段断言）、checkpoint.scheduler 129/194/356/366/406/414/450、faults P6:319 + P11:515（pause 完成后再 kill）、intervention.api pausedTaskWithCompletedA；守卫：api 202/206/239、scheduler 161、faults I19 | ✅ ≥5 |
| ② 修改（revise） | **4** | ≥10 | intervention.test 96（version+1+审计）、127（增删节点+下游重算）、158（failed 回卷 planned）、intervention.api 135（HTTP e2e：pause→revise→resume，自动落 checkpoint）；守卫：test 182/202/230、api 149/153/157/211×3 | ⚠ **差 1**（见 §5-1） |
| ③ 接管（takeover） | **7** | ≥3 | intervention.test 275/312/374（含 scheduler 避让 owner 节点停车 waiting_input）、336 循环内、intervention.api 282/296/341（接管 running 节点）；守卫：test 288/359、api 278/287 | ✅ ≥5 |
| ④ 切模型 | **5 实例 / 3 独立场景** | 1 | tasks.model.api 88（1 场景 3 节点级解析：默认/指定 p-b/未注册 ghost 回退，断言打到 Provider 的 model_id）、revise 改 model 2 场景（test 96 `model:"provider-b"`、api 135 `model:"demo-model"` 随恢复生效） | ⚠ **独立场景 3 < 5**（见 §5-1） |
| ⑤ 恢复（resume） | **≥20** | 3 | checkpoint.api 147/179、scheduler 198/239/273/325/362/410、faults 14 处 resume 调用（P1..P12 恢复路径）、intervention.api 135（修订后恢复跑完新 DAG）；守卫：scheduler 304/310、api 209 | ✅ ≥5 |
| （PRD AC-12 第五类：交还 release） | **4** | ≥2 | intervention.test 313/416（交还+回调度执行）、intervention.api 291/354（交还+auto-kick 完成）；守卫：test 328/336 循环 | ⚠ **差 1**（PRD 类目，票面 5 类不含；见 §5-1） |

**审计事件核对**：runtime 对介入操作落的事件族——`task.paused` / `task.resumed` / `task.restored` / `task.revised`（actor=owner，带 summary+changes 摘要）/ `task.node_taken_over` / `task.node_released` / `task.node_completed_by_owner` / `task.checkpoint_created`；测试断言 actor=owner 与事件载荷的点位 ≥10 处（intervention.test 96 断言 revised 事件 actor、api 259 断言 takeover/release 审计、api 135 断言 revised 事件 + checkpoint reason=revise 等）。全程审计语义成立。

## 4. PRD §9 M1 门槛核对表

| 门槛（PRD §9 M1） | 判定 | 证据指针 |
|---|---|---|
| 记忆可回溯来源 | **达成（M1 单机口径）** | §2.1：100 条合并态复跑 6 步全过（回链 100/100、hash 500/500）；敏感冲突不静默覆盖由 T2 测试锁定（§2.1 末段）；T1-T3 交付 MemoryCandidate/MemorySource/Markdown 投影（issues #13/#14/#15） |
| 单机复杂任务可中断恢复 | **达成（M1 单机口径）** | §2.2：25 点故障注入 25/25（≥19 达标线，实际 20 恢复点全过）；暂停/恢复/restore/kill-9 恢复全链路测试与 API（T5，issue #17）；任务 DAG 与调度（T4，issue #16） |
| 人工介入 5 类操作 × ≥5 次端到端（AC-12 前置） | **部分达成** | §3：暂停/接管/恢复达标；修改 4、切模型独立场景 3、交还 4——缺口如实登记 §5-1 |
| AC 基线按 M1 实测更新 | **达成** | `docs/prd/ac-baseline-m0.md` §7（M1 校准注记，本次更新） |

**M1 门槛判定：两项主线门槛达成**；AC-12 前置覆盖存在三处不足 5 的缺口（不阻塞 M1 主线——AC-12 的正式验收在 M6 全量核对，本票按票面要求如实盘点）。

## 5. 未达项与边界（如实标注）

1. **AC-12 前置覆盖缺口（3 项）**：修改（revise）正向执行 4 次（差 1）；切模型独立端到端场景 3 个（虽实例数 5：3 节点级解析 + 2 次 revise 改 model，但独立场景数 < 5）；交还（release）正向执行 4 次（差 1，PRD AC-12 类目、票面 5 类不含）。补法明确：各补 1-2 个端到端用例即可达标，M2 前随手可补；本票不改产品代码，不顺手凑数。
2. **真实 LLM 抽取冒烟未跑**：抽取/巩固默认实现为确定性启发式（T2 交付口径），`apps/runtime/scripts/smoke-real-provider.ts`（真实 Provider 端到端冒烟）未执行——与 M0 同一边界：真实模型行为待 Owner 密钥（ac-baseline §4）。
3. **FTS5 的 Node 版本边界**：Node 内建 SQLite 在 **22.16+ / 24** 才编入 FTS5；M0 基线登记的工具链 node v22.12.0（`~/.local/node`）**跑不了记忆套件**（建表报 `no such module: fts5`）。本次复跑用 homebrew node v24.22.1。已记入 ac-baseline §7；桌面壳 sidecar 注入路径（`MORROW_SIDECAR_COMMAND`）与 CI（node 22 runner 托管版本）需注意 ≥22.16。
4. **keyring 平台边界（承 M0 报告 §5-1，未变化）**：Windows `cmdkey`/Linux `secret-tool` 后端仍未对真实 OS 凭据库实测，仅 macOS Keychain 实测。
5. **端到端口径**：本报告所有「端到端」均为 FakePi 注入下的 HTTP/服务级链路（T6 的 Task 视图 UI 为 node:test 逻辑测试）；「桌面 UI 人工点击走查」形态的 AC-12 用例未做，属 M6 全量验收形态。
6. **M1 期间 CI 仍走 m0 冒烟门**：M1 专属门禁项（记忆回链/故障注入）未进 CI 判定，复跑证据为合并态本机执行（§2）；是否将 `memory:ac03` 与 faults 套件纳入 CI 属后续工程票。

## 6. 结论

**M1 门禁：通过**（两项 PRD §9 主线门槛达成，证据齐档；三项 AC-12 前置覆盖缺口与两项外部依赖待办如实登记，均不阻塞 M1 收口）。遗留：§5-1 三处补测、§5-2 真实 LLM 冒烟（待 Owner 密钥）、§5-3 node 版本约束传递给打包/CI。
