/**
 * Skill 包安装服务与路由（票 M7-B-T3 / Issue #68 补齐，FR-B7/B8/B10/B11）。
 *
 * 端点：
 *   POST   /v1/skills/packages/install     npm 安装（`--ignore-scripts` 强制）
 *   GET    /v1/skills/packages             已安装列表（来源/版本/权限/状态）
 *   POST   /v1/skills/packages/:name/upgrade   升级（**必须**先看 diff；扩权需显式接受）
 *   DELETE /v1/skills/packages/:name       卸载（删目录 + 禁用能力；审计保留）
 *
 * 为什么升级要两步：`upgrade` 默认只算 diff 并**不装**（除非显式 `confirm=true`）。
 * 决策 #14 要求"升级必须能看到权限变化"，所以第一次调用是"给我看 diff"，第二次
 * 才带 `confirm=true`（扩权还要再带 `accept_permission_widening=true`）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import type { PermissionEngine } from "../capabilities/engine.ts";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import {
  diffPermissions,
  installSkillPackage,
  SkillInstallError,
  type InstalledSkillPackage,
  type PermissionDiff,
} from "./installer.ts";
import type { SkillPackagePermissions } from "./manifest.ts";
import type { SkillPackageRecord, SkillPackageStore } from "./package-store.ts";

export const SKILL_PACKAGE_EVENT_TYPES = {
  installed: "skill_package.installed",
  upgraded: "skill_package.upgraded",
  uninstalled: "skill_package.uninstalled",
  installFailed: "skill_package.install_failed",
} as const;

export interface SkillPackageServiceDeps {
  store: SkillPackageStore;
  ledger: EventLedger;
  replicaId: string;
  capabilities: PermissionEngine;
  /** 包安装根（生产 `~/.morrow/skill-packages`） */
  packagesRoot: string;
  /** npm 执行接缝（测试注入，零真实 npm） */
  install?: (options: {
    spec: string;
    targetDir: string;
    packageDir: string;
  }) => Promise<InstalledSkillPackage>;
  now?: () => Date;
}

/** 升级 diff 的响应（第一次 upgrade 调用返回它） */
export interface UpgradePreview {
  package_name: string;
  from_version: string;
  to_version: string;
  diff: PermissionDiff;
  requires_confirmation: true;
  /** 扩权时需要额外接受 */
  requires_permission_widening_acceptance: boolean;
}

export class SkillPackageService {
  readonly #deps: SkillPackageServiceDeps;
  readonly #now: () => Date;

  constructor(deps: SkillPackageServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  list(): SkillPackageRecord[] {
    return this.#deps.store.list();
  }

  /**
   * 安装一个 npm 技能包。
   *
   * 顺序：安装（`--ignore-scripts`）→ 校验 manifest → 重算 source_hash → 注册能力
   * （五维权限 ⊆ grants，走 PermissionEngine 的同一入口）→ 落记录 → 审计。
   */
  async install(input: { spec: string }): Promise<{ package: SkillPackageRecord; installed: InstalledSkillPackage }> {
    const spec = input.spec.trim();
    const packageName = packageNameFromSpec(spec);
    if (this.#deps.store.get(packageName) !== null) {
      throw new SkillInstallError("already_installed", `skill package "${packageName}" is already installed (use upgrade)`);
    }
    const targetDir = join(this.#deps.packagesRoot, packageName);
    const packageDir = join(targetDir, "node_modules", packageName);

    let installed: InstalledSkillPackage;
    try {
      const runInstall =
        this.#deps.install ??
        ((options: { spec: string; targetDir: string; packageDir: string }) =>
          installSkillPackage({
            spec: options.spec,
            targetDir: options.targetDir,
            packageDir: options.packageDir,
          }));
      installed = await runInstall({ spec, targetDir, packageDir });
    } catch (error) {
      // 安装失败也要留审计（"试过装什么"是安全信号）
      this.#append(SKILL_PACKAGE_EVENT_TYPES.installFailed, {
        spec,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof SkillInstallError ? { code: error.code } : {}),
      });
      throw error;
    }

    // 能力注册走同一入口：permissions ⊆ grants 的校验在 PermissionEngine 里
    this.#deps.capabilities.register(installed.capability, { actorId: "owner" });

    const now = this.#now().toISOString();
    const record: SkillPackageRecord = {
      package_name: packageName,
      spec,
      version: installed.manifest.version,
      source_hash: installed.sourceHash,
      package_dir: installed.packageDir,
      capability: installed.capability.name,
      has_entry: installed.manifest.entry !== undefined,
      permissions: installed.manifest.permissions as unknown as Record<string, string[]>,
      status: "installed",
      installed_at: now,
      updated_at: now,
    };
    this.#deps.store.upsert(record);
    this.#append(SKILL_PACKAGE_EVENT_TYPES.installed, {
      package_name: packageName,
      spec,
      version: record.version,
      source_hash: record.source_hash,
      capability: record.capability,
      has_entry: record.has_entry,
      permissions: record.permissions,
    });
    return { package: record, installed };
  }

  /**
   * 升级（两步）。
   *
   * `confirm !== true` → 只把新版本装到**临时目录**读 manifest 算 diff，然后**删掉**；
   * 现有安装树与注册表都不动。这一点比"先真装再回滚"重要：升级预览不该产生任何
   * 持久副作用（真装会覆盖 node_modules，失败时安装已被破坏）。
   *
   * `confirm === true` → 装到正式目录；若 diff.widens 且未带 `acceptPermissionWidening`
   * 则拒绝（防止一次升级悄悄扩权）。**拒绝时不动现有安装**。
   */
  async upgrade(input: {
    packageName: string;
    spec?: string;
    confirm?: boolean;
    acceptPermissionWidening?: boolean;
  }): Promise<{ preview: UpgradePreview } | { package: SkillPackageRecord; installed: InstalledSkillPackage }> {
    const existing = this.#deps.store.get(input.packageName);
    if (existing === null) {
      throw new SkillInstallError("not_installed", `skill package "${input.packageName}" is not installed`);
    }
    const spec = input.spec?.trim() ?? existing.spec;
    const targetDir = join(this.#deps.packagesRoot, input.packageName);
    const packageDir = join(targetDir, "node_modules", input.packageName);

    // 先算出新版本的样子（不落库、不注册）：diff 需要新 manifest 的权限
    const runInstall =
      this.#deps.install ??
      ((options: { spec: string; targetDir: string; packageDir: string }) =>
        installSkillPackage({
          spec: options.spec,
          targetDir: options.targetDir,
          packageDir: options.packageDir,
        }));

    if (input.confirm !== true) {
      // 预览：装到临时目录（同盘 rename 更快，且绝不碰正式安装树）
      const stagingDir = join(this.#deps.packagesRoot, ".staging", `${input.packageName}-${this.#now().getTime()}`);
      let candidate: InstalledSkillPackage;
      try {
        candidate = await runInstall({
          spec,
          targetDir: stagingDir,
          packageDir: join(stagingDir, "node_modules", input.packageName),
        });
      } finally {
        // 无论成功失败都清掉暂存目录：预览不留任何持久产物
        if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
      }
      const diff = diffPermissions(
        existing.permissions as unknown as SkillPackagePermissions,
        candidate.manifest.permissions,
      );
      return {
        preview: {
          package_name: input.packageName,
          from_version: existing.version,
          to_version: candidate.manifest.version,
          diff,
          requires_confirmation: true,
          requires_permission_widening_acceptance: diff.widens,
        },
      };
    }

    const installed = await runInstall({ spec, targetDir, packageDir });
    const diff = diffPermissions(
      existing.permissions as unknown as SkillPackagePermissions,
      installed.manifest.permissions,
    );
    if (diff.widens && input.acceptPermissionWidening !== true) {
      throw new SkillInstallError(
        "permission_widening_not_accepted",
        "the new version requests additional permissions; review the diff and pass accept_permission_widening=true to proceed",
        { added: diff.added },
      );
    }

    this.#deps.capabilities.register(installed.capability, { actorId: "owner" });
    const now = this.#now().toISOString();
    const record: SkillPackageRecord = {
      ...existing,
      spec,
      version: installed.manifest.version,
      source_hash: installed.sourceHash,
      package_dir: installed.packageDir,
      capability: installed.capability.name,
      has_entry: installed.manifest.entry !== undefined,
      permissions: installed.manifest.permissions as unknown as Record<string, string[]>,
      status: "installed",
      updated_at: now,
    };
    this.#deps.store.upsert(record);
    this.#append(SKILL_PACKAGE_EVENT_TYPES.upgraded, {
      package_name: input.packageName,
      spec,
      from_version: existing.version,
      to_version: record.version,
      source_hash: record.source_hash,
      diff,
      permission_widening_accepted: diff.widens,
    });
    return { package: record, installed };
  }

  /** 卸载：禁用能力 + 删包目录 + 删记录；审计保留（`skill_package.uninstalled`） */
  uninstall(packageName: string): { removed: boolean; capability_disabled: boolean } {
    const existing = this.#deps.store.get(packageName);
    if (existing === null) return { removed: false, capability_disabled: false };
    let capabilityDisabled = false;
    try {
      this.#deps.capabilities.disable(existing.capability);
      capabilityDisabled = true;
    } catch {
      // 能力可能已被停用/不存在：卸载仍然继续（记录与目录才是"已安装"的真相）
    }
    // 删整棵安装树（含 node_modules）：留目录等于留一个可被执行的后门
    const tree = join(this.#deps.packagesRoot, packageName);
    if (existsSync(tree)) rmSync(tree, { recursive: true, force: true });
    this.#deps.store.delete(packageName);
    this.#append(SKILL_PACKAGE_EVENT_TYPES.uninstalled, {
      package_name: packageName,
      version: existing.version,
      capability: existing.capability,
      source_hash: existing.source_hash,
      capability_disabled: capabilityDisabled,
    });
    return { removed: true, capability_disabled: capabilityDisabled };
  }

  #append(eventType: string, payload: Record<string, unknown>) {
    const envelope = buildEventEnvelope({
      replicaId: this.#deps.replicaId,
      actorId: "owner",
      eventType,
      payload,
    });
    this.#deps.ledger.append(envelope);
  }
}

/**
 * 从 npm spec 取出包名（`@scope/pkg@1.2.3` → `@scope/pkg`）。
 *
 * 只做字符串处理，不做网络查询：包名的权威来源是 manifest，但安装**前**要按包名
 * 判重，所以需要这个纯函数。非法 spec 交给 `validateNpmSpec`（installer 里）报错。
 */
export function packageNameFromSpec(spec: string): string {
  const trimmed = spec.trim().replace(/^npm:/, "");
  const at = trimmed.lastIndexOf("@");
  // 不是 scope 的 @（即 at > 0）才是版本分隔符
  const base = at > 0 ? trimmed.slice(0, at) : trimmed;
  return base;
}

// --- 路由 ---------------------------------------------------------------------------

export interface SkillPackageRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: SkillPackageRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface SkillPackageRouteContext {
  packages: SkillPackageService;
}

export const skillPackageRoutes: SkillPackageRoute[] = [
  { method: "GET", re: /^\/v1\/skills\/packages$/, handler: handleList },
  { method: "POST", re: /^\/v1\/skills\/packages\/install$/, handler: handleInstall },
  { method: "POST", re: /^\/v1\/skills\/packages\/([^/]+)\/upgrade$/, handler: handleUpgrade },
  { method: "DELETE", re: /^\/v1\/skills\/packages\/([^/]+)$/, handler: handleUninstall },
];

function handleList(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: SkillPackageRouteContext): void {
  sendJson(res, 200, { packages: ctx.packages.list() });
}

async function handleInstall(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: SkillPackageRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const spec = body.spec;
  if (typeof spec !== "string" || spec.trim().length === 0) {
    sendError(res, 400, "invalid_body", 'a non-empty "spec" string is required (npm package name, optional @version)');
    return;
  }
  try {
    const result = await ctx.packages.install({ spec });
    sendJson(res, 201, {
      package: result.package,
      // 明确回传"postinstall 未执行"，让 UI 能直接说明安全性
      ignored_scripts: true,
      capability: result.installed.capability,
    });
  } catch (error) {
    sendPackageError(res, error);
  }
}

async function handleUpgrade(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: SkillPackageRouteContext,
  params: string[],
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    const result = await ctx.packages.upgrade({
      packageName: params[0],
      ...(typeof body.spec === "string" ? { spec: body.spec } : {}),
      confirm: body.confirm === true,
      acceptPermissionWidening: body.accept_permission_widening === true,
    });
    if ("preview" in result) {
      // 202：还没做，等你确认（并可能接受扩权）
      sendJson(res, 202, result.preview);
      return;
    }
    sendJson(res, 200, { package: result.package, ignored_scripts: true });
  } catch (error) {
    sendPackageError(res, error);
  }
}

function handleUninstall(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: SkillPackageRouteContext,
  params: string[],
): void {
  const result = ctx.packages.uninstall(params[0]);
  if (!result.removed) {
    sendError(res, 404, "not_found", `skill package ${params[0]} is not installed`);
    return;
  }
  sendJson(res, 200, { removed: true, capability_disabled: result.capability_disabled });
}

function sendPackageError(res: ServerResponse, error: unknown): void {
  if (error instanceof SkillInstallError) {
    const status =
      error.code === "not_installed"
        ? 404
        : error.code === "already_installed" || error.code === "permission_widening_not_accepted"
          ? 409
          : error.code === "npm_failed"
            ? 502
            : 400;
    sendError(res, status, error.code, error.message, {
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    return;
  }
  sendError(res, 500, "internal_error", error instanceof Error ? error.message : String(error));
}
