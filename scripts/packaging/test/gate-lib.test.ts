/** 冒烟门库（T9 / Issue #10）：seam = 产物校验 / 二进制发现 / verdict / 报告构建。
 *
 * 负向路径是本票验收核心："人为移除任一产物步骤时门禁变红"——
 * 产物缺失必须落在 runArtifactChecks 的失败列表并令 verdict = fail。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildGateReport,
  findRuntimeBinary,
  gateVerdict,
  runArtifactChecks,
  type GateCheckItem,
} from "../src/gate-lib.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-gate-test-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("findRuntimeBinary", () => {
  it("目录内恰有一个 morrow-runtime-* 文件 → 返回其路径", () => {
    const dir = makeTmp();
    const binary = join(dir, "morrow-runtime-darwin-arm64");
    writeFileSync(binary, "");
    assert.equal(findRuntimeBinary(dir), binary);
  });

  it("目录为空 / 无匹配 → 抛错并给出目录与模式（负向路径）", () => {
    const dir = makeTmp();
    assert.throws(() => findRuntimeBinary(dir), /no morrow-runtime-\* binary in/);
  });

  it("多个匹配 → 抛错（宁失败不猜）", () => {
    const dir = makeTmp();
    writeFileSync(join(dir, "morrow-runtime-darwin-arm64"), "");
    writeFileSync(join(dir, "morrow-runtime-win32-x64.exe"), "");
    assert.throws(() => findRuntimeBinary(dir), /ambiguous/);
  });
});

describe("runArtifactChecks", () => {
  it("全部就位：文件存在 + 目录非空 → 无失败", () => {
    const dir = makeTmp();
    const binary = join(dir, "morrow-runtime-darwin-arm64");
    writeFileSync(binary, "");
    const bundleDir = join(dir, "bundle", "macos");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "Morrow.app"), "");

    const failures = runArtifactChecks([
      { label: "runtime binary", path: binary, kind: "file" },
      { label: "desktop bundle", path: bundleDir, kind: "dir-nonempty" },
    ]);
    assert.deepEqual(failures, []);
  });

  it("文件缺失 → 失败项含 label 与路径（负向路径：产物步骤被移除）", () => {
    const failures = runArtifactChecks([{ label: "runtime binary", path: "/no/such/binary", kind: "file" }]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].label, "runtime binary");
    assert.match(failures[0].reason, /missing/);
    assert.match(failures[0].reason, /\/no\/such\/binary/);
  });

  it("目录缺失与目录为空都算失败（桌面包 upload 步骤被移除的两种形态）", () => {
    const emptyDir = makeTmp();
    const failures = runArtifactChecks([
      { label: "bundle (missing)", path: join(emptyDir, "nope"), kind: "dir-nonempty" },
      { label: "bundle (empty)", path: emptyDir, kind: "dir-nonempty" },
    ]);
    assert.equal(failures.length, 2);
    assert.match(failures[0].reason, /missing/);
    assert.match(failures[1].reason, /empty/);
  });
});

describe("gateVerdict", () => {
  const ci = (id: GateCheckItem["id"], status: GateCheckItem["status"]): GateCheckItem => ({
    id,
    label: id,
    status,
    executor: "CI",
  });
  const micDeferred: GateCheckItem = {
    id: "microphone",
    label: "麦克风捕获探针",
    status: "deferred",
    executor: "真机（T10）",
  };

  it("CI 项全 pass + 真机项 deferred → PASS（真机项不计入 CI 门禁判定）", () => {
    assert.equal(
      gateVerdict({ checks: [ci("startup", "pass"), ci("health", "pass"), ci("sidecar", "pass"), micDeferred] }),
      "pass",
    );
  });

  it("任一 CI 项 fail → FAIL", () => {
    assert.equal(
      gateVerdict({ checks: [ci("startup", "pass"), ci("health", "fail"), ci("sidecar", "pass"), micDeferred] }),
      "fail",
    );
  });

  it("产物校验失败 → FAIL（AC：人为移除任一产物步骤时门禁变红）", () => {
    assert.equal(
      gateVerdict({
        artifactFailures: [
        { label: "desktop bundle", path: "/no/such/dir", reason: "missing dir-nonempty: /no/such/dir" },
      ],
        checks: [ci("startup", "pass"), ci("health", "pass"), ci("sidecar", "pass"), micDeferred],
      }),
      "fail",
    );
  });

  it("非真机项出现 deferred → FAIL（CI 项不允许用 deferred 逃逸）", () => {
    assert.equal(
      gateVerdict({ checks: [ci("startup", "deferred"), ci("health", "pass"), ci("sidecar", "pass"), micDeferred] }),
      "fail",
    );
  });
});

describe("buildGateReport", () => {
  const checks: GateCheckItem[] = [
    { id: "startup", label: "启动（standalone ready JSON → 优雅退出）", status: "pass", executor: "CI", detail: "probe exit=0" },
    { id: "health", label: "健康探针 /v1/health → 200 + 对话探针（内置 mock）", status: "pass", executor: "CI", detail: "probe exit=0" },
    { id: "sidecar", label: "sidecar 通信（生命周期 + 同套探针）", status: "pass", executor: "CI", detail: "probe exit=0" },
    { id: "microphone", label: "麦克风捕获探针（语音管线清单）", status: "deferred", executor: "真机（T10）" },
  ];

  it("报告含四项清单、平台元数据与机器可读 gate-result 行", () => {
    const report = buildGateReport({
      platform: "darwin",
      arch: "arm64",
      startedAt: "2026-10-29T00:00:00.000Z",
      elapsedMs: 1234,
      binaryPath: "/d/morrow-runtime-darwin-arm64",
      checks,
    });
    for (const fragment of [
      "Morrow M0 冒烟门报告",
      "darwin-arm64",
      "启动（standalone ready JSON → 优雅退出）",
      "健康探针 /v1/health → 200 + 对话探针（内置 mock）",
      "sidecar 通信（生命周期 + 同套探针）",
      "麦克风捕获探针（语音管线清单）",
      "gate-result: pass",
    ]) {
      assert.ok(report.includes(fragment), `report should include: ${fragment}`);
    }
  });

  it("报告写明真机门禁项边界（GUI 真机启动 + 麦克风探针 → T10，CI runner 无音频设备与 GUI 会话）", () => {
    const report = buildGateReport({
      platform: "darwin",
      arch: "arm64",
      startedAt: "2026-10-29T00:00:00.000Z",
      elapsedMs: 1,
      checks,
    });
    for (const fragment of ["真机门禁项", "T10", "无音频设备", "GUI 会话", "不计入 CI 门禁判定"]) {
      assert.ok(report.includes(fragment), `report should state boundary: ${fragment}`);
    }
  });

  it("verdict = fail 时报告列产物缺失并给出 gate-result: fail", () => {
    const report = buildGateReport({
      platform: "linux",
      arch: "x64",
      startedAt: "2026-10-29T00:00:00.000Z",
      elapsedMs: 5,
      artifactFailures: [
        { label: "desktop bundle", path: "/no/such/dir", reason: "missing dir-nonempty: /no/such/dir" },
      ],
      checks: checks.map((c) => (c.executor === "CI" ? { ...c, status: "fail" as const } : c)),
    });
    // 契约：失败项以 label 与路径出现在报告里（拼接格式不锁定）
    assert.ok(report.includes("desktop bundle"), "report should list the failing artifact label");
    assert.ok(report.includes("/no/such/dir"), "report should list the failing artifact path");
    assert.ok(report.includes("gate-result: fail"));
  });
});
