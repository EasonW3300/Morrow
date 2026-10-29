# Runtime 双宿主形态与单二进制打包

同一核心应用（Runtime）需要以桌面 sidecar（macOS/Windows/Linux，Tauri 拉起）和 Ubuntu 服务器进程两种形态运行。决定：Runtime 打包为单二进制可执行文件，首选 bun compile，M0 原型验证；若 native 模块或 worker 兼容性不达标，回退 Node 官方 SEA。服务器部署目标为 Ubuntu 一键部署（单二进制 + systemd 单元），不采用 Docker Compose。本地日常开发直接以 Node 跑源码，不强制走打包。

## Considered Options

- Docker Compose 服务器部署：与"一键部署"目标和单人运维成本错配。
- pkg：已停止维护，不考虑。

## Consequences

依赖选型需规避打包器不兼容项（SQLite 优先验证 `node:sqlite` / `bun:sqlite`，native 绑定需在 M0 冒烟中验证）；CI 需要平台矩阵：Ubuntu 产出服务器 `.bin`，三个桌面平台产出 sidecar 二进制。
