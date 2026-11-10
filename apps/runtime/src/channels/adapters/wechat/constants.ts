import type { ChannelEnvironment } from "@morrow/protocol";

/**
 * 微信个人号实验适配器的固定声明（M4-T5 / Issue #42，ADR-0005）。
 *
 * 环境与风险文案是产品约束，不是可调参数：环境（Windows + 最新版微信）决定实验
 * 可复现性；风险文案必须与文档一致地出现在 API 响应（清单/health）里，供 UI 呈现。
 */

/** 目标环境：只在 Windows + 最新版微信桌面客户端上声明可用。 */
export const WECHAT_ENVIRONMENT: ChannelEnvironment = {
  os: "Windows",
  client: "最新版微信 Windows 桌面客户端",
  bridge: "LocalBridge（M4 仅 StubLocalBridge；真实本地桥未实现）",
  real_integration: "not_done",
  notes:
    "真实微信联调未做，需 Owner Windows 机器；不承诺跨 OS 稳定，也不承诺账号安全。",
};

/** 风险声明：API risk_notice 与 README 双处一致（UI 在 T8 呈现）。 */
export const WECHAT_RISK_NOTICE =
  "微信个人号适配器属于实验功能：基于非官方自动化，不稳定、可能随时失效，且可能违反微信平台服务条款，导致账号被限制或封禁；账号风险自担。出厂默认关闭，启用必须显式确认风险（confirm_risk=true）。真实微信联调尚未完成，需 Owner 的 Windows 机器。";

/** 实验适配器标记（清单/health 均如实呈现）。 */
export const WECHAT_EXPERIMENTAL = true;
