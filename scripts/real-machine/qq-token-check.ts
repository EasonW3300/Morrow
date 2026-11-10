/**
 * QQ 官方 Bot 真实凭据连通性检查（M4-T4 外部联调第一层）。
 *
 * 只做一件事：用 Keychain 里的 AppID/AppSecret 换取 access token，确认
 *   ① 凭据有效  ② 端点可达  ③ 返回结构符合适配器预期
 * 不做消息收发（那需要先收到一条入站事件拿到 group_openid/user_openid）。
 *
 * 用法：node --experimental-strip-types scripts/real-machine/qq-token-check.ts
 * 凭据来源：macOS Keychain service=channel:qq account=app_id|app_secret
 */
import { createKeychainStore } from "../../apps/runtime/src/keyring.ts";

const CANDIDATES = [
  "https://bots.qq.com/app/getAppAccessToken",
  "https://api.bot.qq.com/app/getAppAccessToken",
  "https://api.sgroup.qq.com/app/getAppAccessToken",
];

async function main(): Promise<void> {
  const store = createKeychainStore();
  const appId = await store.getSecret("channel:qq", "app_id");
  const appSecret = await store.getSecret("channel:qq", "app_secret");
  if (!appId || !appSecret) {
    console.error("[qq-check] 缺少凭据：channel:qq/app_id 或 app_secret 未在 Keychain 中找到");
    process.exit(2);
  }
  console.log(`[qq-check] 凭据已读取（app_id 长度 ${appId.length}，secret 长度 ${appSecret.length}）`);

  let anyOk = false;
  for (const url of CANDIDATES) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
        signal: AbortSignal.timeout(15_000),
      });
      const elapsed = Date.now() - started;
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // 非 JSON（网关错误页等）
      }
      const token = typeof body.access_token === "string" ? body.access_token : null;
      const expires = body.expires_in ?? null;
      const code = body.code ?? null;
      const message = body.message ?? body.msg ?? null;
      console.log(
        `[qq-check] ${url}\n           HTTP ${res.status} (${elapsed}ms) token=${token === null ? "null" : `长度 ${token.length}`} expires_in=${String(expires)} code=${String(code)} message=${String(message)}`,
      );
      if (token !== null && token.length > 0) anyOk = true;
      if (token === null && res.status >= 400) {
        console.log(`[qq-check] 响应摘要：${text.slice(0, 300).replace(/\s+/g, " ")}`);
      }
    } catch (err) {
      const elapsed = Date.now() - started;
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.log(`[qq-check] ${url}\n           FAILED (${elapsed}ms) ${reason}`);
    }
  }

  console.log(anyOk ? "[qq-check] 结论：凭据可用（至少一个端点返回 access_token）" : "[qq-check] 结论：未取得 access_token（见上方诊断）");
  process.exit(anyOk ? 0 : 1);
}

await main();
