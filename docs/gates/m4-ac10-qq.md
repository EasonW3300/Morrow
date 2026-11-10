# AC-10 协议层复跑（QQ 官方 Bot，平台协议桩）

- 票：M4-T9 / Issue #46 AC-10
- 生成时间：2026-11-10T09:21:49.505Z ｜ Node v24.22.1 ｜ darwin-arm64
- 口径：真实 `QqChannelAdapter`（Ed25519 事件签名）+ 真实 Runtime + `ChannelTestServer` + `registerQqTestStub`（零真实网络）

## 逐项结果

| 项 | 通过 | 说明 |
|---|---|---|
| 群 @ | **20/20** | 白名单 mention_only + <@!appid> 提及；被动回复带 msg_id |
| 私聊（C2C） | **20/20** | /v2/users/{openid}/messages |
| 外发审计 | **20/20** | 40 条 outbound.sent |
| 主动消息受限 | 声明=true；拒绝分类=true | platform reject code=304046; outbox=needs_review; outbound.failed(will_retry=false)+outbound.reviewed; retry attempts after 10min=0 |
| token 刷新 | **PASS** | expired token → refreshed (issued 1 → 2); reply sent once |

## 真实平台层（单列，未达 20 次门线）

证据：`docs/gates/m4-qq-live-evidence.md`

已完成：
- 真实 QQ 官方 Bot 群 @ 入站 → 回复：累计 15 次（首轮 1 + 第二轮 14；含 10 次仅 @ 不带正文），0 拒绝，Owner 侧确认收到
- 真实 QQ 官方 Bot 私聊（C2C）入站 → 回复：1 次（/v2/users/{openid}/messages，端点选择正确）
- 主动消息真实限制：群主动消息 HTTP 400 code=40034105（无权限）→ proactive_rejected；私聊主动消息 HTTP 200（额度内可发），证实分场景受限
- 真实平台发现并修复三处缺陷：unknown_conversation（73cf438）、40034105 未入不可重试码表、测试桩六个注入选项未生效（56ca2d2）

未完成：
- AC-10 要求的群 @ 20 次门线：累计 15 次（差 5），不标完成
- 私聊 20 次门线：当前 1 次
- 真实链路 Outbox 幂等/未知状态与外发审计逐条落库核对

**协议层判定：PASS** ｜ **真实平台层：部分（群 @ 累计 15/20 + 私聊 1 次，0 失败），AC-10 的 20 次门线未达成**
