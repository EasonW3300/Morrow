/**
 * 事件信封 v1 的 TypeScript 形态（PRD §6.3）。
 *
 * 与 schema/event-envelope.schema.json 一一对应，由 types.roundtrip 测试保证不漂移：
 * Schema 合法样例必须能赋给这里的类型（schema ⊆ TS），明显非法样例必须不能赋给。
 * 方向约定：Schema 是运行时守门员，比 TS 更严（uuid / 时间 / hash 的形态约束无法用类型表达）。
 */

/** 事件产生者：owner（主人本人）、contact:<联系人id>、agent:<能力id> */
export type ActorId = "owner" | `contact:${string}` | `agent:${string}`;

/** schema_version 字面量；破坏性变更必须升版本并新增 schema 文件（见 README 演进规则） */
export type SchemaVersion = 1;

/** 渠道回执（外发副作用事件携带） */
export interface ChannelReceipt {
  /** 渠道标识，如 feishu / qq-official / wechat-exp */
  channel: string;
  /** 渠道侧消息 id（送达确认时携带） */
  remote_message_id?: string;
  /** 渠道确认送达时间（RFC 3339 UTC，Z 结尾） */
  delivered_at?: string;
  /** 送达失败时的渠道侧原因 */
  error?: string;
}

/** 事件信封 v1 */
export interface EventEnvelope {
  /** UUID v7，副本内生成；同步协议按其幂等去重 */
  event_id: string;
  /** 产生事件的副本（device 或 server）uuid */
  replica_id: string;
  /** 事件产生者 */
  actor_id: ActorId;
  /** 关联任务 id；非任务事件为 null 或缺省 */
  task_id?: string | null;
  /** 关联会话 id；无则为 null 或缺省 */
  session_id?: string | null;
  /** 小写点分事件类型，如 tool.started；清单只增不减 */
  event_type: string;
  /** RFC 3339 UTC，必须 Z 结尾；生产方规范形态为毫秒精度 */
  occurred_at: string;
  /** 因果链上前置事件 id；无则为 null 或缺省 */
  causation_id?: string | null;
  schema_version: SchemaVersion;
  /** 按 event_type 定义的具体负载；信封层不约束内部字段 */
  payload: Record<string, unknown>;
  /** 对除本字段外的整个信封做规范序列化后取 sha256（规则见 README） */
  integrity_hash: string;
  /** 外发副作用幂等键；仅外发副作用事件携带 */
  idempotency_key?: string;
  /** 渠道回执；仅外发副作用事件携带 */
  receipt?: ChannelReceipt;
  /** true 表示已发送但未获得确认回执（送达状态未知），此时通常无 receipt */
  delivery_unknown?: boolean;
}
