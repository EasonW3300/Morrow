import { DEFAULT_PERSONA, PERSONA_LIMITS, type Persona } from "@morrow/protocol/browser";

/**
 * Persona 设置页的纯逻辑（票 M7-A-T1 / Issue #58）：表单校验、表单 ↔ Persona 映射、
 * 保存前确认弹窗的状态机与影响文案。
 *
 * 校验上限直接复用 @morrow/protocol 的 PERSONA_LIMITS（与服务端同一真相源）；客户端先
 * 挡一层，服务端 400 invalid_persona 仍是权威。职责/禁止行为在表单里是多行文本，
 * 每行一条；空行丢弃。
 *
 * 无 DOM 依赖——node:test 直接跑（与 provider-form.ts 同款约定）。
 */

export interface PersonaFormValues {
  name: string;
  tone: string;
  /** 每行一条职责 */
  responsibilities: string;
  /** 每行一条禁止行为 */
  prohibitions: string;
  /** 其他自由设定 */
  extra: string;
}

export type PersonaFormErrors = Partial<Record<keyof PersonaFormValues, string>>;

/** 多行文本 → 列表：逐行 trim、丢弃空行。 */
export function splitPersonaLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 已保存 Persona → 表单（列表按行展开）。缺省用默认人设。 */
export function personaToForm(persona: Persona = DEFAULT_PERSONA): PersonaFormValues {
  return {
    name: persona.name,
    tone: persona.tone,
    responsibilities: persona.responsibilities.join("\n"),
    prohibitions: persona.prohibitions.join("\n"),
    extra: persona.extra,
  };
}

/** 表单 → PUT payload（trim；空行丢弃）。合法与否由 validatePersonaForm 先判定。 */
export function formToPersona(values: PersonaFormValues): Persona {
  return {
    name: values.name.trim(),
    tone: values.tone.trim(),
    responsibilities: splitPersonaLines(values.responsibilities),
    prohibitions: splitPersonaLines(values.prohibitions),
    extra: values.extra.trim(),
  };
}

/** 表单校验：与服务端 parsePersona 的边界一致；返回空对象 = 通过。 */
export function validatePersonaForm(values: PersonaFormValues): PersonaFormErrors {
  const errors: PersonaFormErrors = {};

  const name = values.name.trim();
  if (name.length === 0) {
    errors.name = "名字必填";
  } else if (name.length > PERSONA_LIMITS.name) {
    errors.name = `名字最多 ${PERSONA_LIMITS.name} 个字符`;
  }

  if (values.tone.length > PERSONA_LIMITS.tone) {
    errors.tone = `语气最多 ${PERSONA_LIMITS.tone} 个字符`;
  }

  const responsibilities = splitPersonaLines(values.responsibilities);
  if (responsibilities.length > PERSONA_LIMITS.responsibilities) {
    errors.responsibilities = `职责最多 ${PERSONA_LIMITS.responsibilities} 条`;
  } else if (responsibilities.some((item) => item.length > PERSONA_LIMITS.responsibilityItem)) {
    errors.responsibilities = `每条职责最多 ${PERSONA_LIMITS.responsibilityItem} 个字符`;
  }

  const prohibitions = splitPersonaLines(values.prohibitions);
  if (prohibitions.length > PERSONA_LIMITS.prohibitions) {
    errors.prohibitions = `禁止行为最多 ${PERSONA_LIMITS.prohibitions} 条`;
  } else if (prohibitions.some((item) => item.length > PERSONA_LIMITS.prohibitionItem)) {
    errors.prohibitions = `每条禁止行为最多 ${PERSONA_LIMITS.prohibitionItem} 个字符`;
  }

  if (values.extra.length > PERSONA_LIMITS.extra) {
    errors.extra = `其他设定最多 ${PERSONA_LIMITS.extra} 个字符`;
  }

  return errors;
}

// --- 保存前确认：状态机（idle → confirming → saving → saved/error） -----------------

export type PersonaSaveState =
  | { status: "idle"; errors: PersonaFormErrors }
  | { status: "confirming"; persona: Persona; sessionCount: number }
  | { status: "saving"; persona: Persona; sessionCount: number }
  | { status: "saved"; persona: Persona }
  | { status: "error"; persona: Persona; message: string };

export type PersonaSaveAction =
  /** 点「保存」：先校验；通过则进入确认（带上受影响会话数），不通过停留 idle 并给字段错误 */
  | { type: "submit"; values: PersonaFormValues; sessionCount: number }
  /** 确认弹窗取消：不写任何东西 */
  | { type: "cancel" }
  /** 确认弹窗确认：进入 saving，调用方随后发 PUT */
  | { type: "confirm" }
  | { type: "saved"; persona: Persona }
  | { type: "failed"; message: string }
  /** 关闭结果提示 / 重新开始 */
  | { type: "reset" };

export const initialPersonaSaveState: PersonaSaveState = { status: "idle", errors: {} };

export function personaSaveReducer(state: PersonaSaveState, action: PersonaSaveAction): PersonaSaveState {
  switch (action.type) {
    case "submit": {
      const errors = validatePersonaForm(action.values);
      if (Object.keys(errors).length > 0) return { status: "idle", errors };
      return { status: "confirming", persona: formToPersona(action.values), sessionCount: action.sessionCount };
    }
    case "cancel":
      return state.status === "confirming" ? initialPersonaSaveState : state;
    case "confirm":
      return state.status === "confirming"
        ? { status: "saving", persona: state.persona, sessionCount: state.sessionCount }
        : state;
    case "saved":
      return state.status === "saving" ? { status: "saved", persona: action.persona } : state;
    case "failed":
      return state.status === "saving" ? { status: "error", persona: state.persona, message: action.message } : state;
    case "reset":
      return initialPersonaSaveState;
  }
}

/** 保存前确认文案（FR-A4）：必须说清受影响会话数与三类后果。 */
export interface PersonaImpactNotice {
  title: string;
  lines: string[];
  confirmLabel: string;
}

export function describePersonaImpact(sessionCount: number): PersonaImpactNotice {
  return {
    title: "保存 Persona 前确认",
    lines: [
      `受影响会话数：${sessionCount} 个既有会话。`,
      "所有既有会话的 KV 缓存前缀会失效。",
      "下一轮请求将按全量 prompt 计费。",
      "历史对话的风格基准会改变。",
    ],
    confirmLabel: "保存并接受影响",
  };
}
