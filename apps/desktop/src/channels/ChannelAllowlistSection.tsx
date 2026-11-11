import { useCallback, useEffect, useState } from "react";
import { api, type ChannelSummary } from "../api.ts";
import {
  ALLOW_MODES,
  allowModeLabel,
  allowlistFromEntries,
  channelDisplayName,
  toAllowlistPayload,
  validateAllowlistRows,
  type AllowlistDraftRow,
} from "../channel-ui.ts";
import type { ChannelAllowMode } from "@morrow/protocol/browser";
import { Button } from "../design-system/primitives/Button.tsx";
import { readableError } from "./shared.ts";

/** 2. 群聊白名单：会话 id × 模式增删与整表保存 */
export function ChannelAllowlistSection({ base, channels }: { base: string; channels: ChannelSummary[] }) {
  const [channelId, setChannelId] = useState<string>("");
  const [rows, setRows] = useState<AllowlistDraftRow[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (channelId === "" && channels.length > 0) {
      const preferred = channels.find((channel) => channel.channel_id === "wechat") ?? channels[0];
      setChannelId(preferred.channel_id);
    }
  }, [channels, channelId]);

  const load = useCallback(
    async (id: string) => {
      if (id === "") return;
      setLoading(true);
      setError(null);
      setMessage(null);
      try {
        const response = await api.getAllowlist(base, id);
        setRows(allowlistFromEntries(response.allowlist));
        setAccountId(response.account_id);
      } catch (err) {
        setError(readableError(err, "加载白名单失败"));
      } finally {
        setLoading(false);
      }
    },
    [base],
  );

  useEffect(() => {
    void load(channelId);
  }, [channelId, load]);

  const save = async () => {
    if (channelId === "" || saving) return;
    const validation = validateAllowlistRows(rows);
    if (validation !== null) {
      setError(validation);
      setMessage(null);
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.putAllowlist(base, channelId, toAllowlistPayload(rows));
      setRows(allowlistFromEntries(response.allowlist));
      setAccountId(response.account_id);
      setMessage("已保存（整表替换，channel.allowlist_updated 审计已落账）。");
    } catch (err) {
      setError(readableError(err, "保存白名单失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="task-section channel-section">
      <div className="section-head">
        <h4>群聊白名单</h4>
        <div className="inline-actions">
          <select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
            {channels.map((channel) => (
              <option key={channel.channel_id} value={channel.channel_id}>
                {channelDisplayName(channel.channel_id)}
              </option>
            ))}
          </select>
          <Button onClick={() => void load(channelId)} disabled={loading || channelId === ""}>
            {loading ? "读取中…" : "刷新"}
          </Button>
        </div>
      </div>
      <p className="page-hint">
        只有白名单内的会话才响应。微信个人号对私聊也要求白名单（fail-closed）。
        「仅 @ 回复」= 群内必须 @ 才处理；「有限主动消息」仍需服从平台频控与场景限制。
      </p>
      {accountId === null && channelId !== "" && (
        <p className="field-hint">该渠道未绑定账号：保存不会生效（先在 Runtime 注册渠道账号）。</p>
      )}
      {error !== null && <div className="banner-error">{error}</div>}
      {rows.length === 0 && error === null && !loading && (
        <p className="empty-note">白名单为空。点「新增会话」添加要响应的群/私聊会话 id。</p>
      )}
      <ul className="allowlist-list">
        {rows.map((row, index) => (
          <li key={index} className="allowlist-row">
            <input
              className="mono allowlist-id"
              value={row.native_conversation_id}
              placeholder="平台会话 id（如 oc_xxx / wx-group-1）"
              spellCheck={false}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, native_conversation_id: event.target.value };
                setRows(next);
              }}
            />
            <select
              value={row.mode}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, mode: event.target.value as ChannelAllowMode };
                setRows(next);
              }}
            >
              {ALLOW_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {allowModeLabel(mode)}
                </option>
              ))}
            </select>
            <Button variant="danger" onClick={() => setRows(rows.filter((_value, position) => position !== index))}>
              删除
            </Button>
          </li>
        ))}
      </ul>
      <div className="form-actions">
        <Button onClick={() => setRows([...rows, { native_conversation_id: "", mode: "mention_only" }])}>
          新增会话
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving || channelId === ""}>
          {saving ? "保存中…" : "保存白名单"}
        </Button>
        {message !== null && <span className="hint-inline tone-ok-text">{message}</span>}
      </div>
    </section>
  );
}
