//! Morrow 桌面壳入口（票 T6 / Issue #7）。
//!
//! 职责只有两件事：
//! 1. 启动时以 sidecar 方式拉起 Runtime（默认 `node --experimental-sqlite dist/main.js`，
//!    命令可用 MORROW_SIDECAR_COMMAND / MORROW_SIDECAR_ARGS / MORROW_SIDECAR_CWD 覆盖，
//!    为 T8 单二进制 / T9 留配置面），从 stdout 的单行 ready JSON 拿到控制面 host/port；
//! 2. 把状态暴露给前端（`sidecar_status` 命令，前端轮询），UI 与 Runtime 之间
//!    只有控制面 HTTP/SSE（fetch/EventSource 直连 127.0.0.1），壳不做私有 IPC 通道。
//!
//! 退出路径：窗口关闭 → ExitRequested → SIGTERM sidecar（Drop 兜底，terminate 幂等）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use sidecar::SidecarStatusView;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
struct SidecarState {
    process: Mutex<Option<sidecar::SidecarProcess>>,
    spawn_error: Mutex<Option<String>>,
}

/// 前端引导的唯一入口：轮询该命令直到 ready/error，拿到 host/port 后直连控制面。
#[tauri::command]
fn sidecar_status(state: tauri::State<SidecarState>) -> SidecarStatusView {
    let process = state.process.lock().unwrap();
    let spawn_error = state.spawn_error.lock().unwrap();
    match (&*process, &*spawn_error) {
        (Some(process), _) => process.status(),
        (None, Some(err)) => SidecarStatusView {
            state: "error".into(),
            host: None,
            port: None,
            error: Some(err.clone()),
        },
        (None, None) => SidecarStatusView {
            state: "starting".into(),
            host: None,
            port: None,
            error: None,
        },
    }
}

fn main() {
    sidecar::install_signal_forwarding();
    tauri::Builder::default()
        .manage(SidecarState::default())
        .setup(|app| {
            // release 打包：Runtime dist 经 tauri resources 落在资源目录 runtime/main.js；
            // dev（debug 构建）：用编译期烘焙的仓库相对路径。
            let release_entry = if cfg!(debug_assertions) {
                None
            } else {
                Some(app.path().resolve("runtime/main.js", tauri::path::BaseDirectory::Resource)?)
            };
            let config = match sidecar::SidecarConfig::resolve(release_entry.as_deref()) {
                Ok(config) => config,
                Err(err) => {
                    *app.state::<SidecarState>().spawn_error.lock().unwrap() = Some(err);
                    return Ok(());
                }
            };
            // sidecar stdout/stderr 落一份日志，打包态排障与验收用（~/Library/Logs/app.morrow.desktop/）
            let log_path = app.path().app_log_dir().ok().map(|dir| dir.join("sidecar.log"));
            match sidecar::spawn(config, log_path) {
                Ok(process) => {
                    sidecar::SIDECAR_PID.store(process.pid() as i32, std::sync::atomic::Ordering::SeqCst);
                    *app.state::<SidecarState>().process.lock().unwrap() = Some(process);
                }
                Err(err) => {
                    *app.state::<SidecarState>().spawn_error.lock().unwrap() = Some(err);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sidecar_status])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                if let Some(process) = &*app_handle.state::<SidecarState>().process.lock().unwrap() {
                    process.terminate(); // 父进程退出 → SIGTERM 子进程，Runtime 优雅落盘退出
                }
            }
        });
}
