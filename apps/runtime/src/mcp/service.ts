/**
 * MCP Server 管理服务（票 M7-B-T2 / Issue #71，FR-B1..B6）。
 *
 * 生命周期与三处硬约束：
 *
 * 1. **装 ≠ 开**。`install` 只落配置（status=disabled）；`enable` 才启动进程并探测。
 *    这两步分开是规格要求（FR-B4「默认 disabled」），也符合"安装一个第三方宿主
 *    进程"应有的谨慎程度。
 *
 * 2. **工具默认无权限**。`enable` 会把 server 的 tools 注册为 capability，但每个
 *    manifest 的五维权限都是空的，且注册需要 `permissions ⊆ grants` 校验通过。
 *    所以"启用 server"不会顺带给出 shell/网络访问；Owner 必须先在全局 grants 里
 *    放行，再给这台 server 配 grants。
 *
 * 3. **degraded 必须能解释**。client 崩溃重启超限后状态是 degraded，服务把
 *    `last_error` 与重启次数一并回传——UI 要能告诉 Owner"为什么它不工作了"，
 *    而不是只显示一个红点。
 *
 * 审计事件（actor=owner，进 append-only 账本）：
 *   mcp.server_installed / mcp.server_enabled / mcp.server_disabled /
 *   mcp.server_removed / mcp.server_grants_updated / mcp.tools_registered
 */

import type { CapabilityManifest, EventEnvelope } from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import type { PermissionEngine } from "../capabilities/engine.ts";
import { McpClient, type McpHealthState } from "./client.ts";
import { mcpCapabilityName, mcpToolToManifest } from "./tools.ts";
import type { McpTransport } from "./client.ts";
import {
  MCP_RISK_ACK_TEXT,
  McpInstallInputError,
  assertRiskAcknowledged,
  formatCommandPreview,
  parseInstallInput,
  serverIdFor,
  type McpServerDraft,
} from "./install.ts";
import {
  EMPTY_MCP_GRANTS,
  McpServerStore,
  type McpServerGrants,
  type McpServerRecord,
  type McpServerStatus,
} from "./store.ts";

export const MCP_EVENT_TYPES = {
  installed: "mcp.server_installed",
  enabled: "mcp.server_enabled",
  disabled: "mcp.server_disabled",
  removed: "mcp.server_removed",
  grantsUpdated: "mcp.server_grants_updated",
  toolsRegistered: "mcp.tools_registered",
} as const;

/** 一台 server 的「已安装」页视图（FR-B6：来源/状态/权限/健康一处可见） */
export interface McpServerView {
  server_id: string;
  display_name: string;
  /** 来源：npm / 文档 / 内置 / MCP（手工或模板） */
  source: string;
  /**
   * **完整未截断**的启动命令（含参数）。规格反复强调这点：安装页与已安装页
   * 都必须能看到 Owner 当初批准了什么。
   */
  launch_command: string;
  command: string;
  args: string[];
  env_keys: string[];
  cwd: string | null;
  enabled: boolean;
  status: McpServerStatus;
  /** 权限摘要（五维各自列出；全空即"未授予任何权限"） */
  grants: McpServerGrants;
  health: {
    state: McpHealthState;
    last_error: string | null;
    restarts: number;
    /** 协议代际与版本（"双代际"的可观测证据） */
    generation: "discover" | "initialize" | null;
    protocol_version: string | null;
    server_name: string | null;
    server_version: string | null;
    /** 能力协商里不支持的部分（如实回传，不静默忽略） */
    unsupported_capabilities: string[];
    tools_count: number;
  };
  risk_acknowledged: boolean;
  created_at: string;
  updated_at: string;
}

export class McpServerError extends Error {
  readonly code:
    | "not_found"
    | "name_conflict"
    | "invalid_input"
    | "unsupported_shape"
    | "empty_input"
    | "risk_not_acknowledged"
    | "not_enabled"
    | "capability_registration_failed"
    | "already_enabled";
  constructor(code: McpServerError["code"], message: string) {
    super(message);
    this.name = "McpServerError";
    this.code = code;
  }
}

export interface McpServerServiceDeps {
  store: McpServerStore;
  ledger: EventLedger;
  replicaId: string;
  capabilities: PermissionEngine;
  /** 传输工厂（测试注入假 stdio；生产按 record.command/args 建真子进程） */
  transportFactory: (record: McpServerRecord) => McpTransport;
  /**
   * 空闲阈值（默认 10 分钟，FR-B4 的规格值）。
   * 测试注入短值即可验证"回收真的发生"，不必等 10 分钟。
   */
  idleTimeoutMs?: number;
  now?: () => Date;
}

/** 每台已启用 server 的运行时态（client + 缓存的工具列表） */
interface ServerRuntime {
  client: McpClient;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  unsupportedCapabilities: string[];
  restarts: number;
  lastError: string | null;
}

export class McpServerService {
  readonly #deps: McpServerServiceDeps;
  readonly #now: () => Date;
  readonly #runtimes = new Map<string, ServerRuntime>();

  constructor(deps: McpServerServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * 安装：解析输入 → 名字去重 → **风险确认硬校验** → 落库（status=disabled）→ 审计。
   *
   * 风险确认的检查放在最前面（解析之后立刻）：这样即使输入合法，未勾选也拿不到
   * server_id，也不可能"先装好再启用"。
   */
  install(input: {
    raw: string;
    displayName?: string;
    source?: McpServerDraft["source"];
    riskAcknowledged: unknown;
    actorId?: string;
  }): { servers: McpServerView[]; warnings: string[]; event_ids: string[] } {
    assertRiskAcknowledged(input.riskAcknowledged);
    let parsed: { drafts: McpServerDraft[]; warnings: string[] };
    try {
      parsed = parseInstallInput(input.raw, {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.source === undefined ? {} : { source: input.source }),
      });
    } catch (error) {
      throw toServerError(error);
    }

    // 先全部校验再落库：多台配置里有一台冲突时不能留半套
    for (const draft of parsed.drafts) {
      if (this.#deps.store.findByName(draft.display_name) !== null) {
        throw new McpServerError(
          "name_conflict",
          `an MCP server named "${draft.display_name}" is already installed; remove it first or use a different name`,
        );
      }
    }

    const now = this.#now().toISOString();
    const installed: McpServerView[] = [];
    const eventIds: string[] = [];
    for (const draft of parsed.drafts) {
      const record: McpServerRecord = {
        server_id: serverIdFor(draft.display_name),
        display_name: draft.display_name,
        source: draft.source,
        command: draft.command,
        args: draft.args,
        env_keys: draft.env_keys,
        cwd: draft.cwd,
        enabled: false,
        status: "disabled",
        protocol_version: null,
        generation: null,
        server_name: null,
        server_version: null,
        last_error: null,
        risk_acknowledged: true,
        // 原文落库：事后能证明"当时告知了什么"，比只记一个布尔值有取证价值
        risk_ack_text: MCP_RISK_ACK_TEXT,
        installed_by: input.actorId ?? "owner",
        created_at: now,
        updated_at: now,
      };
      this.#deps.store.insert(record);
      const entry = this.#append(MCP_EVENT_TYPES.installed, {
        server_id: record.server_id,
        display_name: record.display_name,
        source: record.source,
        launch_command: formatCommandPreview(record.command, record.args),
        env_keys: record.env_keys,
        risk_acknowledged: true,
        risk_ack_text: MCP_RISK_ACK_TEXT,
        enabled: false,
      });
      eventIds.push(entry.envelope.event_id);
      installed.push(this.#view(record));
    }
    return { servers: installed, warnings: parsed.warnings, event_ids: eventIds };
  }

  list(): McpServerView[] {
    return this.#deps.store.list().map((record) => this.#view(record));
  }

  get(serverId: string): McpServerView | null {
    const record = this.#deps.store.get(serverId);
    return record === null ? null : this.#view(record);
  }

  /**
   * 启用：启动进程 → 探测 → 拉工具列表 → 注册 capability → 回写状态。
   *
   * 失败不回滚安装（配置仍然有效，Owner 可以改命令后重试），但状态落 `error` 并把
   * 原因写进 `last_error`——不静默。
   */
  async enable(serverId: string, options: { actorId?: string } = {}): Promise<McpServerView> {
    const record = this.#deps.store.get(serverId);
    if (record === null) throw new McpServerError("not_found", `MCP server ${serverId} is not installed`);
    if (record.enabled) throw new McpServerError("already_enabled", `MCP server ${serverId} is already enabled`);

    const client = new McpClient({
      transportFactory: () => this.#deps.transportFactory(record),
      ...(this.#deps.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.#deps.idleTimeoutMs }),
    });
    const runtime: ServerRuntime = { client, tools: [], unsupportedCapabilities: [], restarts: 0, lastError: null };
    this.#runtimes.set(serverId, runtime);

    try {
      await client.ensureReady();
      const tools = await client.listTools();
      runtime.tools = tools;
      runtime.unsupportedCapabilities = client.probeResult?.unsupportedCapabilities ?? [];
      const registered = this.#registerTools(record, tools);
      const probe = client.probeResult;
      const now = this.#now().toISOString();
      const updated = this.#deps.store.updateRuntimeState(
        serverId,
        {
          enabled: true,
          status: "running",
          last_error: null,
          generation: probe?.generation ?? null,
          protocol_version: probe?.protocolVersion ?? null,
          server_name: probe?.serverInfo.name ?? null,
          server_version: probe?.serverInfo.version ?? null,
        },
        now,
      );
      this.#append(MCP_EVENT_TYPES.enabled, {
        server_id: serverId,
        generation: probe?.generation ?? null,
        protocol_version: probe?.protocolVersion ?? null,
        tools_registered: registered.names,
        unsupported_capabilities: runtime.unsupportedCapabilities,
      });
      if (registered.names.length > 0) {
        this.#append(MCP_EVENT_TYPES.toolsRegistered, {
          server_id: serverId,
          tools: registered.names,
          // 默认权限全空是这一条的重点：启用 server ≠ 授予权限
          grants_default_empty: true,
        });
      }
      return this.#view(updated ?? record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.lastError = message;
      const now = this.#now().toISOString();
      const updated = this.#deps.store.updateRuntimeState(
        serverId,
        { enabled: false, status: "error", last_error: message },
        now,
      );
      this.#append(MCP_EVENT_TYPES.enabled, { server_id: serverId, ok: false, error: message });
      const view = this.#view(updated ?? record);
      view.health.last_error = message;
      return view;
    }
  }

  /** 停用：关进程、注销该 server 的全部工具 capability、状态回 disabled */
  async disable(serverId: string, options: { actorId?: string } = {}): Promise<McpServerView> {
    const record = this.#deps.store.get(serverId);
    if (record === null) throw new McpServerError("not_found", `MCP server ${serverId} is not installed`);
    const runtime = this.#runtimes.get(serverId);
    if (runtime !== undefined) {
      await runtime.client.close();
      this.#runtimes.delete(serverId);
      this.#unregisterTools(record, runtime.tools);
    }
    const updated = this.#deps.store.updateRuntimeState(
      serverId,
      { enabled: false, status: "disabled", last_error: null },
      this.#now().toISOString(),
    );
    this.#append(MCP_EVENT_TYPES.disabled, { server_id: serverId });
    return this.#view(updated ?? record);
  }

  /** 更新该 server 的默认五维权限（不自动重启；新权限在下次调用时生效） */
  updateGrants(
    serverId: string,
    grantsInput: Partial<McpServerGrants>,
    options: { actorId?: string } = {},
  ): { view: McpServerView; event_id: string } {
    const record = this.#deps.store.get(serverId);
    if (record === null) throw new McpServerError("not_found", `MCP server ${serverId} is not installed`);
    const grants = normalizeGrants(grantsInput);
    this.#deps.store.setGrants(serverId, grants, this.#now().toISOString());
    const entry = this.#append(MCP_EVENT_TYPES.grantsUpdated, { server_id: serverId, grants });
    return { view: this.#view(this.#deps.store.get(serverId) ?? record), event_id: entry.envelope.event_id };
  }

  /** 卸载：先停（关进程 + 注销工具），再删配置；审计保留 */
  async remove(serverId: string, options: { actorId?: string } = {}): Promise<{ removed: boolean; event_id: string | null }> {
    const record = this.#deps.store.get(serverId);
    if (record === null) return { removed: false, event_id: null };
    if (record.enabled) await this.disable(serverId, options);
    this.#deps.store.delete(serverId);
    const entry = this.#append(MCP_EVENT_TYPES.removed, {
      server_id: serverId,
      display_name: record.display_name,
      launch_command: formatCommandPreview(record.command, record.args),
    });
    return { removed: true, event_id: entry.envelope.event_id };
  }

  /** 空闲回收（由宿主定时器驱动；返回被回收的 server 数） */
  async reclaimIdle(): Promise<number> {
    let reclaimed = 0;
    for (const [serverId, runtime] of this.#runtimes) {
      const wasReclaimed = await runtime.client.reclaimIfIdle();
      if (!wasReclaimed) continue;
      reclaimed += 1;
      // 空闲回收不改 enabled（下次调用会自动重启）；但状态要如实反映"进程已退"
      this.#deps.store.updateRuntimeState(serverId, { status: "disabled" }, this.#now().toISOString());
    }
    return reclaimed;
  }

  async close(): Promise<void> {
    for (const runtime of this.#runtimes.values()) {
      await runtime.client.close();
    }
    this.#runtimes.clear();
  }

  /**
   * 调用该 server 的某个工具（供 ToolInvoker 分派 MCP capability 用）。
   *
   * 这是「注册了但不可调」缺口的修复点：`enable` 把工具注册成 capability 后，
   * `ToolInvoker.invoke` 必须有一条能真正执行它的路径；否则注册表里显示 enabled、
   * 调用却报 `unknown_tool`（M7-B 之前在其他能力上踩过同一个坑）。
   *
   * 会话（runtime）按需懒启动：空闲回收后这里会自动重新拉起，不需要 enable 重来。
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: unknown,
  ): Promise<{ ok: boolean; text: string; error?: string; raw: unknown }> {
    const record = this.#deps.store.get(serverId);
    if (record === null) {
      return { ok: false, text: "", error: `MCP server "${serverId}" is not installed`, raw: null };
    }
    if (!record.enabled) {
      return { ok: false, text: "", error: `MCP server "${serverId}" is disabled`, raw: null };
    }
    let runtime = this.#runtimes.get(serverId);
    if (runtime === undefined) {
      // 空闲回收后重来：重建 client（下次调用会懒启动）
      runtime = {
        client: new McpClient({
          transportFactory: () => this.#deps.transportFactory(record),
          ...(this.#deps.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.#deps.idleTimeoutMs }),
        }),
        tools: [],
        unsupportedCapabilities: [],
        restarts: 0,
        lastError: null,
      };
      this.#runtimes.set(serverId, runtime);
    }
    const outcome = await runtime.client.callTool(toolName, args ?? {});
    if (!outcome.ok) runtime.lastError = outcome.error ?? "tool call failed";
    return { ok: outcome.ok, text: outcome.text, ...(outcome.error === undefined ? {} : { error: outcome.error }), raw: outcome.raw };
  }

  /** 健康快照（degraded 时带原因与重启次数——UI 要能解释"为什么不工作了"） */
  health(serverId: string): McpServerView["health"] | null {
    const record = this.#deps.store.get(serverId);
    if (record === null) return null;
    return this.#view(record).health;
  }

  // --- 内部 ---------------------------------------------------------------------------

  /** 把 server 的 tools 注册成 Morrow capabilities（五维权限全空） */
  #registerTools(
    record: McpServerRecord,
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>,
  ): { names: string[] } {
    const names: string[] = [];
    for (const tool of tools) {
      const manifest: CapabilityManifest = mcpToolToManifest(record.server_id, tool);
      try {
        this.#deps.capabilities.register(manifest, { actorId: "owner", verified: false });
        names.push(manifest.name);
      } catch (error) {
        // 注册失败不能让整台 server 启用失败（一个坏工具不该拖死其余）；
        // 但必须让 Owner 知道具体哪个工具没注册上。
        const message = error instanceof Error ? error.message : String(error);
        throw new McpServerError(
          "capability_registration_failed",
          `failed to register MCP tool "${mcpCapabilityName(record.server_id, tool.name)}": ${message}`,
        );
      }
    }
    return { names };
  }

  /**
   * 停用该 server 注册的工具。
   *
   * 用 `disable` 而不是"删除"：PermissionEngine 的生命周期是账本式的（只增不减），
   * 没有 unregister——这是刻意的，能力注册史不该被抹掉。停用后 `assertRuntimeUse`
   * 会以 `capability_disabled` 拒绝调用，效果与"消失"一致，但审计链仍完整。
   * 重新启用同一台 server 时，`register` 对同版本同内容幂等，再 `enable` 即可复活。
   */
  #unregisterTools(record: McpServerRecord, tools: Array<{ name: string }>): void {
    for (const tool of tools) {
      const name = mcpCapabilityName(record.server_id, tool.name);
      try {
        this.#deps.capabilities.disable(name);
      } catch {
        // 已不存在/已是 disabled：停用是幂等的，忽略
      }
    }
  }

  #view(record: McpServerRecord): McpServerView {
    const runtime = this.#runtimes.get(record.server_id);
    const health = runtime?.client.health();
    return {
      server_id: record.server_id,
      display_name: record.display_name,
      source: record.source,
      launch_command: formatCommandPreview(record.command, record.args),
      command: record.command,
      args: [...record.args],
      env_keys: [...record.env_keys],
      cwd: record.cwd,
      enabled: record.enabled,
      status: record.status,
      grants: this.#deps.store.grantsOf(record.server_id),
      health: {
        // 进程已回收但 server 仍 enabled：对外是 stopped（下次调用会自动拉起）
        state: health?.state ?? (record.enabled ? "stopped" : "stopped"),
        last_error: record.last_error ?? health?.lastError ?? null,
        restarts: health?.restarts ?? runtime?.restarts ?? 0,
        generation: record.generation,
        protocol_version: record.protocol_version,
        server_name: record.server_name,
        server_version: record.server_version,
        unsupported_capabilities: runtime?.unsupportedCapabilities ?? [],
        tools_count: runtime?.tools.length ?? 0,
      },
      risk_acknowledged: record.risk_acknowledged,
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
  }

  /**
   * 写审计事件。账本 `append` 只返回 `{ sequence }`（信封是我们自己构造的），
   * 所以这里把两者一起返回——调用方要 event_id（响应）也要 sequence（回链）。
   */
  #append(eventType: string, payload: Record<string, unknown>): { envelope: EventEnvelope; sequence: number } {
    const envelope = buildEventEnvelope({
      replicaId: this.#deps.replicaId,
      actorId: "owner",
      eventType,
      payload,
    });
    const { sequence } = this.#deps.ledger.append(envelope);
    return { envelope, sequence };
  }
}

/** 五维规范化：缺失维度补空数组；未知键丢弃（不静默接受拼错的键） */
export function normalizeGrants(input: Partial<McpServerGrants> | null | undefined): McpServerGrants {
  if (input === null || input === undefined) return { ...EMPTY_MCP_GRANTS };
  const read = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  };
  return {
    filesystem: read(input.filesystem),
    network: read(input.network),
    shell: read(input.shell),
    channels: read(input.channels),
    credentials: read(input.credentials),
  };
}

function toServerError(error: unknown): McpServerError {
  if (error instanceof McpInstallInputError) {
    return new McpServerError(error.code, error.message);
  }
  return new McpServerError("invalid_input", error instanceof Error ? error.message : String(error));
}
