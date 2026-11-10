# channels — 渠道域

渠道适配器把平台协议转换为统一的 `InboundMessage` / `OutboundMessage`；入站经 T1 的统一
路由（账号/身份/白名单/权限全部由本地记录决定），助手回复先入 **Outbox** 再投递，所有外发
留 `outbound.*` 审计。首批稳定基线：飞书 Bot（已实现协议层）、QQ 官方 Bot（T4）；微信个人
号为实验适配器（T5）。

本目录的 README 是渠道域的操作/复用手册；代码位于 `apps/runtime/src/channels/`。

## 分层与接缝

```
平台事件（长连接）
  └─ FeishuChannelAdapter.handleFrame  签名校验 → AES 解密 → Verification Token → parseInbound
       └─ ChannelRegistry.ingest → ChannelInboundRouter（本地身份/白名单/@ 判定）
            └─ SessionManager（会话复用/新建）
                 └─ outboundSink → OutboxService.enqueue（幂等键唯一，先落库）
                      └─ dispatchOnce → ChannelOutboxAdapter → ChannelAdapter.send
                           └─ 平台 reply / 主动消息 API（ChannelTestServer 在测试中替换）
```

- `ChannelAdapter`（`src/channels/types.ts`）：`start/stop/send/health/parseInbound/capabilities`，
  只做协议转换；`permission_context` 恒为 `null`。
- `ChannelRegistry`（`src/channels/registry.ts`）：生命周期、账号登记、清单/健康端点、入站入口。
- `ChannelInboundRouter`（`src/channels/inbound.ts`）：fail-closed 的权限与路由。
- `ChannelOutboxAdapter` / `createChannelOutboundSink`（`src/channels/outbox.ts`）：
  Outbox 与适配器的双向桥；`explicit` 错误退避重试，`network/timeout` 判
  `delivery_unknown` 不自动重发。

## 飞书 Bot 适配器

代码：`apps/runtime/src/channels/adapters/feishu/`。

### 能力矩阵（`capabilities()`）

| 维度 | 声明 | 说明 |
|---|---|---|
| `direct_message` | `supported` | 私聊消息收发 |
| `group_mention` | `supported` | 群聊仅在被 @ 时处理（需配置 `bot_open_id`） |
| `group_proactive` | `limited` | 平台对主动消息有场景/权限/频控限制，绝不声明无限主动推送 |
| `attachments` | `limited` | 入站只保留平台引用；出站附件投递未实现（显式报错） |
| `edit` | `unsupported` | 飞书消息编辑不纳入首版 |

### 配置（SecretStore，`channel:feishu:<field>`）

| service | account | 必填 | 说明 |
|---|---|---|---|
| `channel:feishu` | `app_id` | 是 | 自建应用 App ID |
| `channel:feishu` | `app_secret` | 是 | 自建应用 App Secret |
| `channel:feishu` | `verification_token` | 是 | 事件订阅 Verification Token |
| `channel:feishu` | `encrypt_key` | 是 | 事件 Encrypt Key（签名 + AES-256-CBC 解密） |
| `channel:feishu` | `bot_open_id` | 建议 | Bot 的 open_id；未配置时群聊 @ 一律视为未提及（保守不响应） |

非机密项由 `FeishuChannelAdapterOptions` 注入：`baseUrl`（默认
`https://open.feishu.cn`）、`requestTimeoutMs`、`tokenRefreshSkewMs`、事件传输等。
`loadFeishuConfig(secretStore)` 一次性读取并列出全部缺失字段；SecretStore 后端见
`apps/runtime/src/keyring.ts`（macOS Keychain / Windows 凭据管理器 / Linux secret-tool /
`MORROW_SECRET_BACKEND=memory` 冒烟）。

生产接线：

```ts
const adapter = new FeishuChannelAdapter({ accountId: "feishu-default", config });
await startRuntime(config, {
  channelAdapters: [{
    adapter,
    account: {
      account_id: "feishu-default",
      channel_id: "feishu",
      native_account_id: config.appId,
      owner_native_ids: ["ou_owner"], // Owner 的平台 open_id（本地身份映射）
    },
  }],
});
```

注入 `channelAdapters` 后：助手回复自动经 Outbox（`outboundSink`），`runtime.outbox`
的投递出口自动接到适配器（未显式提供 `outboxAdapter` 时）；`GET /v1/channels` 与
`GET /v1/channels/feishu/health` 如实呈现 capabilities/连接状态/token 到期/最近错误。

### 事件订阅：长连接优先，webhook 仅文档说明

- **长连接（默认）**：与 ADR-0004 私有网络优先一致，Runtime 不需要公网回调地址、不需要
  TLS 证书/端口映射。适配器暴露 `FeishuEventTransport` 接缝；生产由飞书官方 WebSocket
  SDK 封装（鉴权/心跳/帧编码由 SDK 负责），适配器协议转换代码不变。
- **默认 `HttpLongPollEventTransport`**：同一 `baseUrl` 上的 HTTP 长轮询
  `GET /open-apis/event/v1/stream`，用于协议层测试与内网桥接；它是传输替身，不声称与
  飞书 WebSocket 帧格式一致。
- **webhook 模式**：飞书也支持把事件推送到公网 URL。这与 ADR-0004「默认不暴露公网」直接
  冲突，因此**首版不实现**；如未来允许公网部署，需要额外的回调路由、证书与重放防护，
  另立票评估。

### 签名 / 解密 / token

- 签名：`X-Lark-Signature = sha256(timestamp + nonce + encrypt_key + raw_body)`；同时校验
  `X-Lark-Request-Timestamp` 时间窗（默认 ±300s）与 `Verification Token`。
- 加密：事件体 `{encrypt}` 用 AES-256-CBC 解密，key = `sha256(encrypt_key)`，IV = 解码后
  前 16 字节，PKCS#7 padding。
- 失败处理：签名/解密/token 失败**不进入会话链路**，由注册表落
  `channel.inbound_rejected`（`reason=event_rejected`，`error_code` 为
  `signature_invalid` / `decrypt_failed` / `token_mismatch` / `timestamp_stale`）。
- token：`tenant_access_token` 进程内缓存，到期前 `tokenRefreshSkewMs`（默认 5 分钟）主动
  刷新；平台仍报 token 失效时强制刷新**一次**并重试，二次失败 → `health().healthy=false`、
  `connection="degraded"`、`last_error` 可查。
- 错误分类 → Outbox：429/403/主动消息拒绝/平台业务码 = `explicit`（failed，指数退避）；
  超时/网络中断 = `timeout|network`（delivery_unknown，不自动重发）。

## ChannelTestServer（T4/T5 复用）

代码：`apps/runtime/src/channels/testing/channel-test-server.ts`（runtime 公共出口已导出）。
它只监听 `127.0.0.1` 随机端口，零真实网络、零真实凭据。

### 对接方式

真实适配器**只改 `baseUrl`**（飞书默认 `https://open.feishu.cn`）：

```ts
const server = new ChannelTestServer({ appId, appSecret, verificationToken, encryptKey, botOpenId });
await server.start(); // baseUrl = http://127.0.0.1:<随机端口>
const adapter = new FeishuChannelAdapter({ config, baseUrl: server.baseUrl });
```

内置端点（飞书 Open API 形状）：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/open-apis/auth/v3/tenant_access_token/internal` | 签发/刷新 tenant token |
| POST | `/open-apis/im/v1/messages/:message_id/reply` | 引用回复 |
| POST | `/open-apis/im/v1/messages?receive_id_type=chat_id` | 主动消息 |
| GET | `/open-apis/event/v1/stream?cursor=&timeout_ms=` | 事件长轮询（签名/可选加密帧） |

### 故障注入（服务端可变状态，不改适配器）

```ts
server.signatureMode = "invalid" | "missing" | "valid"; // 签名失败
server.rateLimit = { remaining: 1, retryAfterSeconds: 2 }; // 429 + Retry-After
server.duplicateEvents = true;                              // 同一事件投递两次
server.replyMode = "hang" | "forbidden" | "ok";             // 响应超时 / 403
server.rejectProactive = true;                              // 主动消息被拒
server.expireAccessToken();                                 // token 过期（刷新后可恢复）
server.rejectAllSendTokens = true;                          // 刷新后仍 401（健康降级路径）
server.failTokenEndpoint = true;                            // token 端点失败
```

### 断言接口

```ts
server.baseUrl;                                   // 适配器 base_url
server.requests;                                  // 全部请求（含 kind/path/headers/body/at）
server.count("token" | "reply" | "proactive" | "event_stream" | "custom");
server.lastRequest("reply");                      // 最后一条 + headers/body
server.requestsFor("reply");
server.replies;                                   // 平台侧收到的回复（native_message_id/body）
server.proactiveMessages;                         // 平台侧收到的主动消息
server.reset();                                   // 清空请求/回执/事件
```

事件：

```ts
server.pushMessage({ text, chatType: "group", mentionBot: true, attachments: [...] });
server.pushEvent(customFeishuEvent);              // 任意飞书事件 JSON
server.buildMessageEvent(...);                    // 只构造不投递
server.buildEventFrame(event);                    // 签名/加密后的 {body, headers}
```

自定义平台端点（T4 QQ/T5 微信）：

```ts
server.route("POST", /^\/qq\/token$/, (ctx) => {
  ctx.respond(200, { access_token: "..." }, { "retry-after": "1" });
}, "token");
// 需要延迟响应时返回 "deferred" 并稍后 ctx.respond(...)；ctx.hang() 模拟不响应
```

覆盖的验收路径：正常收发、签名失败、429 退避、重复投递、超时 → `delivery_unknown`、
主动消息受限、token 过期/刷新失败。T3 的测试文件：
`test/channels.test-server.test.ts`、`test/channels.feishu.test.ts`、
`test/channels.feishu.e2e.test.ts`、`test/channels.feishu.runtime.test.ts`。

## 真实飞书联调（未做，外部依赖阻塞）

**状态：未执行。** 原因：飞书开放平台自建应用尚未注册（ADR-0005 前置清单）。协议层已由
`ChannelTestServer` 全链路覆盖；以下步骤在资质就绪后执行，**不得以桩测试冒充平台验收**。

1. 在飞书开放平台创建企业自建应用，启用机器人能力；记录 App ID / App Secret。
2. 事件订阅：选择「使用长连接接收事件」，订阅 `im.message.receive_v1`；记录
   Verification Token 与 Encrypt Key。
3. 申请所需权限：接收消息、以应用身份发消息（`im:message`、`im:message:send_as_bot` 等；
   主动消息另需平台场景/额度审批）。
4. 把 4 个必填字段写入本机 SecretStore（service `channel:feishu`，account 为字段名），
   建议同时写 `bot_open_id`（可通过飞书「获取机器人信息」接口或事件 mentions 确认）。
5. 以 `channelAdapters` 注入 `FeishuChannelAdapter` 启动 Runtime；确认
   `GET /v1/channels/feishu/health` 为 healthy，`connection=connected`，
   `token_expires_at` 合理。
6. 私聊发消息验证回复引用原消息；群聊把 Bot 拉群、@ 一次验证响应，未 @ 不响应；在
   `GET /v1/outbox` 与事件账本核对 `outbound.queued/sent` 与平台回执。
7. 记录 20 次真实收发证据到门禁报告；主动消息限制、附件限制如实登记。

## 测试命令

```bash
# 渠道域（零真实网络）
cd apps/runtime
node --experimental-sqlite --test --experimental-strip-types test/channels.*.test.ts

# 全 workspace（排除容器套件；node 24 需 /opt/homebrew/bin 优先）
export PATH="/opt/homebrew/bin:$PATH"
pnpm -r test
```

容器相关套件（`sandbox.docker.test.ts`、`capability-factory.harness.container.test.ts`）
需要 Docker，按 CI 口径排除；desktop 测试前先 `pnpm --filter @morrow/runtime build`。
