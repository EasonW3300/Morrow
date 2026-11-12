# MCP Server 以宿主子进程运行：风险必须显式可见

M7 支持接入外部 MCP Server。关键事实：**MCP Server 是宿主子进程，不在我们的容器沙箱内**——`filesystem` 类 server 天生读写宿主文件，`fetch` 类天生出网。这与我们自己 sandboxed tool 的隔离等级不同，不能假装等同。

决定：首版 **只支持 stdio 传输**、MCP Server **以宿主子进程运行**（不做容器化），但安装时必须：①显示**完整未截断**的启动命令与参数（MCP 规范 SEP-1024 的 MUST）；②明确告知"该 server 拥有与 Morrow 同等的宿主权限（可读写文件、可出网、可执行命令）"并勾选确认；③安装后**默认 disabled**，Owner 显式启用；④其工具注册为 capability，受五维 PermissionGrant 约束，默认无网络/无 shell。容器化 MCP 进程列为后续增强。

## Considered Options

- **容器化每个 MCP Server（挂载白名单目录、按需给网络）**：隔离最好，但 macOS 上要求容器内挂载与目录映射，首次可用成本高，且 `filesystem` 类 server 的路径参数需要重写，容易做成"看起来隔离其实没隔离"。
- **纯审计（装完不管）**：等于把宿主权限交给任意第三方进程，不可接受。

## Consequences

- 这是**已知的残余风险**：MCP 生态默认假设"以你的用户权限运行"。我们只能做到风险可见 + 权限收窄 + 审计，做不到进程级隔离。必须写进威胁模型与发布说明。
- 协议要**双代际兼容**：先发 `server/discover`（新规范 `2026-07-28`，无握手）；返回 `UnsupportedProtocolVersionError` 时按其 `supported` 列表换版本，**不得回退 `initialize`**；其他错误或超时才回退到 legacy `initialize`。
- 进程生命周期：首次调用懒启动，空闲 10 分钟退出，崩溃指数退避重启最多 3 次后标 `degraded`（UI 可见）。
