# LLM Provider 仅支持 OpenAI Chat Completions 兼容协议

单人业余开发要求把模型接入的维护成本压到最低。决定：Provider 抽象只实现 OpenAI Chat Completions 兼容协议；每个 Provider 由 `base_url + api_key + 模型名` 三元组配置，不区分云端或本地（DeepSeek、Qwen、Kimi、OpenAI 官方、ollama 等均适用）；密钥存 OS 凭据库（macOS Keychain / Windows Credential Manager / Linux libsecret）。AC-02 的"至少两家供应商"验收解释为：两个不同的 OpenAI 兼容供应商端点。

## Considered Options

- 按厂商写原生适配（如 Anthropic Messages API 原生接入）：可换取 prompt caching、原生工具语义等特性，但协议碎片化对单人项目不划算，与决策稿"首版多云端 LLM"的目标错配。
- 双协议（OpenAI 兼容 + Anthropic 原生）：首版不做；若未来某家供应商的原生能力成为刚需，再增加第二个协议实现。

## Consequences

Anthropic 原生特性（如 cache_control、扩展思考的原生透传）在首版不可用，除非该供应商同时提供 OpenAI 兼容端点；供应商间行为差异（工具调用、流式分片细节）由 Provider 抽象层抹平并纳入 AC-02 测试范围。
