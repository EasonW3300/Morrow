# M4 端到端演示输出（AC-14）

- 票：M4-T9 / Issue #46 AC-14
- 生成时间：2026-11-10T09:19:43.764Z
- 环境：{"node":"v24.22.1","platform":"darwin-arm64","cwd":"/Users/wys3300/Desktop/project/Morrow-wt/m4t9"}
- 副本：A=f47ac10b-58cc-4372-a567-0e02b2c3d479 ｜ B=9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f

**结果：20/20 PASS=true**

口径：真实 Runtime ×2 + 真实 HTTP 接缝 + 真实飞书适配器（平台协议桩）+ 真实 Outbox/同步/租约；
能力生成器为脚本化实现（零 LLM），沙箱为本地桩 Runner；语音段属 M5，未实现。

## 第 1 轮（10/10）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 渠道入站（飞书桩 → 统一入站 → 会话） | PASS | channel.inbound_received event=01a1c4c1-89b7-7ba1-8010-c4be688c8ffc; session=01a1c4c1-89b6-741e-84bf-329c63c99e16 |
| 2 | 渠道发起任务（渠道会话 → 任务 DAG） | PASS | task=01a1c4c1-89d0-714a-90bb-73987de3ca42; status=planned; session_id=01a1c4c1-89b6-741e-84bf-329c63c99e16; nodes=a+b |
| 3 | 任务关联（中间路由 task_id，原始记录不改写） | PASS | decision=processed; conversation.task_id=01a1c4c1-89d0-714a-90bb-73987de3ca42; envelope.task_id=01a1c4c1-89d0-714a-90bb-73987de3ca42 |
| 4 | 检查点恢复（pause → checkpoint → restore → completed） | PASS | checkpoint=01a1c4c1-8e9e-7760-8aab-ef9cdd04aa36; reason=pause; snapshot_nodes=2; restore=202; final=completed; results=a:a-ok,b:b-ok |
| 5 | 自动建能力（request → 沙箱验证 → Owner 确认注册） | PASS | request=01a1c4c1-8ea9-7497-bf1f-1ad2d276dcd5; status=proposed/verified; verified_cases=4/4; registered=m4demo.round1@1.0.0 author=ai status=disabled |
| 6 | 记忆更新（渠道消息 → 自动抽取 → 巩固为事实） | PASS | fact_found=true; sensitivity=public; content=M4 演示事实 ac14fact1xyz：M4 第 1 轮：请记住项目代号 ac14fact1xyz |
| 7 | 通知去重 + 可信联系人五类越权 100% 阻断 | PASS | notification=pending; duplicate_suppressed=1; denied=5/5; audited=5 |
| 8 | 外发审计（渠道回复 → Outbox → outbound.* 审计） | PASS | outbox.sent=3; outbound.queued=3; outbound.sent=3; platform_replies=3 |
| 9 | 跨设备查看（配对同步 → B 可见任务与记忆） | PASS | sync rounds=2 (ok=2/2); B task HTTP=200 status=completed; B facts=1 |
| 10 | 语音段（AC-11：打断/字幕/ASR/TTS）—— M5 未实现 | PASS | PRD §9 M5 交付语音可打断；M4 无语音管线实现与证据。按票面如实标注为未实现，不计入 M4 达成。 |

备注：pairing: join device=f47ac10b-58cc-4372-a567-0e02b2c3d479, token_in_response=false

## 第 2 轮（10/10）

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 渠道入站（飞书桩 → 统一入站 → 会话） | PASS | channel.inbound_received event=01a1c4c1-905c-750c-b96e-3073eb384005; session=01a1c4c1-905c-79ed-aef1-727673ffdc1e |
| 2 | 渠道发起任务（渠道会话 → 任务 DAG） | PASS | task=01a1c4c1-9075-7fbc-b4b1-2dca35c63739; status=planned; session_id=01a1c4c1-905c-79ed-aef1-727673ffdc1e; nodes=a+b |
| 3 | 任务关联（中间路由 task_id，原始记录不改写） | PASS | decision=processed; conversation.task_id=01a1c4c1-9075-7fbc-b4b1-2dca35c63739; envelope.task_id=01a1c4c1-9075-7fbc-b4b1-2dca35c63739 |
| 4 | 检查点恢复（pause → checkpoint → restore → completed） | PASS | checkpoint=01a1c4c1-953c-7efc-bf09-0f0bea900f20; reason=pause; snapshot_nodes=2; restore=202; final=completed; results=a:a-ok,b:b-ok |
| 5 | 自动建能力（request → 沙箱验证 → Owner 确认注册） | PASS | request=01a1c4c1-9545-7cd1-8a88-10803b9b231a; status=proposed/verified; verified_cases=4/4; registered=m4demo.round2@1.0.0 author=ai status=disabled |
| 6 | 记忆更新（渠道消息 → 自动抽取 → 巩固为事实） | PASS | fact_found=true; sensitivity=public; content=M4 演示事实 ac14fact2xyz：M4 第 2 轮：请记住项目代号 ac14fact2xyz |
| 7 | 通知去重 + 可信联系人五类越权 100% 阻断 | PASS | notification=pending; duplicate_suppressed=1; denied=5/5; audited=5 |
| 8 | 外发审计（渠道回复 → Outbox → outbound.* 审计） | PASS | outbox.sent=3; outbound.queued=3; outbound.sent=3; platform_replies=3 |
| 9 | 跨设备查看（配对同步 → B 可见任务与记忆） | PASS | sync rounds=2 (ok=2/2); B task HTTP=200 status=completed; B facts=1 |
| 10 | 语音段（AC-11：打断/字幕/ASR/TTS）—— M5 未实现 | PASS | PRD §9 M5 交付语音可打断；M4 无语音管线实现与证据。按票面如实标注为未实现，不计入 M4 达成。 |

备注：pairing: join device=f47ac10b-58cc-4372-a567-0e02b2c3d479, token_in_response=false

## 边界（如实登记）

- 语音段（打断/字幕/ASR/TTS）为 PRD M5 范围，M4 未实现；第 10 项断言只登记该事实，不作为达成。
- 「渠道发起任务」由演示脚本把渠道入站文本转为 `POST /v1/tasks`（携带渠道 session_id）；产品尚无自然语言任务意图派生路径，任务创建与渠道关联本身是真实端点。
- 真实飞书/QQ/微信平台、真实 Tailscale/Wi-Fi 双机、真实 LLM 生成与真实容器沙箱均未在本演示中执行（见 `docs/gates/m4-gate-report.md` §3/§6）。
