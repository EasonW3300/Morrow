# AC-04 合并态复跑归档（M3-T7 / Issue #36）

**生成时间**：2026-11-10T06:29:14.103Z ｜ **node**：v24.22.1 ｜ **平台**：darwin-arm64
**环境**：127.0.0.1 本机回环双实例（A/B 独立 dataDir + 独立 HTTP 端口；非 Tailscale/Wi-Fi）
**配对**：POST /v1/pairing/join（响应无 token 明文=true；双端 trusted=true）

## 1. 50 × 2 离线事件对账

| 项 | A | B |
|---|---|---|
| 离线写入业务事件 | 50 | 50 |
| 同步后本地业务事件 | 100 | 100 |
| 缺失 | 0 | 0 |
| 重复 | 0 | 0 |
| 来源 A 事件相对顺序一致 | 是 | 是 |
| 来源 B 事件相对顺序一致 | 是 | 是 |

**判定**：无丢失=true；无重复=true；顺序一致=true；pass=true

## 2. 小事件同步 p95（100 样本）

| 统计量 | 值 |
|---|---|
| 样本数 | 100 |
| p50 | 1.66 ms |
| p90 | 2.35 ms |
| **p95** | **2.54 ms** |
| p99 | 3.74 ms |
| min / max / mean | 1.39 / 5.71 / 1.83 ms |
| 单条事件最大字节 | 406 B（≤1KB=true） |
| 阈值 | ≤ 10000 ms（PRD §8 待校准） |
| 判定 | MET |

> 环境说明：本机回环基线（127.0.0.1，单机双实例，node 24）：100 次「1 条 session.created（≤1KB）→ POST /v1/sync/run 完成」的墙钟耗时，百分位用最近秩法。真实 Tailscale/Wi-Fi 网络未测，阈值待校准（PRD §8）。

## 3. 同步审计与状态

| 项 | A | B |
|---|---|---|
| ledger sequence.max | 524 | 525 |
| last_sync_at | 2026-11-10T06:29:14.097Z | 2026-11-10T06:29:14.098Z |
| peer pending_upload | 0 | 1 |
| peer pending_download | 2 | 0 |

sync.run_completed 审计：219（A+B 账本合计）；sync.pulled：216；sync.pushed：204。
