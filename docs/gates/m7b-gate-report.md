# M7 阶段 B 门禁报告（#73）

- **阶段**：M7-B 能力扩展（FR-B1..B16）
- **规格**：#66（`docs/prd/PRD-M7.md` 决策 #7–#22）
- **集成分支**：`integration/m7b`
- **验证时间**：2026-11-17（含 code-review 修复批 `60c156c`）
- **验证口径**：Node 24.22 / macOS arm64（本机 Docker 可用，真实容器测试实跑）

## 0. 一句话结论

阶段 B 的 16 条功能性需求全部有代码与测试证据；**22 条用户故事中 21 条完整覆盖**，
1 条（story 4「默认 disabled」在 UI 上的显式状态提示）在 B2 已实现但缺少一条独立的
UI 断言，列为已知小缺口（见 §5）。建议打 `v0.3.0`。

## 1. 测试与静态检查总账

| 项 | 数值 | 命令 |
|---|---|---|
| runtime 单元/集成测试 | **1119 通过 / 0 失败** | `node --experimental-sqlite --experimental-strip-types --test test/*.test.ts`（排除容器套件） |
| runtime 真实容器套件 | **12 通过 / 0 失败** | `test/exec.container.test.ts`（本机 docker） |
| desktop UI 逻辑测试 | **244 通过 / 0 失败** | `node --experimental-strip-types --test "src/*.test.ts"` |
| 全 workspace typecheck | 干净 | `pnpm -r typecheck` |

阶段 B 新增测试分布：

| 票 | 测试文件 | 用例数 |
|---|---|---|
| B1 (#67) | `mcp-protocol` / `mcp-client` / `mcp-tools-stdio` | 11 + 17 + 10 |
| B3 (#68) | `skill-manifest` / `skill-installer` / `skill-package.api` | 15 + 13 + 9 |
| B5 (#69) | `command-palette`（desktop） | 23 |
| B6 (#70) | `exec-danger-rules` / `exec-mode` / `exec-service` / `exec.api` / `exec-runner-args` / `exec.container` | 27 + 22 + 26 + 17 + 12 + 12 |
| B2 (#71) | `mcp-install` / `mcp.api` | 26 + 18 |
| B4 (#72) | `skill-install-doc-fetch` / `skill-install-proposal` / `skill-install.api` | 28 + 18 + 19 |
| code-review 修复批 | `m7b-review-fixes` | 6 |

## 2. FR-B1..B16 逐条证据

### 4.1 MCP

| 编号 | 需求 | 实现 | 证据（测试名/断言） | 状态 |
|---|---|---|---|---|
| **FR-B1** | 「扩展 → MCP」页：粘贴 JSON/命令安装；模板预填 | `mcp/install.ts`（`parseInstallInput` / `MCP_TEMPLATES`）、`mcp/routes.ts`、`McpInstallView.tsx` | `mcp-install.test.ts`「命令形态：解析出 command 与 args」「JSON：标准 mcpServers 形状（多台）」「模板只产预填草稿…不含任何安装/授权语义」；`mcp.api.test.ts`「GET templates：只预填（不产生安装）」 | ✅ |
| **FR-B2** | 展示完整未截断命令 + 风险勾选；默认 disabled | `assertRiskAcknowledged`（服务层硬校验）、`formatCommandPreview`（不截断）、`risk_ack_text` 原文落库 | 「未勾选风险确认 → 400，且库里没有记录」「勾选后安装成功：201 + 默认 disabled + 完整命令回传」「formatCommandPreview：完整命令不截断（超长参数原样保留）」 | ✅ |
| **FR-B3** | 协议双代际（discover 优先；Unsupported 换版本不回退；其他错误回退 initialize） | `mcp/protocol.ts` + `mcp/client.ts` 三分支 | `mcp-client.test.ts`：「分支 1：discover 成功」「分支 2 边界：server 支持的版本与我们无交集 → degraded，且**不**尝试 initialize」「分支 3：其他错误 → 回退 initialize」 | ✅ |
| **FR-B4** | 懒启动、空闲 10min 退出、崩溃重启 ≤3 次后 degraded | `McpClient.ensureReady`（懒启动）、`reclaimIfIdle`、`DEFAULT_IDLE_TIMEOUT_MS=10min`、`DEFAULT_MAX_RESTARTS=3` | `mcp-client.test.ts`「空闲回收：超过阈值后关闭传输」「重启超上限 → degraded 且后续调用直接拒绝（不再无声重试）」 | ✅ |
| **FR-B5** | 工具注册为 capability，受五维权限；默认无 shell/网络 | `mcp/tools.ts`（`mcpToolToManifest` 权限全空）、`mcp/service.ts` `#registerTools` 走 `PermissionEngine.register`（⊆ grants 校验） | `mcp-tools-stdio.test.ts`「默认权限全空（装 server 不等于全权）」；`mcp.api.test.ts`「启用：…注册工具为 capability」断言 `permissions.filesystem === []` | ✅ |
| **FR-B6** | 「已安装」页展示来源/状态/权限/健康 | `McpServerService.#view`（含 `grants` / `health` / `launch_command`）、`mcp-ui.ts`（`grantsSummary` / `healthDetail`） | `mcp.api.test.ts`「GET servers：来源/状态/权限/健康一处齐全」；`mcp-ui.test.ts`「健康详情：degraded 时带原因与重启次数」 | ✅ |

### 4.2 Skill 包

| 编号 | 需求 | 实现 | 证据 | 状态 |
|---|---|---|---|---|
| **FR-B7** | npm 安装：`--ignore-scripts`、解析 manifest、`source_hash` 校验 | `manifest.ts` `npmInstallArgs`（`--ignore-scripts` 在首位）、`installer.ts` 服务端重算哈希 | `skill-manifest.test.ts` 断言 argv；`skill-installer.test.ts`「source_hash 不符 → 拒绝」+ **负向对照**（去掉 `--ignore-scripts` 时探针触发）；HTTP 面：`skill-package.api.test.ts`「安装：201 + 记录 + 能力注册 + ignored_scripts 标记」 | ✅ |
| **FR-B8** | 有 `entry` 必须带 `sandbox` + `tests`，只能注册 sandboxed | `validateSkillManifest` + `deriveCapabilityManifest`（entry → `container`，**忽略包内更宽松声明**） | `skill-manifest.test.ts`「有 entry 但缺 sandbox → 拒绝」「sandbox.type 非 container → 拒绝」「缺 tests → 拒绝」；`skill-installer.test.ts`「deriveCapabilityManifest 忽略包内宽松 sandbox 声明」 | ✅ |
| **FR-B9** | 智能安装：三种来源 → 提案 → 预览 → 确认 | `doc-fetch.ts` / `proposal.ts` / `proposal-service.ts` / `proposal-routes.ts` / `SkillInstallView.tsx` | 「paste 来源：产提案」「upload 来源」「url 来源：抓取成功后产提案」「**未确认时无任何落地**：提案 pending，无 skill、无 factory request」「确认纯组合提案 → 创建声明式 skill」「确认需要新工具的提案 → 交 Tool Factory」 | ✅ |
| **FR-B10** | 升级手动 + 权限 diff；卸载保留审计 | `package-service.ts` `upgrade`（两步 + 扩权双重同意）、`uninstall` | 「升级默认只返回 diff（202），**不装**新版本」「升级扩权：未显式接受 → 409；接受后升级成功并记 diff 审计」「卸载：记录消失、能力被禁用、审计保留」 | ✅ |
| **FR-B11** | 出网：仅 https、禁回环/私网/元数据、≤5MB、10s、审计 | `doc-fetch.ts`（`isForbiddenAddress` / DNS 复检 / 流式截断 / AbortController） | 28 条：`「回环地址被拒（127/8 全域）」「私网三段被拒」「链路本地与云元数据被拒」「IPv4-mapped IPv6 绕过路径被堵住」「DNS 解析到私网 → 拒绝」「抓取后的 DNS 复检发现 rebinding」「超过大小上限 → too_large」「超时 → timeout」` + `「每次抓取有审计」`（`skill.api.test.ts`） | ✅ |

### 4.3 命令面板与 bash

| 编号 | 需求 | 实现 | 证据 | 状态 |
|---|---|---|---|---|
| **FR-B12** | `/` 面板：命令区 + 技能区、逐字过滤、键盘选择 | `command-palette.ts`（`matchScore` 0/1/2 三档 + `moveIndex` 回绕）、`CommandPalette.tsx` | `command-palette.test.ts` 23 项（前缀/中缀/子序列匹配、↑↓ 回绕、Enter/Esc、技能区） | ✅ |
| **FR-B13** | 容器沙箱 `network none` + workspace 挂载 + 超时/输出上限 | `exec/runner.ts` `buildExecDockerArgs` / `ContainerExecRunner` | `exec-runner-args.test.ts`「网络一律 none」「根只读 + tmpfs」「有工作区时挂载 /workspace」「输出按字节截断」；**真实容器**：`exec.container.test.ts`「联网被阻断（--network none 的正面证据）」「超时被杀」「输出超限被截断」「workspace 挂载可写」「容器内 ~/.ssh 不存在」 | ✅ |
| **FR-B14** | 会话级模式开关，默认每次确认，关闭会话失效 | `exec/mode.ts` `ExecModeRegistry` + `SessionManager.executionEpoch`（代际号） | `exec-mode.test.ts` 22 项，含「默认模式是每次确认」「关闭会话后模式失效」「**关闭再恢复不会继承「完全权限」（代际号防绕过）**」；`exec.api.test.ts`「关闭会话后：模式失效，且恢复后的会话回到默认」 | ✅ |
| **FR-B15** | 完全权限下：危险模式硬拦截 + 快照 + 审计 | `danger-rules.ts` 12 条规则 + `snapshot.ts` + `exec/service.ts` | 「完全权限下危险命令**仍然**被拒」；`exec-service.test.ts`「有工作区时执行前必须快照」「执行结果写 exec.finished 审计」；27 项规则测试含**每个危险意图的多种写法变体** | ✅ |
| **FR-B16** | 只读首确认后免确认；写/网络/危险逐次确认并展示完整脚本 | `isReadOnlyScript` + `ExecModeRegistry.decide/recordConfirmation` | 「只读命令第一次仍需确认（why=readonly_first_time）」「确认过只读命令后，后续只读免确认」「写命令每次都要确认」「确认过写命令**不会**顺带免除只读确认」「需要确认时回传的脚本与输入逐字一致（不做截断/归一化）」 | ✅ |

## 3. 22 条用户故事覆盖

| # | 故事 | 覆盖 | 证据 |
|---|---|---|---|
| 1 | 粘贴 JSON/命令就装 MCP | ✅ | `mcp-install.test.ts` 命令/JSON 双形态 |
| 2 | 模板可点选预填 | ✅ | `mcp-install.test.ts`「模板只产预填草稿」；`installs_on_select: false` |
| 3 | 安装前看到完整未截断命令 + 宿主权限告知 | ✅ | 「完整命令不截断」+ `MCP_RISK_ACK_TEXT` 含「不是沙箱」 |
| 4 | 新装默认 disabled，显式启用与授权 | ✅（代码） | 「安装后默认 disabled」；启用与授权分离（`grants` 全空断言） |
| 5 | MCP 工具受五维权限（默认无 shell/网络） | ✅ | `mcp-tools-stdio.test.ts` 默认权限全空 |
| 6 | 进程空闲退出、崩溃重启有上限 | ✅ | `mcp-client.test.ts` 空闲回收 + degraded |
| 7 | 「已安装」页统一看来源/状态/权限 | ✅ | `mcp.api.test.ts` FR-B6 用例 |
| 8 | 粘 npm 包名就装技能包 | ✅ | `skill-package.api.test.ts` 安装用例 |
| 9 | npm 安装不执行 postinstall | ✅ | `--ignore-scripts` 断言 + 负向对照 |
| 10 | 可执行部分只能沙箱跑，须声明 sandbox + tests | ✅ | `skill-manifest.test.ts` 三连拒绝 |
| 11 | 上传文档/文本/内网链接 → 安装提案 | ✅ | 三种来源各有用例 |
| 12 | 提案必须经确认才落地 | ✅ | 「未确认时无任何落地」 |
| 13 | 升级时看到权限差异 | ✅ | 升级两步 + `diff.widens` |
| 14 | 卸载保留审计与调用历史 | ✅ | 「卸载：…审计保留」 |
| 15 | 输入 `/` 就看到命令与技能 | ✅ | `command-palette.test.ts` |
| 16 | 会话里让 Agent 写脚本并执行（容器） | ✅ | `exec.container.test.ts` 全绿 |
| 17 | 会话级选「每次确认 / 完全权限」 | ✅ | `exec.api.test.ts` 模式端点 |
| 18 | 完全权限下仍拦危险命令 | ✅ | `exec-service.test.ts` 核心用例 |
| 19 | 宿主执行前有快照、可撤销（bounds 明示） | ✅ | 快照 + `SNAPSHOT_SCOPE_NOTICE` 随响应回传并 UI 常驻 |
| 20 | 只读命令首确认后免二次确认 | ✅ | `exec-mode.test.ts` 只读豁免用例 |
| 21 | 沙箱有网络阻断/超时/输出上限的可验证证据 | ✅ | 真实容器 12 项（联网失败是正面证据） |
| 22 | 执行模式在关闭会话后失效 | ✅ | 代际号防绕过（关闭→恢复不继承） |

## 4. 三个接缝的落实

| 接缝 | 位置 | 测试注入点 |
|---|---|---|
| HTTP/SSE 主接缝 | `runtime.ts` 路由表 | 全部 `*.api.test.ts` 黑盒 |
| `McpClient` | `mcp/client.ts`（`transportFactory`） | `McpClient` 单测 + `mcp.api.test.ts` 的 `mcpTransportFactory` |
| `LocalExecRunner` | `exec/runner.ts`（`ExecRequest`/`ExecResultView`） | `exec-service.test.ts` 的 FakeExecRunner；真实容器另有一套 |

另有两个为"零网络/零 npm"新增的内部接缝（规格允许）：

- `ProposalGenerator`（`proposal.ts`）— 生产用 Provider 一次 prompt，测试用脚本化生成器；
- `skillPackageInstall`（`package-service.ts`）— 测试注入假安装结果，零 npm；
- `skillInstallFetch`（`doc-fetch.ts` 的 `fetchDocument` 选项）— 测试注入假抓取，零 DNS/网络。

## 5. 偏差与已知缺口（如实记录）

### 5.1 路径命名偏差（已记录，非缺陷）

- PRD §4.3 的端点清单写 `POST /v1/exec/mode` / `POST /v1/sessions/:id/exec`；实现取
  **会话路径** `PUT /v1/sessions/:id/exec-mode` + `POST /v1/sessions/:id/exec`。
  理由：执行模式是会话级状态，sessionId 放路径比放 body 更难写错，也让"关闭会话即失效"
  在语义上更直观（对已关闭会话返回 409）。**票 #70 的正文本身写作 `exec-mode`**，
  PRD 表格是概览性清单，以票面为准。
- 智能安装的路径族取 `/v1/skill-install/*` 而非 `/v1/skills/propose`：后者已被
  M2-T5 的"案例晋升提案"占用；两者语义完全不同（晋升已有案例 vs 从文档安装），
  混在同一路径会让人误把"贴文档"当"批准晋升"。

### 5.2 交付过程中发现并修复的真实缺口

| 缺口 | 发现方式 | 处理 |
|---|---|---|
| B3 (#68) 只交付库层，无 HTTP 端点/已安装记录/UI → FR-B7/B10 无法验收 | B7 逐条取证时核对 `runtime.ts` 路由表，发现 `installSkillPackage` 无调用点 | 补 `package-store.ts` / `package-service.ts` / 路由 / `SkillPackagesView.tsx` + 9 项测试（commit `7150a44`） |
| 升级预览会真实覆盖 `node_modules` | 写测试时"预览后版本应仍是旧的"失败 | 预览改为装到 `.staging/` 临时目录、算完 diff 立即删除 |
| 危险规则漏拦 `sudo -u root rm -rf /` | 规则正反测试（`-u` 带值选项未跳过，命令名被当成 `root`） | 引入 `VALUE_OPTIONS` 与 `commandIndex` 统一剥前缀 |
| 危险规则漏拦 `git push origin +main` | 同上（`+refspec` 是强制推送） | 规则补 `arg.startsWith("+") && arg.length > 1` |
| 输出截断切出 U+FFFD 替换字符 | `truncateOutput` 按字节切多字节字符 | 回退到 UTF-8 字符边界 |
| 关闭→恢复的会话继承「完全权限」/只读豁免 | 写 `exec-mode.test.ts` 的"关闭后豁免失效"用例 | 引入 `executionEpoch` 代际号（两道防线） |
| MCP 安装的 `"[]"` / `"null"` 输入被当成可执行文件名 | 坏形状测试 | 收紧 JSON 形态判定 + 显式拒绝 JSON 字面量残片 |
| `McpInstallInputError` 未映射 → 未勾选风险确认返回 500 | `mcp.api.test.ts` 断言 400 | `sendMcpError` 同时识别两种错误类型 |

### 5.2.1 code-review（两轴）发现并修复的三个"看起来做完、实际不可用"

阶段 B 的实现票全部"测试绿"之后，安全/正确性两轴复审又抓到三个真缺陷。它们的
共同点是**单测覆盖了零件、但没有人验证整条链路真的通**：

| 缺陷 | 症状 | 根因 | 修法 |
|---|---|---|---|
| **MCP 空闲回收从不发生** | FR-B4「空闲 10min 退出」在生产上是死代码 | `reclaimIdle` 零调用点（单测直接调它，所以"绿"） | 补 `mcpReclaimIntervalMs` 定时器（默认 60s）+ close 清理 + 关子进程 |
| **MCP 工具注册了但不可调** | 注册表 enabled，`invoke` 报 `unknown_tool` | `enable` 只注册进 PermissionEngine，没登记进 ToolInvoker；落进 "no executable implementation wired" 分支被 unregister | 加 MCP 分派分支 + `McpServerService.callTool`（含懒启动）+ `mcpDispatch` 晚绑定解开构造顺序 |
| **"停用"被报成"不存在"** | disable 后 invoke 404 `unknown_tool`，Owner 以为能力被删了 | 停用时 `unregister` | 保留注册，让权限层报 `capability_disabled`（403）；执行体仍不会被调用 |
| **快照失败无审计** | 快照失败正确拒绝了执行，但账本上这次执行"从未发生" | `#execute` 的快照调用没有 try/catch | 补 `phase=snapshot_failed` 审计 |

顺带更正了一条把缺陷写成期望的旧测试（`capabilities.invoke.test.ts` 断言
"disable → 404 unknown_tool"），并新增一条"从未注册的能力仍是 404"以示两种语义
可区分。

### 5.3 仍存在的限制（不阻塞发布，需 Owner 知晓）

1. **DNS rebinding 复检有 TOCTOU 窗口**：Node 的 `fetch` 自行解析 DNS，我们无法把已
   校验的 IP 钉进连接。当前实现是"连接前后各解析一次"，能挡住绝大多数 rebinding，
   但不是零窗口。完美方案需自定义 `undici` agent，留作后续。
2. **MCP resources/prompts 不支持**（规格明确 out of scope）：协商时如实记为
   `unsupportedCapabilities` 并在健康详情里展示，不静默忽略。
3. **MCP 进程不是沙箱**（ADR-0011）：它拥有与 Morrow 同等的宿主权限；Morrow 只能约束
   *经其注册的工具调用*。风险文案原文落库（`risk_ack_text`）以便事后取证。
4. **完全权限不是无边界**：静态规则集是"宁严勿松"的黑名单，无法覆盖所有危险写法
   （例如混淆过的脚本）。这是规格接受的残余风险——兜底是快照 + 审计 + 可撤销。
5. **快照只覆盖会话工作区**：`~/.ssh`、`/etc`、其他项目目录、OS 凭据库、远端仓库
   都不在保护范围，`SNAPSHOT_SCOPE_NOTICE` 随每个响应回传并在 UI 常驻展示。
6. **真实容器验证仅限本机 macOS/Docker**：CI 的 ubuntu 腿会跑，但本轮未在 CI 上复验
   （本地 docker 可用，12 项全绿）。
7. **用户故事 4 的 UI 断言**：默认 disabled 在 API 层有断言、UI 有 `statusBadge("disabled",
   false) → "未启用"` 的纯逻辑测试，但没有一条"点击安装后页面上确实显示未启用"的组件级
   断言（桌面端目前无 DOM 测试环境，全部 UI 逻辑走纯函数测试）。这是 M7-A 起就存在的
   测试策略取舍，不是本阶段引入。

## 6. 建议

打 **`v0.3.0`**（阶段 B 能力扩展）。

发布说明需包含：

- 新增：MCP 安装/启停（含双代际协议）、npm 技能包安装与升级 diff、智能安装（文档→提案）、
  `/` 命令面板、动态 bash（容器沙箱 + 执行模式 + 快照撤销）。
- 安全立场：MCP server 是宿主进程不是沙箱；「完全权限」仍拦危险命令；快照只覆盖会话工作区。
- 已知限制：见 §5.3 七条。
