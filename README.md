# Morrow

单主人、长期记忆、可自主生成能力的个人 Agent。

**当前状态**：M0 收官（冒烟门全绿，见 [M0 门禁报告](docs/gates/m0-gate-report.md)）。

## 文档导航

- [PRD v1.0](docs/prd/PRD-v1.0.md) —— 唯一需求真相源
- [GLOSSARY](GLOSSARY.md) —— 领域统一语言
- [ADR 目录](docs/adr/) —— 工程决策记录（含 0007 桌面壳裁决）
- [M0 门禁报告](docs/gates/m0-gate-report.md) —— CI 三平台 + 真机门禁证据、PRD §9 门槛核对
- [威胁模型](docs/security/threat-model.md) —— 四域威胁、对策与残余风险（PRD §7）
- [M0 验收基线](docs/prd/ac-baseline-m0.md) —— 参考硬件/网络/模型/测试数据（PRD §8 校准基准）
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

里程碑与验收标准见 PRD §8/§9。
