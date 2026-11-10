# Morrow M3 门禁报告（T7 / Issue #36）

**归档日期**：2026-11-10 ｜ **分支基线**：`integration/m0` @ 6c3e47b（M3 六张开发票 #30–#35 + 缺口修复批 + T7 门禁收尾的合并态；修复批分支 `fix/m3-projection-conflict` @ 9fb82ab 起，含 code-review A1/A2/B1/B2 修复） ｜ **真机**：MacBook Pro（Mac16,8，Apple M4 Pro，24 GB，macOS 15.5 Build 24F74）
**参考环境**：`docs/prd/ac-baseline-m0.md`（§9 为 M3 校准注记） ｜ **格式基准**：`docs/gates/m2-gate-report.md`

M3 门槛（PRD §9）：**「三种部署工作；跨设备不重复执行同一任务」**；对应 AC-04（增量双向同步，2 设备各离线 50 条 + 小事件 p95）、AC-05（20 个竞争事实 + 删除不复活）。
T7 归档时的产品缺口在 §6 如实登记；其中 §6-4（任务投影不随同步重建）、§6-5（AC-05 待审核可见值回落）、
§6-6（preference 版本膨胀）由修复批 `51ecc64`（Issues #32 #36）在产品代码中修复并补测试（§2.2/§6），
其余边界仍如实保留。

**后续修复批**：`fix/m3-sync-wiring` @ `d716b99`（Issue #34/#36）闭合 §6-1/2/3（同步启动接线、bearer token 透传、跨设备事前租约互斥），并在 §5/§6/§7 同步改判；AC-04/AC-05 归档数字未重跑（修复不改变同步吞吐路径）。

## 1. CI 证据（integration/m0）

| 项 | 值 |
|---|---|
| 当前 tip | 6c3e47b（merge: integration/m0 合并态——AC-04/AC-05 复跑与门禁报告刷新），与 `integration/m0` 一致 |
| 修复批 tip | 9fb82ab（`fix/m3-projection-conflict`：code-review A1 fencing token 跨副本单调、A2 同步游标命名空间拆分、B1/B2 memory-sync 版本关系与 valid_until、文档与清理；**未 push**） |
| 最新 run | [42767124433](https://github.com/EasonW3300/Morrow/actions/runs/42767124433)（push integration/m0，2026-11-10T06:14:02Z，约 4m13s）—— **success**（8 job 全绿：build ×3、gate ×3、gate report、`sandbox tests (ubuntu, real containers)`） |
| Ubuntu 部署冒烟 job | `gate (linux)` 第 8 步 **Deployment smoke (server form, systemd-equivalent)** success（`scripts/deploy/smoke-server.sh --binary artifacts/runtime/morrow-runtime-linux-x64`，服务器单二进制前台等价形态） |
| 前一条成功 run | [42762135949](https://github.com/EasonW3300/Morrow/actions/runs/42762135949)（a5d7eba，2026-11-10T05:26Z）—— 同为 8 job 全绿，含同一部署冒烟步骤 |
| CI 边界 | CI 只跑**服务器形态**部署冒烟（linux 腿）；纯本地与混合双进程冒烟在本机执行（§3）。真实 systemd 加载需要活跃 systemd 会话，runner 上不做 |

M3 专属门禁项（AC-04/AC-05 复跑、p95 测量、needs_reconcile 场景、两轮演示）不在 CI 判定内，由本报告 §2–§4 在合并态本机补齐——与 M0/M1/M2 报告「CI 边界」同一处置。

## 2. 合并态复跑（本机，6c3e47b 工作树；node v24.22.1 homebrew）

复跑脚本（可重复执行，全部走真实 HTTP 接缝；设备私钥只在进程内存）：

```bash
export PATH="/opt/homebrew/bin:$PATH"
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac04-sync.ts --out docs/gates
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac05-conflicts.ts --out docs/gates
bash scripts/real-machine/m3-demo.sh --out docs/gates/m3-demo-output.md
```

### 2.1 AC-04 增量双向同步（50 × 2 + 小事件 p95）—— **复跑 PASS**

方法：两个独立 Runtime（独立 dataDir / replica_id / SQLite 账本 / HTTP 端口）；B 经
`POST /v1/pairing/join` 加入 A；A/B 各离线创建 50 个会话（各 50 条独立 `session.created`，
同步前互不可见）；`POST /v1/sync/run` 双向同步（真实 HTTP 传输，pull→push→push→pull）后逐项对账。

| 项 | A | B |
|---|---|---|
| 离线写入业务事件 | 50 | 50 |
| 同步后本地业务事件 | 100 | 100 |
| 缺失 | **0** | **0** |
| 重复 | **0** | **0** |
| 来源 A 事件相对顺序一致 | 是 | 是 |
| 来源 B 事件相对顺序一致 | 是 | 是 |
| 同步前隔离（对方事件不可见） | 是 | 是 |
| `last_sync_at` / `sync.run_completed` | 有值 / 有 | 有值 / 有 |

小事件 p95（100 样本；每轮 1 条 `session.created`，最大 406 B ≤1KB；墙钟 = `POST /v1/sync/run` 全轮）：

| 统计量 | 值 |
|---|---|
| p50 | 1.66 ms |
| p90 | 2.35 ms |
| **p95** | **2.43 ms**（两块修复批合并后重跑 `00c3905`；T7 归档时 2.54 ms） |
| p99 | 3.74 ms |
| min / max / mean | 1.39 / 5.71 / 1.83 ms |
| 100 样本收敛到 B | 100/100 |
| 阈值（PRD §8 待校准） | ≤ 10,000 ms → **MET** |

**环境口径（必须随数字引用）**：127.0.0.1 本机回环、单机双实例、node 24——这是**回环基线**；
真实 Tailscale/Wi-Fi 网络未测（待 Owner 环境）。M3 同步接线修复（#34，提交 d716b99）后
HTTP 传输已按设备凭据携带 bearer token，真实非回环路径具备认证接缝，但双机跨网络仍未实测。
归档：`docs/gates/m3-ac04-sync.md` + `.json`。

### 2.2 AC-05 竞争事实与删除（20 样本 + 双向删除）—— **分类、删除与本地可见值 PASS（重放缺陷已修复）**

方法：20 个事实基线 v1 落 A 账本并同步到 B；A/B 各自离线写同一事实的 v2 竞争修订
（内容/敏感等级按样本），重连多轮同步后分类。分类口径复用 M1 巩固器（`DefaultConsolidator`）。

| 期望分类 | 样本数 | 实际（A/B 两侧原因一致） | 结果 |
|---|---|---|---|
| 自动合并（preference） | 6 | 6 全部自动合并；两端收敛到同一 v3 内容 | **PASS** |
| 待审核 `locked` | 3 | 3 | **PASS** |
| 待审核 `sensitivity_change` | 5 | 5 | **PASS** |
| 待审核 `fact_conflict` | 6 | 6 | **PASS** |
| 合计 | **20** | **6 合并 + 14 待审核** | **PASS** |

同步审计（每侧）：`sync.merged` 6、`sync.conflict` 28（14 本地冲突 + 14 对端冲突审计）、
`sync.tombstone_skipped` 3。

删除不复活（双向）：

| 方向 | 双方 deleted_at | 删除方导入旧修订 | `sync.tombstone_skipped` | 判定 |
|---|---|---|---|---|
| A 删 / B 离线改 / B 上线 | 均非空 | 否 | 1 条（引用旧修订 event_id） | **PASS** |
| B 删 / A 离线改 / A 上线 | 均非空 | 否 | 2 条（含前一轮残留） | **PASS** |
| 再同步一轮 | 仍删除 | — | — | **PASS** |

**可见值判定（修复批 `51ecc64`，§6-5 已修复）**：待审核期间两端各自的本地 v2 修订必须保持可见。
修复前两端都产生 `sync.conflict` 后，跨端冲突审计的 `remote_event_ids` 互把对方**本地** v2 修订
也标记为「不采纳」，重放后双方可见值落回基线 v1（**A 0/14、B 0/14**）。修复后重放按事件作者
归属过滤：只压制非本副本创作的远端修订，本地已合并的 v2 保持可见——本轮复跑
**A 14/14、B 14/14**；冲突队列 `memory_conflicts` 完整（14/14），且冲突记录同时携带本地版本引用
（`local_version`/`local_revision_id`/`local_event_id`）与远端事件引用（`remote_event_ids`，14/14）。
归档：`docs/gates/m3-ac05-conflicts.md` + `.json`（`counts.review_local_view_retained[_b]`）。
该修复只影响待审核期间的可见值，不改变 20/20 的「预期合并或待审核」分类与删除不复活判定。
修复后 `POST /v1/sync/conflicts/:id/resolve` 的 keep_new / keep_old / merge 三种裁决均有测试覆盖
（版本链与可见值符合裁决，见 `apps/runtime/test/sync.tasks.test.ts`）。

## 3. 三部署形态启动证据（本机 + CI）

| 形态 | 本机执行 | 结果 | 备注 |
|---|---|---|---|
| 纯本地 | `bash scripts/deploy/smoke-local.sh` | **PASS**：ready → `/v1/health`（ledger.events≥1）→ 一次 mock Provider 对话（stop_reason=stop）→ SIGTERM 优雅退出（runtime.stopped） | 源码形态（未打包二进制）；`MORROW_SECRET_BACKEND=memory` |
| 纯服务器（systemd 等价前台） | `bash scripts/deploy/smoke-server.sh` | **PASS**：unit 模板关键指令 + env 模板回环默认/`/var/lib/morrow` → 按 EnvironmentFile 语义前台起进程 → health → 优雅退出；真实 systemd **SKIPPED（非 Linux，待 Owner Ubuntu 机器验证）** | CI ubuntu 腿以打包单二进制跑同一脚本（§1） |
| 混合双进程 | `bash scripts/deploy/smoke-hybrid.sh` | **PASS**：双进程配对（双端 fingerprint 核对）→ A/B 离线写 5/3 条 → `/v1/sync/{pull,push}` 双向（A→B accepted=8、B→A accepted=7）→ 重推幂等（accepted=0）→ 逐项对账 | 两个真实进程、临时 dataDir、127.0.0.1 随机端口；真实 Tailscale 组网待 Owner |

**CI 证据**：最新 run [42767124433](https://github.com/EasonW3300/Morrow/actions/runs/42767124433) 的
`gate (linux)` 部署冒烟步骤 success（服务器单二进制形态，systemd 等价前台）。
纯本地/混合未加入 CI（本机证据）；真实 systemd 与真实 Tailscale 均待 Owner 环境。

## 4. 跨设备不重复执行（needs_reconcile）证据

| 证据 | 内容 | 结果 |
|---|---|---|
| `apps/runtime/test/lease.scheduler.test.ts` | 「双端独立执行 → needs_reconcile（含两侧证据），Owner 显式裁决后离开该状态」：同 task 两个 replica 的 `task.started` 证据 → `task.needs_reconcile`（evidence.replicas / independent_replicas / reasons=dual_execution）；Owner 裁决后 `task.reconciled` + `task.completed`（actor=owner） | **PASS**（套件内） |
| `apps/runtime/test/lease.api.test.ts` | `POST /v1/tasks/:id/reconcile/detect` 冻结 + `POST /v1/tasks/:id/reconcile` 裁决；`GET /execution` 显示 `needs_reconcile=true` 且无有效租约；非法 resolution 400 | **PASS**（套件内） |
| `scripts/real-machine/m3-demo.sh` 第 8–10 项 | 异地执行证据入账本 → detect 冻结（`task.needs_reconcile`，evidence 含 A/B）→ Owner 裁决 completed（`task.reconciled` owner）；needs_reconcile 期间/裁决后无有效租约 | **PASS × 2 轮** |

事件名：`task.started`（双端证据）、`task.needs_reconcile`、`task.reconciled`、`task.completed`（owner）；
租约路径另有 `task.lease_acquired` / `task.lease_denied` / `task.lease_renewed` / `task.lease_released` /
`task.lease_lost`（`lease.scheduler.test.ts`、`lease.preacquire.test.ts` 覆盖）。

**边界**：本节「双端独立执行 → 冻结」的证据与执行前互斥是两件事——后者由 #34 修复批
（`d716b99`）补齐：acquire 前只 pull 增量并重放远端租约，远端持有即拒绝；acquire 后二次采样检测
双持有并立即冻结（§6-1）。同时任务投影已随同步重建（`51ecc64`，§6-4），对端可列表/查看同步来的
任务且不自动接管执行权，因此「异地任务」不再是投影层面的盲区。无共识协议下「拉取与 acquire」
之间的竞态窗口仍是设计边界（fencing token + needs_reconcile 兜底）。
`apps/runtime/test/sync.tasks.test.ts` 覆盖「双实例真 HTTP：执行到一半同步 → 对端可见且不自动执行」，
`lease.preacquire.test.ts` 覆盖「远端持租约时拒绝 + 双持有冻结」。

## 5. PRD §9 M3 门槛逐项核对

| 门槛 | 判定 | 证据指针 |
|---|---|---|
| 三种部署均工作 | **达成（本机 + CI ubuntu 前台等价）**；真实 systemd 待 Owner | §3：local/server/hybrid 三冒烟全 PASS；CI `gate (linux)` 部署冒烟 success；真实 systemd SKIPPED 标注 |
| 跨设备不重复执行同一任务 | **达成（回环基线，含诚实残余窗口）**：acquire 前跨设备租约检查 + 双持有冻结；fencing token 最终护栏 | §4；§6-1（#34，d716b99）；`lease.preacquire.test.ts`（A 持租约 B 被拒、双持有 → needs_reconcile、拉取节流） |
| AC-04 增量双向同步 | **达成（回环基线）**：50×2 无丢失/无重复/顺序一致；p95 2.43 ms（合并态重跑） | §2.1；`docs/gates/m3-ac04-sync.{md,json}` |
| AC-05 冲突和删除 | **达成（分类 + 删除 + 待审核可见值）**：20/20 分类正确；本地 v2 可见 14/14 两侧（修复前 0/14） | §2.2；`docs/gates/m3-ac05-conflicts.{md,json}`；§6-5 |
| 端到端演示（两轮 10/10） | **达成** | `docs/gates/m3-demo-output.md`（2 轮 × 10 项断言全 PASS） |
| 任务投影随同步重建 | **达成（修复批）**：对端 `GET /v1/tasks` 可见、详情非 404；启动补建；执行器不自动接管 | §6-4；`apps/runtime/test/sync.tasks.test.ts` |
| 全 workspace 测试绿 | **达成** | §7（node:test 831/831 + sidecar Rust 9/9） |

**M3 门禁判定：条件性通过（产品侧阻断项已修复）**——三种部署与 AC-04/AC-05 达成；
「跨设备不重复执行同一任务」补上了跨设备租约事件同步与 acquire 前检查（#34，d716b99），
按 PRD §4.6 FR-DEP-4 的口径达成回环基线。仍未闭合：无共识协议下「拉取 → acquire」之间的
竞态窗口（已文档化，靠 fencing token + needs_reconcile 兜底）、
真实 systemd/Tailscale/UI 人工走查等外部边界。任务投影已随同步重建（§6-4，`51ecc64` 修复）。
其余开放边界见 §6。

## 6. 未达项与边界（如实登记）

> **修复批状态**：原登记项 1/2/3 由 #34（`d716b99`）修复，4/5/6 由 #32/#36（`51ecc64`）修复；
> 7–12 仍为开放边界。AC-04 与 AC-05 均已在两块修复批合并后（`00c3905`）重跑：AC-04 p95 2.43 ms、
> 50×2 对账 PASS；AC-05 可见值 14/14 两侧、冲突记录含本地引用 14/14；`m3-demo.ts` 两轮 20/20。

1. ~~**跨设备执行权没有共享状态**~~ → **已修复（#34，`d716b99`）**。租约表仍按 dataDir 私有（本地
   协调态），但租约生命周期事件 `task.lease_acquired / .lease_renewed / .lease_released`（含既有
   `task.lease_denied / .lease_lost / .execution_transferred`）随同步传播，`lease/view.ts` 按 task
   重放各 holder 的当前租约。`LeaseCoordinator` 在 acquire 前向全部已配对 peer **只 pull 增量**
   （同任务 500ms 内复用）并检查远端未过期租约：远端持有 → 不写本地租约行，记 `task.lease_denied`
   （`source: "remote_lease"` + 持有者/token/到期/来源事件），任务保持 planned / waiting_input；
   acquire 成功后**强制二次拉取**，检测双持有 → 立即释放本地租约并冻结 `needs_reconcile`
   （`evidence.reasons` 含 `dual_lease_hold`），不执行节点。证据：`lease.preacquire.test.ts`。
   **诚实残余窗口**：拉取与 acquire 之间无共识协议，两端仍可能各自认为对方未持有；二次采样只缩小
   窗口。最终护栏是 fencing token（副作用提交前校验）+ `needs_reconcile` Owner 裁决；peer 不可达
   不阻断本地 acquire（离线优先）。
2. ~~**Runtime 进程入口未接线出站同步传输**~~ → **已修复（#34，`d716b99`）**。`startRuntime` 缺省构建
   `DeviceSyncTransport` 注入 `SyncEngine`：base_url 读 `devices.base_url`（join 的 `base_url` 与
   claim 的 `device_base_url` 双向写入），token 读 SecretStore 的 `token:<peer>`；设备加入/撤销经
   `PairingService.onDeviceChanged` 即时失效缓存 + 读路径惰性重建。证据：`sync.wiring.test.ts`
   以两个真实 `main.ts` 进程 + join 后调 `POST /v1/sync/run`，`totals.ok=1 / failed=0`。
3. ~~**HTTP 同步传输不带设备鉴权**~~ → **已修复（#34，`d716b99`）**。push/pull/status 在解析到 token 时
   带 `Authorization: Bearer`；无 token 不带头（回环豁免），401/403 detail 带 `auth` 与
   `missing_token`；`peers[].unreachable_reason` 暴露原因。证据：`sync.wiring.test.ts`
   （有/缺/失效 token + 撤销后不再发请求）。**剩余边界**：join 只为加入方发放 token，服务端→加入方
   的非回环反向同步尚无 token 发放协议（回环可用），真实 Tailscale 双机待 Owner。
4. ~~**任务投影不随同步事件重建**~~ **已修复（`51ecc64`）**：新增 `apps/runtime/src/task-rebuild.ts`
   ——按账本 sequence 重放 `task.*` 重建 `tasks`/`task_nodes`/`task_edges`（状态、`task_version`、
   节点结果、attempts、resources、actor、依赖边）；`task.revised` 携带修订后 DAG 全量投影、
   `task.failed` 携带 `error`，重建可精确复原。挂点与记忆投影一致：同步导入批次末尾（批次含
   投影相关的 `task.*` 时；纯租约心跳 `task.lease_*` 不触发全量重建）重建；启动时「任务表为空但账本有 `task.created`」补建一次。对端 `GET /v1/tasks`
   可列出、`GET /v1/tasks/:id` 返回真实状态；**重建只写投影不触发调度器**，未完成任务只读可见，
   执行仍须显式 resume/kick 并经租约。证据：`sync.tasks.test.ts`、`task-rebuild.test.ts`。
5. ~~**AC-05 重放缺陷（待审核期间本地可见值回落）**~~ **已修复（`51ecc64`）**：重放按**事件作者归属**
   过滤——`sync.conflict` 的 `remote_event_ids` 只压制非本副本创作的修订，本地已合并 v2 不再被打回
   基线。冲突记录同时保留 `local_version`/`local_revision_id`/`local_event_id` 与远端事件引用。
   AC-05 复跑：待审核本地 v2 可见 **A 14/14、B 14/14**（修复前 0/14），冲突队列仍完整 14/14。
6. ~~**preference 自动合并的版本膨胀（偶发）**~~ **已修复（`51ecc64`）**：自动合并版本固定
   `max(本地, 远端) + 1`；导入路径在「远端版本 < 本地版本」时跳过（陈旧 v2 不再二次分类）。
   测试覆盖：重复同步 3 次 + 重复重放 3 次版本稳定在 v3。
7. **附件/二进制大文件传输未做**：`SyncFileMerger` 只提供「整文件按内容寻址 + 双版本保留」的库形态
   seam，无 HTTP 路由、无附件目录同步、无大文件分块；同步面只传事件信封（PRD FR-DEP-3 的
   「附件引用」只有引用语义，没有实现文件搬运）。本票未新增。
8. **p95 为回环基线**：2.43 ms 是 127.0.0.1 单机双实例的墙钟；真实 Wi-Fi/Tailscale 路径未测，
   阈值（≤10 s）待 Owner 环境校准。修复批已接通 bearer token，非回环路径可复现认证链路，但双机
   实测仍待 Owner。
9. **真实 systemd 待 Owner Ubuntu 机器验证**：本机 macOS 无 systemd；CI 只跑 systemd 等价前台。
   另承 deploy 文档：系统级服务下 Linux keyring（`secret-tool`）可能不可访问，配对端点会
   503 `secret_store_unavailable`，需 Owner 机器确认。
10. **真实 Tailscale 组网待 Owner**：本机已接入 tailnet（ac-baseline §3），但双机跨网络配对/同步
    未执行；ADR-0004 的传输前提与步骤已在 `deploy/README.md` 给出。
11. **桌面 UI 人工点击走查未做**：本票与 M1/M2 同一边界；「人工点击」形态属 M6 全量验收。
    设备/同步页面（T6）的浏览器级验证见 `docs/gates/m2-gate-report.md` 同类口径与 desktop 测试。
12. **真实 LLM 生成/Provider 冒烟未跑**：本报告所有对话用本地 mock Provider，工厂相关证据为
    M2 口径；与 M0/M1/M2 同一边界（待 Owner 密钥）。

## 7. 测试规模与最终验证

`pnpm install` 后按包执行（runtime 排除两个真实容器套件，精确口径：
`grep -vE "^test/(sandbox\.docker\.test|capability-factory\.harness\.container\.test)\.ts$"`；
desktop 测试前先 `pnpm --filter @morrow/runtime build`）：

| 套件 | 结果 |
|---|---|
| runtime（node:test，排除容器套件） | **609/609 PASS**（17.5s；T7 归档 603 → +6 修复批用例） |
| protocol | 40/40 |
| pi-adapter | 31/31 |
| desktop（node:test） | 95/95 |
| desktop sidecar（cargo test） | 9/9 |
| packaging | 56/56 |
| **node:test 合计** | **831/831**（M2 合并态 714 → T7 825 → 修复批 831） |

修复批新增测试（两块并行修复合并后同一套件）：
`apps/runtime/test/sync.wiring.test.ts`（真实 `main.ts` 双进程同步、token 强制校验、撤销后不再发请求）、
`apps/runtime/test/lease.preacquire.test.ts`（远端持租约拒绝、双持有冻结、500ms 拉取节流）、
`apps/runtime/test/sync.tasks.test.ts`（双实例真 HTTP：执行到一半同步 → 对端可见且不自动执行、AC-05 20 样本、
裁决版本链、preference 版本稳定）、`apps/runtime/test/task-rebuild.test.ts`（逐字段重放与幂等）。

真实容器套件（`sandbox.docker.test.ts` / `capability-factory.harness.container.test.ts`）按票面要求
本机不跑（docker CLI 可能挂起），由 CI ubuntu 腿的 `sandbox tests (ubuntu, real containers)` job
独立判定（最新 run success，§1）。

## 8. 结论

**M3 门禁：条件性通过（主线门槛已达成，外部边界待 Owner/后续票）**。
达成项：三种部署形态（本机 local/server/hybrid + CI ubuntu 服务器形态）、AC-04 回环基线（50×2 对账
无丢失/无重复/顺序一致，p95 2.43 ms）、AC-05 分类/删除/待审核可见值（20/20 预期合并或待审核；
本地 v2 可见 14/14 两侧；双向删除不复活）、两轮端到端演示 20/20、needs_reconcile 检测与 Owner 裁决。
**跨设备不重复执行同一任务**由 #34（`d716b99`）补齐「租约事件同步 + acquire 前远端检查 + 双持有冻结」
（回环基线达成）；任务投影随同步重建与 AC-05 可见值由 #32/#36（`51ecc64`）补齐。

剩余边界（不阻断 M3 门槛，登记待后续）：无共识协议下「拉取 → acquire」竞态窗口（fencing token +
needs_reconcile 兜底）；服务端→加入方的非回环反向 token 发放；附件/二进制大文件传输（§6-7）；
真实 systemd / 真实 Tailscale 双机 / 桌面 UI 人工走查（Owner 与 M6）。

后续最小闭环建议：① 反向 token 发放协议与真实 Tailscale 双机验证；② 附件引用与文件传输；
③ 真实 systemd 安装验证；④ M6 的桌面 UI 人工走查。
