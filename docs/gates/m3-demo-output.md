# M3 端到端演示输出（M3-T7 / Issue #36）

**生成时间**：2026-11-10T07:23:21.021Z ｜ **node**：v24.22.1 ｜ **平台**：darwin-arm64
**形态**：两个独立 Runtime（127.0.0.1 随机端口、独立 dataDir/SQLite；A 注入 FakePi 规划/执行器）

## 第 1 轮（PASS：10/10）

起止：2026-11-10T07:23:20.533Z → 2026-11-10T07:23:20.799Z

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 配对：B 经 POST /v1/pairing/join 加入 A，双端 trusted，响应无 token 明文 | PASS | fingerprint=B748-59DA-EAE4-66EF devicesA=2 devicesB=2 join_has_token=false |
| 2 | 双向同步：A/B 各 5 条离线事件重连后双方恰好各一次，sync/run 有审计与 last_sync_at | PASS | isolated=true A=10/10 B=10/10 last_sync_at=2026-11-10T07:23:20.631Z rounds=3 |
| 3 | 删除传播：A 删除后双方均保持 deleted_at，B 的离线旧修订未导入（tombstone_skipped） | PASS | A.deleted=true B.deleted=true stale_imported=false skipped_audit=true |
| 4 | 删除不复活：再次双向同步后双方仍为删除态 | PASS | still_deleted=true |
| 5 | 冲突分类（自动合并）：preference 双端竞争 → 两端收敛到同一版本与内容，无待审核冲突 | PASS | A.v=3 B.v=3 same_content=true conflicts=0 sync.mergedA=1 sync.mergedB=1 mergesA=2->2=3@9a3f6c1e:01a1c457-08fa-7bd2-9852-268735fb0c07(preference_update) mergesB=2->2=3@9a3f6c1e:01a1c457-08fa-7bd2-9852-268735fb0c07(preference_update) |
| 6 | 冲突分类（待审核）：locked 修订进 A 的冲突队列，A 本地值不被覆盖 | PASS | pulled=2 reason=locked A.content=Owner 的护照号是 E12345678。 B.content=Owner 的护照号是 E87654321。 |
| 7 | 任务执行权转移：A 持有 token=1 → transfer 释放 → 目标设备 B 取得执行权 | PASS | before.token=1 after.active=false event=01a1c457-0931-7688-b3bd-6b06df91c220 target=9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f B.token=2 |
| 8 | needs_reconcile 检测：双端独立执行证据 → 任务冻结为 needs_reconcile，不静默合并 | PASS | detected=true status=needs_reconcile replicas=9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f,f47ac10b-58cc-4372-a567-0e02b2c3d479 |
| 9 | needs_reconcile 裁决：Owner 显式选择 completed，task.reconciled 以 owner 身份留痕 | PASS | status=completed resolution=completed reconciled_actor=owner |
| 10 | 执行权单点：needs_reconcile 期间与裁决后均无有效执行租约（不并行重放） | PASS | lease=active=false |

注记：
- needs_reconcile 的异地证据以直接入账本方式模拟：任务投影（tasks 表）不随同步事件重建，见门禁报告 §6。

**轮次小结**：PASS=10 FAIL=0

## 第 2 轮（PASS：10/10）

起止：2026-11-10T07:23:20.806Z → 2026-11-10T07:23:21.014Z

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 配对：B 经 POST /v1/pairing/join 加入 A，双端 trusted，响应无 token 明文 | PASS | fingerprint=5A4B-4CEF-FF15-DCAF devicesA=2 devicesB=2 join_has_token=false |
| 2 | 双向同步：A/B 各 5 条离线事件重连后双方恰好各一次，sync/run 有审计与 last_sync_at | PASS | isolated=true A=10/10 B=10/10 last_sync_at=2026-11-10T07:23:20.866Z rounds=3 |
| 3 | 删除传播：A 删除后双方均保持 deleted_at，B 的离线旧修订未导入（tombstone_skipped） | PASS | A.deleted=true B.deleted=true stale_imported=false skipped_audit=true |
| 4 | 删除不复活：再次双向同步后双方仍为删除态 | PASS | still_deleted=true |
| 5 | 冲突分类（自动合并）：preference 双端竞争 → 两端收敛到同一版本与内容，无待审核冲突 | PASS | A.v=3 B.v=3 same_content=true conflicts=0 sync.mergedA=1 sync.mergedB=1 mergesA=2->2=3@9a3f6c1e:01a1c457-09d8-7fd1-9c23-1296aaa3929b(preference_update) mergesB=2->2=3@9a3f6c1e:01a1c457-09d8-7fd1-9c23-1296aaa3929b(preference_update) |
| 6 | 冲突分类（待审核）：locked 修订进 A 的冲突队列，A 本地值不被覆盖 | PASS | pulled=2 reason=locked A.content=Owner 的护照号是 E12345678。 B.content=Owner 的护照号是 E87654321。 |
| 7 | 任务执行权转移：A 持有 token=1 → transfer 释放 → 目标设备 B 取得执行权 | PASS | before.token=1 after.active=false event=01a1c457-0a09-7c35-a8a4-226a078071df target=9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f B.token=2 |
| 8 | needs_reconcile 检测：双端独立执行证据 → 任务冻结为 needs_reconcile，不静默合并 | PASS | detected=true status=needs_reconcile replicas=9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f,f47ac10b-58cc-4372-a567-0e02b2c3d479 |
| 9 | needs_reconcile 裁决：Owner 显式选择 completed，task.reconciled 以 owner 身份留痕 | PASS | status=completed resolution=completed reconciled_actor=owner |
| 10 | 执行权单点：needs_reconcile 期间与裁决后均无有效执行租约（不并行重放） | PASS | lease=active=false |

注记：
- needs_reconcile 的异地证据以直接入账本方式模拟：任务投影（tasks 表）不随同步事件重建，见门禁报告 §6。

**轮次小结**：PASS=10 FAIL=0

**总计**：2 轮，20/20 项断言 PASS（每轮 10 项）
