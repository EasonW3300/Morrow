# M4 QQ 官方 Bot 真实联调证据（首个真实平台闭环）

**日期**：2026-11-10
**环境**：macOS（darwin-arm64），Node v24.22.1，运行时连真实 QQ 开放平台
**凭据**：存于 macOS Keychain（service `channel:qq`，account `app_id` / `app_secret`），未落仓库
**机器人**：AppID 1906368184
**提交**：`73cf438`（`integration/m0`）

## 1. 逐层实测结果

| 层 | 手段 | 结果 |
|---|---|---|
| 凭据有效性 | `POST /app/getAppAccessToken` × 3 端点 | `bots.qq.com` 200 / `api.bot.qq.com` 200（142ms）/ `api.sgroup.qq.com` 404「不支持的调用」（该端点不在此host，符合预期）；access token 79 字符，`expires_in=7200` |
| 网关接入 | `GET /gateway` + WebSocket | 连通，`op 10 Hello` → `op 2 Identify`（intents `1<<25` 群与单聊），收到 `READY` |
| 入站事件 | 群内 @ 机器人 | 收到 `GROUP_AT_MESSAGE_CREATE`：`conv=AAE239F16FBC29E20853F6154D78719A`、`sender=FBE72705F609C036A8E7C3D59970721D`、`text="哈喽"` |
| 出站回复 | 适配器被动回复 API | Owner 端确认收到；适配器日志回执行 `[qq] replied to ROBOT1.0_FB…: id=ROBOT1.0_VMWaTzUx…`（平台返回消息 id，`/v2/groups/{group_openid}/messages`，带 `msg_id` + `msg_seq`）；退出统计 `events=1 rejected=0 replies=1` |

## 2. 真实联调发现并修复的缺陷（协议桩未暴露）

**现象**：能收到群 @ 消息，但 `adapter.send()` 不返回、用户收不到回复。

**定位过程**：
1. 独立探测脚本直连平台发送 API → **HTTP 200**，拿到 `ROBOT1.0_...` 消息 id（证明凭据、网络、平台端点都正常，问题在适配器内部）。
2. 用桩传输隔离调用 `adapter.send()` → 立即抛 `ChannelSendError: unknown qq conversation kind (unknown_conversation)`（0ms，不是挂起）。
3. 读代码确认：`#conversationKinds` 只由 `parseInbound()` 填充；Webhook 路径会调它，**WebSocket 可信路径 `handleTrustedEvent()` 只做 classify 不调 parse** → 会话形态永远未知 → `send()` 无法选择 `/v2/groups/*` 还是 `/v2/users/*`。

**为何协议桩没抓到**：桩测试走的是 HTTP 长轮询 + `handleFrame`（Webhook 语义，内含签名校验并会 parse），从未覆盖「WS 可信入口 → 直接回复」这条真实路径。

**修复**（`73cf438`）：
- `handleTrustedEvent()` 在 classify 为 message 后调用 `parseInbound()` 学习会话形态；解析失败仍走 `onInboundRejected` 留痕。
- 新增回归测试：**WS 入站后不显式 parse，直接 `send()` 必须打到 `/v2/groups/{id}/messages`**（"能收就能回"）。

## 2. 第二轮实测（2026-11-10 09:02Z，300s 窗口，两条路径）

同一机器人、同一凭据，WebSocket 全程在线，**私聊与群 @ 同时验证**：

| 指标 | 数值 |
|---|---|
| 入站事件总数 | **15**（群 @ 14 + 私聊 1） |
| 回复成功 | **15 / 15**（每条都有平台返回的消息 id） |
| 拒绝（rejected） | **0** |
| 入站→回复延迟 | 约 0.4–1.5s（含 token 缓存命中） |

关键样本：

- 群 @（事件 #1）：`text="哈喽"` → 回复 `id=ROBOT1.0_VMWaTzUx…!!`（`/v2/groups/{group_openid}/messages`）
- **私聊（事件 #15）**：`type=direct conv=FBE72705…` → 回复 `id=ROBOT1.0_DFfBuv-ez…!!`（`/v2/users/{openid}/messages`，id 前缀与群消息可区分，证明端点选择正确）
- 事件 #5–#14 为**只 @ 不带正文**（`text=""`）的样本：仍然正常回复，说明 mention-only 消息不会破坏解析链路。

Owner 侧同时对两条路径确认收到回复。

**本轮补上的缺陷（脚本层，非适配器）**：`qq-live-smoke.ts` 原先只回复 `conversation_kind === "group"`，私聊消息被收下但不回——这正是"私聊没反应"的原因；已改为两条路径都回复，并给日志加时间戳、把 health 读取改到 `stop()` 之前（否则退出摘要永远显示 disconnected）。

**本轮补齐的 AC-10 口径**：真实平台层现在有 **15 次连续的群 @ 收发 + 1 次私聊收发**、0 失败；距 AC-10 要求的"各 20 次"仍差 5 次群 @，如实记录为未满。

## 3. 结论

- 本条对应 PRD AC-10 的**真实平台层**：QQ 官方 Bot 的群 @ 与私聊两条入站路径 → 回复在真实平台跑通（群 @ 15 次、私聊 1 次，0 失败，Owner 侧确认收到回复）。
- 未覆盖：AC-10 要求的群 @ "20 次"（当前 15 次，差 5）、主动消息受限的真实拒绝样例、外发审计在真实链路上的落库核对、Outbox 幂等/未知状态在真实平台的验证。这些仍需后续真实轮次补齐，**不标注为已完成**。
- 飞书真实联调按 Owner 要求滞后（自建应用资质未就绪）。

## 4. 复现方式

```bash
# 前置：凭据入 Keychain（一次性）
security add-generic-password -s "channel:qq" -a app_id -w '<AppID>' -U
security add-generic-password -s "channel:qq" -a app_secret -w '<AppSecret>' -U

# 只读观察（不发消息）
export PATH="/opt/homebrew/bin:$PATH"
node --experimental-strip-types scripts/real-machine/qq-live-smoke.ts --seconds 120

# 入站并自动回复（验证完整回环）
node --experimental-strip-types scripts/real-machine/qq-live-smoke.ts --seconds 150 --reply "收到，Morrow 在线"

# 仅验凭据/token（不起网关）
node --experimental-strip-types scripts/real-machine/qq-token-check.ts
```

注意：QQ 群消息只有 **@ 机器人** 时平台才会投递；机器人需已加入该群且未被禁言。
