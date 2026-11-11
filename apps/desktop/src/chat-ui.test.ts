import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSendError } from "./chat-ui.ts";

test("provider_not_configured：给出可读标题与设置页入口", () => {
  const view = describeSendError(
    "provider_not_configured",
    "no model provider configured (register one via POST /v1/providers or set MORROW_PROVIDER_BASE_URL / MORROW_PROVIDER_API_KEY / MORROW_PROVIDER_MODEL)",
  );
  assert.equal(view.title, "尚未配置模型 Provider");
  assert.equal(view.openSettings, true);
  assert.match(view.detail, /no model provider configured/);
});

test("其他错误不显示设置入口，标题按错误码翻译", () => {
  assert.equal(describeSendError("not_found", "session missing").openSettings, false);
  assert.equal(describeSendError("not_found", "session missing").title, "会话不存在");
  assert.equal(describeSendError("unknown_code", "boom").title, "请求失败");
  assert.equal(describeSendError("http_503", "busy").title, "Runtime 拒绝服务");
});
