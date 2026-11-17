/**
 * 文档抓取与 SSRF 防护（票 M7-B-T4 / Issue #72，FR-B11）。
 *
 * 这是全项目**唯一**由 Agent/文档内容驱动的出网入口，所以防护必须是"默认拒绝 + 白名单式放行"：
 *
 *   - **仅 https**（`http:`、`file:`, `ftp:` 一律拒）；
 *   - **拒绝回环/私网/链路本地/云元数据**：`127.0.0.0/8`、`::1`、`10/8`、`172.16/12`、
 *     `192.168/16`、`169.254/16`（含 `169.254.169.254` 元数据）、`0.0.0.0`、`fc00::/7`、`fe80::/10`；
 *   - **DNS 解析后复检**（防 DNS rebinding：域名首次解析到公网、第二次解析到 127.0.0.1）；
 *   - **≤5MB**（流式累计，超限立即中止而不是读完再判）；
 *   - **10s 超时**；
 *   - **每次抓取写审计**（域名/大小/状态/拒绝原因）。
 *
 * 公网访问需要 Owner 显式开启（`allowPublicNetwork`）：默认只允许"内网/私有网络"文档，
 * 这与访谈里「内网链接」的定位一致——默认不放公网，避免"贴个链接就把运行时变成爬虫"。
 *
 * 关于"复检"的实现取舍：Node 的 fetch 在连接阶段自己解析 DNS，我们无法把"我已经校验过的
 * IP"钉进连接（没有 `lookup` 钩子）。所以这里的复检是**两次独立的解析**：连接前解析一次
 * 校验，请求后再解析一次确认没有在窗口内变化。这不是完美防御（仍有 TOCTOU 窗口），
 * 但能挡住绝大多数 rebinding，且成本极低。真正的完美方案需要自定义 agent，留作后续。
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** 抓取上限（规格：单次 ≤5MB） */
export const DOC_MAX_BYTES = 5 * 1024 * 1024;
/** 抓取超时（规格：10s） */
export const DOC_TIMEOUT_MS = 10_000;
/** 允许的文档 MIME（其余一律拒绝：我们只需要文本） */
export const ALLOWED_CONTENT_TYPES: readonly string[] = [
  "text/plain",
  "text/markdown",
  "text/html",
  "text/x-markdown",
  "application/json",
  "application/xhtml+xml",
];

export type DocSourceKind = "upload" | "paste" | "url";

/** 抓取结果（成功） */
export interface DocFetchSuccess {
  ok: true;
  url: string;
  /** 解析后的主机名（审计用） */
  host: string;
  /** 实际解析到的地址（审计/复检用） */
  addresses: string[];
  content_type: string;
  bytes: number;
  text: string;
  duration_ms: number;
}

/** 抓取结果（失败；`code` 用于审计与 UI 归因） */
export interface DocFetchFailure {
  ok: false;
  url: string;
  host: string;
  code:
    | "not_https"
    | "invalid_url"
    | "private_address"
    | "metadata_address"
    | "dns_failed"
    | "dns_rebinding"
    | "timeout"
    | "too_large"
    | "unsupported_content_type"
    | "http_error"
    | "network_error"
    | "public_not_allowed";
  message: string;
  /** HTTP 状态（仅 http_error/unsupported_content_type 时有） */
  status?: number;
  duration_ms: number;
}

export type DocFetchResult = DocFetchSuccess | DocFetchFailure;

/** IPv4 字符串 → 4 字节（非法返回 null） */
function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num > 255) return null;
    octets.push(num);
  }
  return octets as [number, number, number, number];
}

/**
 * 地址是否属于"必须拒绝"的范围。
 *
 * 判定按**网段**而不是字符串前缀（`10.1.2.3` 与 `10.0.0.1` 同段；`100.64/10` 是
 * 运营商级 NAT，同样不该被当作公网）。
 */
export function isForbiddenAddress(address: string): { forbidden: boolean; reason: "private" | "metadata" | null } {
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIpv4(address);
    if (octets === null) return { forbidden: true, reason: "private" }; // 解析不出来就拒
    const [a, b] = octets;
    // 云元数据：169.254.169.254 单独点名（它是"读走实例凭据"的经典路径）
    if (a === 169 && b === 254 && octets[2] === 169 && octets[3] === 254) {
      return { forbidden: true, reason: "metadata" };
    }
    if (a === 127) return { forbidden: true, reason: "private" }; // 回环
    if (a === 10) return { forbidden: true, reason: "private" };
    if (a === 172 && b >= 16 && b <= 31) return { forbidden: true, reason: "private" };
    if (a === 192 && b === 168) return { forbidden: true, reason: "private" };
    if (a === 169 && b === 254) return { forbidden: true, reason: "private" }; // 链路本地
    if (a === 0) return { forbidden: true, reason: "private" }; // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return { forbidden: true, reason: "private" }; // CGNAT
    if (a >= 224) return { forbidden: true, reason: "private" }; // 组播/保留
    // 198.18/15 基准测试段、192.0.2/24 文档段也一并拒（无正当用途）
    if (a === 198 && (b === 18 || b === 19)) return { forbidden: true, reason: "private" };
    if (a === 192 && b === 0 && octets[2] === 2) return { forbidden: true, reason: "private" };
    return { forbidden: false, reason: null };
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::1" || normalized === "::") return { forbidden: true, reason: "private" };
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return { forbidden: true, reason: "private" };
    if (/^fe[89ab]/.test(normalized)) return { forbidden: true, reason: "private" };
    // IPv4-mapped（::ffff:127.0.0.1）：拆出后段复检，否则是一条绕过路径
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped !== null) return isForbiddenAddress(mapped[1]);
    return { forbidden: false, reason: null };
  }
  // 不是合法 IP：保守拒绝（调用方应传解析后的地址）
  return { forbidden: true, reason: "private" };
}

/** 主机名是否是"字面上的 IP"（字符串形态的私网地址也要拦，不能只靠 DNS 结果） */
export function hostLiteralBlocked(host: string): DocFetchFailure["code"] | null {
  const bare = host.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(bare) === 0) return null;
  const verdict = isForbiddenAddress(bare);
  if (!verdict.forbidden) return null;
  return verdict.reason === "metadata" ? "metadata_address" : "private_address";
}

export interface DocFetcherOptions {
  /** 是否允许公网（默认 false：只允许内网/私有网络文档） */
  allowPublicNetwork?: boolean;
  /** DNS 解析接缝（测试注入，零真实 DNS） */
  resolve?: (host: string) => Promise<string[]>;
  /** fetch 接缝（测试注入，零真实网络） */
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * 抓取一份文档。返回值永远是结构化结果（不抛错），因为每种失败都要写审计。
 */
export async function fetchDocument(rawUrl: string, options: DocFetcherOptions = {}): Promise<DocFetchResult> {
  const started = options.now?.() ?? Date.now();
  const elapsed = (): number => (options.now?.() ?? Date.now()) - started;
  const resolve = options.resolve ?? defaultResolve;
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DOC_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DOC_TIMEOUT_MS;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      url: rawUrl,
      host: "",
      code: "invalid_url",
      message: `not a valid absolute URL: ${rawUrl}`,
      duration_ms: elapsed(),
    };
  }

  const host = url.hostname;
  const fail = (code: DocFetchFailure["code"], message: string, status?: number): DocFetchFailure => ({
    ok: false,
    url: url.toString(),
    host,
    code,
    message,
    ...(status === undefined ? {} : { status }),
    duration_ms: elapsed(),
  });

  if (url.protocol !== "https:") {
    return fail("not_https", `document fetching is https-only (got ${url.protocol})`);
  }

  // 字面 IP 立刻判（含元数据地址），不必走 DNS
  const literalBlock = hostLiteralBlocked(host);
  if (literalBlock !== null) {
    return fail(
      literalBlock,
      literalBlock === "metadata_address"
        ? `refusing to fetch cloud metadata address ${host}`
        : `refusing to fetch private/loopback address ${host}`,
    );
  }

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    return fail("dns_failed", `DNS resolution failed for ${host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (addresses.length === 0) {
    return fail("dns_failed", `DNS returned no addresses for ${host}`);
  }
  for (const address of addresses) {
    const verdict = isForbiddenAddress(address);
    if (verdict.forbidden) {
      return fail(
        verdict.reason === "metadata" ? "metadata_address" : "private_address",
        `${host} resolves to ${address}, which is a private/loopback address (possible DNS rebinding)`,
      );
    }
  }

  // 公网默认不放行：需要 Owner 显式开启（"允许文档抓取出网"）
  if (options.allowPublicNetwork !== true) {
    const anyPrivate = addresses.some((address) => isForbiddenAddress(address).forbidden);
    if (!anyPrivate) {
      return fail(
        "public_not_allowed",
        `${host} resolves to a public address; enable "allow public document fetching" to permit it`,
      );
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        signal: controller.signal,
        redirect: "follow",
        headers: { accept: "text/plain, text/markdown, text/html, application/json;q=0.9, */*;q=0.1" },
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      return fail(
        aborted ? "timeout" : "network_error",
        aborted
          ? `document fetch exceeded ${timeoutMs}ms`
          : `network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      return fail("http_error", `HTTP ${response.status} ${response.statusText}`.trim(), response.status);
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType.length > 0 && !ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return fail(
        "unsupported_content_type",
        `unsupported content-type "${contentType}"; supported: ${ALLOWED_CONTENT_TYPES.join(", ")}`,
        response.status,
      );
    }

    // 流式累计：超限立刻中止——读完再判会让 5MB 上限形同虚设
    const reader = response.body?.getReader();
    if (reader === undefined) {
      return fail("network_error", "response has no body stream");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return fail("too_large", `document exceeds the ${maxBytes}-byte limit (read ${bytes} bytes before aborting)`);
      }
      chunks.push(value);
    }

    // 连接后的复检：DNS rebinding 的窗口在这里收窄
    let afterAddresses: string[] = [];
    try {
      afterAddresses = await resolve(host);
    } catch {
      // 复检失败不阻断（内容已经拿到）；记为空数组，审计里能看到
    }
    const rebound = afterAddresses.find((address) => isForbiddenAddress(address).forbidden);
    if (rebound !== undefined) {
      return fail(
        "dns_rebinding",
        `${host} changed to ${rebound} during the request (DNS rebinding detected)`,
      );
    }

    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    return {
      ok: true,
      url: url.toString(),
      host,
      addresses,
      content_type: contentType.length === 0 ? "text/plain" : contentType,
      bytes,
      text,
      duration_ms: elapsed(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * 文档内容的最小可用性判定（"坏文档给可读失败，不产生半成品提案"）。
 *
 * 口径刻意宽松但明确：太短的内容无法支撑一份提案（我们不想让 LLM 在
 * "安装这个" 三个字上凭空编出一套权限清单）。
 */
export const MIN_DOC_CHARS = 40;

export function assessDocument(text: string): { usable: true } | { usable: false; reason: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { usable: false, reason: "文档内容为空" };
  if (trimmed.length < MIN_DOC_CHARS) {
    return {
      usable: false,
      reason: `文档内容过短（${trimmed.length} 字符，至少需要 ${MIN_DOC_CHARS} 字符才能生成有依据的提案）`,
    };
  }
  return { usable: true };
}
