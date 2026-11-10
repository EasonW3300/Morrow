# AC-15 协议层复跑（微信个人号实验适配器，平台协议桩）

- 票：M4-T9 / Issue #46 AC-15
- 生成时间：2026-11-10T09:12:09.063Z ｜ Node v24.22.1 ｜ darwin-arm64
- 口径：真实 `WeChatChannelAdapter` + `StubLocalBridge`（纯内存，零真实微信/零网络）

| 项 | 结果 |
|---|---|
| 配置与环境声明 | 出厂 disabled=true；experimental=true；环境 os=Windows；风险文案常驻 |
| 风险确认 | 未确认 → 409 risk_confirmation_required；确认后 → 200，审计 1 条 |
| 白名单收发 | **20/20**（桥实发 20 条） |
| 非白名单阻断 | **20/20**（无外发） |
| 健康检查 | 初始 healthy=false → 故障 healthy=false（bridge crashed）→ 恢复 healthy=true |
| 日志审计 | 期望事件齐全=true（channel.adapter_started / channel.experimental_enabled / channel.inbound_received / channel.inbound_rejected） |
| 关闭 | disable 200；桥断开=true；禁用后入站 0 条 |

**真实微信层：未做（外部阻塞）** —— 真实微信个人号联调需要 Owner 的 Windows 机器 + 最新版微信 + 真实本地自动化桥；M4 只交付可注入 LocalBridge 接缝与平台桩验证，真实桥未实现。

**判定：PASS**（协议层；真实环境未达成）
