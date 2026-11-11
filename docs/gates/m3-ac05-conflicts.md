# AC-05 合并态复跑归档（M3-T7 / Issue #36）

**生成时间**：2026-11-10T06:50:57.872Z ｜ **node**：v24.22.1 ｜ **平台**：darwin-arm64
**样本**：20 个竞争事实（6 preference 自动合并 + 14 待审核：locked 3 / sensitivity_change 5 / fact_conflict 6）

## 1. 20 个竞争事实分类结果

| # | 样本 | kind | M1 巩固器分支 | 期望 | A 分类 | B 分类 | A v / B v | 收敛 | 本地视图保留 A/B | 判定 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | pref-vim-emacs | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - / - | PASS |
| 2 | pref-theme | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - / - | PASS |
| 3 | pref-dark-light | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - / - | PASS |
| 4 | pref-pnpm-npm | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - / - | PASS |
| 5 | pref-tabs-spaces | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - / - | PASS |
| 6 | pref-font | preference | auto_merge | auto | auto_merge | auto_merge | 3 / 3 | true | - / - | PASS |
| 7 | fact-database | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 2 / 2 | false | true / true | PASS |
| 8 | fact-ubuntu-debian | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 2 / 2 | false | true / true | PASS |
| 9 | fact-port | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 2 / 2 | false | true / true | PASS |
| 10 | fact-sqlite | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 2 / 2 | false | true / true | PASS |
| 11 | fact-city | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 2 / 2 | false | true / true | PASS |
| 12 | fact-branch | fact | review:fact_conflict | fact_conflict | fact_conflict | fact_conflict | 2 / 2 | false | true / true | PASS |
| 13 | locked-passport | profile | review:locked | locked | locked | locked | 2 / 2 | false | true / true | PASS |
| 14 | locked-birthday | profile | review:locked | locked | locked | locked | 2 / 2 | false | true / true | PASS |
| 15 | locked-credential | fact | review:locked | locked | locked | locked | 2 / 2 | false | true / true | PASS |
| 16 | sens-address | profile | review:sensitivity_change | sensitivity_change | sensitivity_change | sensitivity_change | 2 / 2 | false | true / true | PASS |
| 17 | sens-phone | profile | review:sensitivity_change | sensitivity_change | sensitivity_change | sensitivity_change | 2 / 2 | false | true / true | PASS |
| 18 | sens-medical | fact | review:sensitivity_change | sensitivity_change | sensitivity_change | sensitivity_change | 2 / 2 | false | true / true | PASS |
| 19 | sens-apikey | fact | review:sensitivity_change | sensitivity_change | sensitivity_change | sensitivity_change | 2 / 2 | false | true / true | PASS |
| 20 | sens-bank | profile | review:sensitivity_change | sensitivity_change | sensitivity_change | sensitivity_change | 2 / 2 | false | true / true | PASS |

**计数**：自动合并期望 6 → 实际 6；待审核期望 14 → 实际 14；locked 3 / sensitivity_change 5 / fact_conflict 6。

> **可见值判定（M3 修复批 / #32 #36）**：待审核期间两端各自的本地 v2 修订必须保持可见，回落到基线 v1 即失败。修复前归档为 A 0/14、B 0/14（两端互把对方本地 v2 记为不采纳）；本次运行 A 14/14、B 14/14。冲突记录同时保留本地版本引用（local_version/local_revision_id/local_event_id）与远端事件引用（remote_event_ids）：14/14 条具备两者。

## 2. 删除不复活（双向）

| 方向 | fact_id | A deleted | B deleted | 删除方导入了旧修订 | tombstone_skipped 审计 | 判定 |
|---|---|---|---|---|---|---|
| A 删 / B 离线改 / B 上线 | 01a1c439-639e-714b-b16a-94274d823094 | true | true | false | 1 | PASS |
| B 删 / A 离线改 / A 上线 | 01a1c439-639e-7454-9665-59c175da979f | true | true | false | 2 | PASS |

**删除判定**：PASS（双方保持删除态，旧修订未复活）

## 3. 同步审计

| 事件 | A | B |
|---|---|---|
| sync.merged | 6 | 6 |
| sync.conflict | 28 | 28 |
| sync.tombstone_skipped | 3 | 3 |

**总判定**：PASS
