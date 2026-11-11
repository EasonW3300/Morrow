/** sidecar_status 命令返回值（src-tauri/src/sidecar.rs SidecarStatusView 的镜像） */
export interface SidecarStatus {
  state: "starting" | "ready" | "error";
  host: string | null;
  port: number | null;
  error: string | null;
}
