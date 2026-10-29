# 真机门禁项脚本（T10 / Issue #11）

CI runner 无音频设备与 GUI 会话，冒烟门清单 #4 的真机项在本机执行；本目录放可重复执行的探针。

## mic-probe.swift（麦克风捕获探针，AC-11 前置）

```bash
swift scripts/real-machine/mic-probe.swift [--timeout <secs>]   # 默认 60s
```

- 列出音频输入设备 → 检查/请求麦克风权限（TCC）→ 授权后 AVAudioEngine 请求级捕获 1 秒；
- 末行输出单行 JSON：`{"probe":"mic-capture","status":"pass|denied|prompt-timeout|error",...}`；
- 退出码：0 pass / 1 error（含零采样）/ 2 denied / 3 prompt-timeout——**不伪造通过**。

### 授权说明（自动化上下文的已知限制）

从无 GUI 会话归属的进程（如 agent/CI 驱动的 shell）运行时，macOS 会**静默拒绝**授权请求
（`requestAccess` 回调 false 且状态停留 `notDetermined`，系统不弹窗）——2026-10-29 本机实测如此。
手动授权一次的步骤：

1. 系统设置 → 隐私与安全性 → 麦克风 → 为**宿主应用**（探针归因到其责任进程，本机为 ZCode.app；
   从终端跑则归因 Terminal/iTerm）开启麦克风；
2. 重跑本探针，末行应为 `status:"pass"` 且 `frames_captured ≥ 采样率 × 1s`。

授权一次后可重复执行（授权挂在宿主 App 名下，不随探针重跑失效）。
