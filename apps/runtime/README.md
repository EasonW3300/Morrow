# @morrow/runtime

Runtime 骨架 + 事件账本 v1（票 T2 / Issue #3）。核心 Node 应用：任务编排、Agent Loop、
记忆管线、能力工厂、控制 API 的宿主；打包为单二进制，桌面 sidecar 与 Ubuntu 服务器同一代码（ADR-0003）。
本票交付进程骨架与账本地基，Agent 对话事件在 T4 接入。

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

生命周期：`SIGINT`/`SIGTERM` → 停止接收请求 → 记账 `runtime.stopped` → 关闭账本（WAL checkpoint 落盘）→ 退出 0。

## HTTP API（M0 子集，PRD §6.2）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | `{ status: "ok", version, replica_id, sandbox, ledger: { events } }`；沙箱探针为桩，恒返回 `not-configured`（明确第四态，M0 不装 Docker） |
| GET | `/v1/events` | `{ events: EventEnvelope[], total, limit, offset }`；query：`limit`（1–200，默认 50）、`offset`、`replica_id`（uuid 过滤）；非法入参 400 |

node:http + 极简路由，不引框架——为 T8 bun compile 留路。错误统一 `{ error: { code, message } }`；
未匹配路径 404，路径命中但方法不符 405（对事件的任何变更方法在请求层即被拒）。

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

## SQLite 访问选型（验收第 5 条，结论记录在案）

**定 `node:sqlite`（`DatabaseSync`）为唯一绑定**，经 `src/db.ts` 薄 facade（exec/prepare/close +
WAL/busy_timeout pragma）访问。依据 `morrow-research/NOTES-bun.md`：

- 零 native 依赖：Node ≥22.5 内建，Bun 1.4.4 官方兼容表标记 fully implemented，
  `bun build --compile` 单二进制后走兼容层，不阻塞 ADR-0003 打包路线；
- `better-sqlite3`（native N-API，6 平台编译/供应链风险）与 `bun:sqlite`（Node 侧无此模块，
  双代码路径）均不进依赖树；
- facade 收敛在一个文件：若 Bun 兼容层在 M0 冒烟暴露缺陷（如 `backup()` 同步阻塞——本包不使用
  `backup()`，WAL checkpoint 走干净关闭默认路径），换驱动只动 `src/db.ts`。
- M0 冒烟待补：bun compile 后 `node:sqlite` 实测（NOTES-bun.md §4 清单），结论出来前
  ADR-0003 的"首选 bun compile"保持待验证状态。

## 结构

```
src/
  main.ts     进程入口：配置 → startRuntime → 信号处理（优雅退出）
  runtime.ts  HTTP 服务 + 极简路由（路由面小，暂不分文件）+ 生命周期编排
  ledger.ts   EventLedger：append-only 账本（schema 校验、hash 复算、分页/过滤、完整性校验）
  db.ts       SQLite 薄 facade（node:sqlite 绑定收敛点）
  config.ts   环境变量解析 + 副本身份持久化
  health.ts   沙箱可用性探针（M0 桩）
  uuid-v7.ts  UUID v7 生成（事件 event_id 用）
  index.ts    公共出口（库形态供桌面宿主内嵌）
test/         node:test：ledger / server / config / lifecycle 四个 seam
```
