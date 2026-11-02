/**
 * Builder（票 M2-T3 / Issue #24，FR-CAP-3 代码构建：TS 生成 + 依赖锁定、版本固定 +
 * esbuild 打包为 T2 的 SandboxToolPackage 形态）。
 *
 * 产物布局（dataDir/capability-factory/<requestId>/package/）：
 *   package.json        依赖锁留档：dependencies 每条精确版本（^ ~ * latest 即拒——
 *                       plan-schema 是第一道闸，这里是写盘前的第二道，绕过校验的输入
 *                       也造不出浮动版本）
 *   src/tool.ts         生成源码原样落盘（不做改写——源码即证据，verifier 报告可回链）
 *   src/entry.ts        独立执行入口（运行时模板，注册后的调用路径）
 *   src/verify-entry.ts 容器内断言脚本（运行时模板，Verifier 的执行路径）
 *   dist/*.mjs          esbuild 编译验证产物（生成代码必须可打包——语法/引用错误在
 *                       构建阶段暴露为 tool_build_failed，不拖到沙箱里炸）
 *
 * esbuild 失败诊断透出（AC-06 失败日志可追踪）；构建失败不落半成品（先校验依赖、
 * 编译成功后才保留目录）。同 request 重复构建 = 幂等覆盖。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRY_TEMPLATE, VERIFY_TEMPLATE } from "./harness-templates.ts";
import type { ValidatedPlan } from "./types.ts";

const PINNED_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export type BuildResult =
  | {
      ok: true;
      packageDir: string;
      /** 独立执行入口（SandboxToolPackage.entry；DockerRunner 自行 esbuild 打包） */
      toolEntry: string;
      /** 容器内断言脚本入口（Verifier 用） */
      verifyEntry: string;
      sourcePath: string;
      dependencies: Record<string, string>;
    }
  | {
      ok: false;
      code: "dependency_not_pinned" | "tool_build_failed" | "invalid_request_id";
      detail: string;
      diagnostics?: string;
    };

export interface CapabilityBuilderOptions {
  dataDir: string;
}

export class CapabilityBuilder {
  readonly #dataDir: string;

  constructor(options: CapabilityBuilderOptions) {
    this.#dataDir = options.dataDir;
  }

  async build(input: { requestId: string; plan: ValidatedPlan }): Promise<BuildResult> {
    if (!REQUEST_ID_RE.test(input.requestId)) {
      return { ok: false, code: "invalid_request_id", detail: `request id "${input.requestId}" must match /^[A-Za-z0-9._-]{1,128}$/` };
    }
    // 依赖锁第二道闸（FR-CAP-3）：绕过 plan-schema 的输入也造不出浮动版本
    for (const [dep, version] of Object.entries(input.plan.dependencies)) {
      if (!PINNED_VERSION_RE.test(version)) {
        return {
          ok: false,
          code: "dependency_not_pinned",
          detail: `dependency "${dep}" is not pinned to an exact version (got "${version}"); FR-CAP-3 requires locked versions`,
        };
      }
    }

    const packageDir = join(this.#dataDir, "capability-factory", input.requestId, "package");
    const srcDir = join(packageDir, "src");
    rmSync(packageDir, { recursive: true, force: true });
    mkdirSync(srcDir, { recursive: true });

    const toolPath = join(srcDir, "tool.ts");
    const entryPath = join(srcDir, "entry.ts");
    const verifyEntryPath = join(srcDir, "verify-entry.ts");
    writeFileSync(toolPath, input.plan.source, "utf8");
    writeFileSync(entryPath, ENTRY_TEMPLATE, "utf8");
    writeFileSync(verifyEntryPath, VERIFY_TEMPLATE, "utf8");
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify(
        {
          name: input.plan.manifest.name,
          version: input.plan.manifest.version,
          private: true,
          type: "module",
          dependencies: input.plan.dependencies,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    // esbuild 编译验证：两个入口都必须可打包（失败即 tool_build_failed，目录回收）。
    // 产物落 package/dist/（编译证据留档；本地桩执行路径直接复用 verify 产物）。
    try {
      const distDir = join(packageDir, "dist");
      mkdirSync(distDir, { recursive: true });
      await bundleEntry(entryPath, join(distDir, "tool.mjs"));
      await bundleEntry(verifyEntryPath, join(distDir, "verify.mjs"));
    } catch (err) {
      rmSync(packageDir, { recursive: true, force: true });
      if (err instanceof BuildError) {
        return { ok: false, code: "tool_build_failed", detail: err.message, diagnostics: err.diagnostics };
      }
      return {
        ok: false,
        code: "tool_build_failed",
        detail: `esbuild bundling failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      ok: true,
      packageDir,
      toolEntry: entryPath,
      verifyEntry: verifyEntryPath,
      sourcePath: toolPath,
      dependencies: { ...input.plan.dependencies },
    };
  }
}

class BuildError extends Error {
  diagnostics: string;
  constructor(message: string, diagnostics: string) {
    super(message);
    this.name = "BuildError";
    this.diagnostics = diagnostics;
  }
}

/** esbuild 打包（动态 import——esbuild 为 devDependency；DockerRunner 同款决策） */
async function bundleEntry(entry: string, outfile: string): Promise<void> {
  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new BuildError("esbuild is required to build capability factory packages (devDependency of @morrow/runtime)", "");
  }
  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile,
      // 声明依赖从宿主 node_modules 解析（零网络安装；未安装即编译失败透出诊断）
      nodePaths: [nearestNodeModules()],
      logLevel: "silent",
    });
  } catch (err) {
    const diagnostics = err instanceof Error && "errors" in err ? formatEsbuildErrors(err) : "";
    throw new BuildError(`generated source failed to bundle: ${summaryOf(err)}`, diagnostics);
  }
}

function formatEsbuildErrors(err: Error): string {
  const errors = (err as unknown as { errors?: Array<{ text?: string; location?: { file?: string; line?: number } }> }).errors ?? [];
  return errors
    .slice(0, 10)
    .map((e) => `${e.location?.file ?? "?"}:${e.location?.line ?? "?"}: ${e.text ?? "build error"}`)
    .join("\n");
}

function summaryOf(err: unknown): string {
  const message = err instanceof Error ? err.message.split("\n").slice(0, 4).join(" | ") : String(err);
  return message.slice(0, 500);
}

/** 宿主 node_modules 探测：从本文件向上找最近一层（生成依赖经 esbuild nodePaths 解析） */
function nearestNodeModules(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(process.cwd(), "node_modules");
}
