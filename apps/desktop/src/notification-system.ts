/**
 * 系统通知桥（Issue #47，PRD §4.8 FR-NOT-2）。
 *
 * 唯一接触 Tauri v2 官方 `@tauri-apps/plugin-notification` 的模块；所有失败都
 * 折成「不可用/未授予」的布尔结果，由上层（NotificationCenter）降级到应用内中心。
 *
 * 行为约定：
 * - 非 Tauri 环境（浏览器联调）→ unavailable；绝不尝试 Web Notification API
 *   （桌面壳的权限语义不同，统一走插件）；
 * - 首次启动只在「prompt」态请求一次；被拒后写本地标记，之后不再自动弹系统授权框
 *   （用户可在通知中心手动「重新请求权限」）；
 * - 发送失败不抛错（视图层仍保留 pending 供应用内读取），也不记录正文。
 */
import type { NotificationRecord } from "@morrow/protocol/browser";
import {
  PERMISSION_DENIED_STORAGE_KEY,
  type NotificationPermissionState,
} from "./notification-center.ts";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function loadPlugin(): Promise<typeof import("@tauri-apps/plugin-notification")> {
  return import("@tauri-apps/plugin-notification");
}

/**
 * 读取当前权限态。插件只暴露 isPermissionGranted()（无 denied/prompt 区分），
 * 因此「未授予 + 本地拒绝标记」视为 denied（不再自动请求），否则视为 prompt。
 */
export async function getNotificationPermissionState(
  previouslyDenied: boolean,
): Promise<NotificationPermissionState> {
  if (!isTauriRuntime()) return "unavailable";
  try {
    const { isPermissionGranted } = await loadPlugin();
    if (await isPermissionGranted()) return "granted";
    return previouslyDenied ? "denied" : "prompt";
  } catch {
    return "unavailable";
  }
}

/** 显式请求系统通知权限（首次启动或用户点「重新请求权限」）；非 granted 一律按 denied */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isTauriRuntime()) return "unavailable";
  try {
    const { requestPermission } = await loadPlugin();
    const state = await requestPermission();
    return state === "granted" ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

/** 弹系统通知；返回是否真正交给系统（false = 降级应用内，调用方不 ack） */
export async function showSystemNotification(
  record: Pick<NotificationRecord, "title" | "body">,
): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { isPermissionGranted, sendNotification } = await loadPlugin();
    if (!(await isPermissionGranted())) return false;
    sendNotification({ title: record.title, body: record.body });
    return true;
  } catch {
    return false;
  }
}

type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safeStorage(): FlagStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 本地拒绝标记：存在 → 不再自动弹授权框（应用内提示 + 手动重试） */
export function readPermissionDeniedFlag(storage: FlagStorage | null = safeStorage()): boolean {
  try {
    return storage?.getItem(PERMISSION_DENIED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writePermissionDeniedFlag(
  denied: boolean,
  storage: FlagStorage | null = safeStorage(),
): void {
  try {
    if (denied) storage?.setItem(PERMISSION_DENIED_STORAGE_KEY, "1");
    else storage?.removeItem(PERMISSION_DENIED_STORAGE_KEY);
  } catch {
    // 存储不可用（隐私模式/配额）→ 仅影响下次启动是否自动请求，不影响通知展示
  }
}
