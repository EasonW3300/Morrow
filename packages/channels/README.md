# channels — 渠道域

渠道适配器把平台协议转换为统一的 `InboundMessage` / `OutboundMessage`；入站经 T1 的统一
路由（账号/身份/白名单/权限全部由本地记录决定），助手回复先入 **Outbox** 再投递，所有外发
留 `outbound.*` 审计。首批稳定基线：飞书 Bot 与 QQ 官方 Bot（均已实现协议层）；微信个人
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

## QQ 官方 Bot 适配器

代码：`apps/runtime/src/channels/adapters/qq/`（M4-T4 / Issue #41，stable baseline channel）。
它与飞书适配器共用 T1 契约、Outbox 桥、事件传输与 ChannelTestServer，只替换平台协议。

### 能力矩阵（`capabilities()`）

| 维度 | 声明 | 说明 |
|---|---|---|
| `direct_message` | `supported` | 单聊消息收发（`/v2/users/{openid}/messages`） |
| `group_mention` | `supported` | 群内仅在被 @ 时处理（`GROUP_AT_MESSAGE_CREATE`） |
| `group_proactive` | `limited` | 主动消息受平台场景/额度限制；**不承诺无限推送** |
| `attachments` | `limited` | 入站只保留平台 URL 引用；出站富媒体需先上传（未实现） |
| `edit` | `unsupported` | QQ 消息编辑不纳入首版 |

**主动消息限制（必须如实告知 Owner）**：QQ 官方对主动消息有明确上限（例如单聊约
10 qps / 20 qpm / 每用户 1000 条/天，群聊约 60 qpm / 每群 1000 条/天，未认证主体更低；
用户还可以关闭「允许主动发送」）。具体数值以官方文档为准，适配器只在
`capabilities().group_proactive = "limited"` 中声明受限，不在 UI/文档中暗示无限推送。

### 配置（SecretStore，`channel:qq:<field>`）

| service | account | 必填 | 说明 |
|---|---|---|---|
| `channel:qq` | `app_id` | 是 | 机器人 AppID（开放平台「机器人 ID」） |
| `channel:qq` | `app_secret` | 是 | 机器人 AppSecret（换 access token 的 clientSecret） |
| `channel:qq` | `bot_secret` | Webhook 时必填 | 回调 Ed25519 签名密钥；配置后事件必须带有效签名 |
| `channel:qq` | `token_endpoint` | 否 | access token 端点覆盖（内网/联调）；默认官方地址 |

Access Token **不落 SecretStore**，只在进程内缓存并按 `expires_in` 提前刷新（默认提前
5 分钟）；平台仍报 token 失效时强制刷新**一次**并重试，二次失败 → `health()` 降级
（`healthy=false`、`connection="degraded"`、`last_error` 可查）。旧的 `Bot Token` 鉴权
已被 QQ 官方废弃，适配器不实现它。

非机密项由 `QqChannelAdapterOptions` 注入：`apiBaseUrl`（默认
`https://api.sgroup.qq.com`）、`tokenEndpoint`（默认
`https://api.bot.qq.com/app/getAppAccessToken`；旧文档/SDK 常用
`https://bots.qq.com/app/getAppAccessToken`，可用此选项覆盖；`config.tokenEndpoint` 优先）、
`requestTimeoutMs`、`tokenRefreshSkewMs`、事件传输等。

生产接线：

```ts
const config = await loadQqConfig(secretStore); // channel:qq:app_id / app_secret
const adapter = new QqChannelAdapter({ accountId: "qq-default", config });
await startRuntime(startConfig, {
  channelAdapters: [{
    adapter,
    account: {
      account_id: "qq-default",
      channel_id: "qq",
      native_account_id: config.appId,
      owner_native_ids: ["<owner 的 QQ member_openid / user_openid>"],
    },
  }],
});
```

### 事件入站（Webhook / 长连接）

| 平台事件 | 归一化 |
|---|---|
| `GROUP_AT_MESSAGE_CREATE` | `conversation_kind=group`，会话 id=`group_openid`，`mention.agent=true`（只在 @ 机器人时投递） |
| `C2C_MESSAGE_CREATE` | `conversation_kind=direct`，会话 id=`author.user_openid` |

- 文本会去掉 `<@!bot_appid>` 占位符；附件保留 `url` 引用（`native_id` = url）。
- **签名**：配置 `bot_secret` 后按官方语义校验 Ed25519——种子为 BotSecret 补齐/截断到
  32 字节，签名内容为 `X-Signature-Timestamp + rawBody`；失败不进入会话链路，落
  `channel.inbound_rejected`（`signature_invalid` / `signature_missing` /
  `timestamp_stale`）。
- **回调校验 op 13**：`answerQqValidation(event, botSecret)` 返回
  `{ plain_token, signature }`（签名内容 `event_ts + plain_token`），供宿主 Webhook
  层应答。
- 默认事件传输仍是与 ChannelTestServer 对齐的 HTTP 长轮询桥接（`EventTransport` 接缝，
  QQ 复用 T3 实现）；真实平台走下面的 **WebSocket 网关传输**（无需公网回调）。

### 真实 WebSocket 网关传输（生产路径）

代码：`apps/runtime/src/channels/adapters/qq/websocket-transport.ts`。QQ 官方 Webhook
要求平台回调到公网 HTTPS 地址，与 ADR-0004「私有网络、Runtime 不监听公网」冲突；
官方 WebSocket 网关由 Runtime 主动外连，是唯一符合约束的真实接入方式（与飞书长连接同
一决策）。零新增依赖：使用 Node 22+ 全局 `WebSocket`，运行环境缺失时**明确报错**而不静默降级。

协议实现（`QqWebSocketTransport implements EventTransport`）：

1. 复用适配器的 access token 缓存/刷新（`attachTokenProvider`，与 HTTP 发消息同一份
   token，不会出现两条独立刷新链）；
2. `GET https://api.sgroup.qq.com/gateway`（`Authorization: QQBot <access_token>`）→ `{url}`；
3. 连接 `wss://` 后等待 **op 10 Hello**（`heartbeat_interval`），随后发送
   **op 2 Identify**：`{op:2, d:{token:"QQBot <access_token>", intents:33554432, shard:[0,1]}}`；
4. 按 Hello 间隔发送 **op 1 心跳**（`d` = 最近 Dispatch 的 `s`，无则 `null`），
   **op 11** 心跳 ACK 忽略；
5. **op 0 Dispatch**：消息事件（`GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE`）
   交给适配器 `handleTrustedEvent`；
6. **op 7**（平台要求重连）与 **op 9**（会话失效）→ 关闭旧连接、用当前 token 重新
   Identify；
7. 断线重连：指数退避 `1s → 2s → 4s …`，上限 30s；成功 Hello 后重置计数；
8. `stop()`：关闭连接、清理心跳/刷新/重连定时器，幂等。

**intents = `1 << 25`（33,554,432）= `GROUP_AND_C2C_EVENT`**，即群聊 @ 与单聊消息。
注意：**群消息只有 @ 机器人时平台才会投递**（`GROUP_AT_MESSAGE_CREATE`）；普通群消息
不会到达，适配器也不会声称能收到。`AT_MESSAGE_CREATE`（频道/guild 消息）不属于该 intent，
事件形状也不同（`guild_id`/`channel_id`），首版不接入。

**token 刷新**：access token TTL 7200s；传输默认在到期前 300s（`tokenRefreshIntervalMs`
= 6_900_000）调用 provider **强制刷新**，然后关闭连接、**重连并重新 Identify**。不做
Resume（需要 session_id + seq 的额外状态机，出错面更大）；刷新失败按
`tokenRefreshRetryMs`（默认 30s）重试，错误上报 `health().last_error`。

**信任边界（`handleTrustedEvent`）**：WS 在 Identify 时用 access token 完成网关鉴权，
之后的 Dispatch 都来自已认证连接；网关协议**没有** Webhook 的 Ed25519 帧签名（那只用于
公网回调防伪）。因此 WS 传输直接调用 `QqAdapter.handleTrustedEvent(event)`：跳过
`verifyQqEvent` 的签名校验，但保留 `classifyQqEvent` 的结构校验与
`channel.inbound_rejected` 留痕。Webhook 模式继续走 `handleFrame`（带签名校验）。
**其它来源（HTTP 请求体、UI、本地文件）不得调用 `handleTrustedEvent`**，否则等于绕过签名。

生产接线：

```ts
const config = await loadQqConfig(secretStore); // channel:qq:app_id / app_secret
const transport = new QqWebSocketTransport({ apiBaseUrl: "https://api.sgroup.qq.com" });
const adapter = new QqChannelAdapter({
  accountId: "qq-default",
  config,
  eventTransport: transport, // 缺省仍是 HTTP 长轮询（测试/内网桥接）
});
```

测试：`test/channels.qq.websocket.test.ts`（fake WebSocket + fake fetch，零真实网络）覆盖
Hello→Identify→心跳、Dispatch→可信入口、op 7/op 9 重连、指数退避与 Hello 重置、stop
清理幂等、token 刷新后重新 Identify。

### 发送与错误分类

- 被动回复（带 `reply_to_native_message_id`）：群 `POST /v2/groups/{group_openid}/messages`、
  私聊 `POST /v2/users/{user_openid}/messages`，body `{content, msg_type: 0, msg_id, msg_seq}`。
  `msg_seq` 对同一 `msg_id` 递增（QQ 以 `msg_id+msg_seq` 判重；被动回复窗口/次数由平台限制）。
- 主动消息（无 `reply_to_native_message_id`）：同一端点省略 `msg_id`，受平台额度/场景限制。
- **会话形态**：两条 API 需要知道目标是群还是私聊。适配器从入站事件自动学习；
  对从未入站的目标（如通知主动推送）必须显式登记
  `conversationKinds: { "<openid>": "group" | "direct" }` 或调用
  `rememberConversationKind()`。未知形态**显式失败**（`unknown_conversation`，不猜测）。
- 鉴权头：`Authorization: QQBot <access_token>`（与飞书的 `Bearer` 不同）。

| 平台结果 | 分类 | Outbox 语义 |
|---|---|---|
| HTTP 401 / 11241-11243 | `token_invalid` | 强制刷新一次后重试；仍失败 → 健康降级 |
| HTTP 429 / 20028 / 504xxx / 1100100 / 1100308 | `rate_limited` | `failed`，按 Retry-After 指数退避 |
| 主动消息被拒（304021/304022/304035/304045..304052 等） | `proactive_rejected` | **不可重试** → 直接 `needs_review` + 审计（`outbound.failed` `will_retry=false`、`outbound.reviewed` `non_retryable_rejection`） |
| HTTP 403 / 权限码 | `permission_denied` | `failed`（可退避） |
| 其它 4xx/业务码 | `bad_request` | `failed`（可退避） |
| 超时 / 网络中断 | `timeout` / `network` | `delivery_unknown` → `needs_review`，**不自动重发** |

> 为实现「主动消息被拒不重试」，T2 的 `OutboxSendOutcome.failed` 增加了可选
> `retryable?: boolean`；`ChannelSendError.retryable=false` 会原样传到这里。默认行为
> 不变（缺省按可重试处理）。

### QQ 协议桩（`registerQqTestStub`）

`apps/runtime/src/channels/testing/qq-stub.ts` 在共享 `ChannelTestServer` 上用 `route()`
注册 QQ 端点，**没有 fork 服务器**：

```ts
const server = new ChannelTestServer();
await server.start();
const stub = registerQqTestStub(server, { appId, appSecret, botSecret });
const adapter = new QqChannelAdapter({
  config,
  apiBaseUrl: server.baseUrl,
  tokenEndpoint: `${server.baseUrl}/app/getAppAccessToken`,
});

stub.pushMessage({ type: "group", text: "hi", senderId: "owner" }); // 签名后入事件队列
stub.rejectProactive = true;   // 主动消息被拒（群 304046 / 单聊 304050）
stub.rejectAllTokens = true;   // 刷新后仍 401
stub.failTokenEndpoint = true; // token 端点 500
stub.rateLimit = { remaining: 1, retryAfterSeconds: 2 };
stub.mode = "hang" | "forbidden" | "ok";
stub.expireAccessToken();
stub.groupMessages; stub.c2cMessages; stub.rejectedProactive; stub.count("group");
```

共享服务器新增的通用能力（M4-T4 最小扩展）：`ChannelTestServer.pushFrame(frame)`——
允许非飞书签名形态（QQ Ed25519）把预构造帧投入同一事件队列；`pushEvent` 行为不变。

T4 测试文件：`test/channels.qq.test.ts`、`test/channels.qq.e2e.test.ts`、`test/channels.qq.websocket.test.ts`。

## 微信个人号实验适配器（M4-T5 / Issue #42）

代码：`apps/runtime/src/channels/adapters/wechat/`。**实验适配器，出厂默认关闭**
（ADR-0005；GLOSSARY Experimental Adapter）。它不接入微信官方 Bot API，而是依赖
「Windows + 最新版微信 + 本地自动化桥」，因此不承诺跨 OS 稳定，也不承诺账号安全。

### 环境声明（API 与本文一致）

| 字段 | 值 |
|---|---|
| `environment.os` | `Windows` |
| `environment.client` | 最新版微信 Windows 桌面客户端 |
| `environment.bridge` | `LocalBridge`（M4 仅 `StubLocalBridge`；真实桥未实现） |
| `environment.real_integration` | `not_done` |

`GET /v1/channels` 与 `GET /v1/channels/wechat/health` 都返回上述 `environment`，UI 不需要
读文档即可呈现运行前提。

### 风险声明（`risk_notice`）

> 微信个人号适配器属于实验功能：基于非官方自动化，不稳定、可能随时失效，且可能
> 违反微信平台服务条款，导致账号被限制或封禁；账号风险自担。出厂默认关闭，启用
> 必须显式确认风险（confirm_risk=true）。真实微信联调尚未完成，需 Owner 的 Windows 机器。

同一文案出现在：`GET /v1/channels`、`GET /v1/channels/wechat/health` 的 `risk_notice`
字段，以及未确认风险时 `POST /v1/channels/wechat/enable` 的 409 响应。UI 在 M4-T8 呈现。

### 启用 / 禁用（API 强制风险确认）

```bash
# 出厂 disabled：清单 state=stopped、enabled=false、experimental=true
curl -s http://127.0.0.1:<port>/v1/channels

# 未确认风险 → 409 risk_confirmation_required（附 risk_notice）
curl -s -X POST http://127.0.0.1:<port>/v1/channels/wechat/enable \
  -H 'content-type: application/json' -d '{}'

# 显式确认风险 → 启用并启动适配器，落 channel.experimental_enabled 审计
curl -s -X POST http://127.0.0.1:<port>/v1/channels/wechat/enable \
  -H 'content-type: application/json' -d '{"confirm_risk":true}'

# 立即停止收发（幂等；桥断开、后续消息丢弃）
curl -s -X POST http://127.0.0.1:<port>/v1/channels/wechat/disable \
  -H 'content-type: application/json' -d '{}'
```

启用前必须先把允许的会话写入 `channel_allowlist`（私聊与群聊一致）：

```bash
curl -s -X PUT http://127.0.0.1:<port>/v1/channels/wechat/allowlist \
  -H 'content-type: application/json' \
  -d '{"allowlist":[{"native_conversation_id":"wx-chat-1","mode":"mention_only"}]}'
```

不在白名单中的会话：入站不会进入会话链路（`channel.inbound_rejected`
`reason=conversation_not_allowed`），适配器 `send()` 也以
`ChannelSendError(code=conversation_not_allowed)` 明确拒发。

### LocalBridge 内部接缝

适配器只依赖 `apps/runtime/src/channels/adapters/wechat/local-bridge.ts` 的五个动作：

```ts
interface LocalBridge {
  connect(): void | Promise<void>;
  disconnect(): void | Promise<void>; // 必须幂等
  status(): LocalBridgeStatus | Promise<LocalBridgeStatus>; // process/login/window/last_error
  sendMessage(input: LocalBridgeSendInput): LocalBridgeSendResult | Promise<LocalBridgeSendResult>;
  onMessage(handler: (message: LocalBridgeInboundMessage) => void): () => void; // 返回取消订阅
}
```

M4 交付 `StubLocalBridge`（纯内存、零真实微信/网络）：
`connectCalls/disconnectCalls`、`connected`、`sent`、`emit(message)`、`setStatus(...)`、
`setSendError(...)`。测试用它注入桥接进程/登录态/窗口句柄/最近错误，并观察出站。

生产接线的形状（M4 只有桩；替换 `bridge` 即接真实桥）：

```ts
const adapter = new WeChatChannelAdapter({
  accountId: "wechat-default",
  bridge: new StubLocalBridge(), // 真实桥实现 LocalBridge 后替换
});
await startRuntime(config, {
  channelAdapters: [{
    adapter,
    account: {
      account_id: "wechat-default",
      channel_id: "wechat",
      native_account_id: "wx_owner",
      owner_native_ids: ["wx_owner"], // Owner 的微信 native id（本地身份映射）
    },
  }],
});
// 适配器启动后仍为 disabled；随后经 POST /v1/channels/wechat/enable 显式启用。
```

**真实桥未实现。** 所需环境与方案（外部依赖，需 Owner 提供 Windows 机器）：

1. Windows 10/11 + 当前最新版微信桌面客户端，且保持登录。
2. 本地自动化桥进程（例如基于 Windows UI Automation / 注入方案的独立进程），负责
   定位微信窗口句柄、读取新消息、把消息推给 Runtime（本地 IPC 或回环 HTTP）。
3. 桥必须实现上述 `LocalBridge`：`status()` 如实报告进程存活、微信登录态、窗口句柄
   可用性；`sendMessage()` 返回平台消息 id 或明确失败；`onMessage()` 推送入站消息。
4. 桥的启动/重连/窗口检测属于外部工程；在桥就绪前，Runtime 只使用 `StubLocalBridge`，
   **不得以桩测试冒充真实微信验收。**

### health 与诊断

`GET /v1/channels/wechat/health` 除通用字段外返回：

```json
{
  "experimental": true,
  "environment": { "os": "Windows", "client": "最新版微信 Windows 桌面客户端", "...": "..." },
  "risk_notice": "……账号风险自担……出厂默认关闭……",
  "bridge": {
    "process": "running",
    "login": "logged_in",
    "window": "available",
    "last_error": null
  }
}
```

`process/login/window` 任一不满足（桥进程退出、微信未登录/掉线、窗口句柄不可用）时
`healthy=false`、`connection=degraded`，`last_error` 与 `bridge.last_error` 给出原因；
`bridge` 由注入的 `LocalBridge.status()` 提供，桩可逐项注入各状态。

### 测试

`apps/runtime/test/channels.wechat.test.ts` 覆盖：出厂 disabled（start/send 拒绝）、
未确认风险启用被拒、确认后启用 + 白名单收发（StubLocalBridge）、非白名单不响应、
health 各状态注入、禁用后停止收发（stop 幂等）、`risk_notice`/`environment` 存在，
以及 `startRuntime` + API 全链路（409 → 启用 → 白名单 → Outbox 投递到桩 → 禁用）。

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

自定义平台端点（T4 QQ 已由 `registerQqTestStub` 封装；T5 微信可直接 `route()`）：

```ts
server.route("POST", /^\/custom\/token$/, (ctx) => {
  ctx.respond(200, { access_token: "..." }, { "retry-after": "1" });
}, "token");
// 需要延迟响应时返回 "deferred" 并稍后 ctx.respond(...)；ctx.hang() 模拟不响应
```

覆盖的验收路径：正常收发、签名失败、429 退避、重复投递、超时 → `delivery_unknown`、
主动消息受限、token 过期/刷新失败。飞书测试文件：
`test/channels.test-server.test.ts`、`test/channels.feishu.test.ts`、
`test/channels.feishu.e2e.test.ts`、`test/channels.feishu.runtime.test.ts`；
QQ 测试文件：`test/channels.qq.test.ts`、`test/channels.qq.e2e.test.ts`、`test/channels.qq.websocket.test.ts`。

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

## 真实 QQ 联调（WS 传输已实现，真实收发证据待执行）

**状态：真实 WebSocket 网关传输与联调脚本已实现；真实收发证据尚未执行**（需要机器人账号
+ 人在 QQ 里 @ 机器人）。协议层已由 `ChannelTestServer` + `registerQqTestStub` 全链路覆盖，
WS 传输由 `channels.qq.websocket.test.ts` 零网络覆盖；**不得以桩测试冒充平台验收**。

联调脚本：`scripts/real-machine/qq-live-smoke.ts`（只读 Keychain，不打印 token）：

```bash
export PATH="/opt/homebrew/bin:$PATH"
# 只观察（默认 60s）
node --experimental-strip-types scripts/real-machine/qq-live-smoke.ts
# 收到群 @ 消息时用回复 API 回一条（验证完整回环）
node --experimental-strip-types scripts/real-machine/qq-live-smoke.ts --reply "收到，我在" --seconds 120
```

- 从 macOS Keychain（`channel:qq` / `app_id`、`app_secret`）读凭据 → `GET /gateway` →
  WebSocket Hello/Identify → 打印 READY 与每个事件的类型/会话/发送者/文本摘要（不打印 token）；
- `--reply` 仅对**群 @ 消息**生效（`reply_to_native_message_id` 走被动回复 API）；
- `--seconds N` 超时退出（默认 60），退出打印事件/拒绝计数与 `health()`；
- 前置：机器人已加入群，且有人 **@ 机器人**（未 @ 的群消息平台不投递）。

以下步骤在资质就绪后执行：

1. 在 QQ 开放平台注册机器人开发者并创建机器人，记录 AppID 与 AppSecret。
2. 配置沙箱/正式环境的事件订阅：填写回调 HTTPS 地址（只允许 80/443/8080/8443），
   订阅群 @ 与单聊消息事件；记录 BotSecret 用于 Ed25519 校验。
3. 提交所需权限/场景：群聊消息、单聊消息；主动消息需按平台申请场景与额度（多数个人
   开发者默认额度很低或不可用）。
4. 把 `app_id`、`app_secret`、`bot_secret` 写入本机 SecretStore（service `channel:qq`，
   account 为字段名）；如需内网 token 代理，写 `token_endpoint`。
5. 以 `channelAdapters` 注入 `QqChannelAdapter` 启动 Runtime；确认
   `GET /v1/channels/qq/health` 为 healthy、`connection=connected`、
   `token_expires_at` 合理；`GET /v1/channels` 中 `group_proactive=limited`。
6. 私聊发消息验证回复引用原消息；把机器人拉群、@ 一次验证响应，未 @ 不响应；在
   `GET /v1/outbox` 与事件账本核对 `outbound.queued/sent` 与平台回执。
7. 主动消息：先确认平台额度与「允许主动发送」开关；若平台拒绝，核对 Outbox 是否进入
   `needs_review` 且**没有**自动重发，并检查 `outbound.failed` 的
   `retryable=false`/`outbound.reviewed` 审计。
8. 记录 20 次真实收发证据到门禁报告；主动消息限制、附件限制如实登记为平台约束。

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
