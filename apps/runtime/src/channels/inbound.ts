import type {
  ChannelPermissionContext,
  InboundMessage,
  OutboundMessage,
} from "@morrow/protocol";
import type { EventLedger } from "../ledger.ts";
import type { SessionFrame, SessionManager } from "../sessions.ts";
import { buildEventEnvelope } from "../envelope.ts";
import { uuidv7, UUID_RE } from "../uuid-v7.ts";
import { CHANNEL_EVENT_TYPES } from "./events.ts";
import type { ChannelStore, ConversationRecord } from "./store.ts";
import type { ChannelAdapter } from "./types.ts";

/**
 * 统一入站路由（M4-T1 / Issue #38，PRD §4.4 FR-CH-5/6）。
 *
 * 顺序（fail-closed）：
 *   1. 渠道适配器已注册（registry 在调用前已校验；route 再兜一次）
 *   2. 账号已登记、启用、且属于该渠道
 *   3. 发送者由本地 channel_identities 解析为 owner / contact:<id>
 *      ——平台自报身份（载荷里的 principal/is_owner 等）一律不采信
 *   4. 群聊会话必须在白名单；且仅当 agent 被 @ 时处理（私聊直接处理）
 *   5. 可选 Task 关联必须指向存在的任务（只做关联，不创建/推进 Task）
 *   6. 平台原始会话/消息独立落库（raw 原样），然后交给既有会话链路：
 *      已有 session 则续，无则新建；message.user 按解析主体归因
 *   7. 助手回复经适配器 send 回调（Outbox 投递器在 M4-T2 接管持久化）
 * 任何一步拒绝 → channel.inbound_rejected（含 reason）留痕。
 */

export interface InboundRouteOptions {
  /** 中间路由关联的任务 id（写入消息关联列与事件信封；不覆盖平台原始记录） */
  taskId?: string;
  /** 平台原始载荷（原样持久化；缺省用归一化后的 InboundMessage） */
  raw?: unknown;
}

export type InboundDecision = "processed" | "rejected" | "ignored";

export interface InboundRouteResult {
  decision: InboundDecision;
  channel: string;
  /** 拒绝/忽略原因（decision != processed 时存在） */
  reason?: string;
  conversation_id?: string;
  message_id?: string;
  session_id?: string;
  event_id?: string;
}

export interface InboundRejection {
  channel: string;
  reason: string;
  account?: string | null;
  native_message_id?: string | null;
  native_conversation_id?: string | null;
  sender_native_id?: string | null;
  detail?: string | null;
  error_code?: string | null;
}

export interface ChannelInboundRouterOptions {
  ledger: EventLedger;
  replicaId: string;
  sessions: SessionManager;
  store: ChannelStore;
  adapterFor(channelId: string): ChannelAdapter | null;
  /** 任务存在性（中间路由关联校验）；缺省不校验 */
  taskExists?: (taskId: string) => boolean;
  now?: () => Date;
}

export class ChannelInboundRouter {
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #sessions: SessionManager;
  readonly #store: ChannelStore;
  readonly #adapterFor: (channelId: string) => ChannelAdapter | null;
  readonly #taskExists: ((taskId: string) => boolean) | null;
  readonly #now: () => Date;

  constructor(options: ChannelInboundRouterOptions) {
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#sessions = options.sessions;
    this.#store = options.store;
    this.#adapterFor = options.adapterFor;
    this.#taskExists = options.taskExists ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  route(inbound: InboundMessage, options: InboundRouteOptions = {}): InboundRouteResult {
    if (this.#adapterFor(inbound.channel) === null) {
      return this.reject({
        channel: inbound.channel,
        reason: "channel_not_registered",
        account: inbound.account,
        native_message_id: inbound.native_message_id,
        native_conversation_id: inbound.native_conversation_id,
        sender_native_id: inbound.sender.native_id,
      });
    }

    const account = this.#store.findAccount(inbound.account);
    if (account === null || account.channel_id !== inbound.channel) {
      return this.reject({
        channel: inbound.channel,
        reason: "account_not_registered",
        account: inbound.account,
        native_message_id: inbound.native_message_id,
        native_conversation_id: inbound.native_conversation_id,
        sender_native_id: inbound.sender.native_id,
      });
    }
    if (!account.enabled) {
      return this.reject({
        channel: inbound.channel,
        reason: "account_disabled",
        account: inbound.account,
        native_message_id: inbound.native_message_id,
        native_conversation_id: inbound.native_conversation_id,
        sender_native_id: inbound.sender.native_id,
      });
    }

    // 身份只来自本地映射：平台自报的 principal/is_owner 不参与判定
    const identity = this.#store.findIdentity(inbound.account, inbound.sender.native_id);
    if (identity === null) {
      return this.reject({
        channel: inbound.channel,
        reason: "unknown_sender",
        account: inbound.account,
        native_message_id: inbound.native_message_id,
        native_conversation_id: inbound.native_conversation_id,
        sender_native_id: inbound.sender.native_id,
      });
    }

    if (inbound.conversation_kind === "group") {
      if (!this.#store.isConversationAllowed(inbound.account, inbound.native_conversation_id)) {
        return this.reject({
          channel: inbound.channel,
          reason: "conversation_not_allowed",
          account: inbound.account,
          native_message_id: inbound.native_message_id,
          native_conversation_id: inbound.native_conversation_id,
          sender_native_id: inbound.sender.native_id,
        });
      }
      if (!inbound.mention.agent) {
        return this.reject({
          channel: inbound.channel,
          reason: "group_mention_required",
          account: inbound.account,
          native_message_id: inbound.native_message_id,
          native_conversation_id: inbound.native_conversation_id,
          sender_native_id: inbound.sender.native_id,
        });
      }
    }

    if (options.taskId !== undefined) {
      // 信封 task_id 有 uuid 形态约束；先拒非法形态，避免消息已落库后 append 失败半写
      if (!UUID_RE.test(options.taskId) || (this.#taskExists !== null && !this.#taskExists(options.taskId))) {
        return this.reject({
          channel: inbound.channel,
          reason: "unknown_task",
          account: inbound.account,
          native_message_id: inbound.native_message_id,
          native_conversation_id: inbound.native_conversation_id,
          sender_native_id: inbound.sender.native_id,
          detail: options.taskId,
        });
      }
    }

    const permissionContext: ChannelPermissionContext = {
      channel: inbound.channel,
      account: inbound.account,
      sender: inbound.sender,
      conversation: {
        native_conversation_id: inbound.native_conversation_id,
        kind: inbound.conversation_kind,
      },
      principal: identity.principal,
      contact_id: identity.principal.startsWith("contact:")
        ? identity.principal.slice("contact:".length)
        : null,
      granted_categories: [...identity.granted_categories],
    };

    const conversation = this.#store.getOrCreateConversation({
      accountId: inbound.account,
      nativeConversationId: inbound.native_conversation_id,
      kind: inbound.conversation_kind,
      permissionContext,
      now: this.#now(),
    });

    const inserted = this.#store.insertMessage(
      {
        conversationId: conversation.conversation_id,
        nativeMessageId: inbound.native_message_id,
        direction: "inbound",
        senderNativeId: inbound.sender.native_id,
        text: inbound.text,
        timestamp: inbound.timestamp,
        mentionAgent: inbound.mention.agent,
        attachments: inbound.attachments,
        permissionContext,
        taskId: options.taskId ?? null,
        raw: options.raw ?? inbound,
      },
      this.#now(),
    );
    if (inserted.duplicate) {
      // 平台重复投递（重试/回调重放）：幂等忽略，不重复入会话
      return {
        decision: "ignored",
        reason: "duplicate_message",
        channel: inbound.channel,
        conversation_id: conversation.conversation_id,
        message_id: inserted.record.message_id,
      };
    }

    if (options.taskId !== undefined) {
      this.#store.setConversationTask(conversation.conversation_id, options.taskId);
    }

    const sessionId = this.#sessionFor(conversation, inbound.channel);

    const received = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: identity.principal,
      eventType: CHANNEL_EVENT_TYPES.inboundReceived,
      sessionId,
      taskId: options.taskId ?? null,
      payload: {
        channel: inbound.channel,
        account: inbound.account,
        native_message_id: inbound.native_message_id,
        native_conversation_id: inbound.native_conversation_id,
        conversation_kind: inbound.conversation_kind,
        conversation_id: conversation.conversation_id,
        message_id: inserted.record.message_id,
        sender_native_id: inbound.sender.native_id,
        permission_context: permissionContext,
        ...(options.taskId === undefined ? {} : { task_id: options.taskId }),
      },
    });
    this.#ledger.append(received);

    this.#driveSession(inbound, sessionId, identity.principal, conversation, options.taskId);

    return {
      decision: "processed",
      channel: inbound.channel,
      conversation_id: conversation.conversation_id,
      message_id: inserted.record.message_id,
      session_id: sessionId,
      event_id: received.event_id,
    };
  }

  /** 拒绝留痕（未注册渠道/解析失败等非归一化路径也走这里） */
  reject(input: InboundRejection): InboundRouteResult {
    const payload: Record<string, unknown> = {
      channel: input.channel,
      reason: input.reason,
    };
    if (input.account !== undefined && input.account !== null) payload.account = input.account;
    if (input.native_message_id !== undefined && input.native_message_id !== null) {
      payload.native_message_id = input.native_message_id;
    }
    if (input.native_conversation_id !== undefined && input.native_conversation_id !== null) {
      payload.native_conversation_id = input.native_conversation_id;
    }
    if (input.sender_native_id !== undefined && input.sender_native_id !== null) {
      payload.sender_native_id = input.sender_native_id;
    }
    if (input.detail !== undefined && input.detail !== null) payload.detail = input.detail;
    if (input.error_code !== undefined && input.error_code !== null) payload.error_code = input.error_code;

    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType: CHANNEL_EVENT_TYPES.inboundRejected,
      payload,
    });
    this.#ledger.append(envelope);
    return {
      decision: "rejected",
      channel: input.channel,
      reason: input.reason,
      event_id: envelope.event_id,
    };
  }

  /** 会话复用/新建：平台会话已有 session 且仍存在 → 续；否则新建并回写关联 */
  #sessionFor(conversation: ConversationRecord, channel: string): string {
    if (conversation.session_id !== null && this.#sessions.sessionExists(conversation.session_id)) {
      return conversation.session_id;
    }
    const created = this.#sessions.createSession(
      `channel ${channel}:${conversation.native_conversation_id}`,
    );
    this.#store.setConversationSession(conversation.conversation_id, created.sessionId);
    return created.sessionId;
  }

  /**
   * 交给既有会话链路：订阅本轮 assistant 收尾帧（按 causation 对齐本轮 user 事件），
   * 产出后经适配器 send 回调。回复失败只记日志，不撤销已持久化的入站/会话事件。
   */
  #driveSession(
    inbound: InboundMessage,
    sessionId: string,
    principal: ChannelPermissionContext["principal"],
    conversation: ConversationRecord,
    taskId: string | undefined,
  ): void {
    let unsubscribe: (() => void) | null = null;
    let ackEventId: string | null = null;
    const buffered: SessionFrame[] = [];
    const release = (): void => {
      unsubscribe?.();
      unsubscribe = null;
    };

    const handle = (frame: SessionFrame): void => {
      if (frame.kind !== "event") return;
      if (frame.envelope.causation_id !== ackEventId) return;
      if (frame.envelope.event_type === "message.assistant") {
        release();
        const text = typeof frame.envelope.payload.text === "string" ? frame.envelope.payload.text : "";
        if (text.length > 0) {
          this.#sendReply(inbound, conversation, text, taskId);
        }
        return;
      }
      if (frame.envelope.event_type === "agent.error") {
        release();
      }
    };

    unsubscribe = this.#sessions.subscribe(sessionId, (frame) => {
      // 会话运行时复用路径下 FakePi/同步 Agent 可能在本函数拿到 ack 之前就产出收尾帧，
      // 先缓存、拿到本轮 user 事件 id 后按 causation 回放（不丢本轮回复）。
      if (ackEventId === null) {
        buffered.push(frame);
        return;
      }
      handle(frame);
    });

    const ack = this.#sessions.sendUserMessage(sessionId, inbound.text, { actorId: principal });
    ackEventId = ack.eventId;
    for (const frame of buffered.splice(0)) handle(frame);
  }

  #sendReply(
    inbound: InboundMessage,
    conversation: ConversationRecord,
    text: string,
    taskId: string | undefined,
  ): void {
    const adapter = this.#adapterFor(inbound.channel);
    if (adapter === null) return;

    const outbound: OutboundMessage = {
      channel: inbound.channel,
      account: inbound.account,
      native_conversation_id: inbound.native_conversation_id,
      text,
      reply_to_native_message_id: inbound.native_message_id,
      idempotency_key: `channel:${inbound.channel}:${inbound.native_message_id}:assistant`,
    };
    // 出站记录同样落原始表（association 在关联列；raw 保持出站结构原样）
    this.#store.insertMessage(
      {
        conversationId: conversation.conversation_id,
        nativeMessageId: `out:${uuidv7()}`,
        direction: "outbound",
        senderNativeId: null,
        text,
        timestamp: this.#now().toISOString(),
        mentionAgent: false,
        attachments: outbound.attachments ?? [],
        permissionContext: conversation.permission_context,
        taskId: taskId ?? null,
        raw: outbound,
      },
      this.#now(),
    );

    try {
      const result = adapter.send(outbound);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error("[morrow] channel send failed:", err);
        });
      }
    } catch (err) {
      console.error("[morrow] channel send failed:", err);
    }
  }
}
