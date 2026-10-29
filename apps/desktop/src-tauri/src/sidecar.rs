//! Runtime sidecar 生命周期（票 T6 / Issue #7）。
//!
//! 启动协议（apps/runtime README）：子进程 stdout 输出单行 JSON ready 帧
//! `{"ready":true,"host":...,"port":...,"pid":...}`，父进程据此拿到控制面地址；
//! `MORROW_PORT` 默认 0（随机空闲），sidecar 场景无端口冲突。
//! 父进程退出 → SIGTERM 子进程 → Runtime 优雅退出（runtime.stopped 落账 + WAL checkpoint）。
//! Windows 已知限制：OS 级无 SIGTERM（Node 子进程收不到外部终止信号），terminate()
//! 直接强杀、信号转发为 no-op——Windows 上 Runtime 优雅落盘仅覆盖窗口关闭等正常退出路径。
//!
//! 启动命令可配置（为 T8 单二进制 / T9 留配置面），解析优先级：
//!   MORROW_SIDECAR_COMMAND / MORROW_SIDECAR_ARGS（JSON 数组）/ MORROW_SIDECAR_CWD
//!   > 默认：`node --experimental-sqlite <runtime 入口>`。
//! dev（debug 构建）入口 = 仓库内 apps/runtime/dist/main.js（编译期烘焙）；
//! release 打包入口 = Tauri 资源目录 runtime/main.js（tauri.conf.json resources 注入）。

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// ready 等待上限（冷启动含 SQLite 初始化，20s 足够宽裕）
pub const READY_TIMEOUT_SECS: u64 = 20;
/// Node < 22.13 需要（22.13+ 默认开启，标志保留无害）
pub const SQLITE_FLAG: &str = "--experimental-sqlite";
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// ready 帧中壳关心的字段（单行 JSON，apps/runtime/src/main.ts 产出）
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ReadyInfo {
    pub host: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub version: Option<String>,
}

/// 解析一行 stdout：仅接受 `ready:true` 且带 host/port 的 JSON 帧；其余（stopped 行、
/// 噪声、空行）一律 None。容错策略：ready 协议是父子进程唯一契约，宁缺勿滥。
pub fn parse_ready_line(line: &str) -> Option<ReadyInfo> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("ready").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let host = value.get("host")?.as_str()?.to_string();
    if host.is_empty() {
        return None;
    }
    let port = value.get("port")?.as_u64()?;
    if port == 0 || port > u64::from(u16::MAX) {
        return None;
    }
    Some(ReadyInfo {
        host,
        port: port as u16,
        pid: value.get("pid").and_then(|v| v.as_u64()).map(|v| v as u32),
        version: value.get("version").and_then(|v| v.as_str()).map(String::from),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct SidecarConfig {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// 额外注入子进程的环境变量（如测试用 MORROW_DATA_DIR 临时目录）
    pub env: Vec<(String, String)>,
}

impl SidecarConfig {
    /// 环境变量覆盖 > 默认值。release 模式必须提供资源目录里的 runtime 入口。
    pub fn resolve(release_entry: Option<&Path>) -> Result<Self, String> {
        let command =
            std::env::var("MORROW_SIDECAR_COMMAND").unwrap_or_else(|_| "node".to_string());
        if command.trim().is_empty() {
            return Err("MORROW_SIDECAR_COMMAND is empty".into());
        }
        let (default_args, default_cwd) = if cfg!(debug_assertions) {
            let (args, cwd) = defaults_for_entry(&dev_entry());
            (args, Some(cwd))
        } else {
            let entry = release_entry.ok_or_else(|| {
                "release build requires the runtime entry (tauri resource runtime/main.js); \
                 set MORROW_SIDECAR_ARGS to override"
                    .to_string()
            })?;
            let (args, cwd) = defaults_for_entry(entry);
            (args, Some(cwd))
        };
        let args = match std::env::var("MORROW_SIDECAR_ARGS") {
            Ok(raw) => serde_json::from_str::<Vec<String>>(&raw)
                .map_err(|err| format!("MORROW_SIDECAR_ARGS must be a JSON array of strings: {err}"))?,
            Err(_) => default_args,
        };
        let cwd = std::env::var("MORROW_SIDECAR_CWD")
            .map(PathBuf::from)
            .ok()
            .or(default_cwd);
        Ok(Self { command, args, cwd, env: Vec::new() })
    }
}

/// 默认启动参数：`node --experimental-sqlite <entry>`，cwd = 入口所在目录
/// （dist 自包含全部 workspace 依赖；数据目录走 MORROW_DATA_DIR 默认值）。
pub fn defaults_for_entry(entry: &Path) -> (Vec<String>, PathBuf) {
    let args = vec![SQLITE_FLAG.to_string(), entry.to_string_lossy().into_owned()];
    let cwd = entry.parent().unwrap_or(Path::new(".")).to_path_buf();
    (args, cwd)
}

/// dev（debug 构建）的 runtime 入口：仓库内 dist 产物（esbuild 打包自包含）。
/// CARGO_MANIFEST_DIR = apps/desktop/src-tauri → 回退三级到仓库根。
pub fn dev_entry() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../apps/runtime/dist/main.js")
}

/// 暴露给前端的状态视图（sidecar_status 命令返回值）
#[derive(Debug, Clone, Serialize)]
pub struct SidecarStatusView {
    /// "starting" | "ready" | "error"
    pub state: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub error: Option<String>,
}

/// 运行中的 sidecar：ready 前可观测（status），退出时 SIGTERM（幂等，Drop 兜底）。
pub struct SidecarProcess {
    child: Mutex<Child>,
    ready: Arc<OnceLock<ReadyInfo>>,
    error: Arc<Mutex<Option<String>>>,
    terminated: AtomicBool,
}

impl SidecarProcess {
    pub fn status(&self) -> SidecarStatusView {
        if let Some(info) = self.ready.get() {
            return SidecarStatusView {
                state: "ready".into(),
                host: Some(info.host.clone()),
                port: Some(info.port),
                error: None,
            };
        }
        if let Some(err) = &*self.error.lock().unwrap() {
            return SidecarStatusView {
                state: "error".into(),
                host: None,
                port: None,
                error: Some(err.clone()),
            };
        }
        SidecarStatusView { state: "starting".into(), host: None, port: None, error: None }
    }

    pub fn pid(&self) -> u32 {
        self.child.lock().unwrap().id()
    }

    /// 测试 seam（smoke 断言 SIGTERM 后子进程已退出）；生产退出路径用 terminate
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn has_exited(&self) -> bool {
        self.child
            .lock()
            .unwrap()
            .try_wait()
            .map(|exit| exit.is_some())
            .unwrap_or(true)
    }

    /// unix：SIGTERM → 最多等 2s → SIGKILL。幂等（ExitRequested/Exit/Drop 可能多次触发）。
    /// Windows：无 SIGTERM 等价物，跳过宽限期直接强杀（代价见模块注释「Windows 已知限制」）。
    pub fn terminate(&self) {
        if self.terminated.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut child = self.child.lock().unwrap();
        #[cfg(unix)]
        {
            let pid = child.id();
            if pid != 0 {
                // SIGTERM：Runtime 优雅退出（runtime.stopped 落账 + WAL checkpoint）后 exit 0
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// 拉起 sidecar 并启动 stdout/stderr 读取线程；ready/error 异步浮现到 status()。
/// stderr 逐行透传 eprintln（dev 可见）；stdout/stderr 可选落日志文件（打包态排障）。
pub fn spawn(config: SidecarConfig, log_path: Option<PathBuf>) -> Result<SidecarProcess, String> {
    let mut command = Command::new(&config.command);
    command
        .args(&config.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &config.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &config.env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("spawn {} {} failed: {err}", config.command, config.args.join(" ")))?;
    let stdout = child.stdout.take().ok_or("child stdout is not piped")?;
    let stderr = child.stderr.take().ok_or("child stderr is not piped")?;

    let ready: Arc<OnceLock<ReadyInfo>> = Arc::new(OnceLock::new());
    let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    // stdout：ready 协议线程。EOF（子进程退出）且未 ready → 显式 error。
    {
        let ready = Arc::clone(&ready);
        let error = Arc::clone(&error);
        let log_path = log_path.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log_line(&log_path, &line);
                if let Some(info) = parse_ready_line(&line) {
                    let _ = ready.set(info);
                }
            }
            if ready.get().is_none() && error.lock().unwrap().is_none() {
                *error.lock().unwrap() = Some("sidecar exited before printing a ready line".into());
            }
        });
    }

    // stderr：透传 + 落日志（实验性 SQLite warning 等噪声在 stderr，不参与协议）
    {
        let log_path = log_path.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[morrow-sidecar] {line}");
                log_line(&log_path, &line);
            }
        });
    }

    // watchdog：ready 超时兜底（EOF 提前退出由 stdout 线程负责）
    {
        let ready = Arc::clone(&ready);
        let error = Arc::clone(&error);
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(READY_TIMEOUT_SECS);
            while ready.get().is_none() && error.lock().unwrap().is_none() {
                if Instant::now() >= deadline {
                    *error.lock().unwrap() =
                        Some(format!("sidecar not ready after {READY_TIMEOUT_SECS}s"));
                    return;
                }
                thread::sleep(POLL_INTERVAL);
            }
        });
    }

    Ok(SidecarProcess {
        child: Mutex::new(child),
        ready,
        error,
        terminated: AtomicBool::new(false),
    })
}

/// 追加一行到 sidecar 日志（unix 时间戳 + 原始行）；目录不存在则创建，失败静默跳过。
fn log_line(path: &Option<PathBuf>, line: &str) {
    let Some(path) = path else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        use std::io::Write as _;
        let _ = writeln!(file, "[{ts}] {line}");
    }
}

/// 运行中的 sidecar 的 pid（进程级转发改 SignalForward 用：SIGTERM/SIGINT 到壳时，
/// Tauri 事件循环不会运行（默认处置直接终止），异步信号安全处理里只有 kill 一个 syscall）。
/// Windows 无信号消费方，保留统一写入面（main.rs store 不分平台）。
pub static SIDECAR_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

/// SIGTERM/SIGINT → 给 sidecar 发 SIGTERM 后 _exit(0)（异步信号安全：仅 kill 一个 syscall）。
#[cfg(unix)]
extern "C" fn forward_termination_signal(_signal: libc::c_int) {
    let pid = SIDECAR_PID.load(Ordering::SeqCst);
    if pid > 0 {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    unsafe { libc::_exit(0) };
}

/// 注册 SIGTERM/SIGINT 转发：壳被外部信号终止时，先给 sidecar 发 SIGTERM 再退出，
/// 保证 Runtime 优雅落盘（runtime.stopped 落账 + WAL checkpoint）。
/// Windows：无 SIGTERM/SIGINT 语义可注册（控制台事件仅覆盖有控制台的会话，打包 GUI
/// 应用无控制台；Node 子进程也收不到 OS 级终止信号），不做转发——no-op，已知限制见
/// 模块注释；窗口关闭/正常退出路径仍经 terminate() 收敛。
pub fn install_signal_forwarding() {
    #[cfg(unix)]
    {
        let handler =
            forward_termination_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        unsafe {
            libc::signal(libc::SIGTERM, handler);
            libc::signal(libc::SIGINT, handler);
        }
    }
}

// --- 测试 -------------------------------------------------------------------
// 测试 seam（与票面验收对应）：
//   parse_ready_line / defaults_for_entry / resolve —— sidecar 启动协议与可配置性；
//   sidecar_smoke —— 真实 dist 全链路（spawn → ready → health 200 → SIGTERM 落盘退出）。
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    /// env 是进程全局的：env 相关用例串行
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn set_env(key: &str, value: &str) {
        env::set_var(key, value);
    }

    fn clear_env() {
        env::remove_var("MORROW_SIDECAR_COMMAND");
        env::remove_var("MORROW_SIDECAR_ARGS");
        env::remove_var("MORROW_SIDECAR_CWD");
    }

    // --- parse_ready_line：stdout ready 协议 ---------------------------------

    #[test]
    fn parse_ready_line_accepts_runtime_ready_frame() {
        // 字段与 apps/runtime/src/main.ts 的 ready 输出一致（真实样例）
        let line = r#"{"ready":true,"version":"0.1.0","host":"127.0.0.1","port":51174,"pid":28484,"data_dir":"/tmp/morrow","replica_id":"83753145-583e-4df1-8bca-7dc7b4ac4e54"}"#;
        let info = parse_ready_line(line).expect("ready frame should parse");
        assert_eq!(info.host, "127.0.0.1");
        assert_eq!(info.port, 51174);
        assert_eq!(info.pid, Some(28484));
        assert_eq!(info.version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn parse_ready_line_tolerates_surrounding_whitespace() {
        let info = parse_ready_line("  {\"ready\":true,\"host\":\"localhost\",\"port\":8080}\r\n")
            .expect("whitespace-wrapped frame should parse");
        assert_eq!(info.port, 8080);
        assert_eq!(info.host, "localhost");
        assert_eq!(info.pid, None);
    }

    #[test]
    fn parse_ready_line_rejects_non_ready_frames() {
        assert!(parse_ready_line("").is_none());
        assert!(parse_ready_line("not json").is_none());
        assert!(parse_ready_line(r#"{"ready":false}"#).is_none());
        // 优雅退出行不是 ready 帧
        assert!(parse_ready_line(r#"{"stopped":true,"signal":"SIGTERM"}"#).is_none());
        // 缺 port（控制面地址不可用）不能算 ready
        assert!(parse_ready_line(r#"{"ready":true,"host":"127.0.0.1"}"#).is_none());
        // 缺 host 同理
        assert!(parse_ready_line(r#"{"ready":true,"port":8080}"#).is_none());
    }

    // --- 默认参数与配置解析 ----------------------------------------------------

    #[test]
    fn defaults_use_sqlite_flag_and_entry_dir_as_cwd() {
        let entry = Path::new("/repo/apps/runtime/dist/main.js");
        let (args, cwd) = defaults_for_entry(entry);
        assert_eq!(args[0], "--experimental-sqlite");
        assert_eq!(args[1], "/repo/apps/runtime/dist/main.js");
        assert_eq!(args.len(), 2);
        assert_eq!(cwd, Path::new("/repo/apps/runtime/dist"));
    }

    #[test]
    fn resolve_env_overrides_take_precedence() {
        let _guard = ENV_LOCK.lock().unwrap();
        set_env("MORROW_SIDECAR_COMMAND", "/usr/local/bin/morrow-runtime");
        set_env("MORROW_SIDECAR_ARGS", r#"["serve","--port","0"]"#);
        set_env("MORROW_SIDECAR_CWD", "/tmp/sidecar-cwd");
        let config = SidecarConfig::resolve(None).expect("override config should resolve");
        assert_eq!(config.command, "/usr/local/bin/morrow-runtime");
        assert_eq!(config.args, vec!["serve", "--port", "0"]);
        assert_eq!(config.cwd, Some(PathBuf::from("/tmp/sidecar-cwd")));
        clear_env();
    }

    #[test]
    fn resolve_invalid_args_json_is_an_error() {
        let _guard = ENV_LOCK.lock().unwrap();
        set_env("MORROW_SIDECAR_ARGS", "serve --port 0");
        assert!(SidecarConfig::resolve(None).is_err(), "非 JSON 数组的 ARGS 必须显式报错");
        clear_env();
    }

    #[test]
    fn resolve_defaults_target_runtime_dist() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_env();
        if cfg!(debug_assertions) {
            let config = SidecarConfig::resolve(None).expect("dev default should resolve");
            assert_eq!(config.command, "node");
            assert_eq!(config.args[0], "--experimental-sqlite");
            assert!(
                config.args[1].ends_with("apps/runtime/dist/main.js"),
                "dev 默认入口应指向仓库 dist，实际: {}",
                config.args[1]
            );
            assert_eq!(
                config.cwd.as_deref(),
                Some(Path::new(&config.args[1]).parent().unwrap())
            );
        } else {
            // release：必须显式给入口（资源目录），缺失要报错而不是静默跑错目标
            assert!(SidecarConfig::resolve(None).is_err());
            let config =
                SidecarConfig::resolve(Some(Path::new("/res/runtime/main.js"))).expect("release with entry");
            assert_eq!(config.args[1], "/res/runtime/main.js");
        }
        clear_env();
    }

    #[test]
    fn dev_entry_points_into_repo() {
        assert!(dev_entry().ends_with("apps/runtime/dist/main.js"));
    }

    // --- 全链路冒烟：真实 dist → ready → health → SIGTERM ----------------------

    #[test]
    fn sidecar_smoke_dist_ready_health_then_sigterm() {
        let entry = dev_entry();
        if !entry.exists() {
            eprintln!("skip: runtime dist 未构建（先跑 pnpm --filter @morrow/runtime build）");
            return;
        }
        let data_dir = env::temp_dir().join(format!("morrow-sidecar-smoke-{}", std::process::id()));
        let (args, cwd) = defaults_for_entry(&entry); // ["--experimental-sqlite", <entry>]
        let config = SidecarConfig {
            command: "node".into(),
            args,
            cwd: Some(cwd),
            env: vec![("MORROW_DATA_DIR".into(), data_dir.to_string_lossy().into_owned())],
        };
        let process = spawn(config, None).expect("sidecar should spawn");

        // 1) ready 状态浮现（watchdog 兜底超时由实现保证）
        let deadline = Instant::now() + Duration::from_secs(READY_TIMEOUT_SECS);
        let status = loop {
            let status = process.status();
            match status.state.as_str() {
                "ready" => break status,
                "error" => panic!("sidecar error before ready: {:?}", status.error),
                _ => {}
            }
            assert!(Instant::now() < deadline, "timeout waiting for sidecar ready");
            thread::sleep(POLL_INTERVAL);
        };
        let host = status.host.expect("ready implies host");
        let port = status.port.expect("ready implies port");

        // 2) 控制面健康（raw HTTP，验证 UI 即将使用的同一地址）
        let body = http_get(&host, port, "/v1/health").expect("health request should succeed");
        assert!(body.contains("200"), "expected 200, got: {body}");
        assert!(body.contains("\"status\":\"ok\""), "health body: {body}");

        // 3) SIGTERM：子进程退出（Runtime 优雅落盘），幂等再调不炸
        process.terminate();
        process.terminate();
        assert!(process.has_exited(), "child should exit after SIGTERM");
    }

    fn http_get(host: &str, port: u16, path: &str) -> std::io::Result<String> {
        let mut stream = TcpStream::connect((host, port))?;
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
        )?;
        let mut body = String::new();
        stream.read_to_string(&mut body)?;
        Ok(body)
    }
}
