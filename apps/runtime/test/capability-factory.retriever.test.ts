// 能力检索测试（票 M2-T3 / Issue #24，FR-CAP-1：先查现有能力避免重复造轮子）。
// 检索源：注册表（name 分词覆盖）+ 工厂描述索引（Jaccard）+ FTS 记忆（相关经验）。
// 命中已有能力 → reused=true（复用路径，不重建）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "../src/ledger.ts";
import { PermissionEngine } from "../src/capabilities/engine.ts";
import { DefaultCapabilityRetriever } from "../src/capabilities/factory/retriever.ts";
import type { CapabilityManifest } from "@morrow/protocol";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function manifestOf(name: string): CapabilityManifest {
  return {
    name,
    version: "1.0.0",
    author: "human",
    runtime: "typescript",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    sandbox: { type: "none", network: "none", filesystem: "none" },
    tests: [],
  };
}

function engineWith(dir: string, names: string[]): PermissionEngine {
  const ledger = EventLedger.open(dir);
  const engine = new PermissionEngine({ dataDir: dir, ledger, replicaId: REPLICA });
  for (const name of names) engine.register(manifestOf(name), { actorId: "owner" });
  return engine;
}

test("注册表命中：需求覆盖能力的全部 name 分词 → reused（复用路径，不重建）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "morrow-retr-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const engine = engineWith(dir, ["memory.write", "docx-to-markdown"]);
  const retriever = new DefaultCapabilityRetriever({
    capabilities: engine,
    describeCapabilities: () => [],
  });
  const result = retriever.retrieve("please convert these docx files to markdown");
  assert.equal(result.reused, true, "全部 name 分词被提及 → 复用");
  const top = result.matches.find((m) => m.name === "docx-to-markdown");
  assert.ok(top !== undefined);
  assert.equal(top.source, "registry");
  assert.equal(top.score, 1);
  assert.ok(result.memoryHits.length === 0);
});

test("注册表未命中：部分分词不算复用（防误判）；无关请求 reused=false", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "morrow-retr2-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const engine = engineWith(dir, ["docx-to-markdown"]);
  const retriever = new DefaultCapabilityRetriever({ capabilities: engine, describeCapabilities: () => [] });
  const partial = retriever.retrieve("convert my markdown notes into a pdf book");
  assert.equal(partial.reused, false, "只提及 markdown 一个分词 → 不复用");
  const unrelated = retriever.retrieve("generate a random password");
  assert.equal(unrelated.reused, false);
});

test("工厂描述索引命中：历史生成能力的 description 与需求 Jaccard ≥ 阈值 → reused（source=factory-index）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "morrow-retr3-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const engine = engineWith(dir, []);
  const retriever = new DefaultCapabilityRetriever({
    capabilities: engine,
    describeCapabilities: () => [
      { name: "csv-row-parse", description: "Parse a single csv row into json fields" },
    ],
  });
  const result = retriever.retrieve("parse one csv row into json fields for me");
  assert.equal(result.reused, true);
  const top = result.matches[0];
  assert.equal(top.source, "factory-index");
  assert.equal(top.name, "csv-row-parse");
});

test("FTS 记忆：memorySearch 命中带进 memoryHits（相关经验，不单独触发复用）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "morrow-retr4-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const engine = engineWith(dir, []);
  const searches: string[] = [];
  const retriever = new DefaultCapabilityRetriever({
    capabilities: engine,
    describeCapabilities: () => [],
    memorySearch: (q) => {
      searches.push(q);
      return [{ content: "上次用 pandoc 转过 docx", entry_kind: "fact" }];
    },
  });
  const result = retriever.retrieve("convert docx to pdf");
  assert.equal(result.reused, false, "记忆命中不等于能力复用");
  assert.equal(result.memoryHits.length, 1);
  assert.match(result.memoryHits[0].content, /pandoc/);
  assert.equal(searches.length, 1);
  assert.ok(searches[0].length > 0, "检索词非空");
});

test("检索词组装：记忆查询用需求分词（去掉停用词），无注册表命中时不误报", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "morrow-retr5-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const engine = engineWith(dir, ["memory.write"]);
  const retriever = new DefaultCapabilityRetriever({
    capabilities: engine,
    describeCapabilities: () => [],
    memorySearch: () => [],
  });
  const result = retriever.retrieve("I want to write something");
  assert.equal(result.reused, false, "泛化动词不构成 memory.write 复用");
});
