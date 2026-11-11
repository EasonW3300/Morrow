import { useCallback, useEffect, useState } from "react";
import { api, type ChannelSummary } from "../api.ts";
import { channelDisplayName, validateNotifyTargetInput } from "../channel-ui.ts";
import { Button } from "../design-system/primitives/Button.tsx";
import { readableError } from "./shared.ts";

interface TargetRow {
  channelId: string;
  current: string | null;
  draft: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  message: string | null;
}

/**
 * 默认通知会话（M6-T2 / Issue #53 走查修复）。
 *
 * channel:<id> 通知规则保存前，Runtime 要求该渠道已配置默认通知会话
 * （PUT /v1/channels/:id/notify-target，fail-closed）。此前 UI 无任何配置入口：
 * 用户在「通知规则」里选渠道目标保存只会得到 400 notify_target_required。
 * 本区块把前置条件放到规则上方，并在保存后提示规则可以继续配置。
 */
export function ChannelNotifyTargetSection({
  base,
  channels,
}: {
  base: string;
  channels: ChannelSummary[];
}) {
  const [rows, setRows] = useState<TargetRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const channelIds = channels.map((channel) => channel.channel_id).join(",");

  const load = useCallback(async () => {
    setLoadError(null);
    const loaded = await Promise.all(
      channels.map(async (channel): Promise<TargetRow> => {
        try {
          const view = await api.getChannelNotifyTarget(base, channel.channel_id);
          return {
            channelId: channel.channel_id,
            current: view.native_conversation_id,
            draft: view.native_conversation_id ?? "",
            loading: false,
            saving: false,
            error: null,
            message: null,
          };
        } catch (err) {
          return {
            channelId: channel.channel_id,
            current: null,
            draft: "",
            loading: false,
            saving: false,
            error: readableError(err, "读取默认通知会话失败"),
            message: null,
          };
        }
      }),
    );
    setRows(loaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- channelIds 是 channels 的稳定指纹
  }, [base, channelIds]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (channelId: string, next: Partial<TargetRow>) => {
    setRows((prev) => prev.map((row) => (row.channelId === channelId ? { ...row, ...next } : row)));
  };

  const save = async (row: TargetRow) => {
    const validation = validateNotifyTargetInput(row.draft);
    if (validation !== null) {
      patch(row.channelId, { error: validation, message: null });
      return;
    }
    patch(row.channelId, { saving: true, error: null, message: null });
    try {
      const view = await api.putChannelNotifyTarget(base, row.channelId, row.draft.trim());
      patch(row.channelId, {
        saving: false,
        current: view.native_conversation_id,
        draft: view.native_conversation_id ?? "",
        message: `已保存；现在可以在下方「通知规则」里选择「渠道 · ${channelDisplayName(row.channelId)}」。`,
      });
    } catch (err) {
      patch(row.channelId, { saving: false, error: readableError(err, "保存默认通知会话失败") });
    }
  };

  if (channels.length === 0) return null;

  return (
    <section className="task-section channel-section">
      <div className="section-head">
        <h4>默认通知会话</h4>
        <Button onClick={() => void load()}>刷新</Button>
      </div>
      <p className="page-hint">
        渠道通知规则（channel:&lt;id&gt;）的前置条件：先指定该渠道接收通知的会话。会话必须已存在或已加入白名单；
        未配置时保存渠道规则会被 Runtime 拒绝（notify_target_required），不会静默丢失。
      </p>
      {loadError !== null && <div className="banner-error">{loadError}</div>}
      <ul className="notify-target-list">
        {rows.map((row) => (
          <li key={row.channelId} className="notify-target-row">
            <div className="notify-target-main">
              <strong>{channelDisplayName(row.channelId)}</strong>
              <span className="hint-inline mono">{row.channelId}</span>
              <span className={row.current === null ? "badge tone-warn" : "badge tone-ok"}>
                {row.current === null ? "未配置" : `当前：${row.current}`}
              </span>
            </div>
            <div className="notify-target-edit">
              <input
                className="mono"
                value={row.draft}
                placeholder="该渠道已存在/已白名单的会话 id"
                onChange={(event) => patch(row.channelId, { draft: event.target.value })}
              />
              <Button
                variant="primary"
                size="sm"
                disabled={row.saving}
                onClick={() => void save(row)}
              >
                {row.saving ? "保存中…" : "保存"}
              </Button>
            </div>
            {row.error !== null && <p className="hint-inline tone-error-text">{row.error}</p>}
            {row.message !== null && <p className="hint-inline tone-ok-text">{row.message}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
