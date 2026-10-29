# @morrow/runtime

Runtime 骨架 + 事件账本 v1（票 T2 / Issue #3）+ 对话贯通（票 T4 / Issue #5）+ Provider 配置、
凭据库与切换（票 T5 / Issue #6）。核心 Node 应用：任务编排、Agent Loop、记忆管线、能力工厂、
控制 API 的宿主；打包为单二进制，桌面 sidecar 与 Ubuntu 服务器同一代码（ADR-0003）。
T5 交付 Provider CRUD + OS 凭据库 + 连通性测试端点 + 会话级 Provider 切换与失败隔离。

## 运行与测试

```bash
pnpm --filter @morrow/runtime start   # node --experimental-sqlite --experimental-strip-types src/main.ts
pnpm --filter @morrow/runtime test    # tsc --noEmit + node:test（测试框架与 protocol 一致）
```

Node 22.13 以下需要 `--experimental-sqlite` 标志（22.13+ 起默认开启，标志保留无害）；
TS 语法限定在可擦除子集（无 enum / namespace / 参数属性），与 type stripping 兼容。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MORROW_HOST` | `127.0.0.1` | 监听地址 |
| `MORROW_PORT` | `0`（随机空闲） | 实际端口经 stdout 的 ready 行（单行 JSON）告知父进程，sidecar 场景无端口冲突 |
| `MORROW_DATA_DIR` | `~/.morrow/data` | 账本等落盘数据目录（根 .gitignore 已忽略 data/） |
| `MORROW_REPLICA_ID` | 按 dataDir 持久化 | 副本 uuid；未显式配置时写入 `<dataDir>/replica-id`，重启后身份稳定（同步按 replica 去重依赖它） |
| `MORROW_PROVIDER_BASE_URL` | 缺省（无 Provider） | OpenAI Chat Completions 兼容端点（ADR-0002）；三个 PROVIDER 变量都缺省 = 未配置 |
| `MORROW_PROVIDER_API_KEY` | `""` | 静态 key；vLLM/Ollama 等本地端点可留空 |
| `MORROW_PROVIDER_MODEL` | 与 BASE_URL 同必需 | 模型 id |
| `MORROW_PROVIDER_CONTEXT_WINDOW` | `131072` | 模型上下文窗口 |
| `MORROW_PROVIDER_MAX_TOKENS` | `8192` | 单次生成上限 |

**Provider 优先级（T5）**：`MORROW_PROVIDER_*` 不再是唯一来源，而是 **env 回退**——显式 CRUD
注册的 Provider 优先；仅在无任何注册 Provider（或显式把默认切到 `env`）时，环境变量充当默认
Provider（虚拟 id 固定 `env`，不落盘、密钥不入凭据库）。详见下文「Provider 配置与凭据库」。

Provider 未配置时会话可建可查，发消息返回 503 `provider_not_configured`。
Agent Loop 经 PiAdapter 接口注入（`startRuntime(config, { agentAdapterFactory })`）：
生产默认 `createPiAdapter`（按会话解析的 Provider 构建；无 Provider 时 503），测试注入
`createFakePi`（同构接口，无网络）。注入工厂时不做 Provider 预检（工厂自决如何处置
provider 参数）；凭据库可经 `startRuntime(config, { secretStore })` 注入（测试/宿主）。

生命周期：`SIGINT`/`SIGTERM` → 停止接收请求 → 中止在跑的 Agent 轮次并释放运行时 →
记账 `runtime.stopped` → 关闭账本（WAL checkpoint 落盘）→ 退出 0。

## HTTP API（M0 子集，PRD §6.2）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | `{ status: "ok", version, replica_id, sandbox, ledger: { events } }`；沙箱探针为桩，恒返回 `not-configured`（明确第四态，M0 不装 Docker） |
| GET | `/v1/events` | `{ events: EventEnvelope[], total, limit, offset }`；query：`limit`（1–200，默认 50）、`offset`、`replica_id`（uuid 过滤）；非法入参 400 |
| POST | `/v1/sessions` | 建会话，body `{ title?, provider_id? }`（provider_id 需已注册，或为 env 回退）→ 201 `{ session_id, event_id, sequence, occurred_at, provider_id?, title? }`；未知 provider_id → 400 `unknown_provider` |
| GET | `/v1/sessions` | 会话列表（`session.created` 投影，含显式 `provider_id`）→ `{ sessions: [...] }` |
| POST | `/v1/sessions/:id/messages` | 发送用户输入，body `{ text }`（非空字符串）→ 202 `{ message_id, event_id, sequence, status }`；status `processing`（本轮立即驱动）或 `queued`（同会话有轮次在跑，FIFO 排队） |
| GET | `/v1/sessions/:id/messages` | 历史投影 → `{ session_id, messages: [{ message_id, role, text, stop_reason?, event_id, sequence, occurred_at }] }` |
| GET | `/v1/sessions/:id/stream` | SSE 会话事件流（见下节） |
| GET | `/v1/providers` | Provider 列表（元数据投影 + env 回退条目）→ `{ providers, default_provider_id }` |
| POST | `/v1/providers` | 注册 Provider，body `{ name, base_url, model, api_key?, provider_id?, compat?, context_window?, max_tokens? }` → 201 元数据；重复 id 409、非法 400 |
| GET | `/v1/providers/:id` | 单个 Provider 元数据 → 200 / 404 `provider_not_found` |
| PUT | `/v1/providers/:id` | 更新（部分字段；`api_key` 提供即轮换）→ 200 / 404 |
| DELETE | `/v1/providers/:id` | 删除（元数据 + 凭据库条目）→ 200 `{ deleted }` / 404 |
| POST | `/v1/providers/:id/default` | 把默认 Provider 切到该 id → 200 `{ default_provider_id }` |
| POST | `/v1/providers/:id/test` | 连通性测试 → `{ result: "ok" \| "auth_failed" \| "unreachable" \| "error", ... }`（见下文） |
| GET | `/v1/devices` | 本副本已知设备记录（只读；M0 最小实现，见下文「Device 记录」）→ `{ devices: [{ replica_id, label, created_at, last_seen_at }] }` |

错误统一 `{ error: { code, message } }`；未匹配路径 404，路径命中但方法不符 405，
body 非法 400 `invalid_body`，未知会话 404。node:http + 极简路由，不引框架——为 T8 bun compile 留路。

CORS（票 T6）：桌面 WebView 与浏览器联调是跨源客户端；本地来源
（`http(s)://(localhost|127.0.0.1|tauri.localhost)`、`tauri://localhost`）放行，
preflight OPTIONS → 204，白名单含 `content-type` 与 `last-event-id`（SSE 断线重连）。
非本地来源不带 CORS 头，浏览器直接拦截——互联网页面不可读写本地控制面。

## Provider 配置与凭据库（T5，ADR-0002）

每个 Provider = `base_url + api_key + 模型名` 三元组 + compat 开关 + 显示名（GLOSSARY: Provider）。

**存储分离（密钥安全不变量）**：

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| `api_key` | OS 凭据库（service `com.morrow.runtime`，account = provider_id） | 绝不出现在配置文件、日志、API 响应、账本（响应只含 `has_api_key` 投影；错误消息不回显密钥） |
| 元数据（name/base_url/model/compat/窗口参数） | `<dataDir>/providers.json`（本地配置存储，原子写） | **不入 SQLite 账本**（票面明确）；文件内容不含密钥 |
| env 回退（`MORROW_PROVIDER_*`） | 仅内存（虚拟 id `env`） | 不落盘、不入凭据库 |

**OS 凭据库后端**（零 native 模块，各 OS 自带 CLI 包一层统一 `SecretStore` 接口，为 T8 bun
compile 铺路；实现见 `src/keyring.ts`）：

| 后端 | CLI | 实测状态 |
| --- | --- | --- |
| macOS Keychain | `/usr/bin/security`（add/find/delete-generic-password） | ✅ 本机实测通过（测试用 `com.morrow.t5-test-*` 独立 service 名，套件结束清理） |
| Windows Credential Manager | `cmdkey`（写/删）+ PowerShell CredRead P/Invoke（读） | ⚠️ 接口 + exec 桩测试锁定命令构造，真实 OS **未实测** |
| Linux secret-tool | libsecret CLI（store/lookup/clear，密钥走 stdin） | ⚠️ 接口 + exec 桩测试，真实 OS **未实测** |
| 内存桩 | — | 测试替身；`detectSecretStore` 对未知平台回退到此（密钥仅进程内存） |

已知限制：macOS/Windows 的密钥经 CLI argv 短暂可见（各 OS CLI 的固有限制，Linux 走 stdin
无此问题）；M0 单用户本地场景接受并记录在案。`secretStore` 可经 `startRuntime` 注入。

**优先级与默认指针**：显式 CRUD > 环境变量。首个注册的 Provider 自动成为默认；
`POST /v1/providers/:id/default` 显式切换；删除默认时落到剩余第一个（无剩余但有 env 回退
则默认为 `env`）。`GET /v1/providers` 会把 env 回退作为只读条目列出（CRUD 对 `env` 无效，
404/400）。

**切换语义**：会话创建可选 `provider_id`（显式绑定，落 `session.created` payload，重启后按
账本重放投影）；未绑定会话在**发送时**用当前默认。切换 Provider = 新会话绑定另一 Provider
（会话内 Provider 固定：AgentRuntime 的对话历史由其内部 state 持有，换 Provider 即换会话，
账本仍完整审计两段对话）。AC-02「新任务可切换 Provider」即按此实现。

**失败隔离**：会话互相独立——某 Provider 配错（凭据库缺失/工厂失败/连接失败）只影响绑定它的
会话（`agent.error` 收尾），其他 Provider 上的进行中会话不受影响（测试
`provider-switch.test.ts` 覆盖：good 会话在工具执行中，broken 会话报错，good 完整收尾并可
继续对话）。pi-ai 对空 key 抛错，默认工厂对免密端点（vLLM/Ollama）用其自身 `unused` 占位
约定——这些端点忽略 Authorization 头。

**连通性测试**（`POST /v1/providers/:id/test`）：发一次最小 OpenAI 兼容请求
（`POST {base_url}/chat/completions`，`max_tokens: 1`，非流式），10s 超时，结果分类：

| result | 含义 |
| --- | --- |
| `ok` | 2xx（附 `http_status`、`latency_ms`） |
| `auth_failed` | 401 / 403（密钥无效或无权限） |
| `unreachable` | 连接失败 / DNS 失败 / 超时（附 `detail` 错误码，如 `ECONNREFUSED`） |
| `error` | 其余 HTTP 状态（端点可达但异常，如 404/500）——附加诊断类，AC 三类仍两两可区分 |

结果载荷只含状态码/错误码/延迟，不含密钥、不含供应商响应体（防错误网关回显 Authorization 头）。

## SSE 会话事件流

每帧三类：

| 帧 | `id:` | 账本 | 说明 |
| --- | :-: | :-: | --- |
| `event: <event_type>` + `data: <信封 JSON>` | 账本 seq | ✅ | durable 帧；顺序与账本一致 |
| `event: text_delta` + `data: {"delta":"..."}` | 无 | ❌ | 流式文本增量，易失展示层事件 |
| `event: done` + `data: {"session_id"}` | 无 | ❌ | 本轮结束标记（连接时空闲立即发；每轮完成后再发） |

- **连接即重放**：不带 `Last-Event-ID` 从会话首事件全量重放；带 `Last-Event-ID`（数字 seq）
  只重放其后的账本事件，再接 live 帧。重放与 live 之间按 seq 去重，durable 帧顺序 = 账本顺序。
- **断线取舍**：断连期间的 `text_delta` 不可恢复（易失）；`message.assistant` 是权威全文
  （每轮恰好一条，中断轮也落盘已产出前缀 + `stop_reason: "aborted"`），客户端重连后以其覆盖
  本地累积的部分文本。进程重启后重放同样从账本投影（增量丢失，durable 完整）。
- 心跳：15s 一次 `: ping` 注释帧。连接生命周期挂在 res `close` 上清理（req `close` 在 GET
  请求体读完即触发，不能用作 SSE 断连信号）。

## 同会话并发语义（选择记录在案）

**排队串行，不 409**：`POST messages` 在用户输入落账本后立即 202 返回（消息已持久化），
Agent Loop 按 FIFO 逐轮驱动，轮次之间不交错（账本可证：后一轮的 tool.started 晚于前一轮的
message.assistant）。选择排队的理由：输入本身就该留审计，409 会把重试负担推给客户端且无收益；
M0 不设队列上限（单用户本地场景）。

## M0 会话事件族（event_type 清单只增不减）

| event_type | actor_id | causation_id | payload |
| --- | --- | --- | --- |
| `session.created` | `owner` | null | `{ title?, provider_id? }`（T5：显式 Provider 绑定时含 provider_id；字段只加不减） |
| `message.user` | `owner` | null | `{ message_id, text }` |
| `tool.started` | `agent:runtime` | 触发轮的 message.user | `{ tool_call_id, tool_name, args }` |
| `tool.finished` | `agent:runtime` | 对应 tool.started | `{ tool_call_id, tool_name, text, is_error, duration_ms? }` |
| `agent.error` | `agent:runtime` | message.user | `{ message }` |
| `message.assistant` | `agent:runtime` | message.user | `{ message_id, text, stop_reason }` |

信封 `session_id` 关联会话；全部过 protocol JSON Schema + integrity_hash 复算后入账本
（append-only 三层防线见下）。`text_delta` 不入账本（易失，见 SSE 一节）。
每轮恰好一条 `message.assistant` 收尾——正常轮 `stop_reason: "stop"`；错误轮先 `agent.error`
再落 `stop_reason: "error"` 的 assistant（text 为已产出前缀）；中断轮 `stop_reason: "aborted"`，
已产出事件不丢失且不污染后续轮次。

## Agent Loop 与会话运行时

- 每会话一个 `AgentRuntime`（PiAdapter 接口，惰性创建、驻内存）：对话历史由 Pi agent state
  持有（NOTES-pi §9），进程重启后不重灌历史——账本有完整审计，历史重放/重灌是后续票的事。
- 会话的 Provider 在**创建运行时那一刻**按「显式绑定 > 当前默认」解析（密钥经凭据库取出，
  只在内存传递）；运行时创建后固定，后续轮次不再解析（切换 = 新会话）。
- 窄事件 → 账本：`tool_start` → `tool.started`；`tool_end` → `tool.finished`；`error` →
  `agent.error`；`agent_end` → `message.assistant`（stop_reason 透传）；`text_delta` → SSE。
- 未配置 Provider 时发消息在 HTTP 层即 503，不记账（用户输入不会被静默吞掉）。

## 真实 Provider 冒烟（手动，不进测试套件）

```bash
MORROW_PROVIDER_BASE_URL="https://api.example.com/v1" \
MORROW_PROVIDER_API_KEY="sk-..." \
MORROW_PROVIDER_MODEL="gpt-..." \
node --experimental-sqlite --experimental-strip-types apps/runtime/scripts/smoke-real-provider.ts
```

临时数据目录起 runtime → 建会话 → SSE 先行 → 发消息 → 实时打印帧 → 打印账本事件与历史投影；
无成功 assistant 轮即退出码 1。任何 OpenAI 兼容端点可用（Ollama/vLLM 免密：API_KEY 留空）。

## 事件账本 v1

- **信封与校验**：写入事件必须是 protocol 包的 `EventEnvelope` v1；落盘前过 JSON Schema（ajv 2020-12，
  运行时守门员）+ `computeIntegrityHash` 复算比对（hash 与内容不符拒绝写入）。
- **只追加（三层防线）**：账本类不暴露修改/删除方法；HTTP 层无变更方法（405）；SQLite 表上
  `BEFORE UPDATE/DELETE` 触发器 `RAISE(FAIL, 'events table is append-only')`，绕过接口直连库也改不动。
  纠错一律新事件 + `causation_id` 补偿（protocol README 演进规则）。
- **完整性校验**：`ledger.verifyIntegrity({ sampleRate? })` 逐事件（默认，sampleRate=1）或按 seq
  取模确定性抽样，重算 hash 与落盘值比对，返回 `{ ok, checked, total, mismatches }`。
  注意 `integrity_hash` 是防篡改**证据**而非防篡改**手段**（无签名密钥，改数据+重算 hash 不可检出；
  签名/审计是后续票的事）。
- **存储格式**：`events(seq PK AUTOINCREMENT, event_id UNIQUE, replica_id, event_type, occurred_at, envelope)`，
  `envelope` 存信封的 canonical JSON 全文（byte 级稳定，篡改字节即可检出）；WAL + `synchronous=FULL`
  （账本 durability 优先）+ `busy_timeout=5000`。
- **内部事件**：`runtime.started` / `runtime.stopped`（`actor_id: "agent:runtime"`，stopped 的
  `causation_id` 指向本次运行的 started）。

## Device 记录（M0 最小实现，票 #3）

`devices` 表（与事件账本同库 `events.sqlite`，表可变、不影响 events 的 append-only）：
`replica_id`（主键）、`label`（M0 无命名机制，恒 null）、`created_at`（首见时间）、
`last_seen_at`（最近一次启动）。启动时从 `replica-id` 文件解析出的 `config.replicaId`
upsert 种子；`GET /v1/devices` 只读。

**边界（如实）**：M0 只登记**本副本**一条记录——不做配对、撤销、多设备注册表；那是 M3
同步里程碑的范围（PRD §5.2 配对协议、AC-04/05）。`actor_id` 的事件级归属已由信封
（`owner` / `agent:runtime`）承载，本表是设备维度的补充记录。

## SQLite 访问选型（验收第 5 条，结论记录在案）

**定 `node:sqlite`（`DatabaseSync`）为唯一绑定**，经 `src/db.ts` 薄 facade（exec/prepare/close +
WAL/busy_timeout pragma）访问。依据 `morrow-research/NOTES-bun.md`：

- 零 native 依赖：Node ≥22.5 内建，Bun 1.4.4 官方兼容表标记 fully implemented，
  `bun build --compile` 单二进制后走兼容层，不阻塞 ADR-0003 打包路线；
- `better-sqlite3`（native N-API，6 平台编译/供应链风险）与 `bun:sqlite`（Node 侧无此模块，
  双代码路径）均不进依赖树；
- facade 收敛在一个文件：若 Bun 兼容层在 M0 冒烟暴露缺陷（如 `backup()` 同步阻塞——本包不使用
  `backup()`，WAL checkpoint 走干净关闭默认路径），换驱动只动 `src/db.ts`。
- M0 冒烟已完成（票 T8）：bun compile 后 `node:sqlite` 零标志实测通过，结论与证据见
  `docs/adr/0006-sqlite-binding-node-sqlite.md`；打包与探针入口见 `scripts/packaging/`。

## 结构

```
src/
  main.ts        进程入口：配置 → startRuntime → 信号处理（优雅退出）
  runtime.ts     HTTP 服务 + 极简路由（含 SSE 与 Provider handlers）+ 生命周期编排
  sessions.ts    SessionManager：会话事件族 → 账本 + Agent Loop（串行队列）+ 会话帧广播 + Provider 绑定解析
  providers.ts   ProviderRegistry：三元组 CRUD + 默认指针 + env 回退解析（元数据 → providers.json，密钥 → 凭据库）
  keyring.ts     OS 凭据库统一封装（macOS security 实测 / Windows cmdkey+PowerShell / Linux secret-tool / 内存桩）
  connectivity.ts Provider 连通性测试（最小 OpenAI 兼容请求 + 三类结果分类）
  ledger.ts      EventLedger：append-only 账本（schema 校验、hash 复算、分页/过滤、scan、完整性校验）
  envelope.ts    事件信封工厂（T2 生命周期事件与 T4 会话事件共用）
  db.ts          SQLite 薄 facade（node:sqlite 绑定收敛点）
  devices.ts     DeviceRegistry：devices 表（replica_id 主键）+ 启动种子（M0 最小实现，票 #3）
  config.ts      环境变量解析（含 Provider 三元组 env 回退种子）+ 副本身份持久化
  health.ts      沙箱可用性探针（M0 桩）
  uuid-v7.ts     UUID v7 生成（事件 event_id / message_id / provider_id 用）
  index.ts       公共出口（库形态供桌面宿主内嵌）
scripts/
  smoke-real-provider.ts  真实 Provider 冒烟（手动执行，读环境变量，不进测试套件）
test/         node:test：ledger / server / config / lifecycle / sessions / keyring / providers /
              providers.api / connectivity / provider-switch 十个 seam
```
