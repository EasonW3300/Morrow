# 0.1.0 发布检查表（M6 / Issue #54）

> **执行权与边界**：本清单由发布负责人在**发布工作树**（`integration/m0` 合并态）上逐项执行。
> **合并到 `main`、打 tag、push 一律标注「Owner 执行」——Agent 不得代跑**；本文件的用途是
> 让 Owner 按顺序勾选并复制命令。

- 发布版本：`0.1.0`
- 发布分支：`integration/m0`
- 发布准备基线：`0236012`（`merge: TECH-DEBT ChannelsView 拆分 + 通道生命周期语义下沉（#50）`）
  —— M6-T1/T2/T4 合并后 tip 会前移，**发布提交一律以 §0 `git rev-parse --short HEAD` 为准**，
  并在该 tip 上确认 §5 的 CI 证据
- 文档基线：[CHANGELOG.md](../../CHANGELOG.md)、[M4 门禁报告](../gates/m4-gate-report.md)、[威胁模型](../security/threat-model.md)
- 参考环境：macOS（Apple M4 Pro，Node 24.22.1 / pnpm 9.12.0 / bun 1.4.4）；CI 见 `.github/workflows/m0.yml`

---

## 0. 发布前确认（Owner）

- [ ] 确认发布提交就是 `integration/m0` 期望的 tip：`git rev-parse --short HEAD`
- [ ] 确认 CI 最新 run 全绿（见 §5 的 9/9 证据）
- [ ] 确认本机工具链：`node -v`（≥22，FTS5 需 22.16+ 或 24）、`pnpm -v`、`bun --version`
  （bun 未在 PATH 时用 `~/.bun/bin/bun`，打包脚本已内置回退）
- [ ] 确认工作树干净：`git status --porcelain` 无输出
- [ ] 确认「已知限制」与 [CHANGELOG.md](../../CHANGELOG.md) 的陈述一致（语音/附件/飞书资质/微信 Windows/AC-02/Tailscale）

```bash
git fetch origin
git checkout integration/m0
git pull --ff-only origin integration/m0
git rev-parse --short HEAD
git status --porcelain
```

## 1. 版本统一（0.1.0 单源）

- [ ] 根 `package.json`、`apps/runtime`、`apps/desktop`、`packages/*`、`scripts/packaging` 全部 `0.1.0`
- [ ] `apps/runtime/src/runtime.ts` 的 `VERSION` 取自本包 `package.json`（无第二个常量）
- [ ] 启动 Runtime 后 ready 行 / `/v1/health` 的 `version` 为 `0.1.0`

```bash
# 所有 workspace 包的名称与版本
node -e 'for (const f of ["package.json","apps/runtime/package.json","apps/desktop/package.json","packages/protocol/package.json","packages/pi-adapter/package.json","scripts/packaging/package.json"]) { const p = require("./" + f); console.log(f, p.name, p.version); }'

# VERSION 单源（应只见 packageJson.version 赋值）
grep -n "export const VERSION" apps/runtime/src/runtime.ts

# ready 行 / health 的版本（临时 dataDir，随机端口；Ctrl-C 结束）
MORROW_DATA_DIR="$(mktemp -d)" pnpm --filter @morrow/runtime start
# stdout 首行 {"ready":true,...,"version":"0.1.0",...}
```

- [x] 已在发布准备时核对：全部包 `0.1.0`，`VERSION = packageJson.version`（见提交说明）

## 2. 构建与测试门禁

- [ ] 依赖安装（锁文件不变）：`pnpm install --frozen-lockfile`
- [ ] 全 workspace 类型检查：`pnpm -r typecheck`
- [ ] Runtime 单元测试（排除真容器套件）：`pnpm --filter @morrow/runtime test:unit`
- [ ] 桌面 UI/逻辑测试（不触发 cargo）：`pnpm --filter @morrow/desktop test:ui`
- [ ] 打包脚本自身单测：`pnpm --filter @morrow/packaging test`

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm --filter @morrow/runtime test:unit
pnpm --filter @morrow/desktop test:ui
pnpm --filter @morrow/packaging test
```

> Node 版本提示：`test:unit` 依赖 SQLite FTS5。若本机 Node 为 22.12/22.13 等未编入 FTS5 的版本，
> 会报 `no such module: fts5`；用 Node 22.16+ / 24（例如 `PATH=/opt/homebrew/bin:$PATH`）复跑。

## 3. 发布产物（runtime 单二进制 + 探针）

- [ ] `pnpm pack:runtime` 成功，产物存在且可执行
- [ ] standalone 探针 PASS（health → sqlite → 对话 → 退出码 0）
- [ ] sidecar 探针 PASS（父进程拉起 / ready 握手 / SIGTERM 优雅退出 + 同套探针）
- [ ] （可选，完整门禁）`pnpm gate:runtime` 通过；本机无桌面 bundle 时 bundle 项记为 skipped
- [ ] （可选，CI 形态）桌面 `.app` 由 CI `build (macos)` 产出；本机需要时执行
      `pnpm --filter @morrow/desktop run tauri:build --bundles app`

```bash
pnpm pack:runtime
ls -lh scripts/packaging/dist/
pnpm probe:runtime:standalone
pnpm probe:runtime:sidecar
pnpm gate:runtime        # 可选：一键产物校验 + 双探针
```

- [x] 已在本机构建并跑通（结果见提交说明）：产物 `scripts/packaging/dist/morrow-runtime-darwin-arm64`，
      standalone / sidecar 探针均 PASS

## 4. 文档一致性与发布材料

- [ ] 根 `README.md`「当前状态」为 `0.1.0` + 已知限制摘要
- [ ] 根 `README.md` 文档导航含 M6 材料：威胁模型、M6 门禁报告、UI 走查、本检查表、CHANGELOG
- [ ] `CHANGELOG.md` 含 M0–M4 功能分组 + 「已知限制」
- [ ] `deploy/README.md`、`packages/channels/README.md`、`packages/voice/README.md` 与实现一致
- [ ] `docs/release/m6-checklist.md`（本文件）为最终版
- [ ] 根导航中的 M6 链接可达：`docs/security/README.md`、`docs/gates/m6-security-summary.md`、
      `docs/gates/m6-gate-report.md`、`docs/gates/m6-ui-walkthrough.md` 分别由 M6-T1 / T2 / T4 交付；
      这些分支合并前链接可能暂时 404，合并后应全部可达（发布前逐一点击确认）

```bash
# 快速自检：版本与已知限制关键词
grep -n "0.1.0\|已知限制" README.md CHANGELOG.md
grep -n "m6-gate-report\|m6-ui-walkthrough\|m6-checklist\|CHANGELOG" README.md
ls docs/release/m6-checklist.md CHANGELOG.md
```

## 5. CI 证据（integration/m0）

- [ ] 最新 `m0` workflow run 为 success，9/9 jobs 全绿
- [ ] 记录 run id 与 head sha 到发布记录

```bash
gh run list --repo EasonW3300/Morrow --branch integration/m0 --limit 3 \
  --json databaseId,headSha,status,conclusion,createdAt \
  --jq '.[] | "\(.databaseId) \(.headSha[0:7]) \(.status)/\(.conclusion) \(.createdAt)"'

gh run view <RUN_ID> --repo EasonW3300/Morrow \
  --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
```

- [x] 发布准备时的最新 run：`42953367507`（`integration/m0` @ `0236012`）——9/9 success：
      `typecheck + unit tests`、`build (macos/linux/windows)`、`gate (macos/linux/windows)`、
      `gate report (aggregate)`、`sandbox tests (ubuntu, real containers)`。
      历史参照：M4 门禁 run `42789125967`（8 job 全绿；typecheck/单测 job 为后续新增）。

## 6. 合并与打 tag —— **Owner 执行**

> 以下三条命令会改变 `main` 与远端，**只能由 Owner 在确认 §0–§5 全部勾选后手动执行**。
> Agent 不执行、不代跑。

```bash
# 6.1 切到 main 并快进/合并 integration/m0（保留里程碑合并结构）
git checkout main
git pull --ff-only origin main
git merge --no-ff integration/m0 -m "release: v0.1.0（M0–M4 合并态）"

# 6.2 打附注 tag（tag 指向 release 合并提交）
git tag -a v0.1.0 -m "Morrow v0.1.0 — M0–M4：事件账本/对话/记忆/任务/能力工厂/同步部署/渠道通知；M5 语音不在范围"

# 6.3 推送 main 与 tag
git push origin main --tags
```

- [ ] `git checkout main` + `git pull --ff-only origin main`（Owner 执行）
- [ ] `git merge --no-ff integration/m0 -m "release: v0.1.0（M0–M4 合并态）"`（Owner 执行）
- [ ] `git tag -a v0.1.0 -m "Morrow v0.1.0 — ..."`（Owner 执行）
- [ ] `git push origin main --tags`（Owner 执行）
- [ ] 在 GitHub Releases 以 `v0.1.0` tag 建 Release，正文取自 `CHANGELOG.md` 的 0.1.0 节

## 7. 发布后验证 —— **Owner 执行**

- [ ] `main` 上 CI `m0` workflow success
- [ ] `git ls-remote --tags origin v0.1.0` 可见 tag
- [ ] 从 `main` 重新 `pnpm install --frozen-lockfile && pnpm pack:runtime && pnpm probe:runtime`
      仍 PASS（发布提交可重现）
- [ ] 服务器形态：`scripts/deploy/install-ubuntu.sh --dry-run --binary <产物>` 通过（有 Ubuntu 时）

```bash
gh run list --repo EasonW3300/Morrow --branch main --limit 1
git ls-remote --tags origin v0.1.0
```

## 8. 回滚

- [ ] 保留上一版二进制与 dataDir 备份（见 [部署指南 §升级与回滚](../../deploy/README.md)）
- [ ] 二进制回滚：`sudo install -m 0755 <上一版二进制> /usr/local/bin/morrow && sudo systemctl restart morrow`
- [ ] 发布回滚：`git revert --no-commit <release merge>`（或重置 tag，需 Owner 明确决策）

```bash
# tag 回滚（仅 Owner，且仅在已发布 tag 有误时）
git tag -d v0.1.0
git push origin :refs/tags/v0.1.0
```

---

## 附：本次发布准备结果（Agent 执行，供 Owner 复核）

| 项 | 结果 |
|---|---|
| 版本统一 | 根 + 5 个 workspace 包均 `0.1.0`；`VERSION = packageJson.version`（`runtime.ts:109`），ready 行为 `0.1.0` |
| typecheck | `pnpm -r typecheck` 全绿（protocol / pi-adapter / runtime / desktop / packaging） |
| Runtime 单测 | `pnpm --filter @morrow/runtime test:unit` —— **738/738 pass**（node v24.22.1） |
| 桌面 UI 测试 | `pnpm --filter @morrow/desktop test:ui` —— **133/133 pass** |
| 打包脚本单测 | `pnpm --filter @morrow/packaging test` —— **56/56 pass** |
| 单二进制 | `scripts/packaging/dist/morrow-runtime-darwin-arm64`（87 MB 显示 / 101 MB 磁盘；bun 1.4.4，darwin-arm64） |
| 探针 | standalone PASS（version=0.1.0，health/sqlite/dialogue ok，exit 0）；sidecar PASS（阶段 A 优雅退出 + 阶段 B 同套探针） |
| 冒烟门 | `pnpm gate:runtime` —— **verdict PASS**（报告 `scripts/packaging/dist/gate-report-darwin-arm64.md`；无 `--bundle-dir`，bundle 项按本机快速门禁 skipped） |
| CI | `integration/m0` @ `0236012`，run `42953367507`，**9/9 success** |
| 发布准备中的修复 | 根 `gate:runtime` 脚本原先未传 `--binary-dir`，按文档执行会直接报 usage 错——已补默认 `--binary-dir scripts/packaging/dist`（不改产品行为） |
| 未执行 | 合并 main / tag / push（Owner） |
