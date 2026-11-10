# 部署指南（三种形态 + 私有网络）

票 [M3-T5 / Issue #34](https://github.com/EasonW3300/Morrow/issues/34)，对应 ADR-0003（单二进制双宿主）、
ADR-0004（私有网络优先）、ADR-0008（bearer token 鉴权）。同一个 Runtime 单二进制/同一份源码
可以在桌面 sidecar、Ubuntu 服务器、以及"本地 + 服务器"混合形态下运行，代码零分叉。

## 选哪种形态

| 形态 | 适合 | 组成 | 同步 | 本地离线 |
|---|---|---|---|---|
| 纯本地 | 单机使用（现状） | Runtime 本地进程 + 桌面壳 | 不需要 | 天然满足 |
| 纯服务器 | 希望多设备/远程访问，服务器常在线 | Ubuntu 单二进制 + systemd + Tailscale | 服务器为权威副本，客户端同步到它 | 客户端断网时不可用（除混合形态） |
| 混合 | 移动办公 + 家里服务器（推荐） | 本地 Runtime（优先）+ 服务器 Runtime（同步对端/可选远程执行） | 双向增量，重连续传 | 满足：本地写入照常，重连后合并 |

服务器形态的统一约定：

| 项 | 路径/值 |
|---|---|
| 二进制 | `/usr/local/bin/morrow` |
| systemd unit | `/etc/systemd/system/morrow.service`（模板 `deploy/systemd/morrow.service`） |
| 环境文件 | `/etc/morrow/morrow.env`（模板 `deploy/morrow.env.example`） |
| 数据目录 | `/var/lib/morrow`（`MORROW_DATA_DIR`；账本/记忆/游标/workspace 全在此） |
| 默认监听 | `127.0.0.1`（**绝不默认 0.0.0.0**）；模板端口 `8787` |

## 私有网络（ADR-0004，必读）

Morrow 不内嵌公网证书/ACME，默认假设所有设备在同一私有网络内。Runtime 只监听回环或
**私有网络接口**，传输安全由隧道层保证；配对码 + 双端公钥指纹仍会执行，防同网段冒充。

推荐 [Tailscale](https://tailscale.com/)（WireGuard 组网，任意 WireGuard 方案同理）：

```bash
# 1) 服务器与每台设备安装并登录同一账号（Ubuntu）
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 2) 取服务器的私有网络地址（100.64.0.0/10 区间）
tailscale ip -4
#   100.x.y.z

# 3) 只监听该私有接口（编辑 /etc/morrow/morrow.env）
sudoedit /etc/morrow/morrow.env
#   MORROW_HOST=100.x.y.z
sudo systemctl restart morrow

# 4) 确认没有监听公网网卡（应只见 127.0.0.1 与 tailscale0/该地址）
ss -lntp | grep 8787

# 5) 从另一台设备验证连通（同账号设备之间）
tailscale ping <server-tailscale-ip>
curl http://<server-tailscale-ip>:8787/v1/health
```

WireGuard 用户把 `MORROW_HOST` 设为 `wg0` 上的私网地址即可。**不要**设成 `0.0.0.0`
或 `::`：那会同时监听公网网卡。需要主机防火墙时只放行隧道接口：

```bash
sudo ufw allow in on tailscale0 to any port 8787 proto tcp
```

鉴权（ADR-0008）：来自 `127.0.0.1`/`::1` 的请求豁免（纯本地零配置）；其余来源必须携带
配对时下发的 `Authorization: Bearer <device token>`，否则 401。唯一例外是
`POST /v1/pairing/claim`（新设备尚未持有 token，配对码是单次、5 分钟 TTL 的凭据）。
token 只在 claim 响应中出现一次，客户端应存 OS 凭据库；服务端只存摘要。

## 纯本地

日常开发直接跑源码（ADR-0003：不强制打包）：

```bash
pnpm install
MORROW_DATA_DIR="$(mktemp -d)" pnpm --filter @morrow/runtime start
# stdout 首行是 ready JSON：{"ready":true,"host":"127.0.0.1","port":...,"replica_id":...}
curl http://127.0.0.1:<port>/v1/health
```

验证（本机可跑，零真实网络/真实 LLM）：

```bash
scripts/deploy/smoke-local.sh
# 临时 dataDir 起进程 → /v1/health → 一次对话（本地 OpenAI mock Provider）→ SIGTERM 优雅退出
```

## 纯服务器（Ubuntu + systemd）

### 1. 构建单二进制

在**与服务器同架构**的机器上（Ubuntu x64 用 x64 主机/CI linux 腿）：

```bash
pnpm install
pnpm pack:runtime
# → scripts/packaging/dist/morrow-runtime-linux-x64（x64 自动 -baseline）
```

把仓库（至少 `deploy/`、`scripts/deploy/`）与二进制拷到服务器。

### 2. 安装

```bash
# 先预览（不需要 root，不改系统）
scripts/deploy/install-ubuntu.sh --dry-run --binary ./morrow-runtime-linux-x64

# 正式安装
sudo scripts/deploy/install-ubuntu.sh --binary ./morrow-runtime-linux-x64
```

脚本是**幂等**的：

- 创建系统用户/组 `morrow`（已存在则保留）；
- 建 `/etc/morrow`（root:morrow 0750）与 `/var/lib/morrow`（morrow:morrow 0750）；
- 安装二进制（0755）、unit（0644）；**已有 `/etc/morrow/morrow.env` 不覆盖**；
- `daemon-reload` → `enable` → `restart`（首次启动与升级都走同一条路径）；
- `--no-start` 只安装；`--uninstall` 停用并移除 unit/二进制但保留数据与 env；
  `--uninstall --purge` 才连 `/var/lib/morrow`、`/etc/morrow` 一起删。

### 3. 配置与启动

```bash
sudoedit /etc/morrow/morrow.env   # 至少按「私有网络」一节改 MORROW_HOST
sudo systemctl restart morrow
systemctl status morrow
journalctl -u morrow -f
curl http://<MORROW_HOST>:8787/v1/health
```

`morrow.env` 是 systemd `EnvironmentFile` 语法：`KEY=VALUE`、`#` 注释、不要 `export`、
不要留空变量（例如 `MORROW_REPLICA_ID=` 是空字符串，会校验失败——注释掉即可）。副本身份
默认在 `<DATA_DIR>/replica-id` 首次启动生成并持久化，迁移机器保留 dataDir 即保留身份。

### 4. unit 做了什么

`deploy/systemd/morrow.service` 关键项：

- `User=morrow` / `Group=morrow`，`StateDirectory=morrow`（自动建并授权 `/var/lib/morrow`）；
- `EnvironmentFile=/etc/morrow/morrow.env`，`ExecStart=/usr/local/bin/morrow`；
- `Restart=on-failure` + `RestartSec=3`；`KillSignal=SIGTERM` + `TimeoutStopSec=20`
  （走 Runtime 的优雅退出：停收请求 → 记账 `runtime.stopped` → 关账本）；
- 加固：`NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict`、`ProtectHome=true`、
  `ReadWritePaths=/var/lib/morrow` 等；
- 日志进 journald（`SyslogIdentifier=morrow`）；硬限 `LimitNOFILE=65536`、`TasksMax=512`、
  `MemoryHigh=2G`、`MemoryMax=4G`（重负载/本地模型编排时按机器规格上调）。
- 启用 Docker 沙箱能力时才需要放开容器 socket，unit 内已给出注释行。

### 验证边界（如实）

`scripts/deploy/smoke-server.sh` 在本机可验证：unit/env 模板的静态契约 + 按
`EnvironmentFile` 语义拉起的前台进程（health + 优雅退出）。真实 systemd 加载、开机自启
需要 systemd 会话，**本机（macOS）无法验证**；在 Owner 的 Ubuntu 机器上执行
`install-ubuntu.sh` 后以 `systemctl status morrow` + 重启机器确认。

另一个待 Owner 机器确认的点：设备身份私钥走 OS 凭据库（Linux = `secret-tool`）。
系统级 systemd 服务没有登录会话时，GNOME Keyring/KWallet 可能不可访问，配对端点会返回
`503 secret_store_unavailable`。若遇到，先在同一 `morrow` 用户下确认 `secret-tool
lookup service com.morrow.device account <replica-id>` 可用（需要已解锁的 keyring）；这属于服务器密钥后端
的已知边界，冒烟用 `MORROW_SECRET_BACKEND=memory` 绕开但不适用于生产（重启后指纹变化）。

## 混合形态（本地优先 + 服务器同步对端）

拓扑：本地 Runtime A 承担日常交互（离线也照常写账本）；服务器 Runtime B 是同步对端
（也可选承担远程执行）。A/B 经 Tailscale 互访，事件按 `(replica_id, sequence)` 增量同步、
`event_id` 幂等去重，**绝不复制活跃 SQLite 文件**（PRD §4.2 / FR-DEP-3）。断网期间 A 本地
写入，重连后双向补齐，不重复不丢失；删除走 tombstone（离线副本不复活已删数据）。

### 配对（T2 / ADR-0008）

1. 已信任的一侧调用 `POST /v1/pairing/codes` 生成 6 位一次性码（5 分钟、单次）+ 本机指纹；
2. 新设备调用 `POST /v1/pairing/claim`（`code` + `device_public_key` + `device_label`
   + 自己的 `device_replica_id` + 期望的 `server_fingerprint`）；
3. 服务端校验码与指纹 → 落信任并下发一次性 bearer token；响应携带双方指纹，客户端与
   本地显示值比对，不一致不得信任；
4. 反向配对再来一次（双向同步的前提是双方都把对方列为 trusted 设备）。

`scripts/deploy/smoke-hybrid.sh` 是可执行参考：两个真实 Runtime 进程、各自临时 dataDir、
127.0.0.1 随机端口；生成码 → 双向 claim（含指纹核对）→ A 离线写 5 条、B 离线写 3 条 →
`/v1/sync/pull` + `/v1/sync/push` 双向同步 → 重推幂等（accepted=0）→ 逐项对账。

### 服务器侧准备

服务器先按「纯服务器」装好并把 `MORROW_HOST` 设为 Tailscale 地址；本地设备加入同一
Tailscale 网络。配对时把服务器的 Tailscale 地址作为 base URL；token 存客户端 OS 凭据库
（桌面端接线见 T2/T6 面）。

## 升级与回滚

```bash
# 升级前先备份（见下）
sudo systemctl stop morrow
sudo tar -C /var/lib -czf "morrow-data-$(date +%Y%m%d-%H%M%S).tar.gz" morrow

# 升级：同一条幂等命令换新二进制并重启
sudo scripts/deploy/install-ubuntu.sh --binary ./morrow-runtime-linux-x64-NEW
systemctl status morrow && curl http://<MORROW_HOST>:8787/v1/health

# 回滚二进制
sudo systemctl stop morrow
sudo install -m 0755 ./morrow-runtime-linux-x64-OLD /usr/local/bin/morrow
sudo systemctl start morrow
```

账本/记忆 schema 变更以"加表/加列 + `PRAGMA table_info` 幂等判定"为主，通常旧二进制可读新库；
但**不承诺向后兼容**。回滚到旧版本前先停服备份 dataDir；若旧版本不认新 schema，恢复数据备份
再启动。`/etc/morrow/morrow.env` 同样建议纳入版本管理（若其中含 Provider API key，按密钥保管）。

## 数据备份与恢复

活动 SQLite（WAL 模式）不能热拷贝出"半张表"。最稳妥的是停服后整目录打包：

```bash
sudo systemctl stop morrow
sudo tar -C /var/lib -czf /var/backups/morrow-$(date +%F).tar.gz morrow
sudo systemctl start morrow
```

恢复：

```bash
sudo systemctl stop morrow
sudo mv /var/lib/morrow /var/lib/morrow.broken
sudo tar -C /var/lib -xzf /var/backups/morrow-YYYY-MM-DD.tar.gz
sudo chown -R morrow:morrow /var/lib/morrow && sudo chmod 0750 /var/lib/morrow
sudo systemctl start morrow
curl http://<MORROW_HOST>:8787/v1/health   # ledger.events 应与备份时接近
```

`/var/lib/morrow` 内包含账本 `events`、记忆投影 `memory/`、设备/同步游标、workspace；
`providers.json` 只有元数据，API key 在 OS 凭据库（服务器上为 secret-tool）。迁移到新机器时，
除 dataDir 外还需重新配置 Provider key（或保持 `MORROW_PROVIDER_*` 环境变量）。

## 故障排查

| 症状 | 排查 |
|---|---|
| `EADDRINUSE` / 起不来 | `ss -lntp \| grep 8787`；换 `MORROW_PORT` 或找出占用进程；`journalctl -u morrow -n 50` |
| `EACCES` / 数据写失败 | 数据目录必须在 `/var/lib/morrow`（`ProtectSystem=strict` 只放行它）；`sudo chown -R morrow:morrow /var/lib/morrow`，权限 0750；别把 `MORROW_DATA_DIR` 指到 `/root`、`/home`（`ProtectHome=true`） |
| 远端 401 `unauthorized` / `invalid_token` | 非回环必须带配对下发的 bearer token；确认请求头 `Authorization: Bearer ...`，token 是否被撤销/重装设备后失效 → 重新配对 |
| 远端 403 `device_revoked` / `device_untrusted` | 设备被撤销（终态，需重新配对流程）或未完成 claim；`GET /v1/devices` 查看 trusted/revoked |
| 配对码无效/过期 | 6 位码 5 分钟 TTL、单次消费；同来源失败 10 次/5 分钟会限速；重新 `POST /v1/pairing/codes` |
| 配对 503 `secret_store_unavailable` | 服务器上的 OS 凭据库不可用（Linux `secret-tool`/keyring 未解锁，system service 无用户会话时常见）；按「验证边界」一节在同一用户下确认 keyring，勿用 `memory` 后端冒充生产 |
| 同步 409 `sync_gap` | 批次 sequence 缺口或与游标不衔接，**游标未推进**。`GET /v1/sync/status` 对比双方 `sequence.max` 与游标；从 `last_pulled_sequence` 重新拉全量批次，不要跳号；对端账本被重建时需重新配对/从空 dataDir 重新同步（先备份） |
| `sync_integrity_mismatch` | 信封被篡改或版本不兼容；整批拒绝，检查两端版本 |
| 同步 `pending` 不动 | 对端不可达（`sync_transport_unavailable` 503）；`tailscale ping`、防火墙只放行 tailscale0、确认 `MORROW_HOST` 是私网地址 |
| 没有对话回复 / 503 `provider_not_configured` | `morrow.env` 未配 `MORROW_PROVIDER_*`，或显式注册的默认 Provider 被删；`GET /v1/providers` |
| health 的 sandbox 为 `missing`/`daemon_down` | 服务器缺容器运行时（Docker/Podman）；builtin 能力不受影响，sandboxed 能力会 503 |

常用命令：

```bash
systemctl status morrow
journalctl -u morrow -n 200 --no-pager
journalctl -u morrow -f
curl -s http://127.0.0.1:8787/v1/health
curl -s http://127.0.0.1:8787/v1/devices
curl -s http://127.0.0.1:8787/v1/sync/status
```

## 冒烟脚本（发布前必跑）

| 脚本 | 形态 | 断言 |
|---|---|---|
| `scripts/deploy/smoke-local.sh` | 本地 | 临时 dataDir → health → 一次对话（mock Provider）→ SIGTERM 优雅退出 |
| `scripts/deploy/smoke-server.sh` | 服务器 | unit/env 模板静态契约 → 按 env 文件前台起进程 → health → 优雅退出；真实 systemd 标注待验证 |
| `scripts/deploy/smoke-hybrid.sh` | 混合 | 双进程 + 双向配对 → 双方离线写入 → 双向增量同步 → 幂等重推 → 逐项对账 |

```bash
scripts/deploy/smoke-local.sh
scripts/deploy/smoke-server.sh
scripts/deploy/smoke-hybrid.sh

# 用打包产物跑（二进制级证据；默认优先 dist/ 下当前平台产物）
scripts/deploy/smoke-local.sh   --binary scripts/packaging/dist/morrow-runtime-darwin-arm64
scripts/deploy/smoke-hybrid.sh  --keep   # 保留临时数据目录排查
```

冒烟进程统一 `MORROW_SECRET_BACKEND=memory`（设备私钥只在进程内存，不写 OS 凭据库），
所以不需要钥匙串权限；生产部署保持 `auto`。

## 参考

- ADR-0003：[Runtime 双宿主形态与单二进制打包](../docs/adr/0003-runtime-single-binary-dual-host.md)
- ADR-0004：[传输安全默认私有网络（Tailscale）优先](../docs/adr/0004-private-network-first-transport.md)
- 规格 #29：M3 部署与同步；票 #34
