/**
 * Persona 设置页纯逻辑测试（票 M7-A-T1 / Issue #58）：表单校验、多行列表映射、
 * 保存前确认状态机与影响文案。无 DOM 依赖，node:test 直接跑。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_PERSONA, PERSONA_LIMITS } from "@morrow/protocol/browser";
import {
  describePersonaImpact,
  formToPersona,
  initialPersonaSaveState,
  personaSaveReducer,
  personaToForm,
  splitPersonaLines,
  validatePersonaForm,
  type PersonaFormValues,
  type PersonaSaveState,
} from "./persona-ui.ts";

const VALID_FORM: PersonaFormValues = {
  name: "小墨",
  tone: "温和但直接",
  responsibilities: "个人助理\n开发助手",
  prohibitions: "不要编造事实",
  extra: "回答先给结论。",
};

test("校验：合法表单通过；名字必填且 ≤40；其余字段超限各自报错", () => {
  assert.deepEqual(validatePersonaForm(VALID_FORM), {});

  assert.equal(validatePersonaForm({ ...VALID_FORM, name: "   " }).name, "名字必填");
  assert.ok(validatePersonaForm({ ...VALID_FORM, name: "x".repeat(PERSONA_LIMITS.name + 1) }).name !== undefined);
  assert.ok(validatePersonaForm({ ...VALID_FORM, tone: "x".repeat(PERSONA_LIMITS.tone + 1) }).tone !== undefined);
  assert.ok(
    validatePersonaForm({ ...VALID_FORM, responsibilities: "x".repeat(PERSONA_LIMITS.responsibilityItem + 1) })
      .responsibilities !== undefined,
  );
  assert.ok(
    validatePersonaForm({
      ...VALID_FORM,
      responsibilities: Array.from({ length: PERSONA_LIMITS.responsibilities + 1 }, () => "x").join("\n"),
    }).responsibilities !== undefined,
  );
  assert.ok(
    validatePersonaForm({ ...VALID_FORM, prohibitions: "x".repeat(PERSONA_LIMITS.prohibitionItem + 1) })
      .prohibitions !== undefined,
  );
  assert.ok(validatePersonaForm({ ...VALID_FORM, extra: "x".repeat(PERSONA_LIMITS.extra + 1) }).extra !== undefined);
});

test("多行文本 ↔ 列表：逐行 trim、空行丢弃；已保存 Persona 可回填表单", () => {
  assert.deepEqual(splitPersonaLines(" a \n\n b \n"), ["a", "b"]);
  assert.deepEqual(formToPersona(VALID_FORM), {
    name: "小墨",
    tone: "温和但直接",
    responsibilities: ["个人助理", "开发助手"],
    prohibitions: ["不要编造事实"],
    extra: "回答先给结论。",
  });

  const form = personaToForm(DEFAULT_PERSONA);
  assert.equal(form.name, "Morrow");
  assert.equal(form.tone, "简洁直接");
  assert.equal(form.responsibilities, "个人助理与开发助手");
  assert.equal(form.prohibitions, "");
  assert.equal(form.extra, "");
});

test("确认弹窗状态机：校验失败停留 idle；通过进入 confirming；取消不保存；确认进入 saving", () => {
  const invalid = personaSaveReducer(initialPersonaSaveState, {
    type: "submit",
    values: { ...VALID_FORM, name: "" },
    sessionCount: 7,
  });
  assert.equal(invalid.status, "idle");
  if (invalid.status === "idle") assert.equal(invalid.errors.name, "名字必填");

  const confirming = personaSaveReducer(initialPersonaSaveState, {
    type: "submit",
    values: VALID_FORM,
    sessionCount: 7,
  });
  assert.equal(confirming.status, "confirming");
  if (confirming.status !== "confirming") return;
  assert.equal(confirming.sessionCount, 7);
  assert.deepEqual(confirming.persona, formToPersona(VALID_FORM));

  const cancelled = personaSaveReducer(confirming, { type: "cancel" });
  assert.deepEqual(cancelled, initialPersonaSaveState);

  const saving = personaSaveReducer(confirming, { type: "confirm" });
  assert.equal(saving.status, "saving");
  const saved = personaSaveReducer(saving, { type: "saved", persona: formToPersona(VALID_FORM) });
  assert.equal(saved.status, "saved");

  const failed = personaSaveReducer(saving, { type: "failed", message: "网络错误" });
  assert.equal(failed.status, "error");
  if (failed.status === "error") assert.equal(failed.message, "网络错误");
});

test("确认文案列出受影响会话数与三类后果（缓存前缀/计费/风格基准）", () => {
  const notice = describePersonaImpact(12);
  const text = [notice.title, ...notice.lines].join("\n");
  assert.ok(text.includes("12"));
  assert.ok(text.includes("受影响会话数"));
  assert.ok(text.includes("KV 缓存前缀会失效"));
  assert.ok(text.includes("按全量 prompt 计费"));
  assert.ok(text.includes("历史对话的风格基准会改变"));
});

test("状态机不允许跳过确认直接保存", () => {
  const idle: PersonaSaveState = initialPersonaSaveState;
  assert.equal(personaSaveReducer(idle, { type: "confirm" }).status, "idle");
  assert.equal(personaSaveReducer(idle, { type: "saved", persona: DEFAULT_PERSONA }).status, "idle");
});
