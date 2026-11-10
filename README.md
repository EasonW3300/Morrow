# Morrow

单主人、长期记忆、可自主生成能力的个人 Agent。

**当前状态**：M2 收官（「缺能力→造工具→安全验证→重用」演示达成，见 [M2 门禁报告](docs/gates/m2-gate-report.md)；M1 两项主线门槛达成，见 [M1 门禁报告](docs/gates/m1-gate-report.md)；M0 冒烟门全绿，见 [M0 门禁报告](docs/gates/m0-gate-report.md)）。

## 文档导航

- [PRD v1.0](docs/prd/PRD-v1.0.md) —— 唯一需求真相源
- [GLOSSARY](GLOSSARY.md) —— 领域统一语言
- [ADR 目录](docs/adr/) —— 工程决策记录（含 0007 桌面壳裁决）
- [部署指南](deploy/README.md) —— 三种部署形态（纯本地 / Ubuntu systemd / 本地+服务器混合）、私有网络（Tailscale/WireGuard）、安装升级回滚与备份、部署冒烟脚本
- [M0 门禁报告](docs/gates/m0-gate-report.md) —— CI 三平台 + 真机门禁证据、PRD §9 门槛核对
- [M1 门禁报告](docs/gates/m1-gate-report.md) —— 记忆回链 / 故障注入 / 人工介入覆盖盘点、PRD §9 M1 门槛核对
- [M2 门禁报告](docs/gates/m2-gate-report.md) —— 能力工厂 harness 双路径 / 并行隔离 / 完整演示脚本（[归档输出](docs/gates/m2-demo-output.md)）、PRD §9 M2 门槛核对
- [威胁模型](docs/security/threat-model.md) —— 四域威胁、对策与残余风险（PRD §7）
- [M0 验收基线](docs/prd/ac-baseline-m0.md) —— 参考硬件/网络/模型/测试数据（PRD §8 校准基准；§7/§8 为 M1/M2 校准注记）
- [决策稿 V0.6](docs/history/decision-baseline-v0.6.md) —— 归档的 PRD 输入基线

## 仓库结构

```
apps/desktop        Tauri 2 + React 桌面壳（Chat / Task / Voice / 设置）
apps/runtime        核心 Node 应用：编排、记忆、能力、API（单二进制打包）
packages/protocol   事件 schema、API 合约、共享类型（TS + JSON Schema）
packages/pi-adapter Pi 内核版本锁定适配层（ADR-0001）
packages/memory     记忆管线：抽取 / 巩固 / 冲突 / Markdown 投影
packages/sync       副本同步引擎：增量、租约、配对
packages/channels   渠道网关：飞书 / QQ 官方 / 微信实验
packages/capability 能力工厂：生成 / 沙箱验证 / 注册 / 演进
packages/voice      语音管线：VAD / ASR / TTS / 打断
workers/go          Go 组件（系统适配、性能敏感服务、CLI）
docs/prd, docs/adr  PRD 与决策记录
docs/gates          门禁报告归档（docs/security 威胁模型）
docs/history        归档文档
```

## 部署（三形态）

同一个 Runtime（单二进制/同一源码）支持三种形态，详见 [部署指南](deploy/README.md)：

- **纯本地**：桌面壳拉起 Runtime，默认只监听 `127.0.0.1`，零配置可用；
- **纯服务器**：Ubuntu 单二进制 + systemd（`deploy/systemd/morrow.service`、`/etc/morrow/morrow.env`、数据 `/var/lib/morrow`），一键幂等安装 `scripts/deploy/install-ubuntu.sh`；
- **混合**：本地优先、离线可用，重连后经增量同步与服务器对账。

传输默认走私有网络（[ADR-0004](docs/adr/0004-private-network-first-transport.md)：Tailscale/WireGuard），
Runtime 默认不监听公网；非回环访问必须持配对下发的 bearer token。发布前三形态冒烟：
`scripts/deploy/smoke-{local,server,hybrid}.sh`。

## Runtime HTTP API（能力域摘要）

完整端点清单见 PRD §6.2；能力域（M2）端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | /v1/capabilities | 能力清单 / 注册（permissions ⊆ grants 五维判定） |
| GET/PUT | /v1/capabilities/grants | Owner 五维预授权 |
| GET | /v1/capabilities/:id | 详情（当前记录 + verified 已验证标记 + 版本历史） |
| POST | /v1/capabilities/:id/{enable,disable,rollback} | 生命周期（事件驱动同步调用注册表） |
| POST | /v1/capabilities/:id/invoke | **能力调用**（body = 工具 input；`?session_id=` 供归属）。经 ToolInvoker 统一执行链：builtin 进程内直呼、sandboxed 容器执行，权限复核在链上 |
| POST | /v1/capabilities/request | 发起能力生成（工厂闭环） |
| POST | /v1/capabilities/:id/confirm | Owner 确认门（沙箱验证 → 注册，verified=1） |
| GET/POST | /v1/capabilities/skills[...]、/v1/skills[...] | Skill 提案/决策/重用（T6 合约别名） |

**调用错误码**：`POST .../invoke`（能力与 Skill 重用共用）的 HTTP 状态按统一契约表映射（单源 `apps/runtime/src/invocation-errors.ts`）：`unknown_tool`→404、`permission_denied`→403、`invalid_sandbox_contract`/`tool_package_unsupported`/`capability_escalation`→400、`sandbox_unavailable`/`image_pull_failed`→503（附 install-hint）、`tool_timeout`→504、`tool_build_failed`→500、工具自身失败（`tool_error`/`tool_exit_nonzero`/`tool_protocol_error`/`tool_output_too_large`）→502。每次调用先落 `capability.used` 审计后返回（Skill 重用另落 `skill.invoked`）。

里程碑与验收标准见 PRD §8/§9。
