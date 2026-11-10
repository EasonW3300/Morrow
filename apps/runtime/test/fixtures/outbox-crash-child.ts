// 崩溃语义测试用的真实子进程（M4-T2 / Issue #39）：
// 用生产 OutboxService 发起一次投递；适配器先写平台侧「收到请求」标记，随后永不返回——
// 父测试在此刻 SIGKILL 进程，验证「请求已发出但无回执」重启后不重发。
// 运行方式：node --experimental-strip-types test/fixtures/outbox-crash-child.ts <dataDir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventLedger } from "../../src/ledger.ts";
import {
  OutboxService,
  type OutboxChannelAdapter,
  type OutboxSendOutcome,
} from "../../src/outbox/service.ts";

const dataDir = process.argv[2];
if (dataDir === undefined) {
  console.error("usage: outbox-crash-child.ts <dataDir>");
  process.exit(2);
}

const replicaId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const ledger = EventLedger.open(dataDir);
const adapter: OutboxChannelAdapter = {
  send(request): Promise<OutboxSendOutcome> {
    // 模拟平台已收到请求：写标记文件（父进程据此确认「已发出」）。
    writeFileSync(join(dataDir, "platform-received"), JSON.stringify({ key: request.idempotency_key }));
    process.stdout.write("SENT\n");
    // 永不返回：父测试在读到 SENT 后立即 SIGKILL。
    return new Promise<OutboxSendOutcome>(() => {});
  },
};
const service = new OutboxService({
  dataDir,
  ledger,
  replicaId,
  adapter,
  sendTimeoutMs: 60_000,
});
service.enqueue({
  idempotencyKey: "crash-key-1",
  channelId: "feishu",
  accountId: "bot-1",
  target: { kind: "conversation", id: "oc_crash" },
  payload: { text: "survives a crash?" },
});
void service.dispatchOnce();
