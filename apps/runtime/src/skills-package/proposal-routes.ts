import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { DOC_MAX_BYTES, DOC_TIMEOUT_MS } from "./doc-fetch.ts";
import { ProposalError, type InstallProposal } from "./proposal.ts";
import type { InstallProposalService } from "./proposal-service.ts";

/**
 * 智能安装路由（票 M7-B-T4 / Issue #72，FR-B9/B12）：
 *
 *   POST /v1/skills/propose                  生成提案（三种来源：upload/paste/url）
 *   GET  /v1/skills/proposals?status=        提案列表（默认全部；Owner 审阅用）
 *   GET  /v1/skills/proposals/:id            提案详情（含权限清单与示例调用）
 *   POST /v1/skills/proposals/:id/confirm    确认并落地（第三/四道门）
 *   POST /v1/skills/proposals/:id/reject     拒绝（只改状态，不产生产物）
 *   GET  /v1/skills/proposal-config          抓取上限与公网开关的当前值
 *
 * 命名注意：既有 `POST /v1/skills/propose` 已被 M2-T5 的"案例晋升提案"占用
 * （那是**已有案例**晋升为 skill，不是文档安装）。为避免语义撞车，本票的安装提案
 * 走 `proposals` 路径族；`propose` 只做**输入形状分派**：带 `source_kind` 的请求
 * 走安装提案，其余按既有行为。分派放在路由表里而不是同一 handler 内，见下。
 */

export interface ProposalRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: ProposalRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface ProposalRouteContext {
  proposals: InstallProposalService;
  /** 抓取策略快照（URL 来源的可用性说明） */
  fetchPolicy: { allowPublicNetwork: boolean; maxBytes: number; timeoutMs: number };
}

export const proposalRoutes: ProposalRoute[] = [
  { method: "POST", re: /^\/v1\/skill-install\/propose$/, handler: handlePropose },
  { method: "GET", re: /^\/v1\/skill-install\/proposals$/, handler: handleList },
  { method: "GET", re: /^\/v1\/skill-install\/proposals\/([^/]+)$/, handler: handleGet },
  { method: "POST", re: /^\/v1\/skill-install\/proposals\/([^/]+)\/confirm$/, handler: handleConfirm },
  { method: "POST", re: /^\/v1\/skill-install\/proposals\/([^/]+)\/reject$/, handler: handleReject },
  { method: "GET", re: /^\/v1\/skill-install\/config$/, handler: handleConfig },
];

/**
 * 语义分派说明：既有 `POST /v1/skills/propose` 是案例晋升（M2-T5），本票的
 * "文档 → 提案"必须另起路径族，否则一个 URL 里有 `source_kind` 就会被误当授权。
 * 用 `/v1/skill-install/*` 命名：安装（install）与晋升（promote）在语义上分开。
 */

async function handlePropose(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ProposalRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;

  const sourceKind = body.source_kind;
  if (sourceKind !== "upload" && sourceKind !== "paste" && sourceKind !== "url") {
    sendError(res, 400, "invalid_body", 'source_kind must be "upload", "paste" or "url"');
    return;
  }

  const urlValue = typeof body.url === "string" ? body.url.trim() : "";
  const textValue = typeof body.text === "string" ? body.text : "";
  const fileName = typeof body.file_name === "string" ? body.file_name.trim() : "";

  if (sourceKind === "url" && urlValue.length === 0) {
    sendError(res, 400, "invalid_body", 'source_kind=url requires a "url" string');
    return;
  }
  if (sourceKind !== "url" && textValue.trim().length === 0) {
    sendError(res, 400, "invalid_body", "source_kind=upload/paste requires non-empty \"text\"");
    return;
  }
  if (sourceKind === "upload" && Buffer.byteLength(textValue, "utf8") > DOC_MAX_BYTES) {
    // 上传内容也受同一上限：否则"上传文件"会成为绕过 5MB 限制的路径
    sendError(res, 413, "payload_too_large", `uploaded document exceeds the ${DOC_MAX_BYTES}-byte limit`);
    return;
  }

  try {
    const result = await ctx.proposals.propose({
      sourceKind,
      sourceRef: sourceKind === "url" ? urlValue : sourceKind === "upload" ? fileName || "uploaded file" : "pasted text",
      ...(sourceKind === "url" ? { url: urlValue } : { text: textValue }),
    });
    sendJson(res, 201, {
      proposal: result.proposal,
      // 抓取证据回传（成功时含解析地址与字节数；失败时不会有提案，故这里必为成功或 null）
      doc_fetch: result.doc_fetch,
      /** 明确：提案阶段没有任何注册/代码落地 */
      materialized: false,
    });
  } catch (error) {
    sendProposalError(res, error);
  }
}

function handleList(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ProposalRouteContext,
): void {
  const status = url.searchParams.get("status");
  if (status !== null && !["pending", "confirmed", "materialized", "rejected", "failed"].includes(status)) {
    sendError(res, 400, "invalid_query", "status must be pending|confirmed|materialized|rejected|failed");
    return;
  }
  const proposals = ctx.proposals.list(status === null ? {} : { status: status as InstallProposal["status"] });
  sendJson(res, 200, { proposals });
}

function handleGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ProposalRouteContext,
  params: string[],
): void {
  const proposal = ctx.proposals.get(params[0]);
  if (proposal === null) {
    sendError(res, 404, "proposal_not_found", `proposal ${params[0]} does not exist`);
    return;
  }
  // 预览即详情：权限清单、示例调用、不确定点全部原样给出
  sendJson(res, 200, { proposal, materialized: proposal.status === "materialized" });
}

async function handleConfirm(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ProposalRouteContext,
  params: string[],
): Promise<void> {
  try {
    const proposal = await ctx.proposals.confirm(params[0]);
    sendJson(res, 200, {
      proposal,
      materialized: proposal.status === "materialized",
      materialized_as: proposal.materialized_as,
      ...(proposal.error === null ? {} : { error_message: proposal.error }),
    });
  } catch (error) {
    sendProposalError(res, error);
  }
}

async function handleReject(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ProposalRouteContext,
  params: string[],
): Promise<void> {
  // reject 允许空 body
  let reason: string | undefined;
  const contentType = req.headers["content-type"];
  if (contentType !== undefined && /^application\/json\b/i.test(contentType.trim())) {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    if (typeof body.reason === "string") reason = body.reason;
  }
  try {
    const proposal = ctx.proposals.reject(params[0], reason === undefined ? {} : { reason });
    sendJson(res, 200, { proposal, materialized: false });
  } catch (error) {
    sendProposalError(res, error);
  }
}

function handleConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ProposalRouteContext,
): void {
  sendJson(res, 200, {
    /** 抓取只有 https；公网默认关闭（需要 Owner 显式开启） */
    https_only: true,
    allow_public_network: ctx.fetchPolicy.allowPublicNetwork,
    max_bytes: ctx.fetchPolicy.maxBytes,
    timeout_ms: ctx.fetchPolicy.timeoutMs,
    /** 默认拒绝的地址段（UI 直接展示给 Owner 看） */
    blocked_ranges: [
      "127.0.0.0/8",
      "::1",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
      "169.254.169.254 (cloud metadata)",
      "fc00::/7",
      "fe80::/10",
    ],
    /** 提案阶段不产生任何注册或代码 */
    proposes_only: true,
  });
}

function sendProposalError(res: ServerResponse, error: unknown): void {
  if (error instanceof ProposalError) {
    const status =
      error.code === "proposal_not_found"
        ? 404
        : error.code === "bad_document"
          ? 422
          : error.code === "not_confirmable"
            ? 409
            : error.code === "materialization_failed"
              ? 500
              : 400;
    sendError(res, status, error.code, error.message);
    return;
  }
  sendError(res, 500, "internal_error", error instanceof Error ? error.message : String(error));
}

/** 抓取策略默认值（供 runtime 装配时显式传入，避免隐式默认散落） */
export const DEFAULT_FETCH_POLICY = {
  allowPublicNetwork: false,
  maxBytes: DOC_MAX_BYTES,
  timeoutMs: DOC_TIMEOUT_MS,
} as const;
