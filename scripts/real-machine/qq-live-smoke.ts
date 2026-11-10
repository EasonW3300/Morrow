#!/usr/bin/env node
/**
 * QQ 官方 Bot 真机联调冒烟（M4-T4 / Issue #41）。
 *
 * 走真实 WebSocket 网关（不是 Webhook，Runtime 不需要公网回调地址）：
 *   Keychain 读凭据 → access token → GET /gateway → wss 连接 → Hello/Identify →
 *   打印收到的每个群 @ / 单聊事件；可选 `--reply` 验证完整回环。
 *
 * 前置（macOS Keychain，服务名 channel:qq）：
 *   security add-generic-password -s "channel:qq" -a app_id -w '<AppID>'
 *   security add-generic-password -s "channel:qq" -a app_secret -w '<AppSecret>'
 *
 * 用法：
 *   export PATH="/opt/homebrew/bin:$PATH"
 *   node --experimental-strip-types scripts/real-machine/qq-live-smoke.ts [--seconds 60]
 *   node --experimental-strip-types scripts/real-machine/qq-live-smoke.ts --reply "收到，我在" --seconds 120
 *
 * 参数：
 *   --reply "文本"   收到**群 @ 消息**时用回复 API 回一条（验证完整回环）；缺省只观察
 *   --seconds N      超时退出秒数（默认 60）；退出打印事件计数与 health
 *
 * 安全：只读 Keychain；绝不打印 app_secret / access_token。真实事件需要用户（或群成员）
 * 在 QQ 里 @ 机器人；机器人未 @ 的群消息平台不会投递。
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  QqChannelAdapter,
  QqWebSocketTransport,
  loadQqConfig,
  type QqConfig,
} from "../../apps/runtime/src/channels/adapters/qq/index.ts";
import type { SecretStore } from "../../apps/runtime/src/keyring.ts";
import { isParseError } from "../../apps/runtime/src/channels/types.ts";
import { parseQqInbound } from "../../apps/runtime/src/channels/adapters/qq/events.ts";

const ACCOUNT = "qq-live";

const { values } = parseArgs({
  options: {
    reply: { type: "string" },
    seconds: { type: "string", default: "60" },
    help: { type: "boolean", default: false },
  },
});

if (values.help === true) {
  console.log(
    [
      "用法: node --experimental-strip-types scripts/real-machine/qq-live-smoke.ts [--reply 文本] [--seconds N]",
      "",
      "  --reply 文本   收到群 @ 消息时回复该文本（缺省只观察）",
      "  --seconds N    超时退出秒数（默认 60）",
      "",
      "凭据：macOS Keychain 的 channel:qq / app_id、app_secret。",
    ].join("\n"),
  );
  process.exit(0);
}

const replyText = values.reply ?? null;
const seconds = Number(values.seconds ?? "60");
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error(`[qq] invalid --seconds: ${values.seconds}`);
  process.exit(2);
}

/** 只读本机 Keychain 的最小 SecretStore 适配（不写入、不落盘）。 */
function keychainSecretStore(): SecretStore {
  return {
    async getSecret(service: string, account: string): Promise<string | null> {
      try {
        const value = execFileSync(
          "security",
          ["find-generic-password", "-s", service, "-a", account, "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        return value.length === 0 ? null : value;
      } catch {
        return null;
      }
    },
    async setSecret(): Promise<void> {
      throw new Error("qq-live-smoke: SecretStore is read-only");
    },
    async deleteSecret(): Promise<void> {
      throw new Error("qq-live-smoke: SecretStore is read-only");
    },
  };
}

function summarize(text: string, max = 40): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

async function main(): Promise<void> {
  let config: QqConfig;
  try {
    config = await loadQqConfig(keychainSecretStore());
  } catch (err) {
    console.error(
      `[qq] 读取 Keychain 凭据失败：${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      '提示: security add-generic-password -s "channel:qq" -a app_id -w "<AppID>"（app_secret 同理）',
    );
    process.exit(2);
  }

  const transport = new QqWebSocketTransport({
    apiBaseUrl: "https://api.sgroup.qq.com",
    onReady: () => {
      console.log(`[qq] READY account=${ACCOUNT} app_id=${config.appId} (Hello + Identify 已发送)`);
    },
  });
  const adapter = new QqChannelAdapter({
    accountId: ACCOUNT,
    config,
    apiBaseUrl: "https://api.sgroup.qq.com",
    eventTransport: transport,
  });

  let events = 0;
  let rejected = 0;
  let replies = 0;
  let finished = false;

  const finish = async (reason: string): Promise<void> => {
    if (finished) return;
    finished = true;
    try {
      await adapter.stop();
      const health = await adapter.health();
      console.log(`[qq] exit (${reason}) events=${events} rejected=${rejected} replies=${replies}`);
      console.log(JSON.stringify({ events, rejected, replies, health }, null, 2));
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void finish("SIGINT"));
  process.on("SIGTERM", () => void finish("SIGTERM"));

  await adapter.start({
    accountId: ACCOUNT,
    onInbound: (raw) => {
      events += 1;
      const event = raw as Record<string, unknown>;
      const parsed = parseQqInbound(event, { accountId: ACCOUNT, botOpenId: config.appId });
      if (isParseError(parsed)) {
        const type = typeof event.t === "string" ? event.t : "unknown";
        console.log(`[event #${events}] type=${type} (unparseable: ${parsed.code})`);
        return;
      }
      console.log(
        `[event #${events}] type=${parsed.conversation_kind === "group" ? "group_mention" : "direct"}` +
          ` conv=${parsed.native_conversation_id} sender=${parsed.sender.native_id}` +
          ` msg=${parsed.native_message_id} text="${summarize(parsed.text)}"`,
      );

      if (replyText === null || parsed.conversation_kind !== "group") return;
      replies += 1;
      void adapter
        .send({
          channel: "qq",
          account: ACCOUNT,
          native_conversation_id: parsed.native_conversation_id,
          text: replyText,
          reply_to_native_message_id: parsed.native_message_id,
          idempotency_key: `qq-live:${parsed.native_message_id}:reply`,
        })
        .then((receipt) => {
          console.log(`[qq] replied to ${parsed.native_message_id}: id=${receipt.remote_message_id ?? "?"}`);
        })
        .catch((err: unknown) => {
          console.error(
            `[qq] reply failed for ${parsed.native_message_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
    onInboundRejected: (event) => {
      rejected += 1;
      console.log(`[qq] inbound rejected code=${event.code} message=${event.message}`);
    },
  });

  console.log(`[qq] observing for ${seconds}s (reply=${replyText === null ? "off" : "on"})`);
  console.log(`[qq] 请在 QQ 里 @ 机器人（群消息未 @ 不会被平台投递）。`);

  setTimeout(() => {
    void finish(`${seconds}s timeout`);
  }, seconds * 1_000);
}

await main();
