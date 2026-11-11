/**
 * 沙箱夹具工具的元信息（sandbox.docker.test.ts 引用）。
 * 与 sandbox-fixture-tool.ts 分文件：工具本体 import 即执行（读 stdin），测试只能引用路径。
 */

import { fileURLToPath } from "node:url";

export const FIXTURE_TOOL = fileURLToPath(new URL("./sandbox-fixture-tool.ts", import.meta.url));

export type FixtureMode = "echo" | "network-probe" | "read-file" | "write-file" | "sleep" | "alloc" | "fail";
