# AC-09 协议层复跑（飞书 Bot，平台协议桩）

- 票：M4-T9 / Issue #46 AC-09
- 生成时间：2026-11-10T09:11:57.373Z ｜ Node v24.22.1 ｜ darwin-arm64
- 口径：真实 `FeishuChannelAdapter` + 真实 Runtime + `ChannelTestServer`（飞书 Open API 形状，零真实网络）
- **真实平台层：未做（外部阻塞）** —— 飞书自建应用资质未注册

## 逐项结果

| 项 | 通过 | 说明 |
|---|---|---|
| 私聊（p2p 入站 → 回复） | **20/20** | 签名 + AES 解密 + 入站路由 + Outbox |
| 群 @（白名单 mention_only） | **20/20** | 提及 bot 才处理 |
| 可信联系人授权 | **20/20** | 一次性邀请码绑定，默认仅 query |
| 外发审计 | **20/20** | 80 条 outbound.sent，平台 reply 逐条对账 |
| 任务关联 | **20/20** | 中间路由 task_id（原始记录不改写） |

## 汇总

- 入站事件：80 ｜ Outbox queued/sent：80/80 ｜ 平台回执：80
- 联系人绑定事件：20 ｜ 会话数：61
- 能力声明：direct=supported，group_mention=supported，group_proactive=limited（受限），attachments=limited（受限）

**判定：PASS**（协议层；真实平台层未达成）
