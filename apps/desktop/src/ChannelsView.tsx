import { Button } from "./design-system/primitives/Button.tsx";
import { ChannelAllowlistSection } from "./channels/ChannelAllowlistSection.tsx";
import { ChannelListSection } from "./channels/ChannelListSection.tsx";
import { ChannelNotifyTargetSection } from "./channels/ChannelNotifyTargetSection.tsx";
import { ContactsSection } from "./channels/ContactsSection.tsx";
import { NotificationRulesSection } from "./channels/NotificationRulesSection.tsx";
import { OutboxReviewSection } from "./channels/OutboxReviewSection.tsx";
import { useChannelsData, useNowMs } from "./channels/useChannelsData.ts";

/**
 * 设置 →「渠道」子页签（M4-T8 / Issue #45；PRD §5.1 渠道管理、§4.4 渠道、§4.8 通知/联系人）。
 *
 * 编排容器：只负责取数与区块装配，具体区块落在 `./channels/`：
 *   1. ChannelListSection      适配器清单（类型/状态/health/capabilities/启停/凭据入口）；
 *   2. ChannelRiskDialog       微信实验启用前的完整风险确认；
 *   3. ChannelCredentialsForm  飞书/QQ 凭据配置（SecretStore，只显示 configured 投影）；
 *   4. ChannelAllowlistSection 群聊白名单；
 *   5. ContactsSection         可信联系人（授权/邀请码/身份歧义）；
 *   6. NotificationRulesSection 通知规则；
 *   7. OutboxReviewSection     Outbox 人工核对与最近 sent 对照。
 *
 * 共享状态：`useChannelsData` 收拢清单 + health + 页面级错误 + 刷新；
 * 其余状态留在各自区块内，经显式 props 传递（不引入状态库）。
 * 全部走控制面 HTTP API；常量与类型只从 `@morrow/protocol/browser` 引（守卫测试）。
 */
export function ChannelsView({ base }: { base: string }) {
  const { channels, healths, error, reload } = useChannelsData(base);
  const nowMs = useNowMs();

  return (
    <div className="settings-section channels-page">
      <div className="page-head">
        <h2>渠道</h2>
        <Button onClick={() => void reload()}>刷新清单与健康</Button>
      </div>
      <p className="page-hint">
        渠道 = 平台适配器 + 本地账号 + 白名单 + 权限解析。所有外发先落 Outbox（不自动重发未知状态）；
        实验适配器（微信个人号）出厂关闭，启用必须显式确认风险。凭据只进系统凭据库，保存后不回显。
      </p>
      {error !== null && <div className="banner-error">{error}</div>}
      <ChannelListSection
        base={base}
        channels={channels}
        healths={healths}
        nowMs={nowMs}
        onChanged={reload}
      />
      <ChannelAllowlistSection base={base} channels={channels} />
      <ContactsSection base={base} nowMs={nowMs} />
      <ChannelNotifyTargetSection base={base} channels={channels} />
      <NotificationRulesSection base={base} channels={channels} />
      <OutboxReviewSection base={base} nowMs={nowMs} />
    </div>
  );
}
