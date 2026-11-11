# @morrow/protocol

事件信封 schema、API 合约与共享类型（PRD §6.3）。JSON Schema 与 TypeScript 双形态由
round-trip 契约测试固定：两边共用同一份测试夹具（`test/fixtures.ts`），任何一侧漂移两边同时变红。

## 包内容

| 文件 | 职责 |
| --- | --- |
| `schema/event-envelope.schema.json` | 事件信封 v1 JSON Schema（2020-12）。**跨语言契约的唯一真相源**，Go workers 等直接读取 |
| `src/event-envelope.ts` | 等价 TypeScript 类型 |
| `src/integrity.ts` | `canonicalJson` + `computeIntegrityHash`（integrity_hash 规范序列化） |
| `src/api-contracts.ts` | 控制面 API 合约类型（`ProviderRecord` / `ConnectivityResult` / `ProviderCompatConfig`）——runtime 与 desktop 的唯一真相源（M0 code-review / Issue #11 收敛三处拷贝） |
| `src/index.ts` | 公共出口 |

## 事件信封 v1 字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | :-: | --- |
| `event_id` | uuid **v7** | ✅ | 副本内生成；同步按其幂等去重，全局唯一不复用 |
| `replica_id` | uuid | ✅ | 产生事件的副本（device 或 server） |
| `actor_id` | `"owner"` \| `"contact:<id>"` \| `"agent:<id>"` | ✅ | 事件产生者 |
| `task_id` | uuid \| null |  | 关联任务；非任务事件为 null 或缺省 |
| `session_id` | uuid \| null |  | 关联会话 |
| `event_type` | 小写点分标识（如 `tool.started`） | ✅ | 事件类型清单只增不减 |
| `occurred_at` | RFC 3339 **UTC**（`Z` 结尾） | ✅ | 生产方规范形态为毫秒精度 |
| `causation_id` | uuid \| null |  | 因果链上前置事件 id |
| `schema_version` | 字面量 `1` | ✅ | 见下方演进规则 |
| `payload` | object | ✅ | 按 `event_type` 定义；信封层不约束内部字段 |
| `integrity_hash` | `sha256-<64位小写hex>` | ✅ | 见下方规范序列化规则 |

**外发副作用事件**（如 `channel.message.sent`）在信封上另带三个可选字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `idempotency_key` | 非空 string | 渠道投递幂等键 |
| `receipt` | object | 渠道回执：`channel`（必填）、`remote_message_id?`、`delivered_at?`、`error?` |
| `delivery_unknown` | boolean | `true` 表示已发送但未获确认回执（送达状态未知），此时通常无 `receipt` |

信封层这三个字段为**可选**：是否必填由具体事件族（`channel.*` 等）在各自的包内约束，
避免信封 schema 依赖一个只增不减的事件类型清单。

## integrity_hash 规范序列化规则

1. 取整个信封对象，**剔除 `integrity_hash` 字段本身**；
2. 递归按键名**升序**排序对象键（UTF-16 码元序，即 JS 默认字符串比较）；数组保序；字段一个不删、一个不加；
3. 紧凑输出（无空白）；字符串转义与数字格式遵循 ECMAScript `JSON.stringify` 语义；
   非 ASCII 字符不转义，按 UTF-8 原样输出；
4. 对结果字符串按 UTF-8 取 sha256，输出 `sha256-<64位小写hex>`。

注意：

- 输入必须是 JSON 值。出现 `undefined` / 函数 / `bigint` / `symbol` / `NaN` / `Infinity` 时
  `canonicalJson` **抛错而非静默丢弃**（丢弃会掩盖数据）；
- 其他语言实现（如 Go）必须与上述规则逐字节一致；`test/integrity.test.ts` 用**手工写出的
  规范字面量 + `shasum -a 256` 独立计算的哈希**作锚点，实现退化立即可见；
- 数字序列化遵循 JS shortest-round-trip（IEEE 754），含浮点的 payload 跨语言复算需对齐此语义。

## JSON Schema ⇄ TypeScript 契约方向

- **Schema 是运行时守门员**，比 TS 更严：uuid v7 版本位、时间形态、hash 形态无法用类型表达；
- round-trip 测试保证：**Schema 接受的事件必能赋给 TS 类型**（`test/types.roundtrip.test.ts`，
  由 `tsc --noEmit` 在 `pnpm test` 中强制；非法样例用 `@ts-expect-error` 固定，类型漂移会因
  指令未被命中而报 TS5071）；
- 反方向不保证：TS 类型接受（如 `contact:` 空后缀）不代表 Schema 放行，落盘前必须过 Schema。

## 演进规则（PRD §6.3）

1. **只加字段不删改**：v1 生命周期内只允许新增字段，且新增字段必须可选、不得改变既有字段
   语义或校验约束（任何会让旧事件变红的收紧都是破坏性变更）；
2. **破坏性变更必须升 `schema_version`**：新增 `schema/event-envelope.v2.schema.json`
   （`schema_version` 锁 `const: 2`），v1 文件除加字段外永不修改；校验方按事件携带的
   `schema_version` 选择对应 schema 文档；
3. **已写入事件永不重写**：事件是不可变的 append-only 记录，`integrity_hash` 落盘后不得重算；
   纠错一律通过新事件（`causation_id` 指向被纠正事件）补偿，禁止原地改写。

## 测试

```bash
pnpm --filter @morrow/protocol test
```

等价于 `tsc --noEmit && node --test --experimental-strip-types "test/*.test.ts"`。

测试框架选了 Node 内置 `node:test` 而非 vitest：本包是纯数据契约（类型 + JSON + 纯函数），
零运行时依赖是目标；`node --test --experimental-strip-types` 直接跑 TS 源文件，免构建步骤，
devDependencies 仅 `typescript`（编译期契约）、`ajv`（测试中充当 Schema 校验器）与 `@types/node`。
TS 语法限定在可擦除子集（无 enum / namespace / 参数属性）以配合 type stripping。
