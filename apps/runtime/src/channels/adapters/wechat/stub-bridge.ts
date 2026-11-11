import {
  LocalBridgeError,
  type LocalBridge,
  type LocalBridgeInboundMessage,
  type LocalBridgeSendInput,
  type LocalBridgeSendResult,
  type LocalBridgeStatus,
} from "./local-bridge.ts";

/**
 * StubLocalBridge（M4-T5）：纯内存本地桥桩，仅供测试/开发。
 *
 * 它模拟「Windows 微信客户端 + 本地自动化桥」的行为，不触碰真实微信、不发真实网络：
 *   connect()/disconnect()  记录调用次数；disconnect 幂等
 *   status()                可注入进程/登录/窗口句柄状态（健康检查各分支）
 *   emit(message)           模拟桥收到一条微信消息（未连接/未订阅时丢弃）
 *   sendMessage(input)      记录出站并返回假回执；可注入错误
 *
 * 真实桥不在 M4 交付范围内（外部依赖：Owner Windows 机器）。
 */
export interface StubLocalBridgeOptions {
  /** 连接成功后的桥状态（默认 running / logged_in / available） */
  status?: Partial<LocalBridgeStatus>;
  /** connect 时抛出的错误（模拟桥进程启动失败） */
  connectError?: Error;
  /** 每次 sendMessage 抛出的错误（模拟微信明确拒收/超时/网络中断） */
  sendError?: Error;
}

export class StubLocalBridge implements LocalBridge {
  #connected = false;
  #status: LocalBridgeStatus;
  #lastError: string | null = null;
  #handler: ((message: LocalBridgeInboundMessage) => void) | null = null;
  #sent: LocalBridgeSendInput[] = [];
  #sendSeq = 0;
  #connectError: Error | null;
  #sendError: Error | null;

  connectCalls = 0;
  disconnectCalls = 0;

  constructor(options: StubLocalBridgeOptions = {}) {
    this.#status = {
      process: "running",
      login: "logged_in",
      window: "available",
      last_error: null,
      ...options.status,
    };
    this.#connectError = options.connectError ?? null;
    this.#sendError = options.sendError ?? null;
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** 已发出的消息（测试观察点：conversation_id / text / reply_to_message_id） */
  get sent(): readonly LocalBridgeSendInput[] {
    return this.#sent;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.#connectError !== null) {
      this.#lastError = this.#connectError.message;
      this.#status = { ...this.#status, process: "error" };
      throw this.#connectError;
    }
    this.#connected = true;
    this.#lastError = null;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.#connected = false;
  }

  status(): LocalBridgeStatus {
    if (!this.#connected) {
      return {
        process: "stopped",
        login: "logged_out",
        window: "unavailable",
        last_error: this.#lastError,
      };
    }
    return { ...this.#status, last_error: this.#lastError ?? this.#status.last_error ?? null };
  }

  sendMessage(input: LocalBridgeSendInput): LocalBridgeSendResult {
    if (!this.#connected) {
      throw new LocalBridgeError("explicit", "stub local bridge is not connected", {
        code: "bridge_not_connected",
        retryable: false,
      });
    }
    if (this.#sendError !== null) {
      throw this.#sendError;
    }
    this.#sent.push(input);
    this.#sendSeq += 1;
    return {
      message_id: `wx-stub-out-${this.#sendSeq}`,
      delivered_at: new Date().toISOString(),
    };
  }

  onMessage(handler: (message: LocalBridgeInboundMessage) => void): () => void {
    this.#handler = handler;
    return () => {
      if (this.#handler === handler) this.#handler = null;
    };
  }

  /** 测试注入：模拟桥收到一条微信消息；未连接/未订阅时返回 false（丢弃）。 */
  emit(message: LocalBridgeInboundMessage): boolean {
    if (!this.#connected || this.#handler === null) return false;
    this.#handler(message);
    return true;
  }

  /** 测试注入：整体或局部替换桥状态（健康检查各分支）。 */
  setStatus(status: Partial<LocalBridgeStatus>): void {
    this.#status = { ...this.#status, ...status };
    if (status.last_error !== undefined) this.#lastError = status.last_error;
  }

  /** 测试注入：设置下一次/每次 sendMessage 的错误。 */
  setSendError(error: Error | null): void {
    this.#sendError = error;
  }
}
