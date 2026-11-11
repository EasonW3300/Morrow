# Ubuntu systemd 真机部署验证证据（M6 门禁项）

**日期**：2026-11-11
**目标机**：`101.34.91.32`（腾讯云 VM-0-11-ubuntu）
**环境**：Ubuntu 22.04.5 LTS / x86_64 / systemd 249 (249.11-0ubuntu3.17) / 内核 5.15.0-106-generic
**执行者**：Owner 授权的 agent 会话（密码经系统弹窗输入，连接建立后密码文件立即删除）
**脚本**：`scripts/real-machine/server-session.sh`（48h 会话复用）+ `scripts/real-machine/server-verify.sh`
**产物**：Linux x64 单二进制 106MB（`bun build --compile --target=bun-linux-x64-baseline`，交叉编译自 macOS arm64）
**提交基线**：`integration/m0` @ `0236012`（M6-T3 之后；验证脚本自身迭代见 `dec4334`/`8a…`/`3cecb35`）

## 1. 验证结果（全部 PASS）

| 检查项 | 结果 | 说明 |
|---|---|---|
| 服务 active | **PASS** | `systemctl is-active morrow` |
| 服务 enabled | **PASS** | 开机自启（`multi-user.target.wants` 符号链接已建） |
| health 200（就绪轮询 ≤15s） | **PASS** | 规避 systemd is-active 后尚未 listen 的竞态 |
| 数据目录归属 morrow | **PASS** | `/var/lib/morrow` owner=`morrow` |
| 账本已落盘 | **PASS** | `events.sqlite` 非空 |
| 审计事件含 `runtime.started` | **PASS** | 经 `GET /v1/events?limit=20` 查询（服务器未装 sqlite3，改走权威读路径） |
| 重启后 health 200 | **PASS** | `systemctl restart` 后仍健康 |
| 重启后账本完整 | **PASS** | 重启不丢事件 |
| `--probe` 自检 | **PASS** | health 200 + `node:sqlite 3.53.4` roundtrip + **真实 PiAdapter 对话**（本地 SSE mock，`stop_reason=stop`，25ms） |

关键日志片段（原始输出见 `scripts/real-machine/` 运行记录）：

```
{"ready":true,"version":"0.1.0","host":"127.0.0.1","port":8787,"pid":…,"data_dir":"/var/lib/morrow","replica_id":"6294dfc2-d69d-4652-ba0c-1dfa5afaa16f"}
{"stopped":true,"signal":"SIGTERM"}          # 优雅退出：停收请求 → 记账 → 关账本
{"probe":"pass","checks":{"health":{"ok":true,"status":"ok"},"sqlite":{"ok":true,"driver":"node:sqlite","sqlite_version":"3.53.4"},"dialogue":{"ok":true,"stop_reason":"stop","text":"探针正常","elapsed_ms":25}}}
```

`replica_id` 跨重启保持一致（`6294dfc2…`），证明副本身份在 dataDir 持久化。

## 2. 清理结果（逐项核对为空）

| 路径 | 结果 |
|---|---|
| `/etc/systemd/system/morrow.service` | gone |
| `/usr/local/bin/morrow` | gone |
| `/etc/morrow/` | gone |
| `/var/lib/morrow/` | gone |
| 系统用户/组 `morrow` | gone |
| `~/morrow-deploy/`（上传包） | gone |
| `/tmp/morrow-probe*`、mock 脚本/日志 | gone |
| 端口 8787 / 18080 监听 | 0 条 |
| 磁盘剩余 | 14G |

`df` 复核：清理后磁盘占用回到验证前水位，未残留二进制（106MB）或数据。

## 3. 本次验证发现并修复的脚本缺陷（真机才暴露）

1. **`health` 检查与 systemd 启动竞态**：首跑 PASS、二跑 FAIL（`is-active` 后进程可能尚未 listen）→ 改为就绪轮询（≤15s）。
2. **`--probe` 对话段必须有 OpenAI 兼容端点**：原先只验 health + sqlite 就失败 → 脚本在服务器上临时起最小 SSE mock（python3 标准库，零安装），跑完清理；这样验的是完整 PiAdapter 链路。
3. **`pkill -f <mock 脚本名>` 会杀掉执行它的 ssh shell**（远端命令行含同样字符串）→ 改为**按端口杀进程**（`ss -ltnpH "sport = :18080"` → `kill`）。
4. **账本检查用 `sqlite3`**：服务器未安装 → 改用 `GET /v1/events`。

## 4. 未覆盖项（如实登记）

- **回滚演练**：`install-ubuntu.sh` 提供 `--uninstall`（保留数据）/ `--purge`（连数据删），但本机与真机均未做「升级 → 回滚 → 数据完好」的完整演练 → M6 门禁「回滚」一项仍记为**部分**。
- **真实 systemd 崩溃恢复**（非优雅重启，如 OOM kill / 断电）：只验了 `systemctl restart` 与 SIGTERM 优雅退出。
- **反向 token 方向**：服务端 → 加入方的非回环同步未在真机测（需 Tailscale 双机）。
- 验证用的临时 mock 与 probe 数据目录均在验证后删除，未留下可复跑的服务器现场；复跑请执行 `scripts/real-machine/server-verify.sh`（会重新交叉编译并上传）。

## 5. 复现方式

```bash
# 1) 建立 48h 可复用会话（弹窗输密码，密码不落盘）
scripts/real-machine/server-session.sh

# 2) 全流程：交叉编译 → 预检 → 安装 → 9 项验证 → 清理核对
scripts/real-machine/server-verify.sh

# 只保留安装便于手工排查
scripts/real-machine/server-verify.sh --keep
```
