# AC-13 协议层复跑（通知与权限）

- 票：M4-T9 / Issue #46 AC-13
- 生成时间：2026-11-10T09:13:21.831Z ｜ Node v24.22.1 ｜ darwin-arm64

## A. 可信联系人越权 100% 阻断

| 类别 | 动作 | 尝试 | 阻断 | 原因 |
|---|---|---|---|---|
| private_memory | memory_read | 20 | 20 | private_memory_denied |
| filesystem | filesystem | 20 | 20 | filesystem_denied |
| dev_tools | shell | 20 | 20 | dev_tools_denied |
| unauthorized_capability | capability | 20 | 20 | capability_not_granted |
| other_session | session | 20 | 20 | session_not_owned |

- 合计：**100/100 阻断（100.0%）**；审计事件 `contact.permission_denied` 100 条
- 对照组（public 记忆，memory_reference）：20/20 放行

## B. 通知路由与去重

- 规则：8 条（completed/failed/waiting_input/milestone × desktop/channel:echo）
- 20 轮：每类事件向两个目标各投递 2 次 → 送达 **160** 条，窗口内重复被去重 **160** 条（重复投递抑制率 50.0%；即第 2 次投递 100% 被抑制）
- 历史：160 条（desktop pending 80 / channel sent 80）；echo 适配器实发 80

**判定：PASS**（协议层，零真实网络）
