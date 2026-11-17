/**
 * MCP 客户端（票 M7-B-T1 / Issue #67）。
 *
 * 两件事：**双代际探测**（协议细节在 `protocol.ts`）与**进程生命周期管理**。
 * 传输层经 `McpTransport` 接缝注入——默认实现是 stdio 子进程（NDJSON 行协议），
 * 测试注入内存实现即可穷举所有分支，无需真实起进程。
 *
 * 进程是**宿主子进程**，不是容器沙箱（ADR-0011 的已知残余风险）。因此本模块不做
 * "隔离"，只做：懒启动（不常驻）、空闲退出（不占资源）、崩溃有限重启（不无声死掉）。
 */

import {
  buildRequest,
  classifyCapabilities,
  isUnsupportedVersionError,
  negotiateVersion,
  supportedVersionsFromError,
  type JsonRpcResponse,
  type McpProbeResult,
  type McpToolCallResult,
  type McpToolDescriptor,
} from "./protocol.ts";

/** 单次请求的超时（毫秒）；探测阶段也用这个值判定"超时 → 视为 legacy" */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
/** 空闲多久后关掉子进程（毫秒） */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** 崩溃重启上限；超过即 degraded */
export const DEFAULT_MAX_RESTARTS = 3;

/**
 * 传输层接缝。
 *
 * 刻意**不**把它设计成 `call(method, params)` 的高层接口：探测逻辑需要根据原始
 * JSON-RPC 响应（含 error.code/data，以及"不认识这个方法"这种信号）做分支判定，
 * 高层接口会把这些信息抹平。
 */
export interface McpTransport {
  /** 启动传输（stdio 下就是 spawn；幂等） */
  start(): Promise<void>;
  /** 发送一次请求并等响应；超时抛 McpTimeoutError，进程死亡抛 McpTransportClosedError */
  request(message: unknown): Promise<JsonRpcResponse>;
  /** 关闭传输（幂等） */
  close(): Promise<void>;
  /** 传输是否处于可用状态（用于懒启动判定） */
  isOpen(): boolean;
}

export class McpTimeoutError extends Error {
  constructor(message = "MCP request timed out") {
    super(message);
    this.name = "McpTimeoutError";
  }
}

export class McpTransportClosedError extends Error {
  constructor(message = "MCP transport is closed") {
    super(message);
    this.name = "McpTransportClosedError";
  }
}

export class McpProtocolError extends Error {
  readonly code: number;
  readonly details?: unknown;
  constructor(code: number, message: string, details?: unknown) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.details = details;
  }
}

/** 健康状态（映射到 channel health 的同类四态，便于 UI 复用） */
export type McpHealthState = "stopped" | "starting" | "ready" | "degraded";

export interface McpClientOptions {
  /** 传输工厂：每次（重）启动都新建一个传输实例 */
  transportFactory: () => McpTransport;
  now?: () => number;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxRestarts?: number;
  /** 探测时要尝试的版本（缺省用协议层的支持列表） */
  preferredVersions?: readonly string[];
}

export interface McpToolCallOutcome {
  ok: boolean;
  /** 工具返回的文本内容（拼接所有 text 块；无 text 则为空串） */
  text: string;
  /** 工具自报失败（isError）或协议错误 */
  error?: string;
  raw: McpToolCallResult | null;
}

export class McpClient {
  readonly #options: McpClientOptions;
  readonly #now: () => number;
  #transport: McpTransport | null = null;
  #probe: McpProbeResult | null = null;
  #state: McpHealthState = "stopped";
  #lastError: string | null = null;
  #lastUsedAt = 0;
  #restarts = 0;
  #nextId = 1;
  /** 探测失败但"值得重试"的标记：崩溃后允许重新探测 */
  #needsProbe = true;

  constructor(options: McpClientOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  get state(): McpHealthState {
    return this.#state;
  }

  /** 探测结果（health 里回显：代际/版本/能力/不支持项） */
  get probeResult(): McpProbeResult | null {
    return this.#probe;
  }

  health(): {
    state: McpHealthState;
    lastError: string | null;
    restarts: number;
    idleMs: number;
    probe: McpProbeResult | null;
  } {
    const idleMs = this.#transport === null ? 0 : this.#now() - this.#lastUsedAt;
    return {
      state: this.#state,
      lastError: this.#lastError,
      restarts: this.#restarts,
      idleMs,
      probe: this.#probe,
    };
  }

  /** 确保传输可用并完成探测（懒启动；探测成功后可反复调用，不重复探测） */
  async ensureReady(): Promise<void> {
    if (this.#state === "degraded") {
      throw new McpProtocolError(-32603, `MCP client is degraded: ${this.#lastError ?? "unknown"}`);
    }
    if (this.#transport === null || !this.#transport.isOpen()) {
      await this.#startTransport();
    }
    if (this.#needsProbe) {
      await this.#probeProtocol();
    }
    this.#lastUsedAt = this.#now();
  }

  /** 空闲回收：超过 idleTimeoutMs 未使用则关掉传输（供定时器或调用前检查） */
  async reclaimIfIdle(): Promise<boolean> {
    if (this.#transport === null) return false;
    const idleFor = this.#now() - this.#lastUsedAt;
    if (idleFor < (this.#options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS)) return false;
    await this.#closeTransport();
    this.#state = "stopped";
    return true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.ensureReady();
    const response = await this.#call("tools/list");
    const result = response.result;
    if (typeof result !== "object" || result === null) return [];
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return [];
    return tools
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .filter((item) => typeof item.name === "string")
      .map((item) => ({
        name: item.name as string,
        ...(typeof item.description === "string" ? { description: item.description } : {}),
        ...(typeof item.inputSchema === "object" && item.inputSchema !== null
          ? { inputSchema: item.inputSchema as Record<string, unknown> }
          : {}),
      }));
  }

  async callTool(name: string, args: unknown = {}): Promise<McpToolCallOutcome> {
    await this.ensureReady();
    let response: JsonRpcResponse;
    try {
      response = await this.#call("tools/call", { name, arguments: args });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, text: "", error: message, raw: null };
    }
    if (response.error !== undefined) {
      // 协议层错误（工具不存在、参数非法）：报给调用方，不静默重试
      return { ok: false, text: "", error: `${response.error.code}: ${response.error.message}`, raw: null };
    }
    const result = response.result as McpToolCallResult | undefined;
    if (result === undefined) return { ok: true, text: "", raw: null };
    const text = (result.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
    return {
      ok: result.isError !== true,
      text,
      ...(result.isError === true ? { error: text.length > 0 ? text : "tool reported isError" } : {}),
      raw: result,
    };
  }

  /**
   * 标记传输已损坏（正常调用路径失败后由调用方调用，不在探测阶段调用）。
   *
   * 与 `#send` 解耦的原因：探测阶段的失败是"分支信号"（可能只是超时/方法不存在），
   * 不代表传输死亡；把两者混为一谈会让 legacy 回退无法完成。
   */
  async markTransportBroken(reason: string): Promise<void> {
    await this.#handleTransportFailure(new McpTransportClosedError(reason));
  }

  async close(): Promise<void> {
    await this.#closeTransport();
    this.#state = "stopped";
  }

  // --- 内部 ---------------------------------------------------------------------------

  async #startTransport(): Promise<void> {
    this.#state = "starting";
    this.#transport = this.#options.transportFactory();
    try {
      await this.#transport.start();
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      this.#transport = null;
      this.#state = "degraded";
      throw new McpProtocolError(-32603, `MCP transport failed to start: ${this.#lastError}`);
    }
    this.#needsProbe = true;
  }

  async #closeTransport(): Promise<void> {
    const transport = this.#transport;
    this.#transport = null;
    this.#probe = null;
    this.#needsProbe = true;
    if (transport !== null) {
      try {
        await transport.close();
      } catch {
        // 关闭失败不影响状态转换：进程可能已经死了
      }
    }
  }

  /**
   * 双代际探测（顺序不可调换，理由见文件头注释与 ADR-0011）。
   */
  async #probeProtocol(): Promise<void> {
    const versions = this.#options.preferredVersions ?? undefined;
    // 第 1 步：现代协议 server/discover
    const discoverResponse = await this.#tryCall("server/discover", versions === undefined ? undefined : { supported: versions });
    if (discoverResponse.ok) {
      const result = discoverResponse.response.result;
      const record = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
      const protocolVersion =
        typeof record.protocolVersion === "string"
          ? record.protocolVersion
          : typeof record.protocol_version === "string"
            ? (record.protocol_version as string)
            : "unknown";
      const capabilities = classifyCapabilities(record.capabilities);
      this.#probe = {
        generation: "discover",
        protocolVersion,
        serverInfo: readServerInfo(record),
        capabilities,
        unsupportedCapabilities: capabilities.unsupported,
      };
      this.#needsProbe = false;
      this.#restarts = 0;
      this.#state = "ready";
      return;
    }

    // 第 2 步：版本不支持 → 按 server 声明重试，**不回退 initialize**
    const error = discoverResponse.response.error;
    if (isUnsupportedVersionError(error)) {
      const supported = supportedVersionsFromError(error);
      const chosen = negotiateVersion(supported);
      if (chosen === null) {
        this.#failProbe(
          `MCP server requires a protocol version we do not support (server supports: ${supported.join(", ") || "unknown"})`,
        );
        return;
      }
      const retry = await this.#tryCall("server/discover", { supported: [chosen] });
      if (retry.ok) {
        const record = (typeof retry.response.result === "object" && retry.response.result !== null
          ? retry.response.result
          : {}) as Record<string, unknown>;
        const capabilities = classifyCapabilities(record.capabilities);
        this.#probe = {
          generation: "discover",
          protocolVersion:
            typeof record.protocolVersion === "string" ? record.protocolVersion : chosen,
          serverInfo: readServerInfo(record),
          capabilities,
          unsupportedCapabilities: capabilities.unsupported,
        };
        this.#needsProbe = false;
        this.#restarts = 0;
        this.#state = "ready";
        return;
      }
      this.#failProbe(
        `MCP server rejected the negotiated protocol version ${chosen}: ${
          retry.response.error?.message ?? "unknown error"
        }`,
      );
      return;
    }

    // 第 3 步：其他错误 / 超时 / 方法不存在 → 判定 legacy，回退 initialize
    const legacy = await this.#tryCall("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      clientInfo: { name: "morrow", version: "0.3.0" },
    });
    if (!legacy.ok) {
      this.#failProbe(
        `MCP initialize failed: ${legacy.response.error?.message ?? discoverResponse.failureReason ?? "unknown"}`,
      );
      return;
    }
    // 现代协议要求 initialize 之后再发 initialized 通知（无需响应）；legacy 亦然
    await this.#notify("notifications/initialized");
    const record = (typeof legacy.response.result === "object" && legacy.response.result !== null
      ? legacy.response.result
      : {}) as Record<string, unknown>;
    const capabilities = classifyCapabilities(record.capabilities);
    this.#probe = {
      generation: "initialize",
      protocolVersion:
        typeof record.protocolVersion === "string" ? record.protocolVersion : "legacy",
      serverInfo: readServerInfo(record),
      capabilities,
      unsupportedCapabilities: capabilities.unsupported,
    };
    this.#needsProbe = false;
    this.#restarts = 0;
    this.#state = "ready";
  }

  /**
   * 探测失败：置 degraded 并**抛出**。
   *
   * 早期版本只设状态不抛，调用方 `ensureReady()` 会以为成功继续往下走，直到某个
   * 后续调用才莫名失败——错误发生在远离病因的地方。探测失败必须当场传播。
   */
  #failProbe(message: string): never {
    this.#lastError = message;
    this.#state = "degraded";
    this.#needsProbe = true;
    throw new McpProtocolError(-32603, `MCP probe failed: ${message}`);
  }

  /** 发一次可能失败的请求（探测用：把超时/断连也当作"分支信号"而不是异常） */
  async #tryCall(
    method: string,
    params?: unknown,
  ): Promise<{ ok: true; response: JsonRpcResponse } | { ok: false; response: JsonRpcResponse; failureReason: string }> {
    try {
      const response = await this.#send(method, params);
      if (response.error !== undefined) {
        return { ok: false, response, failureReason: `JSON-RPC error ${response.error.code}` };
      }
      return { ok: true, response };
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      // 传输层失败（超时/断连）也要能参与分支判定 → 用空错误对象表示"没有 JSON-RPC 响应"
      return { ok: false, response: { jsonrpc: "2.0", id: null, error: { code: -32603, message: failureReason } }, failureReason };
    }
  }

  /** 正常请求（失败抛错；调用方用 callTool 的 try/catch 兜住） */
  async #call(method: string, params?: unknown): Promise<JsonRpcResponse> {
    return this.#send(method, params);
  }

  async #send(method: string, params?: unknown): Promise<JsonRpcResponse> {
    if (this.#transport === null) throw new McpTransportClosedError();
    const message = buildRequest(this.#nextId, method, params);
    this.#nextId += 1;
    try {
      const response = await withTimeout(
        this.#transport.request(message),
        this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      this.#lastUsedAt = this.#now();
      return response;
    } catch (err) {
      // 注意：这里**不**关闭传输。探测阶段（discover 超时 → 回退 initialize）需要用
      // 同一个传输继续谈——早期版本在此 close，导致 legacy 回退必然失败。
      // 传输是否真的死亡，由正常调用路径（listTools/callTool）在失败后经
      // markTransportBroken() 显式标记。
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** 传输坏了：关掉、按上限重启，超限则 degraded */
  async #handleTransportFailure(err: Error): Promise<void> {
    await this.#closeTransport();
    if (this.#restarts >= (this.#options.maxRestarts ?? DEFAULT_MAX_RESTARTS)) {
      this.#lastError = `transport failed ${this.#restarts} times, giving up: ${err.message}`;
      this.#state = "degraded";
      return;
    }
    this.#restarts += 1;
    this.#state = "stopped";
    this.#lastError = err.message;
  }

  /** 单向通知（initialized 等）：无 id、不等响应 */
  async #notify(method: string, params?: unknown): Promise<void> {
    if (this.#transport === null) return;
    const message = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    try {
      // 通知也可能没有响应；交给传输层实现决定（stdio 直接写一行即可）
      await withTimeout(
        this.#transport.request(message).then(() => undefined),
        this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
    } catch {
      // 通知失败不致命：很多 server 不回它
    }
  }
}

/** 从 discover/initialize 结果里读 serverInfo（两种代际字段名一致，缺失给空对象） */
function readServerInfo(record: Record<string, unknown>): { name?: string; version?: string } {
  const info = record.serverInfo;
  if (typeof info !== "object" || info === null) return {};
  const infoRecord = info as Record<string, unknown>;
  return {
    ...(typeof infoRecord.name === "string" ? { name: infoRecord.name } : {}),
    ...(typeof infoRecord.version === "string" ? { version: infoRecord.version } : {}),
  };
}

/** 给 promise 加超时（超时抛 McpTimeoutError，便于与"业务失败"区分） */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpTimeoutError(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
