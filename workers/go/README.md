# Go Workers

Go 组件构建产物与模块根目录；CI 产出独立二进制，由 Runtime 经统一调用接口拉起。

## textstats（M2-T2 / Issue #23，首个 Go Worker 示范）

最小文本工具：行/词/字节统计（`mode:"count"`）与文本规范化（`mode:"normalize"`：
折叠空白 + 小写）。PRD §2 双语言（TS/Go）的 Go 半边示范。

- **协议**：与沙箱内 TS 工具一致（`apps/runtime/src/sandbox/protocol.ts`）——stdin 收
  单行 JSON 输入，stdout 输出单行信封 `{"ok":true,"result":…}` / `{"ok":false,"error":"…"}`。
- **注册形态**：`manifest {author:"human", runtime:"go", sandbox:{type:"builtin"}}`——
  human vetted 编译产物，builtin 类**直跑不经容器**（沙箱只服务 AI 生成代码）；
  调用经 `apps/runtime/src/sandbox/invoker.ts`（ToolInvoker）同一接缝，执行前过
  PermissionEngine 运行时复核（与 sandboxed 类同口径）。
- **构建**：`./build.sh` → `bin/textstats`（宿主平台；Windows 产 `textstats.exe`）。
  要求 go ≥ 1.25；CGO 关闭 + `-trimpath -ldflags "-s -w"`（静态、可复现）。
- **测试**：`apps/runtime/test/sandbox.go-worker.test.ts`——本机有 go 时自动真编译
  （或复用已有产物）真跑；无 go 且无产物 → skip 并注明理由。
