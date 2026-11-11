# 升级 → 回滚 → 数据完好 演练证据（M6 门禁「回滚」项）

**日期**：2026-11-11
**目标机**：`101.34.91.32`（Ubuntu 22.04.5 / x86_64 / systemd 249）
**脚本**：`scripts/real-machine/server-rollback-drill.sh`（可复跑，自带清场）
**提交基线**：`integration/m0` @ `21b267a`

## 演练内容

验证 `deploy/README.md`「升级与回滚」承诺的路径是否真的成立：

```
安装 v1 → 产生数据（账本 + 副本身份）
  → --uninstall（**保留** dataDir 与 env）
  → 校验：二进制/unit 已移除、服务已停、数据与身份仍在
  → 重新安装
  → 校验：副本身份不变、账本事件不减少、服务健康
  → --purge 清场并逐项核对
```

## 结果（全 PASS）

| 阶段 | 检查 | 结果 |
|---|---|---|
| 安装 v1 | 服务健康（就绪轮询） | PASS |
| | 记录 `replica_id=4fb29dab-3201-4aa4-919a-c6c7100a298f`、`events=2` | — |
| 回滚（`--uninstall`） | 二进制已移除 | PASS |
| | unit 已移除 | PASS |
| | 服务已停止 | PASS |
| | 数据目录仍保留 | PASS |
| | 账本仍在 | PASS |
| | 副本身份仍在 | PASS |
| | env 仍保留 | PASS |
| 重新安装 | **副本身份未变**（`4fb29dab…` 一致） | PASS |
| | 账本未丢（事件 2 → 4，只增不减） | PASS |
| | 服务健康 | PASS |
| 清场（`--purge`） | 各路径核对为空（脚本输出 `done`，无 `REMAINS`） | PASS |

安装脚本自身的提示也印证了语义：

```
[install] kept /var/lib/morrow (data) and /etc/morrow/morrow.env (config);
          remove them with --purge if no longer needed
```

## 首次演练的两个假 FAIL（检查脚本缺陷，已修）

第一次运行报 `副本身份仍在` / `env 仍保留` 两项 FAIL，但同一轮的「重新安装」阶段显示 `replica_id` 与前值**完全一致**、事件数从 2 增到 4——若数据真被删掉，重装会生成新的 `replica_id` 且事件从 2 重新开始。

根因：这两项检查原先用 `[ -s ... ]` / `[ -e ... ]` 以 `ubuntu` 用户身份执行，而
`/var/lib/morrow` 是 `0750 morrow`、`/etc/morrow/morrow.env` 是 `0640 root:morrow`——
**权限不足导致 test 失败，被误读成"数据丢失"**。脚本已改为 `sudo -n test ...` 并重跑，得到上面全 PASS 的结果。

这条值得写进证据而不是悄悄改掉：**门禁脚本自己的假阴性同样危险**，它会让一次成功的回滚看起来像数据丢失。

## 未覆盖

- 真实崩溃恢复（OOM kill / 断电）：只验了 `systemctl restart` 与 SIGTERM 优雅退出。
- 二进制**版本间**回滚（v0.1.0 ↔ 未来版本）：本版只有一个版本，验证的是「卸载后重装同版本、数据保持」这一路径；跨版本回滚需等第二个版本。
- 数据库 schema 迁移回滚：当前无降级迁移路径（M1–M4 迁移均为幂等加列，未实现 undo）。

## 复现

```bash
scripts/real-machine/server-session.sh            # 48h 会话（弹窗输密码）
scripts/real-machine/server-rollback-drill.sh     # 全流程（含清场）
scripts/real-machine/server-rollback-drill.sh --keep   # 保留安装便于手工检查
```
