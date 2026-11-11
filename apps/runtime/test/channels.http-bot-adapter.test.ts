// HTTP Bot 骨架表驱动测试（Issue #49）：同一断言模板跑飞书/QQ 两套错误码表，
// 锁住「平台响应 → 统一类别」的映射与平台错误类 → ChannelSendError 的 retryable 语义。
// 这张表是重构的行为安全网：顺序（如 QQ proactive 先于 permission、飞书相反）、
// 文案、httpStatus、业务码与 Retry-After 都必须与重构前逐项一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySendFailure,
  type BotErrorCategory,
  type BotPlatformError,
  type BotPlatformErrorOptions,
  type SendErrorRule,
  type SendFailureContext,
} from "../src/channels/adapters/shared/error-catalog.ts";
import {
  FeishuError,
  FEISHU_SEND_ERROR_RULES,
  type FeishuErrorCategory,
} from "../src/channels/adapters/feishu/errors.ts";
import { QqError, QQ_SEND_ERROR_RULES, type QqErrorCategory } from "../src/channels/adapters/qq/errors.ts";

interface ExpectedFailure {
  category: BotErrorCategory;
  message: string;
  httpStatus: number;
  code?: number;
  retryAfterSeconds?: number;
}

interface MappingCase {
  response: {
    status: number;
    code?: number;
    message?: string;
    retryAfterSeconds?: number | null;
  };
  proactive?: boolean;
  /** null = 平台已受理（分类结果必须为 null） */
  expect: ExpectedFailure | null;
}

/** 同一断言模板：给定平台规则表与用例，逐项核对分类结果 */
function assertMapping(
  platform: string,
  rules: readonly SendErrorRule[],
  cases: readonly MappingCase[],
): void {
  for (const [index, testCase] of cases.entries()) {
    const context: SendFailureContext = {
      httpStatus: testCase.response.status,
      code: testCase.response.code,
      platformMessage: testCase.response.message,
      proactive: testCase.proactive ?? false,
      retryAfterSeconds: testCase.response.retryAfterSeconds ?? null,
    };
    const actual = classifySendFailure(rules, context);
    const at = `${platform} case #${index} (${JSON.stringify(testCase.response)})`;

    if (testCase.expect === null) {
      assert.equal(actual, null, `${at}: 平台受理不应产生错误类别`);
      continue;
    }
    assert.ok(actual !== null, `${at}: 未命中任何错误类别`);
    assert.equal(actual.category, testCase.expect.category, `${at}: category`);
    assert.equal(actual.message, testCase.expect.message, `${at}: message`);
    assert.equal(actual.httpStatus, testCase.expect.httpStatus, `${at}: httpStatus`);
    assert.equal(actual.code, testCase.expect.code, `${at}: code`);
    assert.equal("code" in actual, testCase.expect.code !== undefined, `${at}: code 字段存在性`);
    assert.equal(actual.retryAfterSeconds, testCase.expect.retryAfterSeconds, `${at}: retryAfter`);
    assert.equal(
      "retryAfterSeconds" in actual,
      testCase.expect.retryAfterSeconds !== undefined,
      `${at}: retryAfter 字段存在性`,
    );
  }
}

test("错误码映射：同一断言模板跑飞书/QQ 两套码表", () => {
  assertMapping("feishu", FEISHU_SEND_ERROR_RULES, [
    // 平台受理：code=0 且 2xx
    { response: { status: 200, code: 0, message: "success" }, expect: null },
    { response: { status: 200, code: 0, message: "success" }, proactive: true, expect: null },
    // 飞书缺 code 也算失败（code !== 0）
    {
      response: { status: 200 },
      expect: { category: "bad_request", message: "feishu responded 200", httpStatus: 200 },
    },
    // 429 优先于一切；文案固定拼 Retry-After，不带业务码
    {
      response: { status: 429, code: 99991400, message: "too many request", retryAfterSeconds: 2 },
      expect: {
        category: "rate_limited",
        message: "feishu rate limited (retry-after 2s)",
        httpStatus: 429,
        retryAfterSeconds: 2,
      },
    },
    {
      response: { status: 429 },
      expect: {
        category: "rate_limited",
        message: "feishu rate limited (retry-after 1s)",
        httpStatus: 429,
        retryAfterSeconds: 1,
      },
    },
    // 401 / token 业务码 → token_invalid（先于 403 判定）
    {
      response: { status: 401, code: 99991663, message: "invalid or expired tenant_access_token" },
      expect: {
        category: "token_invalid",
        message: "invalid or expired tenant_access_token",
        httpStatus: 401,
        code: 99991663,
      },
    },
    {
      response: { status: 403, code: 99991663, message: "token invalid" },
      expect: { category: "token_invalid", message: "token invalid", httpStatus: 403, code: 99991663 },
    },
    {
      response: { status: 200, code: 99991668, message: "tenant access token expired" },
      expect: {
        category: "token_invalid",
        message: "tenant access token expired",
        httpStatus: 200,
        code: 99991668,
      },
    },
    // 403 → permission_denied（飞书 permission 先于 proactive）
    {
      response: { status: 403, code: 230001, message: "permission denied (injected)" },
      proactive: true,
      expect: {
        category: "permission_denied",
        message: "permission denied (injected)",
        httpStatus: 403,
        code: 230001,
      },
    },
    // 主动消息业务码仅在 proactive=true 时归 proactive_limited
    {
      response: { status: 400, code: 230001, message: "proactive message not allowed in this scene" },
      proactive: true,
      expect: {
        category: "proactive_limited",
        message: "proactive message not allowed in this scene",
        httpStatus: 400,
        code: 230001,
      },
    },
    {
      response: { status: 400, code: 230001, message: "proactive message not allowed in this scene" },
      proactive: false,
      expect: {
        category: "bad_request",
        message: "proactive message not allowed in this scene",
        httpStatus: 400,
        code: 230001,
      },
    },
    // 其余非 2xx / 非 0 业务码 → bad_request
    {
      response: { status: 500, message: "boom" },
      expect: { category: "bad_request", message: "boom", httpStatus: 500 },
    },
    {
      response: { status: 400, code: 10003, message: "app_id or app_secret invalid" },
      expect: {
        category: "bad_request",
        message: "app_id or app_secret invalid",
        httpStatus: 400,
        code: 10003,
      },
    },
  ]);

  assertMapping("qq", QQ_SEND_ERROR_RULES, [
    // QQ 允许响应体不带 code
    { response: { status: 200, code: 0 }, expect: null },
    { response: { status: 200 }, expect: null },
    { response: { status: 200, code: 0 }, proactive: true, expect: null },
    // HTTP 429 与限流业务码（含 504000~504999 区间）→ rate_limited
    {
      response: { status: 429, retryAfterSeconds: 2 },
      expect: {
        category: "rate_limited",
        message: "qq rate limited (retry-after 2s)",
        httpStatus: 429,
        retryAfterSeconds: 2,
      },
    },
    {
      response: { status: 200, code: 504001 },
      expect: {
        category: "rate_limited",
        message: "qq rate limited (retry-after 1s)",
        httpStatus: 200,
        code: 504001,
        retryAfterSeconds: 1,
      },
    },
    {
      response: { status: 200, code: 20028, message: "频率限制" },
      expect: { category: "rate_limited", message: "频率限制", httpStatus: 200, code: 20028, retryAfterSeconds: 1 },
    },
    // 429 优先于 proactive（主动消息限频仍按限流退避重试）
    {
      response: { status: 429, code: 304046, retryAfterSeconds: 5 },
      proactive: true,
      expect: {
        category: "rate_limited",
        message: "qq rate limited (retry-after 5s)",
        httpStatus: 429,
        code: 304046,
        retryAfterSeconds: 5,
      },
    },
    // 401 / token 业务码 → token_invalid
    {
      response: { status: 401, message: "token invalid" },
      expect: { category: "token_invalid", message: "token invalid", httpStatus: 401 },
    },
    {
      response: { status: 200, code: 11242, message: "token 校验失败" },
      expect: { category: "token_invalid", message: "token 校验失败", httpStatus: 200, code: 11242 },
    },
    // 主动消息拒绝码（含真实平台 40034105）→ proactive_rejected，且必须先于 permission
    {
      response: { status: 400, code: 304046, message: "不允许在此子频道发主动消息" },
      proactive: true,
      expect: {
        category: "proactive_rejected",
        message: "不允许在此子频道发主动消息",
        httpStatus: 400,
        code: 304046,
      },
    },
    {
      response: { status: 400, code: 40034105, message: "主动消息失败, 无权限" },
      proactive: true,
      expect: {
        category: "proactive_rejected",
        message: "主动消息失败, 无权限",
        httpStatus: 400,
        code: 40034105,
      },
    },
    // 文案兜底：码表之外但文案命中主动消息关键词
    {
      response: { status: 200, message: "active message limit reached" },
      proactive: true,
      expect: {
        category: "proactive_rejected",
        message: "active message limit reached",
        httpStatus: 200,
      },
    },
    // 同一码/文案在非主动场景不得归 proactive
    {
      response: { status: 400, code: 304046, message: "不允许在此子频道发主动消息" },
      proactive: false,
      expect: {
        category: "bad_request",
        message: "不允许在此子频道发主动消息",
        httpStatus: 400,
        code: 304046,
      },
    },
    {
      response: { status: 400, code: 40034105, message: "主动消息失败, 无权限" },
      proactive: false,
      expect: {
        category: "bad_request",
        message: "主动消息失败, 无权限",
        httpStatus: 400,
        code: 40034105,
      },
    },
    // 403 与权限业务码 → permission_denied；业务码命中时错误对象固定报 403
    {
      response: { status: 403, message: "forbidden" },
      expect: { category: "permission_denied", message: "forbidden", httpStatus: 403 },
    },
    {
      response: { status: 200, code: 11264, message: "频道权限未授权" },
      expect: { category: "permission_denied", message: "频道权限未授权", httpStatus: 403, code: 11264 },
    },
    // 其余非 2xx / 非 0 业务码 → bad_request
    {
      response: { status: 400, code: 123, message: "bad request" },
      expect: { category: "bad_request", message: "bad request", httpStatus: 400, code: 123 },
    },
    {
      response: { status: 500, message: "boom" },
      expect: { category: "bad_request", message: "boom", httpStatus: 500 },
    },
  ]);
});

interface ErrorPolicyCase<C extends string> {
  category: C;
  kind: "explicit" | "network" | "timeout";
  retryable: boolean;
  retryAfterSeconds?: number;
}

/** 同一断言模板：平台错误类 → ChannelSendError 的类别/kind/retryable/文案 */
function assertErrorPolicy<C extends string>(
  platform: string,
  cases: readonly ErrorPolicyCase<C>[],
  create: (options: BotPlatformErrorOptions<C>) => BotPlatformError<C>,
): void {
  for (const testCase of cases) {
    const error = create({
      category: testCase.category,
      message: "boom",
      ...(testCase.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: testCase.retryAfterSeconds }),
    });
    const send = error.toSendError();
    assert.equal(send.kind, testCase.kind, `${platform} ${testCase.category}: kind`);
    assert.equal(send.code, testCase.category, `${platform} ${testCase.category}: code`);
    assert.equal(send.retryable, testCase.retryable, `${platform} ${testCase.category}: retryable`);
    assert.equal(
      send.retry_after_seconds,
      testCase.retryAfterSeconds,
      `${platform} ${testCase.category}: retry_after_seconds`,
    );
    assert.equal(
      send.message,
      `${platform} ${testCase.category}: boom`,
      `${platform} ${testCase.category}: message 前缀`,
    );
  }
}

test("平台错误类 → ChannelSendError：两平台的类别/retryable/文案策略不变", () => {
  assertErrorPolicy<FeishuErrorCategory>(
    "feishu",
    [
      { category: "token_invalid", kind: "explicit", retryable: true },
      { category: "rate_limited", kind: "explicit", retryable: true, retryAfterSeconds: 3 },
      { category: "permission_denied", kind: "explicit", retryable: true },
      { category: "proactive_limited", kind: "explicit", retryable: true },
      { category: "bad_request", kind: "explicit", retryable: true },
      { category: "platform", kind: "explicit", retryable: true },
      { category: "unsupported_attachment", kind: "explicit", retryable: false },
      { category: "network", kind: "network", retryable: false },
      { category: "timeout", kind: "timeout", retryable: false },
    ],
    (options) => new FeishuError(options),
  );

  assertErrorPolicy<QqErrorCategory>(
    "qq",
    [
      { category: "token_invalid", kind: "explicit", retryable: true },
      { category: "rate_limited", kind: "explicit", retryable: true, retryAfterSeconds: 3 },
      { category: "permission_denied", kind: "explicit", retryable: true },
      { category: "bad_request", kind: "explicit", retryable: true },
      { category: "platform", kind: "explicit", retryable: true },
      // 三类 explicit 但不可重试：主动消息被拒、出站附件未实现、未知会话形态
      { category: "proactive_rejected", kind: "explicit", retryable: false },
      { category: "unsupported_attachment", kind: "explicit", retryable: false },
      { category: "unknown_conversation", kind: "explicit", retryable: false },
      { category: "network", kind: "network", retryable: false },
      { category: "timeout", kind: "timeout", retryable: false },
    ],
    (options) => new QqError(options),
  );
});
