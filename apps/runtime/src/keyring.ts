/**
 * OS 凭据库统一封装（票 T5 / Issue #6，ADR-0002：密钥只进 OS 凭据库）。
 *
 * 零 native 模块（为 T8 bun compile 铺路，同 db.ts 选型逻辑）：用各 OS 自带 CLI 包一层
 * 统一 SecretStore 接口——
 *   macOS   `security` CLI（/usr/bin/security，系统自带）        —— 本机实测通过
 *   Windows cmdkey（写/删）+ PowerShell CredRead P/Invoke（读）   —— 接口 + exec 桩测试，真实 OS 未实测
 *   Linux   secret-tool（libsecret CLI，GNOME Keyring/KWallet 适配层）—— 接口 + exec 桩测试，真实 OS 未实测
 *   其他    内存桩（测试替身；无凭据库环境的显式回退，密钥只在进程内存）
 *
 * 安全边界：
 * - 密钥经 CLI argv/stdin 传递。macOS 用 argv（security CLI 不支持非交互 stdin 写入）；
 *   Linux 用 stdin（secret-tool store 从 stdin 读 secret，密钥不进进程列表）；
 *   Windows cmdkey 只支持 argv（未实测路径，文档标注）。短生命周期的 argv 暴露是
 *   各 OS CLI 的固有限制，M0 单用户本地场景接受并记录在案。
 * - 所有调用带超时，防凭据库交互弹窗挂死进程（超时按错误抛出）。
 */

import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (
  file: string,
  args: string[],
  options?: { input?: string },
) => Promise<ExecResult>;

export interface SecretStore {
  /** 写入或覆盖（同 service+account 原子更新，密钥轮换用） */
  setSecret(service: string, account: string, secret: string): Promise<void>;
  /** 读取；不存在返回 null（区分于空串密钥） */
  getSecret(service: string, account: string): Promise<string | null>;
  /** 删除；幂等（不存在不抛错） */
  deleteSecret(service: string, account: string): Promise<void>;
}

const EXEC_TIMEOUT_MS = 10_000;

/** node:child_process.execFile 的 Promise 化包装（非零退出码不 reject，返回 exitCode） */
export function defaultExec(file: string, args: string[], options?: { input?: string }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          reject(new Error(`${file} timed out after ${EXEC_TIMEOUT_MS}ms`));
          return;
        }
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: code });
      },
    );
    if (options?.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

// --- macOS Keychain（/usr/bin/security，本机实测） ----------------------------

/**
 * macOS Keychain 后端：
 * - set：`security add-generic-password -s <service> -a <account> -w <secret> -U`（-U = 存在则更新）
 * - get：`security find-generic-password -s <service> -a <account> -w`（exit 44 = 未找到）
 * - delete：`security delete-generic-password -s <service> -a <account>`（未找到也视为已删）
 */
export function createKeychainStore(exec: ExecFn = defaultExec, securityPath = "/usr/bin/security"): SecretStore {
  return {
    async setSecret(service, account, secret) {
      const res = await exec(securityPath, [
        "add-generic-password",
        "-s", service,
        "-a", account,
        "-w", secret,
        "-U",
      ]);
      if (res.exitCode !== 0) {
        throw new Error(`keychain setSecret failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
      }
    },
    async getSecret(service, account) {
      const res = await exec(securityPath, [
        "find-generic-password",
        "-s", service,
        "-a", account,
        "-w",
      ]);
      if (res.exitCode !== 0) return null; // 44 = item not found；其他错误（如无钥匙串访问权）同样按未找到处理
      const out = res.stdout;
      // security 输出末尾带换行；密钥本身可能含换行——只剥最后一个换行
      return out.endsWith("\n") ? out.slice(0, -1) : out;
    },
    async deleteSecret(service, account) {
      const res = await exec(securityPath, [
        "delete-generic-password",
        "-s", service,
        "-a", account,
      ]);
      if (res.exitCode !== 0 && res.exitCode !== 44) {
        throw new Error(`keychain deleteSecret failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
      }
    },
  };
}

// --- Windows Credential Manager（cmdkey + PowerShell；真实 OS 未实测） --------

/**
 * Windows Credential Manager 后端（凭据目标 `<service>:<account>`）：
 * - set：`cmdkey /generic:<target> /user:<user> /pass:<secret>`
 * - get：PowerShell 内联 CredRead P/Invoke（cmdkey 无读取能力）；blob 按 UTF-16LE 解码
 *   （与 cmdkey 写入的编码一致）
 * - delete：`cmdkey /delete:<target>`
 */
const CRED_READ_SCRIPT_TEMPLATE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MorrowCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credPtr);
  public static string ReadBlob(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return null; // type 1 = CRED_TYPE_GENERIC
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (cred.CredentialBlobSize <= 0) return "";
      byte[] bytes = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, bytes, 0, bytes.Length);
      return System.Text.Encoding.Unicode.GetString(bytes);
    } finally { Marshal.FreeHGlobal(ptr); }
  }
}
'@
[MorrowCred]::ReadBlob('TARGET')
`;

function credReadScript(target: string): string {
  return CRED_READ_SCRIPT_TEMPLATE.replace("TARGET", target.replaceAll("'", "''"));
}

export function createWindowsCredentialStore(exec: ExecFn = defaultExec): SecretStore {
  const target = (service: string, account: string): string => `${service}:${account}`;
  return {
    async setSecret(service, account, secret) {
      const res = await exec("cmdkey", [
        `/generic:${target(service, account)}`,
        "/user:morrow",
        `/pass:${secret}`,
      ]);
      if (res.exitCode !== 0) {
        throw new Error(`cmdkey setSecret failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
      }
    },
    async getSecret(service, account) {
      const res = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", credReadScript(target(service, account))]);
      if (res.exitCode !== 0) return null;
      return res.stdout.length > 0 ? res.stdout : null;
    },
    async deleteSecret(service, account) {
      const res = await exec("cmdkey", [`/delete:${target(service, account)}`]);
      // cmdkey 对不存在的目标输出 "error ... not found" 且非零退出——按幂等处理
      if (res.exitCode !== 0 && !/not found|找不到|未能找到/i.test(res.stderr + res.stdout)) {
        throw new Error(`cmdkey deleteSecret failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
      }
    },
  };
}

// --- Linux secret-tool（libsecret CLI；真实 OS 未实测） -----------------------

/**
 * Linux secret-tool 后端（attribute 方式存储：service=<service> account=<account>）：
 * - set：`secret-tool store --label=... service <service> account <account>`，secret 从 stdin 读（不进 argv）
 * - get：`secret-tool lookup service <service> account <account>`（空输出/非零 = 未找到）
 * - delete：`secret-tool clear service <service> account <account>`（幂等）
 */
export function createLinuxSecretToolStore(exec: ExecFn = defaultExec, secretToolPath = "secret-tool"): SecretStore {
  return {
    async setSecret(service, account, secret) {
      const res = await exec(secretToolPath, [
        "store",
        "--label=morrow provider secret",
        "service", service,
        "account", account,
      ], { input: secret });
      if (res.exitCode !== 0) {
        throw new Error(`secret-tool setSecret failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
      }
    },
    async getSecret(service, account) {
      const res = await exec(secretToolPath, ["lookup", "service", service, "account", account]);
      if (res.exitCode !== 0 || res.stdout.length === 0) return null;
      return res.stdout.endsWith("\n") ? res.stdout.slice(0, -1) : res.stdout;
    },
    async deleteSecret(service, account) {
      const res = await exec(secretToolPath, ["clear", "service", service, "account", account]);
      if (res.exitCode !== 0) {
        throw new Error(`secret-tool deleteSecret failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
      }
    },
  };
}

// --- 内存桩（测试替身 / 无凭据库环境的显式回退） -------------------------------

export function createInMemorySecretStore(): SecretStore {
  const secrets = new Map<string, string>();
  const key = (service: string, account: string): string => `${service}\u0000${account}`;
  return {
    async setSecret(service, account, secret) {
      secrets.set(key(service, account), secret);
    },
    async getSecret(service, account) {
      return secrets.get(key(service, account)) ?? null;
    },
    async deleteSecret(service, account) {
      secrets.delete(key(service, account));
    },
  };
}

// --- 平台检测 -----------------------------------------------------------------

export interface DetectedSecretStore {
  store: SecretStore;
  /** 后端标识（诊断与文档用） */
  backend: "macos-keychain" | "windows-credential-manager" | "linux-secret-tool" | "in-memory";
}

export function detectSecretStore(platform: NodeJS.Platform = process.platform): DetectedSecretStore {
  switch (platform) {
    case "darwin":
      return { store: createKeychainStore(), backend: "macos-keychain" };
    case "win32":
      return { store: createWindowsCredentialStore(), backend: "windows-credential-manager" };
    case "linux":
      return { store: createLinuxSecretToolStore(), backend: "linux-secret-tool" };
    default:
      return { store: createInMemorySecretStore(), backend: "in-memory" };
  }
}
