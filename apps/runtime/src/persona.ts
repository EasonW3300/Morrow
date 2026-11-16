import {
  DEFAULT_PERSONA,
  PERSONA_LIMITS,
  type Persona,
} from "@morrow/protocol";
import { buildEventEnvelope } from "./envelope.ts";
import type { EventLedger } from "./ledger.ts";

/**
 * 全局 Persona（票 M7-A-T1 / Issue #58，ADR-0009）：
 *
 * - **持久化**：每次保存写 `persona.updated` 事件（actor=owner，payload=全量 Persona），
 *   随账本同步传播；读取走内存缓存（以最近事件 id 为键，跨设备同步导入后自动失效）。
 * - **拼装**：固定顺序 名字 → 语气 → 职责 → 禁止 → 其他（顺序不可配置）。ADR-0009
 *   的缓存前缀稳定性依赖这个顺序：调整顺序会让所有既有会话的 KV 缓存失效。
 * - **注入**：会话 system prompt 与记忆抽取器提示词；不注入任务规划器（后者要求严格
 *   JSON 输出）。
 *
 * 校验上限见 protocol 的 PERSONA_LIMITS（桌面表单共用同一份常量）。服务端仍是权威：
 * 非法输入一律 400 invalid_persona，不静默截断或丢弃字段。
 */

export { DEFAULT_PERSONA, PERSONA_LIMITS };
export type { Persona };

/** Persona 事件族（清单只增不减） */
export const PERSONA_EVENT_TYPES = {
  updated: "persona.updated",
} as const;

/** 校验失败（HTTP 层映射 400 invalid_persona） */
export class PersonaValidationError extends Error {
  readonly code = "invalid_persona";

  constructor(message: string) {
    super(message);
    this.name = "PersonaValidationError";
  }
}

export type PersonaParseResult =
  | { ok: true; persona: Persona }
  | { ok: false; code: "invalid_persona"; message: string };

/**
 * 解析并规范化 Persona 请求体：
 * - 缺省字段回落到默认值（PUT 允许只提交部分字段；GET 恒返回全量）；
 * - 字符串去首尾空白；职责/禁止清单去空白项；
 * - 空名字、超长、类型不符 → 拒绝（不截断）。
 */
export function parsePersona(raw: unknown): PersonaParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "invalid_persona", message: "persona must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;

  const name = readString(record.name, "name", DEFAULT_PERSONA.name);
  if (!name.ok) return name;
  if (name.value.length === 0) {
    return { ok: false, code: "invalid_persona", message: "name must be a non-empty string" };
  }
  if (name.value.length > PERSONA_LIMITS.name) {
    return {
      ok: false,
      code: "invalid_persona",
      message: `name must be at most ${PERSONA_LIMITS.name} characters`,
    };
  }

  const tone = readString(record.tone, "tone", DEFAULT_PERSONA.tone);
  if (!tone.ok) return tone;
  if (tone.value.length > PERSONA_LIMITS.tone) {
    return {
      ok: false,
      code: "invalid_persona",
      message: `tone must be at most ${PERSONA_LIMITS.tone} characters`,
    };
  }

  const responsibilities = readStringList(
    record.responsibilities,
    "responsibilities",
    DEFAULT_PERSONA.responsibilities,
    PERSONA_LIMITS.responsibilities,
    PERSONA_LIMITS.responsibilityItem,
  );
  if (!responsibilities.ok) return responsibilities;

  const prohibitions = readStringList(
    record.prohibitions,
    "prohibitions",
    DEFAULT_PERSONA.prohibitions,
    PERSONA_LIMITS.prohibitions,
    PERSONA_LIMITS.prohibitionItem,
  );
  if (!prohibitions.ok) return prohibitions;

  const extra = readString(record.extra, "extra", DEFAULT_PERSONA.extra);
  if (!extra.ok) return extra;
  if (extra.value.length > PERSONA_LIMITS.extra) {
    return {
      ok: false,
      code: "invalid_persona",
      message: `extra must be at most ${PERSONA_LIMITS.extra} characters`,
    };
  }

  return {
    ok: true,
    persona: {
      name: name.value,
      tone: tone.value,
      responsibilities: responsibilities.value,
      prohibitions: prohibitions.value,
      extra: extra.value,
    },
  };
}

/**
 * 固定顺序拼装：名字 → 语气 → 职责 → 禁止 → 其他。
 * 空的可选段落省略（不输出空标题），但已有段落顺序恒定——单测锁定，改顺序即红。
 */
export function composePersonaPrompt(persona: Persona): string {
  const lines: string[] = [`名字：${persona.name}`, `语气：${persona.tone}`];
  if (persona.responsibilities.length > 0) {
    lines.push("职责：", ...persona.responsibilities.map((item) => `- ${item}`));
  }
  if (persona.prohibitions.length > 0) {
    lines.push("禁止行为：", ...persona.prohibitions.map((item) => `- ${item}`));
  }
  if (persona.extra.trim().length > 0) {
    lines.push("其他设定：", persona.extra.trim());
  }
  return lines.join("\n");
}

export interface PersonaUpdateResult {
  persona: Persona;
  eventId: string;
  sequence: number;
  occurredAt: string;
}

export interface PersonaServiceOptions {
  ledger: EventLedger;
  replicaId: string;
}

/**
 * Persona 读写服务：账本是唯一真相源，内存缓存以「最近事件 id」为键。
 * 同步导入对端 `persona.updated` 后，下一次 get() 会因事件 id 变化自动重读。
 */
export class PersonaService {
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  #cached: { eventId: string | null; persona: Persona } | null = null;

  constructor(options: PersonaServiceOptions) {
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
  }

  /** 当前人设：无事件或事件不可解析 → 默认值（缺省即默认，不是错误） */
  get(): Persona {
    const latest = this.#latest();
    const eventId = latest?.envelope.event_id ?? null;
    if (this.#cached === null || this.#cached.eventId !== eventId) {
      const parsed = latest === null ? null : parsePersona(latest.envelope.payload);
      if (parsed !== null && !parsed.ok) {
        console.warn(`[morrow] ignoring malformed persona.updated event ${latest?.envelope.event_id}: ${parsed.message}`);
      }
      this.#cached = {
        eventId,
        persona: parsed !== null && parsed.ok ? parsed.persona : clonePersona(DEFAULT_PERSONA),
      };
    }
    return clonePersona(this.#cached.persona);
  }

  /** 校验并保存：写 `persona.updated`（actor=owner，payload=全量 Persona）。 */
  update(raw: unknown): PersonaUpdateResult {
    const parsed = parsePersona(raw);
    if (!parsed.ok) throw new PersonaValidationError(parsed.message);
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "owner",
      eventType: PERSONA_EVENT_TYPES.updated,
      payload: { ...clonePersona(parsed.persona) },
    });
    const { sequence } = this.#ledger.append(envelope);
    this.#cached = { eventId: envelope.event_id, persona: clonePersona(parsed.persona) };
    return {
      persona: clonePersona(parsed.persona),
      eventId: envelope.event_id,
      sequence,
      occurredAt: envelope.occurred_at,
    };
  }

  #latest(): { envelope: import("@morrow/protocol").EventEnvelope } | null {
    const events = this.#ledger.scan({ eventType: PERSONA_EVENT_TYPES.updated });
    return events.length === 0 ? null : events[events.length - 1] ?? null;
  }
}

function clonePersona(persona: Persona): Persona {
  return {
    name: persona.name,
    tone: persona.tone,
    responsibilities: [...persona.responsibilities],
    prohibitions: [...persona.prohibitions],
    extra: persona.extra,
  };
}

type StringResult = { ok: true; value: string } | { ok: false; code: "invalid_persona"; message: string };

function readString(raw: unknown, field: string, fallback: string): StringResult {
  if (raw === undefined) return { ok: true, value: fallback };
  if (typeof raw !== "string") {
    return { ok: false, code: "invalid_persona", message: `${field} must be a string` };
  }
  return { ok: true, value: raw.trim() };
}

type StringListResult =
  | { ok: true; value: string[] }
  | { ok: false; code: "invalid_persona"; message: string };

function readStringList(
  raw: unknown,
  field: string,
  fallback: string[],
  maxItems: number,
  maxItemLength: number,
): StringListResult {
  if (raw === undefined) return { ok: true, value: [...fallback] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: "invalid_persona", message: `${field} must be an array of strings` };
  }
  if (raw.length > maxItems) {
    return { ok: false, code: "invalid_persona", message: `${field} must have at most ${maxItems} items` };
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      return { ok: false, code: "invalid_persona", message: `${field} must contain only strings` };
    }
    const value = item.trim();
    if (value.length === 0) {
      return { ok: false, code: "invalid_persona", message: `${field} must not contain empty items` };
    }
    if (value.length > maxItemLength) {
      return {
        ok: false,
        code: "invalid_persona",
        message: `${field} items must be at most ${maxItemLength} characters`,
      };
    }
    out.push(value);
  }
  return { ok: true, value: out };
}
