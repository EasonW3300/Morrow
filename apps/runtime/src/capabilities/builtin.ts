import type { CapabilityManifest } from "@morrow/protocol";
import { MEMORY_WRITE_TOOL_PARAMETERS, MEMORY_WRITE_TOOL_NAME } from "../memory/tool.ts";
import type { PermissionEngine } from "./engine.ts";

/**
 * builtin 能力注册路径（票 M2-T1 / Issue #22）：把既有内置工具纳入注册表治理。
 *
 * memory.write（M1-T1 的前台 Memory Tool）迁移为注册表条目：启动时 ensure-registered
 * （幂等——同 name+version 同内容不再审计），author=human（Owner 交付的内置件，注册即
 * enabled）。会话工具注入改查注册表（runtime.ts 按 enabled 的 typescript 能力实例化
 * 内置工厂），行为不变——disable memory.write 后新会话不再注入该工具。
 *
 * manifest 口径：memory.write 是进程内记忆写入，不触文件系统/网络/shell/渠道/凭据，
 * 五维权限全空（任何 grant 下都可注册）；无沙箱（sandbox.type=none）——沙箱政策只约束
 * author=ai 的生成代码（§2 执行隔离），human builtin 不受限。
 */

/** memory.write 的 manifest v1（input_schema 与工具实现共享同一常量，无双真相源） */
export const MEMORY_WRITE_CAPABILITY_MANIFEST: CapabilityManifest = {
  name: MEMORY_WRITE_TOOL_NAME,
  version: "1.0.0",
  author: "human",
  runtime: "typescript",
  permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
  input_schema: MEMORY_WRITE_TOOL_PARAMETERS,
  output_schema: { type: "object" },
  sandbox: { type: "none", network: "none", filesystem: "none" },
  tests: [],
};

/** builtin 能力全集（后续内置工具在此追加——ensure-registered 逐个幂等注册） */
export function builtinCapabilityManifests(): CapabilityManifest[] {
  return [MEMORY_WRITE_CAPABILITY_MANIFEST];
}

/**
 * 启动时确保 builtin 能力已注册（幂等）：首见注册（capability.registered，actor
 * agent:runtime，payload 带 builtin 标记）；已注册同版本同内容 → no-op；同版本不同
 * 内容 → version_conflict 抛出（builtin 版本常量未随 manifest 演进升版，fail-fast 修常量）。
 */
export function ensureBuiltinCapabilities(engine: PermissionEngine): void {
  for (const manifest of builtinCapabilityManifests()) {
    engine.register(manifest, { actorId: "agent:runtime", builtin: true });
  }
}
