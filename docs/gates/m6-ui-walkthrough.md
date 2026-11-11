# M6-T2 Liquid Glass UI 人工走查（Issue #53）

- 分支：`m6/t2`（基线 `integration/m0` tip `0236012`）
- 走查方式：真实浏览器（ZCode In-app Browser）+ Vite dev（`127.0.0.1:1421`）+ 五个联调夹具的**真实 Runtime**；
  页面操作全部经真实 HTTP/SSE 控制面，不是脚本断言替代。DOM 结论取自运行中的 ARIA/DOM 快照，
  视觉结论取自浅色/深色实机截图（1280×720）。
- 夹具：`settings` / `task` / `channel` / `device` / `capability` 五个脚本 + 三个额外 Runtime
  （无 Provider、`MORROW_SANDBOX_PROBE=off`、缺失/守护进程不可达探针）与两个独立对端 Runtime（配对用）。

## 1. 逐视图结论

| # | 视图/区块 | 结论 | 关键证据（真实交互） |
|---|---|---|---|
| 1 | 会话 | **通过（修 2）** | 新建会话 → 发送：脚本化 Agent 流式 `text_delta` 正常收尾；`dev-fixture` 中工具成功/失败行均可见。**无 Provider** 时 503 显示「尚未配置模型 Provider」+ 服务端原文 +「去设置 → Provider 与模型」按钮，点击落到设置页标题。刷新页面后历史消息、`tool.started/finished`、`agent.error` 全部重建（修复前工具事件丢失）。 |
| 2 | 任务 | **通过（修 2，登记 1）** | 列表（状态/版本）→ 详情（DAG 分层、节点尝试次数/结果）→ 事件流分页均可见。`planned` 任务点「恢复」进入运行（详情 2s 轮询）；安全点前点「暂停」→ 已暂停 + checkpoint 列表；「修改…」改 `archive` 目标 → `task_version` 1→2；pending 节点「接管」→ Owner 接管中 →「完成…」提交结果；「恢复」继续执行；「恢复到此检查点」入口存在。`device-fixture` 的 `needs_reconcile` 任务显示橙色警示横幅、双端执行证据、裁决说明输入 +「标记为已完成/标记为失败」，实测裁决后转「已完成」并落 `task.reconciled`/`task.completed`。事件流在运行中 2s 自动刷新、状态变化后自动重拉，并新增「刷新事件」。终态任务不再显示必然 400 的节点「接管」按钮。 |
| 3 | 设置-Provider | **通过** | 新增 Provider（显示名/Base URL/模型/API Key）保存成功，列表只显示「密钥已存」，编辑表单不回显明文。连通性四类结果逐一实跑：`HTTP 200 连通正常`、`HTTP 401 认证失败`、`HTTP 500 服务错误`、`ECONNREFUSED 网络不可达`，每类均有可读说明 + 下一步建议；删除有二次确认，删除后元数据与密钥一并清除。 |
| 4 | 设置-渠道 | **通过（修 2）** | 适配器清单：飞书（token 剩余 1 分钟/不健康降级）、QQ（健康）、微信（实验徽标 + 已停止）均显示；能力边界逐项呈现「可用/受限/不可用」，主动消息不显示「可用」。微信「启用（实验）…」弹出完整风险声明、声明环境/本地桥/真实联调状态、勾选确认与「确认启用（自担风险）」。凭据表单只显示 App ID/Secret「已配置（不回显）」，缺失必填项有提示。白名单新增 `wx-group-walkthrough` 并保存成功（API 回读三条）；联系人授权勾选「任务执行」保存成功；身份歧义选人后列表清空；通知规则保存成功；Outbox `needs_review` 行显示失败原因与「我已核对，重发 / 标记已送达」，最近 `sent` 对照可见。**新增「默认通知会话」区块**：三渠道当前值投影 + 输入保存；配置微信后含 `channel:wechat` 的规则可保存（此前保存 400 且无 UI 入口）。 |
| 5 | 设置-设备与同步 | **通过（修 1）** | 设备列表：本机/可信/已撤销三态、指纹短格式、配对时间、最后同步、撤销二次确认均正常。生成配对码（6 位 + mm:ss 倒计时 + 本机指纹）；用**第二个 Runtime** 的配对码完成「核对并加入」：双端指纹一致页 → 完成 → 设备列表**立即出现**新 peer（未点刷新）；错误路径 `cannot_join_self` 文案明确。同步状态：本地 seq/peer 游标/待上传/待下载「未知」（对端不可达时如实返回 null）；「立即同步一轮」显示 `0/2 成功、失败 2 台` 的逐设备原因。冲突审核实跑「保留本地（keep_old）」→ 队列清零。 |
| 6 | 健康 | **通过** | 四态实跑：`ready`（docker 29.4.0 可用）、`not_configured`（MORROW_SANDBOX_PROBE=off，中性说明「不是故障」）、`missing`（无容器运行时 + 三平台安装指引）、`daemon_down`（命令存在但 daemon 不可达 + 启动指引）。状态/版本/副本/账本事件数均来自 `GET /v1/health`。 |
| 7 | 通知中心 | **通过** | 铃铛 `aria-label="通知中心，3 条未读"` + 徽标 3；面板列出完成/失败/等待输入三类（含时间与原因），点击「任务完成…」跳到任务页并选中对应任务；「全部标记已读」后铃铛徽标消失、面板显示「暂无未读」；`&notification_permission=denied` 时显示「系统通知权限未授予…不会再重复弹出系统授权框」+「重新请求权限」，应用内列表不受影响。 |

## 2. 走查发现的问题清单

### 2.1 已修（本分支）

| ID | 问题 | 修复 | 测试/证据 |
|---|---|---|---|
| F1 | `channel-fixture` 启动即 `notify_target_required`：A3 修复批后 `channel:<id>` 规则保存要求默认通知会话，夹具先写规则 | 夹具先补 QQ 白名单 + `setNotifyTarget(feishu/qq)` 再 `upsertRules`（采用「补夹具种子」方案；同时补 UI 入口见 F6） | 夹具 stdout `ready:true`；`GET /v1/channels/{feishu,qq}/notify-target` 返回会话 id |
| F2 | 历史回看丢失工具事件：`stateFromHistory` 把 `lastSeq` 设到末条消息，SSE 重放中序号更小的 `tool.*`/`agent.error` 被去重丢弃 | `ChatState.seededFromHistory`：历史仅作首帧前占位，首条 durable 帧到达后按账本全量重放重建 | 刷新页面后 DOM 仍含 `✓工具 lookup_time 12ms`、`✗工具 run_code 12ms 失败`；`sse.test.ts` 新增「工具事件与 agent.error 在重放后保留」 |
| F3 | 无 Provider 错误只给 `POST /v1/providers`/env 原文，无 UI 落点 | 新增 `chat-ui.ts describeSendError`；错误横幅给出可读标题、原文与「去设置 → Provider 与模型」按钮（`App` 传入 `onOpenSettings`） | 实机点击按钮后页面标题为「Provider 与模型」；`chat-ui.test.ts` 2 例 |
| F4 | 任务事件流只在打开详情时加载：运行中节点事件、暂停/修订/裁决后的新事件不出现，且无刷新入口 | 运行中 2s 轮询当前窗口；`refreshKey`（状态+版本+更新时间）变化时重拉；新增「刷新事件」按钮 | 实机运行 5.5s 后标题从初始窗口变为「13 条」；裁决后出现 `task.reconciled`/`task.completed`；`task-ui.test.ts` 覆盖刷新策略 |
| F5 | 终态任务（completed/failed/cancelled）仍显示节点「接管」等介入按钮，点击必然 409 | `taskIsTerminal` 驱动 `interactive`，终态隐藏节点级接管/完成/交还 | 已完成任务 DOM 中不再出现「接管」；`task-ui.test.ts` 覆盖三种终态 |
| F6 | 渠道通知规则可选中 `channel:<id>`，但无默认通知会话配置入口；保存报原始 `PUT /v1/.../notify-target` 错误 | 新增「默认通知会话」区块（`ChannelNotifyTargetSection` + `api.get/putChannelNotifyTarget` + `validateNotifyTargetInput`）；规则保存失败改为引导文案 | 实机配置微信目标后含 `channel:wechat` 的规则保存成功；`channel-ui.test.ts` 覆盖空/空白校验 |
| F7 | 配对完成（双端指纹一致）后设备列表不刷新，新 peer 要手点「刷新」 | `DevicesView` 提升刷新 token，配对确认/继续时刷新列表；文案改为「列表已自动刷新」 | 使用新 peer（`3678bfdf`）配对：确认前列表无该副本，确认后立即出现 |
| F8 | 五个夹具用 `{...loadConfig(), dataDir}` 覆盖 dataDir，`replicaId` 仍取自默认 `~/.morrow/data`，所有夹具实例共享同一副本 id（配对自检误判 `cannot_join_self`） | 夹具改为 `loadConfig({ ...process.env, MORROW_DATA_DIR: dataDir })`，副本身份跟随夹具临时目录 | 两个独立 Runtime 配对成功（`1bcf8cf2`、`3678bfdf`）；夹具重启后 replica id 各自独立 |

新增/更新测试：`chat-ui.test.ts`、`sse.test.ts`、`task-ui.test.ts`、`channel-ui.test.ts`，desktop 套件 133 → **139**。

### 2.2 登记（不属本票可安全闭环）

| ID | 问题 | 说明 |
|---|---|---|
| P1 | Owner 完成 `delivery_unknown` 接管节点后，Runtime 自动置节点 `pending_review`、任务 `waiting_input(reconciliation_required)`；UI 无 pending_review 裁决/交还入口（Runtime 也未提供对应端点） | 实测：接管 → 完成 → 恢复后停在「等待输入」，节点「待人工核对」，无可操作按钮。需要新票定义节点级核对裁决协议与 UI，不能在本走查中臆造语义 |
| P2 | `channel-fixture` 的 403 `failed` 预置行在 5s backoff 后被自动重试成功，走查时在「最近 sent」显示为已送达 | Outbox 对可重试失败的正常行为；但夹具无法稳定展示 failed 状态。建议后续夹具改用不可重试错误码，或把 backoff 调到走查时长之外 |
| P3 | 设备夹具预置 peer 无 `base_url`，`立即同步一轮` 必然失败（逐设备原因可读） | 夹具限制，非 UI 缺陷；真实双机同步由 M3 证据承载 |
| P4 | 任务级 `needs_reconcile` 裁决为 completed 后，DAG 节点仍显示「待执行」 | 裁决是任务级结论，Runtime 不伪造节点结果；当前 UI 如实呈现原始节点状态。是否需要节点态收敛由产品口径决定，登记待评估 |

## 3. 视觉走查（Liquid Glass）

- 浅色/深色两种主题逐页目视：顶栏/侧栏为 L2 玻璃，内容卡片、表单、列表、通知面板为 L1/标准材质；
  未把正文或表格放进高透明玻璃，符合 `UI_DESIGN_SYSTEM.md` §1.2「玻璃是功能层，不是内容层」。
- 新增「默认通知会话」区块使用 `--color-surface-secondary` 行表面 + 普通边框，输入/按钮沿用设计系统
  primitives；无新增硬编码颜色（全部 token），浅色截图对比度正常。
- 无 Provider 错误横幅：标题 + 原文 + 操作按钮三层，浅色下文字对比与按钮命中区正常；长 URL/环境变量
  自动换行，不溢出。
- 空态、禁用态、错误态均可见且语义明确（暂停失败/同步失败/加入失败均有可读原因）；未发现需要按
  设计规范修正的纯视觉缺陷。

## 4. 最终验证

```
pnpm --filter @morrow/runtime build        # esbuild dist/main.js
pnpm --filter @morrow/desktop run build    # tsc --noEmit + vite build
pnpm --filter @morrow/desktop test:ui      # 139/139 pass
pnpm --filter @morrow/runtime test:unit    # 738/738 pass
pnpm -r typecheck                          # protocol / pi-adapter / desktop / runtime / packaging 全通过
```

## 5. 复现命令

```bash
# 终端 1：UI
pnpm --filter @morrow/desktop dev -- --port 1421

# 终端 2：渠道夹具（notify-target 已由夹具种子；微信规则可直接保存）
node --experimental-sqlite --experimental-strip-types apps/desktop/scripts/channel-fixture.ts

# 其余视图
node --experimental-sqlite --experimental-strip-types apps/desktop/scripts/settings-fixture.ts
node --experimental-sqlite --experimental-strip-types apps/desktop/scripts/task-fixture.ts
node --experimental-sqlite --experimental-strip-types apps/desktop/scripts/device-fixture.ts
node --experimental-sqlite --experimental-strip-types apps/runtime/scripts/dev-fixture.ts

# 浏览器打开 stdout 给出的 http://127.0.0.1:1421/?runtime=http://127.0.0.1:<port>
# 权限降级：追加 &notification_permission=denied
```

健康四态：同一 UI 指向不同 Runtime 启动参数即可复现——
`MORROW_SANDBOX_PROBE=off`（not_configured）；`PATH` 去掉容器运行时（missing）；
PATH 中放一个退出码 1 的 `docker` 桩（daemon_down）。
