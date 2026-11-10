# AC-05 合并态复跑归档（M3-T7 / Issue #36）

**生成时间**：2026-11-10T06:29:48.237Z ｜ **node**：v24.22.1 ｜ **平台**：darwin-arm64
**样本**：20 个竞争事实（6 preference 自动合并 + 14 待审核：locked 3 / sensitivity_change 5 / fact_conflict 6）

## 1. 20 个竞争事实分类结果

| # | 样本 | kind | M1 巩固器分支 | 期望 | A 分类 | B 分类 | A v / B v | 收敛 | 本地视图保留 | 判定 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | pref-vim-emacs | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - | PASS |
| 2 | pref-theme | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - | PASS |
| 3 | pref-dark-light | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - | PASS |
| 4 | pref-pnpm-npm | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - | PASS |
| 5 | pref-tabs-spaces | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - | PASS |
| 6 | pref-font | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - | PASS |
| 7 | fact-database | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 1 / 1 | true | false | PASS |
| 8 | fact-ubuntu-debian | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 1 / 1 | true | false | PASS |
| 9 | fact-port | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 1 / 1 | true | false | PASS |
| 10 | fact-sqlite | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 1 / 1 | true | false | PASS |
| 11 | fact-city | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 1 / 1 | true | false | PASS |
| 12 | fact-branch | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 1 / 1 | true | false | PASS |
| 13 | locked-passport | profile | review:locked | locked | locked | locked | 1 / 1 | true | false | PASS |
| 14 | locked-birthday | profile | review:locked | locked | locked | locked | 1 / 1 | true | false | PASS |
| 15 | locked-credential | fact | review:locked | locked | locked | locked | 1 / 1 | true | false | PASS |
| 16 | sens-address | profile | review:sensitivity_change | sensitivity_change | sensitivity_change | sensitivity_change | 1 / 1 | true | false | PASS |
| 17 | sens-phone | profile | review:sensitivity_change | sensitivity_change | sensitivity_change | sensitivity_change | 1 / 1 | true | false | PASS |
| 18 | sens-medical | fact | review:sensitivity_change | sensitivity_change | sensitivity_change | sensitivity_change | 1 / 1 | true | false | PASS |
| 19 | sens-apikey | fact | review:sensitivity_change | sensitivity_change | sensitivity_change | sensitivity_change | 1 / 1 | true | false | PASS |
| 20 | sens-bank | profile | review:sensitivity_change | sensitivity_change | sensitivity_change | sensitivity_change | 1 / 1 | true | false | PASS |

**计数**：自动合并期望 6 → 实际 6；待审核期望 14 → 实际 14；locked 3 / sensitivity_change 5 / fact_conflict 6。

> **缺陷观测（如实登记，见门禁报告 §6）**：14 个待审核样本的**分类全部正确**，但两端都产生 sync.conflict 后，跨端冲突审计互把对方本地 v2 修订记入 remote_event_ids，重放时双方可见值回落基线 v1；本地 v2 可见的条数 = 0/14。冲突队列（memory_conflicts）仍完整保留两侧内容，Owner 仍可裁决；缺陷在「重放过滤未按 local_replica_id 归属判定」，不影响 AC-05 的「预期合并或待审核」分类判定，但影响待审核期间的本地可见值。

## 2. 删除不复活（双向）

| 方向 | fact_id | A deleted | B deleted | 删除方导入了旧修订 | tombstone_skipped 审计 | 判定 |
|---|---|---|---|---|---|---|
| A 删 / B 离线改 / B 上线 | 01a1c426-041d-75c8-bd93-02a7316ebe9d | true | true | false | 1 | PASS |
| B 删 / A 离线改 / A 上线 | 01a1c426-041d-7ef1-b91b-b265a725f499 | true | true | false | 2 | PASS |

**删除判定**：PASS（双方保持删除态，旧修订未复活）

## 3. 同步审计

| 事件 | A | B |
|---|---|---|
| sync.merged | 6 | 6 |
| sync.conflict | 28 | 28 |
| sync.tombstone_skipped | 3 | 3 |

**总判定**：PASS
