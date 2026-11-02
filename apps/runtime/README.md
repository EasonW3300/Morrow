# @morrow/runtime

Runtime 骨架 + 事件账本 v1（票 T2 / Issue #3）+ 对话贯通（票 T4 / Issue #5）+ Provider 配置、
凭据库与切换（票 T5 / Issue #6）+ 任务 DAG 与调度（M1-T4 / Issue #16）。核心 Node 应用：
任务编排、Agent Loop、记忆管线、能力工厂、控制 API 的宿主；打包为单二进制，桌面 sidecar
与 Ubuntu 服务器同一代码（ADR-0003）。T5 交付 Provider CRUD + OS 凭据库 + 连通性测试端点
+ 会话级 Provider 切换与失败隔离；M1-T4 交付任务事件族 + 状态机 + 规划/执行贯通。
凭据库与切换（票 T5 / Issue #6）。核心 Node 应用：任务编排、Agent Loop、记忆管线、能力工厂、
控制 API 的宿主；打包为单二进制，桌面 sidecar 与 Ubuntu 服务器同一代码（ADR-0003）。
T5 交付 Provider CRUD + OS 凭据库 + 连通性测试端点 + 会话级 Provider 切换与失败隔离。
M1-T1（Issue #13）交付记忆垂直切片：memory.write 工具 + 高价值规则即时写入候选 +
`GET /v1/memory/facts` FTS5 检索（表结构一次到位，fact 巩固写路径留 T2）。
M1-T2（Issue #14）交付后台抽取与巩固管线：轮次收尾异步抽取（可注入 Extractor，默认确定性
启发式）→ 巩固（可注入 Consolidator，默认确定性决策矩阵）产出 MemoryFact + MemoryRevision
版本链；常规偏好冲突自动更新留历史，重大事实 / locked / 敏感等级冲突进待确认队列；
候选/冲突控制面端点与 `memory.extracted` / `memory.consolidated` 等运行事件。
M1-T3（Issue #15）交付 Markdown 投影、受控导入与删除标记：长期记忆投影为 §6.4 格式的
`dataDir/memory/*.md`（再生成幂等），`POST /v1/memory/import` 把人工编辑转版本化修订
（不绕过冲突检测，frontmatter 版本对账防覆盖），`DELETE /v1/memory/facts/:id` 软删 +
`memory.fact_deleted` tombstone + 投影移除（重投影不复活），AC-03 前置脚本 100 条记录
回链断言（`memory:ac03`）。

## 运行与测试

```bash
pnpm --filter @morrow/runtime start   # node --experimental-sqlite --experimental-strip-types src/main.ts
pnpm --filter @morrow/runtime test    # tsc --noEmit + node:test（测试框架与 protocol 一致）
```

Node 22.13 以下需要 `--experimental-sqlite` 标志（22.13+ 起默认开启，标志保留无害）；
TS 语法限定在可擦除子集（无 enum / namespace / 参数属性），与 type stripping 兼容。
**FTS5 依赖（M1-T1）**：记忆检索用 SQLite FTS5，Node 内建 SQLite 在 **22.16+ / 24** 才编入
FTS5 模块——更老的小版本（如 22.12）起服务/跑测试会在建表时报 `no such module: fts5`
（MemoryStore.open 会转译为带版本的提示）。CI（`node-version: 22` 解析到最新 22.x）与
本地开发请用满足该条件的 Node。

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
| GET | `/v1/health` | `{ status: "ok", version, replica_id, sandbox, ledger: { events } }`；沙箱探针为桩，恒返回 `not-configured`（明确第四态；真实化是 M2-T1 / Issue #22 交付，检测逻辑见 `src/sandbox/detect.ts`） |
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
| POST | `/v1/providers/:id/test` | 连通性测试 → `{ result: "ok" \| "auth_failed" \| "unreachable" \| "error", ... }`（`unreachable` 带 `kind: "timeout" \| "connect_error"` 结构化类别，见下文） |
| GET | `/v1/devices` | 本副本已知设备记录（只读；M0 最小实现，见下文「Device 记录」）→ `{ devices: [{ replica_id, label, created_at, last_seen_at }] }` |
| POST | `/v1/tasks` | 建任务并规划（M1-T4 / Issue #16），body `{ goal }`（非空字符串）→ 201 任务详情（DAG/状态/版本）；规划经 PiAdapter（生产默认 Provider + 规划系统提示词，测试注入 FakePi），规划成功即后台自动调度（见下节）；无 Provider 503 `planner_unavailable`、body 非法 400；坏规划输出不 5xx——任务以 `failed` 状态持久化，响应仍 201 |
| GET | `/v1/tasks` | 任务列表 → `{ tasks: [{ task_id, goal, status, task_version, created_at, updated_at }] }` |
| GET | `/v1/tasks/:id` | 任务详情（DAG/状态/版本）→ 200 `{ ...summary, nodes: [{ node_id, key, title, goal?, depends_on, agent_role?, model?, retriable, side_effect, status, attempts, result?, error? }], error? }` / 404 `task_not_found` |
| GET | `/v1/tasks/:id/events` | 任务执行事件（分页；`task_id` 专列 + 索引）→ `{ events, total, limit, offset }`；query 同 `/v1/events`（`limit` 1–200 默认 50、`offset`）；未知任务 404 |
| POST | `/v1/tasks/:id/pause` | 安全点暂停（M1-T5 / Issue #17）：停派发 + 等在跑节点到边界（不中止）→ `task.paused` 迁移 → checkpoint 落库 → 200 `{ task, checkpoint }`；非 running 409 `task_invalid_transition`、边界 10s 未收尾 504 `task_timeout` |
| POST | `/v1/tasks/:id/resume` | 从最新 checkpoint（可为空）reconcile（副作用分类 gate）→ 202 `{ task, checkpoint_id, reconcile }`，后台驱动至终态；接受 paused / waiting_input / planned（调度前崩溃孤儿）/ running（中断残留）；活跃 running 与终端态、created（无计划）409 |
| POST | `/v1/tasks/:id/restore` | 指定 checkpoint 恢复，body `{ checkpoint_id }`（必填）→ 202 `{ task, checkpoint_id, reconcile }`；未知/他任务 checkpoint 404 `checkpoint_not_found`、版本不匹配 409 `checkpoint_version_mismatch` |
| GET | `/v1/tasks/:id/checkpoints` | checkpoint 列表（新→旧，快照全量）→ `{ checkpoints: [{ checkpoint_id, task_id, task_version, reason, created_at, snapshot }] }`；未知任务 404 |
| GET | `/v1/memory/facts` | 记忆检索（M1-T1）：`q`（必填非空关键词，FTS5 短语查询，中英文均可）→ `{ q, facts: [{ id, stage, type, content, sensitivity, confidence?, version, sources, created_at }] }`；`sources` 为来源账本事件 id 数组（回链），缺 q/空 q → 400 `invalid_query` |
| GET | `/v1/memory/candidates` | 候选列表（M1-T2）：`status` 可选（`pending`/`consolidated`/`dismissed`/`conflicted`）+ 分页（`limit` 1–200 默认 200、`offset`）→ `{ candidates: [{ candidate_id, content, kind, sensitivity, confidence, source_event_id, observed_at, occurred_at, version, status, created_at }] }`；非法 status → 400 `invalid_query` |
| POST | `/v1/memory/candidates/:id/decide` | Owner 决定（M1-T2）：body `{ decision: "accept" \| "dismiss" }`；accept → 立即巩固该候选（绕过置信度准入线）→ 200 `{ candidate_id, decision, outcome: { kind: "fact_created" \| "fact_updated" \| "corroborated" \| "conflict", fact_id?/conflict_id? }, run }`；dismiss → 状态置 dismissed；未知 id 404 `memory_not_found`、非 pending 409 `memory_invalid_state`（conflicted 候选走冲突裁决端点）、decision 非法 400 |
| GET | `/v1/memory/conflicts` | 冲突列表（M1-T2）：`status` 可选（`open` 待确认队列 / `resolved`）+ 分页 → `{ conflicts: [{ conflict_id, candidate_id, fact_id, reason, existing_content, incoming_content, existing_sensitivity, incoming_sensitivity, status, resolution?, resolved_content?, created_at, resolved_at? }] }` |
| POST | `/v1/memory/conflicts/:id/resolve` | 冲突裁决（M1-T2，FR-MEM-5 的出口）：body `{ resolution: "keep_new" \| "keep_old" \| "merge", content? }`；keep_new → 采纳候选值（版本+1 + 修订 `conflict_resolved` + `memory.fact_updated`）；keep_old → 事实不动、候选 dismissed（只留 `memory.conflict_resolved`）；merge → 必须携带非空 `content`（Owner 合并文本）进版本链（修订 `conflict_merged`，敏感性维持既有分级）→ 200 `{ conflict_id, fact_id, resolution, version, revision_id, factUpdatedEventId, conflictResolvedEventId }`；未知 404、已裁决 409、merge 缺 content / resolution 非法 400 |
| POST | `/v1/memory/import` | 受控导入（M1-T3 / Issue #15，FR-MEM-6）：body `{ markdown }` = 编辑后的 §6.4 投影文件全文 → 200 `{ status: "updated" \| "conflict" \| "unchanged", fact_id, version, import_event_id, ... }`；合法编辑转版本化修订（版本+1 + MemoryRevision `manual_import` + `memory.fact_updated`，投影文件同步刷新）；locked / 敏感分级变更进待确认队列不直写（status=`conflict` + `conflict_id`/`reason`，裁决走 resolve 端点）；frontmatter `version` 落后库内 → 409 `memory_stale_version`（防覆盖）；未知/已删事实 404、缺 frontmatter / 缺 `markdown` 400 |
| DELETE | `/v1/memory/facts/:id` | 删除标记（M1-T3，FR-MEM-8 单机前置）：tombstone 事件 `memory.fact_deleted` 入账本 + facts 行软删（`deleted_at` 标记；修订/来源多对多保留作回链审计）+ FTS 索引移除 + 投影文件移除 → 200 `{ deleted: true, fact_id, version, deleted_at, event_id }`；重投影不复活已删记忆；locked 记忆默认拒绝 409 `memory_locked_confirm`，`?confirm=true` 显式确认后删除；未知/已删 404 |
| POST | `/v1/memory/project` | 投影再生成命令（M1-T3，幂等）：现存有效事实 → `<dataDir>/memory/{fact_id}.md`（§6.4 frontmatter），只写差异文件（同状态产出同字节）+ 清理孤儿投影文件（外来文件不动）→ 200 `{ directory, written, unchanged, removed }` |

错误统一 `{ error: { code, message } }`；未匹配路径 404，路径命中但方法不符 405，
body 非法 400 `invalid_body`，body 的 content-type 非 application/json 一律 415
`unsupported_media_type`（CSRF 最小防护，见下），未知会话 404。node:http + 极简路由，
不引框架——为 T8 bun compile 留路。

CORS（票 T6）：桌面 WebView 与浏览器联调是跨源客户端；本地来源
（`http(s)://(localhost|127.0.0.1|tauri.localhost)`、`tauri://localhost`）放行，
preflight OPTIONS → 204，白名单含 `content-type` 与 `last-event-id`（SSE 断线重连）。
非本地来源不带 CORS 头，浏览器拦截其跨源读写。但 CORS 不等于 CSRF 防线：**simple POST
（text/plain 等 safelist content-type）不经 preflight、请求本身仍会到达**——因此写端点
（带 body 的 POST/PUT）在服务器端强制 `content-type: application/json`，缺失/撒谎一律
415（safelist 外的合法跨源请求会被浏览器强制 preflight，白名单不放行）。当前防护与
残余风险（GET 类只读、无 body 的 POST、DNS rebinding）见 `docs/security/threat-model.md` 域 4。

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
| `event: <event_type>` + `data: <信封 JSON>` | 账本 seq | ✅ | durable 帧；账本子序列保序（口径见下） |
| `event: text_delta` + `data: {"delta":"..."}` | 无 | ❌ | 流式文本增量，易失展示层事件 |
| `event: done` + `data: {"session_id"}` | 无 | ❌ | 本轮结束标记（连接时空闲立即发；每轮完成后再发） |

- **连接即重放**：不带 `Last-Event-ID` 从会话首事件全量重放；带 `Last-Event-ID`（数字 seq）
  只重放其后的账本事件，再接 live 帧。重放与 live 之间按 seq 去重，durable 帧顺序 = 账本顺序。
- **保序口径（明确语义）**：「事件顺序与账本一致」指 **durable 帧是账本的子序列、按 seq 保序**
  （本会话的账本事件之间不交错、不乱序）；`text_delta` 是**易失帧**，不入账本、不参与该保证
  （断连即丢，权威全文见 `message.assistant`）。
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
| `memory.candidate_created` | `agent:runtime` | 来源 message.user | `{ candidate_id, content, kind, sensitivity, confidence, source_id, source_event_id, rule }`（M1-T1；rule = 命中的启发式规则 / `memory.write` / 抽取器规则名） |
| `memory.extracted` | `agent:runtime` | 本轮 message.assistant | `{ user_event_id, assistant_event_id?, extracted_count, skipped_duplicates, candidate_ids }`（M1-T2：抽取运行收尾，0 条也留痕——管线跑过且可审计） |
| `memory.consolidated` | `agent:runtime` | 自动路径 = 同轮 memory.extracted；decide 路径 = 候选来源事件 | `{ candidate_count, created_fact_ids, updated_fact_ids, corroborated_fact_ids, conflict_ids, candidate_ids }`（M1-T2：巩固运行收尾；无待巩固候选时不产生空运行事件） |
| `memory.fact_created` | `agent:runtime` | 证据 message.user | `{ fact_id, content, kind, sensitivity, version, candidate_id, source_event_id }`（M1-T2：巩固新建事实） |
| `memory.fact_updated` | `agent:runtime` | 证据 message.user | `{ fact_id, version, content, sensitivity, revision_id, reason, candidate_id?, conflict_id?, source_event_id }`（M1-T2：版本链推进——reason = `preference_update` / `conflict_resolved` / `conflict_merged`） |
| `memory.conflict_detected` | `agent:runtime` | 证据 message.user | `{ conflict_id, fact_id, candidate_id, reason, existing_content, incoming_content }`（M1-T2：reason = `fact_conflict` / `locked` / `sensitivity_change`；上报即不静默覆盖） |
| `memory.conflict_resolved` | `agent:runtime` | 证据 message.user | `{ conflict_id, resolution, fact_id, version, revision_id?, resolved_content? }`（M1-T2：裁决落定；keep_old 也留此事件——"不改"亦是裁决） |

信封 `session_id` 关联会话；全部过 protocol JSON Schema + integrity_hash 复算后入账本
（append-only 三层防线见下）。`text_delta` 不入账本（易失，见 SSE 一节）。
每轮恰好一条 `message.assistant` 收尾——正常轮 `stop_reason: "stop"`；错误轮先 `agent.error`
再落 `stop_reason: "error"` 的 assistant（text 为已产出前缀）；中断轮 `stop_reason: "aborted"`，
已产出事件不丢失且不污染后续轮次。

## M1 任务事件族与调度（票 M1-T4 / Issue #16，PRD §4.3 FR-TASK-1/2/6）

**端到端语义**：`POST /v1/tasks` 同步规划（目标描述 → Agent Loop 规划提示词 → JSON 计划 →
schema + 语义校验（key 唯一/依赖可解析/无环）→ DAG 落表 + `task.planned`），201 返回规划
快照后**自动后台调度**——任务族无独立 run 端点（PRD §6.2），暂停/补充输入等介入操作是
FR-TASK-3 的范围；客户端轮询详情与事件观察执行进度（curl 演示：POST → 轮询 GET 详情）。
规划失败（工厂抛错/输出非法）不 5xx：`task.planning_failed` + `task.failed` 留痕，任务以
`failed` 状态存在。规划工厂可经 `startRuntime(config, { taskPlannerFactory, taskNodeAgentFactory })`
注入（测试 FakePi 脚本化，零网络）；节点执行工厂默认用会话默认 Provider（node.model 仅记录）。

**状态机**（决策稿 §6；`needs_reconcile` 留后）：`created → planned → running →
(paused | waiting_input | failed | completed | cancelled)`，`paused | waiting_input → running`
的恢复记 `task.resumed`；终端态拒绝一切迁移（非法迁移不落任何事件，服务层
`TaskService.transition` 抛 `invalid_transition`，HTTP 409 `task_invalid_transition`）。

**事件族**（event_type 清单只增不减；信封 `task_id` 关联任务，全部入账本 `task_id` 专列）：

| event_type | actor_id | causation_id | payload 要点 |
| --- | --- | --- | --- |
| `task.created` | `owner` | null | `{ goal }` |
| `task.planned` | `agent:runtime` | task.created | `{ task_version, edge_count, nodes: [全量 DAG 投影] }` |
| `task.started` | `agent:runtime` | task.planned | `{}`（planned→running） |
| `task.resumed` | `agent:runtime` | 触发事件 | `{}`（paused/waiting_input→running 的恢复） |
| `task.node_started` | `agent:runtime` | task.started | `{ node_id, key, title, goal, attempt }` |
| `task.node_finished` | `agent:runtime` | 对应 node_started | `{ node_id, key, status, attempt, result?, error?, stop_reason? }` |
| `tool.started` / `tool.finished` | `agent:runtime` | node_started / 对应 tool.started | 会话族同型 + `{ node_id, key, attempt }`（工具事件复用会话类型，causation 链到节点） |
| `agent.error` | `agent:runtime` | node_started | `{ message, node_id, key, attempt }` |
| `task.paused` / `task.waiting_input` | `agent:runtime` | 触发事件 | `{}` |
| `task.completed` | `agent:runtime` | task.started | `{ nodes_completed, nodes_total }` |
| `task.failed` | `agent:runtime` | task.started | `{ reason: "node_failed" \| "planning_failed" \| "stalled", node_id?, key?, message }` |
| `task.cancelled` | `agent:runtime` | 触发事件 | `{}` |
| `task.planning_failed` | `agent:runtime` | task.created | `{ message }` |

**调度器**（单机版）：就绪 = pending 且依赖全 completed（依赖拓扑定序）；同批就绪节点
并发执行，同时在跑节点数受 `concurrency` 上限约束（`TaskSchedulerOptions.concurrency`，
默认 2、最小 1；上限是调度器级资源，`schedule()` 入队 FIFO 逐任务驱动使它跨任务成立，
任务内并行不受影响）。节点执行 = 一次 Agent Loop（驱动模式与会话同构：窄事件翻译入账本
+ causation 链）；`retriable` 节点失败自动重试一次（attempts=2），最终失败标记节点并使整
任务 `task.failed`（payload 带失败节点）。节点副作用分类
`reversible | compensatable | irreversible | delivery_unknown` 随节点记录（保守默认
`delivery_unknown`；真实投递与补偿在 M4 SideEffectOutbox）。任务/节点表
（tasks/task_nodes/task_edges）是与账本同库的可变投影表（迁移见 `task-migrations.ts`），
账本仍是唯一事实源。优雅退出：`close()` 中止在跑节点、拒绝未开跑的排队任务后落盘。

## M1 Checkpoint 与中断恢复（票 M1-T5 / Issue #17，PRD §4.3 FR-TASK-5/6、§6）

**暂停语义（安全点）**：`pause` = 受理即停派发（drive 主循环让位，不会并发把任务迁到终态）
+ 等在跑节点到边界（自然收尾，不中止——在跑节点的工作不浪费、事件流保持真实）→
`task.paused` 迁移 → checkpoint 落库 → 返回。边界 10s 未收尾（节点悬挂）→ 504，任务保持
running。pause 在等待期间任务被并发终结（completed/failed）→ 409（任务状态为准）。

**Checkpoint（FR-TASK-5 字段集）**：`task_checkpoints` 表（与任务投影同库，JSON 快照 +
元数据）+ `task.checkpoint_created` 事件。快照 `morrow.checkpoint/1`：Task Graph（节点/边/
状态/task_version）、Run 状态（status、run 根事件、账本 event_cursor、已完成节点的输出
引用 = `task.node_finished(completed)` 账本事件 id）、workspace（M1 恒 null——无工作区，
FR-TASK-8 未实现，`workspace_note` 说明）、execution（runtime 版本 + 默认 Provider 投影，
绝不含密钥；节点建议模型；工具版本表 M1 占位空）、session_ids（Task↔Session 关联后续票，
恒空）、待处理副作用清单（按分类：not_delivered / delivered_unverified / compensation_pending）。
写入顺序：先行后事件；事件写失败补偿删行（不留孤儿），任务保持 paused 可重试。

**恢复语义（FR-TASK-6，分类 → 动作）**：恢复的危险是「重复送达」而非「首跑」——从未执行
的节点照常调度；只有已完成/在跑（半写）节点被回卷重执行时按副作用分类 gate（决策函数
`planReconcile`，resume 与 restore 同一管线）：

| 节点状态 | side_effect | 动作 |
| --- | --- | --- |
| completed（checkpoint 亦记 completed 或无 checkpoint） | 任意 | keep_completed，不重放 |
| pending / pending_review / failed | 任意 | 原状保持（pending_review 即人工核对队列） |
| checkpoint 后才完成 / 半写 running | reversible | 回卷 pending，重放 |
| 同上 | compensatable | 回卷 pending 重放 + 登记待补偿（M1 只记录，真实补偿在 M4） |
| 同上 | irreversible / delivery_unknown | **不自动重发**：置 `pending_review`（节点级人工核对态，保留原 result 供核对）；无可跑节点时任务转 `waiting_input`（`reconciliation_required`） |

选择节点级 `pending_review` 而非任务级 `needs_reconcile`：任务级冻结会让可继续的兄弟节点
陪停，且核对范围本来就是节点级；`needs_reconcile` 留给 M3 执行租约冲突。`pending_review`
的放行是 FR-TASK-3 的审核 UI；库形态可经 `TaskService.setNodeState` 决策后 resume。

**resume / restore**：`resume` = 最新 checkpoint（可为空）reconcile → `task.restored`（无
checkpoint 时 causation 为 null）→ 迁回 running（planned 记 `task.started`、paused/
waiting_input 记 `task.resumed`、中断残留 running 补 `task.resumed`
`recovered_after_interruption`）→ 重新入队驱动。`restore` 指定 checkpoint（校验归属与
task_version，不匹配 409）。终端态（completed/failed/cancelled）与 created（无计划）一律
409——回卷经 FR-TASK-3 修订流程。跨恢复的 attempts 在节点行上单调递增（半写那次也计入）。

**故障注入套件**（`test/checkpoint.faults.test.ts`，AC-07 前置，25 个注入点 / 20 个恢复
成功 + 5 个守卫）：进程级以真实子进程（`test/fixtures/task-child-runtime.ts`，FakePi 注入
零网络）kill -9 注入——节点执行中（四类副作用各一）、pause 等边界窗口、pause 完成后、DAG
中段、resume 驱动中、并行兄弟、规划中、连续两次 kill、restore 跨重启；进程内注入——
checkpoint 事件写中断（补偿删行）、attempts 膨胀半写、反向半写（结果落行事件未落）、
checkpoint 行丢失、失败节点收敛、并发双 resume/双 pause、waiting_input 幂等、无漂移
restore。套件可重复执行（临时目录 + 显式脚本）。

## Agent Loop 与会话运行时

- 每会话一个 `AgentRuntime`（PiAdapter 接口，惰性创建、驻内存）：对话历史由 Pi agent state
  持有（NOTES-pi §9），进程重启后不重灌历史——账本有完整审计，历史重放/重灌是后续票的事。
- 会话的 Provider 在**创建运行时那一刻**按「显式绑定 > 当前默认」解析（密钥经凭据库取出，
  只在内存传递）；运行时创建后固定，后续轮次不再解析（切换 = 新会话）。
- 窄事件 → 账本：`tool_start` → `tool.started`；`tool_end` → `tool.finished`；`error` →
  `agent.error`；`agent_end` → `message.assistant`（stop_reason 透传）；`text_delta` → SSE。
- 未配置 Provider 时发消息在 HTTP 层即 503，不记账（用户输入不会被静默吞掉）。
- 会话可用工具经工厂 extras 注入（M1-T1：`agentTools(sessionId)` → `AgentRuntimeExtras.tools`，
  生产默认工厂透传给 `createPiAdapter` 的 tools 通道；注入测试工厂可忽略该参数）。

## 记忆管线（M1-T1 候选 + M1-T2 抽取/巩固，Issue #13 / #14）

**表结构**（与事件账本同库 `events.sqlite`，表可变、不影响 events 的 append-only；
迁移全 `CREATE TABLE IF NOT EXISTS` + 候选表 CHECK 重建（T1 旧库自动加 `conflicted` 状态），可重复执行）：

| 表 | 用途 | 状态 |
| --- | --- | --- |
| `memory_sources` | 记忆来源（回链账本 event_id；GLOSSARY: MemorySource「事实必须可回链到来源」） | ✅ 写入 |
| `memory_candidates` | 候选记忆（来源/观察时间/发生时间/置信度/敏感等级/版本/status，GLOSSARY: MemoryCandidate）；status：`pending` → `consolidated` \| `dismissed` \| `conflicted` | ✅ 写入 |
| `memory_facts` | 长期记忆（版本与有效期，GLOSSARY: MemoryFact） | ✅ 写入（M1-T2 巩固） |
| `memory_fact_sources` | 事实↔来源多对多（巩固聚合多条来源） | ✅ 写入（M1-T2） |
| `memory_revisions` | 事实版本历史（FR-MEM-5） | ✅ 写入（M1-T2） |
| `memory_conflicts` | 冲突待确认队列（重大事实 / locked / 敏感等级冲突，FR-MEM-5） | ✅ 写入（M1-T2） |
| `memory_fts` | FTS5 索引（content + entry_id/entry_kind UNINDEXED），候选与事实统一索引 | ✅ 写入 |

**两条写入路径，一个出口**（`MemoryService.#persist`：先落行（来源+候选+FTS 同一事务），后记账本事件）：

1. **观察路径**：`message.user` 落账后 SessionManager 同步调用 `MemoryObserver.observeUserMessage`
   → `heuristics.ts` 确定性高价值规则（不依赖模型）命中即写候选。规则按优先级取首个命中：
   `explicit-remember`（置信度 0.9，内容 = 关键词之后部分）> `preference-statement`（0.8，整句）
   > `fact-statement`（0.7，整句）；闲聊/提问不命中，零副作用。观察失败只记日志，不阻断会话主流程。
2. **工具路径**：`memory.write` 工具经 PiAdapter tools 通道注册（入参 schema = protocol
   `MemoryWriteInput`），模型显式调用；来源 = 会话最新一条 `message.user`；非法入参以
   `isError` 文本返回给模型而非抛异常。缺省 `kind=fact`、`confidence=0.9`、`sensitivity=private`。

**事件族**（event_type 清单只增不减）：见「M0 会话事件族」表中的 memory.* 行。
事件过统一信封（protocol JSON Schema + integrity_hash 复算），候选/事实证据的
`causation_id` 指向来源 `message.user` 事件——「记忆可回链」在账本侧由 causation 承载，
在检索侧由 `sources` 数组承载。顺序约定：行先于事件（行是可重建投影，事件缺失即本次
写入未生效，不静默吞掉）。

**后台抽取与巩固（M1-T2 / Issue #14，FR-MEM-3/4/5）**——两个可注入接缝 + 服务层写路径：

1. **抽取（`extraction.ts`，seam `MemoryExtractor`）**：SessionManager 在 `message.assistant`
   落账后调用 `MemoryObserver.observeTurnEnd`（可选方法，T2 新增）→ `MemoryService.extractTurn`
   fire-and-forget 异步执行（失败只记日志，不影响会话主链路；`RuntimeOptions.memoryExtractor`
   可注入，默认 `HeuristicExtractor` = 同一套确定性启发式的多句全量扫描）。输出候选带
   内容/kind/置信度/sensitivity/rule；**同来源事件 + 同内容去重**（T1 即时写入先写走的候选
   不重复），运行落 `memory.extracted`（0 条也留痕）。
2. **巩固（`consolidator.ts`，seam `MemoryConsolidator`）**：抽取收尾把**全部 pending 候选中
   confidence ≥ 0.8（`AUTO_CONSOLIDATE_MIN_CONFIDENCE`）**的交给巩固器（跨写路径补齐——T1
   即时写入与 memory.write 工具产生的候选同样在下一轮收尾被巩固）；低置信弱命中（0.7 的
   fact-statement）留 pending 等 Owner `decide`。巩固器是纯判定（输入候选批次 + 现存事实
   视图，逐条决策、事实视图即时刷新杜绝批内重复建事实），服务执行写路径：
   - `create_fact`：事实 v1 + 来源多对多 + FTS + `memory.fact_created`；
   - `update_fact`：版本+1 + MemoryRevision（reason=`preference_update`）+ `memory.fact_updated`；
   - `corroborate`：归一化内容相同 → 只补来源、不推进版本（locked 事实也允许印证）；
   - `escalate`：冲突行 + 候选转 `conflicted` + `memory.conflict_detected`——绝不静默覆盖。
   运行收尾落 `memory.consolidated`。
3. **冲突规则（FR-MEM-5 口径，按序判定）**：同主题 = kind 相同 且 显著词元交集非空
   （ASCII 词 ≥2 字符 + CJK 单字去停用字）；①既有事实 **locked** 且内容不同 → 上报
   （GLOSSARY：禁止一切自动改写，连偏好也不豁免）；②候选与事实**敏感等级不同** → 上报
   （可见性分级不静默变更，升级与放宽都算）；③同主题 **preference** → 自动更新留历史
   （版本链）；④其余 kind 内容不同 → 上报（重大事实冲突）。裁决三选一：keep_new /
   keep_old / merge（Owner 提供合并文本），见端点表——keep_new/merge 推进版本链，
   keep_old 事实不动只留裁决事件。

**候选/冲突控制面**：端点见上表；候选 decisions（accept/dismiss）与冲突裁决（resolve）
的行变更均为单事务（候选/事实/修订/冲突行同进退），事件在行落定后记账。

**检索**：`GET /v1/memory/facts?q=` → FTS5 短语查询（用户输入经 CJK 逐字插空格归一化 +
引号转义：unicode61 下连续中文成词，短语查询即子串匹配，零 native 分词依赖），按 rank 排序
上限 50，候选/事实统一索引，命中带 `sources` 回链。**默认敏感级**：新记忆一律
`sensitivity=private`（GLOSSARY: Sensitivity Level，仅 Owner 会话可读），工具入参可显式覆盖。

**Markdown 投影 / 受控导入 / 删除标记（M1-T3 / Issue #15，FR-MEM-6/8）**：

1. **投影**：现存有效事实 → `<dataDir>/memory/{fact_id}.md`（文件名 = fact_id），frontmatter
   严格按 PRD §6.4 十字段（id/type/sensitivity/confidence/valid_from/valid_until/sources/
   created_at/updated_at/version），正文 = 事实内容原文。值格式两处刻意偏差取无损/一致性：
   `id` 用 fact_id 原文（与检索 API、文件名同一真相源，不带示例中的 `mem_` 前缀）、时间戳
   用完整 ISO 8601 UTC；`confidence` 对事实恒为 `null`（置信度是候选属性，字段按 §6.4
   字段集保留）。**幂等**：渲染是 store 状态的纯函数——同状态产出同字节（统一 LF + 尾随
   换行，无需换行归一层），projectAll 只写差异文件并清理孤儿 `{uuid}.md`（外来文件不动）；
   再生成命令 `POST /v1/memory/project`。已删/已过期事实不投影。
2. **受控导入**：`POST /v1/memory/import`，body = `{ markdown }`（编辑后的投影文件全文——
   一次携带全部 frontmatter，与投影互为往返；结构化 `{fact_id, content}` 形态会绕过 §6.4
   解析与版本对账，不做）。流程：id 定位事实（不存在/已删 404）→ version 对账（落后即 409
   `memory_stale_version` 防覆盖）→ `memory.import_received` 证据事件 → 内容与分级均未变
   → `unchanged`；否则候选（confidence 1，人工编辑即 Owner 授权）+ 与 T2 巩固同一冲突口径：
   locked 任何变更 → 冲突队列（`locked`），分级变更 → 冲突队列（`sensitivity_change`，纯
   分级变更也算，比巩固器更严），其余 → 版本+1 + MemoryRevision（`manual_import`）+
   `memory.fact_updated` + 投影单事实刷新。frontmatter 其余字段是投影只读面（type 不可变、
   sources/时间戳以库内为准），不因导入改写。
3. **删除标记**：`DELETE /v1/memory/facts/:id` → facts 行软删（`deleted_at`；修订/来源保留
   作回链审计）+ FTS 索引移除（检索面立即退出）+ `memory.fact_deleted` tombstone 事件
   （payload 带事实终态，M3 同步传播的证据）+ 投影文件移除；重投影只认现存事实，不复活
   已删记忆。**locked 删除需确认**：默认 409 `memory_locked_confirm`，`?confirm=true`
   显式放行（locked = 变更须经 Owner 确认，删除是不可逆变更，宁可多问）。

**AC-03 前置脚本**：`pnpm --filter @morrow/runtime memory:ac03`
（`scripts/memory-ac03.ts`）——100 条设计记录端到端（词元两两不相交的确定性内容）：
写入→抽取→巩固→投影（幂等断言）→检索→逐条回链断言（全部 100 条投影 frontmatter 的
sources 非空且指向存在的账本事件）→账本完整性校验→受控导入/删除抽查。确定性、零网络、
可重复执行（临时数据目录即建即清）。

**边界（如实）**：抽取/巩固默认实现是确定性启发式——按句匹配、不懂语义（反讽/引用有
误报漏报），同主题判定靠词元交集（过宽多问、过窄多建事实，均可经控制面纠偏）；LLM 抽取/
巩固后续经同接口替换（`MemoryExtractor` / `MemoryConsolidator`），无需动写路径；投影为
单向导出（`POST /v1/memory/project` 再生成），尚无编辑器文件监听/自动重投影；删除的跨
副本传播是 M3（本票只落单机 tombstone）；`memory.*` 事件经账本入 SSE 重放
（session_id 关联），不进会话实时帧；FTS5 为硬依赖（Node 22.16+/24，见文首）。

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
  runtime.ts     HTTP 服务 + 极简路由（含 SSE 与 Provider/任务 handlers）+ 生命周期编排
  sessions.ts    SessionManager：会话事件族 → 账本 + Agent Loop（串行队列）+ 会话帧广播 + Provider 绑定解析
  tasks.ts       TaskService：任务生命周期 + 规划（Agent Loop + JSON 计划校验）+ DAG 投影 + 任务状态机 + task.* 事件族
  scheduler.ts   TaskScheduler：单机调度器（依赖拓扑 + 并发上限 + retriable 重试；节点执行 = 一次 Agent Loop）
  checkpoint.ts Checkpoint 域（M1-T5）：FR-TASK-5 快照 + task_checkpoints 表 + planReconcile 恢复决策 + task.checkpoint_created/task.restored 事件
  task-migrations.ts 任务域表 DDL（tasks/task_nodes/task_edges/task_checkpoints，与账本同库的可变投影）
  providers.ts   ProviderRegistry：三元组 CRUD + 默认指针 + env 回退解析（元数据 → providers.json，密钥 → 凭据库）
  keyring.ts     OS 凭据库统一封装（macOS security 实测 / Windows cmdkey+PowerShell / Linux secret-tool / 内存桩）
  connectivity.ts Provider 连通性测试（最小 OpenAI 兼容请求；unreachable 带 timeout/connect_error 结构化 kind）
  ledger.ts      EventLedger：append-only 账本（schema 校验、hash 复算、分页/过滤、scan、完整性校验）
  envelope.ts    事件信封工厂（T2 生命周期事件与 T4 会话事件共用）
  db.ts          SQLite 薄 facade（node:sqlite 绑定收敛点）
  devices.ts     DeviceRegistry：devices 表（replica_id 主键）+ 启动种子（M0 最小实现，票 #3）
  memory/        记忆管线（M1-T1 候选 / Issue #13 + M1-T2 抽取巩固 / Issue #14）：
                   store.ts      MemoryStore：记忆表 + FTS5 检索 + 巩固/冲突事务写路径
                   service.ts    MemoryService：三条候选写入路径 + 抽取/巩固管线 + 控制面
                   extraction.ts MemoryExtractor 接缝 + 默认确定性抽取器（T2）
                   consolidator.ts MemoryConsolidator 接缝 + 默认决策矩阵/冲突规则（T2）
                   heuristics.ts 确定性高价值规则（即时写入取首命中 / 抽取取全部）
                   tool.ts       memory.write 工具（PiAdapter tools 通道注册）
                   routes.ts     facts/candidates/conflicts 控制面端点
  config.ts      环境变量解析（含 Provider 三元组 env 回退种子）+ 副本身份持久化
  sandbox/       沙箱执行 Worker（M2-T2 / Issue #23，详见下节）
  health.ts      沙箱可用性探针（M0 桩；真实化是 M2-T1 / Issue #22 的交付，检测逻辑见 sandbox/detect.ts）
  uuid-v7.ts     UUID v7 生成 + 小写 uuid 形态正则 UUID_RE（config / runtime 共用）
  index.ts       公共出口（库形态供桌面宿主内嵌）
scripts/
  smoke-real-provider.ts  真实 Provider 冒烟（手动执行，读环境变量，不进测试套件）
test/         node:test：ledger / server / config / lifecycle / sessions / keyring / providers /
              providers.api / connectivity / provider-switch / cors / devices / tasks（服务层）/
              tasks.api（HTTP 任务族）/ checkpoint（快照字段集与恢复决策）/ checkpoint.scheduler
              （pause/resume/restore 编排）/ checkpoint.api（HTTP 介入端点）/
              checkpoint.faults（故障注入套件，AC-07）/ memory（heuristics / store / store2 巩固
              写路径 / consolidator 决策矩阵 / pipeline 管线 / api 检索 / pipeline.api 抽取巩固
              端到端）/ sandbox（contract / detect / runner-units / docker-runner / invoker /
              permission / go-worker / wiring / docker 真实容器套件）等 seam
```

## 沙箱执行 Worker（M2-T2 / Issue #23，PRD §2 执行隔离 + FR-CAP-4）

**安全语义（GLOSSARY Sandbox）**：沙箱是运行 AI 生成代码的隔离执行环境；无可用沙箱时
**拒绝执行生成代码**（fail-closed，不降级直跑）。vetted builtin（human 签发的 Go Worker）
不经沙箱，不受影响。

### 分层与接缝

```
ToolInvoker（src/sandbox/invoker.ts）  ← startRuntime 注入 seam：RuntimeOptions.sandboxRunner / permissionEngine
  │  同一注册（register(manifest, package)）+ 调用（invoke(name, input)）接缝
  │  固定次序：查注册表 → PermissionEngine.assertRuntimeUse（执行前复核）→ 分发
  ├─ sandbox.type=builtin → go-worker.ts 直跑（Go 编译产物，stdio JSON，SIGKILL 超时）
  └─ sandbox.type=container → SandboxRunner.run(pkg, input, contract)
        └─ DockerRunner（docker-runner.ts）：esbuild 预打包 → docker run → SandboxResult
```

- **SandboxRunner 接缝**（`src/sandbox/runner.ts`）：`run(toolPackage, input, contract) → Promise<SandboxResult>`。
  接口注入（`RuntimeOptions.sandboxRunner`）；测试/宿主注入 FakeRunner，本机无 docker 时
  sandboxed 调用拒绝而 builtin 照常（Runner 仅服务 sandboxed 类）。
- **契约**（`src/sandbox/contract.ts`）：manifest.sandbox 规范化——`network` v1 仅 `none`
  （默认）、`filesystem` 仅 `workspace-only`（默认）、`resources` 缺省 `{cpus:1, memoryMb:256,
  timeoutMs:30000}`；未知取值/超限 → `SandboxContractError`（注册时 fail fast）。
- **工具回传协议**（`src/sandbox/protocol.ts`）：工具以 stdin 收 JSON 输入、stdout **最后一个
  非空行**输出单行信封 `{"ok":true,"result":…}` / `{"ok":false,"error":"…"}`；stderr 承载诊断。
  TS 与 Go 工具同一协议（ADR-0006：沙箱内工具不碰主库，一切结果经协议回传由 Runtime 落账）。

### 容器实现强制项（DockerRunner）

| 契约项 | docker 落地 | 测试证据 |
| --- | --- | --- |
| network: none | `--network none` | 容器内 fetch 出网探针失败（`sandbox.docker.test.ts`，失败原因随 result 回传） |
| filesystem: workspace-only | workspace 挂载（声明 FS 权限 → rw，未声明不挂载）+ 包目录 `:ro` + `--read-only` 根 FS + `/tmp` tmpfs | workspace 内可读可写、workspace 外宿主路径 ENOENT、容器根路径写入 EROFS |
| resources | `--cpus` / `--memory` | 64MB 上限下分配 160MB → OOM 退出 137 |
| timeout | 按容器名 `docker kill` 强杀 | sleep 5s / timeout 1.2s → `timed_out` + 退出 137 |
| 纵深加固 | `--pids-limit 128`、`--security-opt no-new-privileges`、无 tty（stdout 干净） | `sandbox.runner-units.test.ts`（args 纯函数锁旗标） |

镜像拉取策略：`node:22-alpine` 首次执行按需 pull（先 `image inspect`，缺失才 pull，
结果 `pulled: true` 记录一次拉取；不预拉不阻塞启动）。打包产物为 `.mjs`（容器内无
package.json，靠扩展名保证按 ESM 执行）。esbuild 经动态 import 引入（devDependency；
单二进制路线的打包决策留 M2-T3，探针不触发该路径）。

### 拒绝路径（无容器运行时）

`detectContainerRuntime`（`src/sandbox/detect.ts`，探测命令可桩注入）按 docker → podman
顺序探测；macOS 上 Docker Desktop 与 OrbStack 共用 docker CLI，按 info 的
OperatingSystem 字段归类 orbstack；Windows 探 docker.exe，缺失再探 WSL2（子系统在但
无引擎 → WSL2 专项指引）；CLI 在但 daemon 不可达 → 指引点名启动 daemon。
不可用 → sandboxed 调用抛 `SandboxUnavailableError`：

- code：`sandbox_unavailable`，附对应 OS 的 `installHint`（macOS: Docker Desktop /
  OrbStack；Linux: Docker Engine / Podman；Windows: WSL2 + Docker Desktop）。
- HTTP 映射约定（接入路由层时按此执行）：`sandbox_unavailable` → **503**；
  `permission_denied` → 403；`invalid_sandbox_contract` / `tool_package_unsupported` → 400；
  `tool_timeout` → 504；`tool_error` / `tool_exit_nonzero` / `tool_protocol_error` /
  `tool_output_too_large` → 502（工具自身失败）；`image_pull_failed` / `tool_build_failed` → 503/500。

### 运行时权限复核（M2-T1 接缝）

执行前固定调用 `PermissionEngine.assertRuntimeUse({manifest, contract, input, context})`
（`src/sandbox/permission.ts`）。本票交付接口桩 + 确定性本地判定基线（fail-closed）：
manifest 声明 network 权限但契约为 none → 拒绝；输入含 workspace 外绝对路径 → 执行前
拒绝（builtin 同样过复核）。M2-T1（Issue #22）合并后由其 Grant 五维语义接管该接缝。

### Go Worker 示范（workers/go）

首个真实 Go 工具 `textstats`（行/词/字节统计 + 文本规范化；PRD §2 双语言）：

```bash
workers/go/build.sh   # CGO_ENABLED=0 go build → bin/textstats（宿主平台；go ≥1.25）
```

注册形态 `manifest {author:"human", runtime:"go", sandbox:{type:"builtin"}}`，经
ToolInvoker 同一接缝注册 + 调用（`test/sandbox.go-worker.test.ts`：本机有 go 真编译真跑，
无 go 且无产物 → skip 并注明理由）。协议与容器内 TS 工具一致（protocol.ts）。

### 测试与 CI

```bash
pnpm --filter @morrow/runtime test:sandbox   # 仅沙箱族（真实容器路径 + 注入桩路径）
pnpm --filter @morrow/runtime test           # 全量（含沙箱族）
```

- 真实容器套件（`sandbox.docker.test.ts`）顶部先探测容器运行时：不可用 → 整套 skip 并
  注明理由（CI 仅 ubuntu 腿跑：runner 预装 docker；macos/windows runner 无 docker，
  m0.yml `sandbox-tests` job 已标注）。
- 其余沙箱测试（契约/检测/args/协议/invoker/权限/wiring/go-worker）零 docker 零网络零
  LLM——fake exec / FakeRunner / 探测桩注入。
- 真实容器套件首次运行会拉取 node:22-alpine（约 20–60s），后续复用本地镜像。
