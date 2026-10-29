/**
 * @morrow/protocol 公共出口。
 * JSON Schema（跨语言真相源）与 TS 类型（创作期形态）由此一并导出。
 */
export type {
  ActorId,
  ChannelReceipt,
  EventEnvelope,
  SchemaVersion,
} from "./event-envelope.ts";
export {
  canonicalJson,
  computeIntegrityHash,
  type EventEnvelopeWithoutHash,
} from "./integrity.ts";
export { default as eventEnvelopeSchema } from "../schema/event-envelope.schema.json" with { type: "json" };
