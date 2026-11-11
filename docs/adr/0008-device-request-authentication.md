# 设备请求鉴权选 bearer token（配对时下发，服务端只存摘要）

M3-T2（FR-DEP-2）需要为「非本机回环来源」的 Runtime API 请求提供设备鉴权。决定采用 **bearer token**：新设备通过一次性配对码 claim 时，服务端下发 256 位随机令牌（`mrw_` + base64url），客户端存入 OS 凭据库；后续请求带 `Authorization: Bearer <token>`，服务端只以 SHA-256 摘要查 devices 表。ed25519 设备密钥对仍然保留——它的职责是**设备身份与双端指纹核对**，不用于逐请求签名。令牌未设置过期时间，靠撤销（`revoked=1`）即时失效；重放防护依赖私有网络传输（ADR-0004）+ 令牌高熵 + OS 凭据库保管 + 撤销后服务端立即拒绝。

## 背景与范围

- 传输层：ADR-0004 已定「默认私有网络（Tailscale/WireGuard）」，公网直连与 TLS 不在 M3 验收范围。鉴权因此只需防**同一私有网络内的伪造设备**，不需要承担公网凭据泄露的完整防护。
- 纯本地部署必须零配置可用：本机 UI/CLI 经 `127.0.0.1`/`::1` 访问 Runtime 时**不要求**任何令牌。
- 设备身份：ed25519 密钥对（私钥仅存 OS 凭据库，service `com.morrow.device` + account `replica_id`）；公钥落 devices 表；指纹 = 公钥 raw 32 字节的 SHA-256 前 16 hex，短格式 `ABCD-EF01-2345-6789` 供双端人工核对。
- 撤销：`DELETE /v1/devices/:id` 置 `revoked=1` 并保留 token 摘要作为吊销墓碑；该设备后续请求明确返回 403 `device_revoked`。

## 决策

### 请求鉴权：bearer token

- `POST /v1/pairing/claim` 成功响应包含 `token`（仅此一次出现）与服务端/新设备双方指纹。
- 客户端把 token 存 OS 凭据库（service `com.morrow.device`，account `token:<server_replica_id>`），此后非回环请求携带 `Authorization: Bearer <token>`。
- 服务端 devices 表只存 `sha256(token)`（`token_hash`）；API 投影白名单构造，摘要不出现在任何响应。
- 每次认证后刷新 `last_seen_at`；多设备可并存多条令牌。

### 回环豁免边界（精确、可审计）

- 放行：socket 远端地址为 `127.0.0.1`、`::1` 或 IPv4-mapped `::ffff:127.0.0.1`（IPv6 zone 后缀剥离后比较）。**仅此三种形态**；`127.0.0.2` 等 127/8 其他地址不放行。
- **不信任任何代理头**（`X-Forwarded-For` / `Forwarded` 一律忽略）——Runtime 直接面向连接方，避免「声明自己是回环」的绕过。若未来引入反向代理，必须在新 ADR 中重定义信任边界。
- 非回环唯一免除 bearer 的路径是 `POST /v1/pairing/claim`：新设备尚无令牌，配对码本身是单次、5 分钟、按来源地址限速（默认 10 次失败 / 5 分钟）的凭据。
- `OPTIONS`（CORS preflight）不承载业务意图，由路由层先返回 204，不进入鉴权判定；实际请求仍按上述规则校验。
- `GET /v1/health` **不豁免**：非回环探活同样需要令牌（部署冒烟可在本机回环执行）。

### 撤销语义

- 撤销为终态：`revoked=1` 后该设备的令牌不再可用（403），且不能凭旧配对码重新 claim。
- 保留 `token_hash` 作为墓碑：使撤销设备得到可区分的 403 而不是退化为 401 `invalid_token`；摘要无访问权，鉴权必查 `revoked`。
- 本机自身设备不可撤销（409 `cannot_revoke_self`），避免把回环之外的管理入口全部锁死。
- 撤销与配对均落账本审计事件：`device.paired`（含双方指纹）与 `device.revoked`；payload 不含私钥与 token 明文。

### 双端指纹确认

- `POST /v1/pairing/codes` 响应返回服务端公钥 + 指纹（短格式）；claim 响应同时返回服务端与新设备指纹。
- 客户端可把从已信任设备侧读到的指纹放进 claim 的 `server_fingerprint`：不一致时服务端返回 409 `fingerprint_mismatch` 且**不消耗配对码**，允许核对后重试。这是「指纹不匹配明确失败」的服务端落点；最终信任仍由人核对两端显示值决定。

## Considered Options

- **① ed25519 请求签名（`X-Morrow-Device` + `X-Morrow-Signature`，覆盖 method + path + body-hash + timestamp，5 分钟防重放窗）**——安全性更强（不传输可重放凭据、天然防篡改），但实现面大：需要统一请求体缓冲与规范化（GET/SSE/PUT/DELETE 各不相同）、时钟偏差处理（建议 ±5 分钟并记录非单调时钟风险）、签名串版本化与调试成本；对「单主人 + 私有网络」的威胁模型收益有限。**不采用，保留为公网模式（ADR-0004 预留）的升级路径。**
- **② bearer token（采用）**——实现简单、撤销直接（删/改一行状态即生效）、对 SSE/桌面 WebView/Go Worker 等所有 HTTP 客户端一致；代价是令牌本身可重放，需要靠传输层与保管面兜底。
- 不鉴权、仅依赖私有网络——不采用：ADR-0004 明确同网段仍可能伪造设备，配对码 + 指纹 + 设备鉴权是三层中的第三层。

## 重放防护说明（bearer 方案的残余风险）

bearer token **不携带请求上下文**，任何拿到明文的第三方都可重放。分层缓解：

1. 传输：默认私有网络隧道（ADR-0004），令牌不过公网明文链路。
2. 保管：令牌只存 OS 凭据库；服务端只存 SHA-256 摘要；不写配置文件、日志、事件 payload 或任何 API 响应（有测试断言扫描）。
3. 熵与生命周期：256 位随机，不可猜测；claim 响应是唯一明文出现点。
4. 撤销：丢失设备后 Owner 撤销即全局失效（403），无需等令牌过期。
5. 配对入口：6 位码短时 + 单次 + claim 失败限速，降低被暴力猜中的概率。

明确接受：若攻击者已能读取目标设备 OS 凭据库或截获隧道内明文，bearer 令牌可被重放至令牌撤销为止；需要抗此级别的场景走签名方案（①）或更强的传输层（TLS），不在 M3 范围。

## Consequences

- Runtime 的 `authorizeRequest` 成为所有非回环请求的唯一鉴权入口；新增路由自动受保护（鉴权先于路由匹配）。
- 撤销设备后，其进行中的 SSE 长连接不会立刻断开（下一个请求才 401/403）；M3-T3 同步引擎需在拉取前复核设备状态，不能只依赖连接建立时鉴权。
- 浏览器 `EventSource` 无法设置自定义 Authorization 头：非回环 SSE 客户端目前需改用可设头的流式实现，或等待后续 ADR 定义查询参数/短期票据方案（本票不引入 URL 令牌，避免日志泄漏）。
- 公网模式若启用，必须重新评估本 ADR（TLS + 可能切到签名方案 ①）。
