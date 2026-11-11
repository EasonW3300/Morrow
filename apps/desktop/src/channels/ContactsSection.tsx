import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ContactAmbiguityView,
  type ContactCapabilityCategory,
  type ContactInviteView,
  type ContactView,
} from "../api.ts";
import { CONTACT_CAPABILITY_CATEGORIES } from "@morrow/protocol/browser";
import {
  contactCategoryLabel,
  grantSelectionSummary,
  grantedCategories,
  inviteCountdown,
  toggleCategory,
  toGrantsPayload,
  validateDisplayName,
  validateGrantSelection,
} from "../channel-ui.ts";
import { Button } from "../design-system/primitives/Button.tsx";
import { readableError, relativeTime } from "./shared.ts";

/** 3. 可信联系人：授权类别、邀请码、身份歧义裁决 */
export function ContactsSection({ base, nowMs }: { base: string; nowMs: number }) {
  const [contacts, setContacts] = useState<ContactView[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ContactCapabilityCategory[]>>({});
  const [ambiguities, setAmbiguities] = useState<ContactAmbiguityView[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState("");
  const [invite, setInvite] = useState<ContactInviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [loadedContacts, loadedAmbiguities] = await Promise.all([
        api.listContacts(base),
        api.listContactAmbiguities(base, "open"),
      ]);
      setContacts(loadedContacts);
      setDrafts((previous) =>
        Object.fromEntries(
          loadedContacts.map((contact) => [
            contact.contact_id,
            previous[contact.contact_id] ?? grantedCategories(contact.grants),
          ]),
        ),
      );
      setAmbiguities(loadedAmbiguities);
      setError(null);
    } catch (err) {
      setError(readableError(err, "加载联系人失败"));
    }
  }, [base]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const generateInvite = async () => {
    const nameError = validateDisplayName(displayName);
    if (nameError !== null) {
      setError(nameError);
      return;
    }
    setBusy("invite");
    setError(null);
    setMessage(null);
    setCopied(false);
    try {
      const created = await api.createContactInvite(
        base,
        displayName.trim().length === 0 ? {} : { display_name: displayName.trim() },
      );
      setInvite(created);
      setMessage("邀请码只显示这一次；请经渠道发送给对方，由对方回复绑定。");
      await reload();
    } catch (err) {
      setError(readableError(err, "生成邀请码失败"));
    } finally {
      setBusy(null);
    }
  };

  const copyInvite = async () => {
    if (invite === null) return;
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("复制失败：请手动选中邀请码复制。");
    }
  };

  const saveGrants = async (contact: ContactView) => {
    const categories = drafts[contact.contact_id] ?? grantedCategories(contact.grants);
    const validation = validateGrantSelection(categories);
    if (validation !== null) {
      setError(validation);
      return;
    }
    setBusy(contact.contact_id);
    setError(null);
    setMessage(null);
    try {
      await api.putContactGrants(base, contact.contact_id, toGrantsPayload(categories));
      setMessage(`已更新「${contact.display_name}」的授权（contact.grants_updated 审计已落账）。`);
      await reload();
    } catch (err) {
      setError(readableError(err, "保存授权失败"));
    } finally {
      setBusy(null);
    }
  };

  const resolveAmbiguity = async (ambiguity: ContactAmbiguityView) => {
    const contactId = choices[ambiguity.ambiguity_id] ?? ambiguity.candidate_contact_ids[0] ?? "";
    if (contactId === "") {
      setError("该歧义没有可选择的候选联系人。");
      return;
    }
    setBusy(ambiguity.ambiguity_id);
    setError(null);
    setMessage(null);
    try {
      await api.resolveContactAmbiguity(base, ambiguity.ambiguity_id, contactId);
      setMessage("已裁决身份歧义（contact.ambiguity_resolved 审计已落账）。");
      await reload();
    } catch (err) {
      setError(readableError(err, "裁决失败"));
    } finally {
      setBusy(null);
    }
  };

  const countdown = invite === null ? null : inviteCountdown(invite.expires_at, nowMs);

  return (
    <section className="task-section channel-section">
      <div className="section-head">
        <h4>可信联系人</h4>
        <Button onClick={() => void reload()}>刷新</Button>
      </div>
      <p className="page-hint">
        授权粒度 = 联系人 × 能力类别；默认只有「查询问答」。任务执行与记忆引用（仅 public）需显式勾选；
        身份歧义必须由你选择，系统不自动合并。
      </p>
      {error !== null && <div className="banner-error">{error}</div>}
      {message !== null && <p className="hint-inline tone-ok-text">{message}</p>}

      <div className="invite-box">
        <div className="invite-form">
          <label className="field">
            <span className="field-label">邀请新联系人（显示名可选）</span>
            <input
              value={displayName}
              placeholder="例如：同事小王"
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <Button variant="primary" onClick={() => void generateInvite()} disabled={busy === "invite"}>
            {busy === "invite" ? "生成中…" : "生成邀请码"}
          </Button>
        </div>
        {invite !== null && countdown !== null && (
          <div className="invite-result">
            <div>
              <span className="field-label">一次性邀请码</span>
              <div className="invite-code mono">{invite.code}</div>
            </div>
            <div className="invite-meta">
              <span className={`badge badge-tone-${countdown.tone === "ok" ? "ok" : countdown.tone === "warn" ? "warn" : "error"}`}>
                {countdown.label}
              </span>
              <Button onClick={() => void copyInvite()}>{copied ? "已复制" : "复制"}</Button>
              {countdown.expired && <span className="field-error">已过期，请重新生成。</span>}
            </div>
          </div>
        )}
      </div>

      {contacts.length === 0 && <p className="empty-note">还没有可信联系人。生成邀请码并让对方在渠道里回复即可绑定。</p>}
      <ul className="contact-list">
        {contacts.map((contact) => {
          const categories = drafts[contact.contact_id] ?? grantedCategories(contact.grants);
          return (
            <li key={contact.contact_id} className="contact-row">
              <div className="contact-main">
                <div className="contact-title">
                  <strong>{contact.display_name}</strong>
                  <span className="badge">{contact.status === "active" ? "有效" : "已暂停"}</span>
                  <span className="mono hint-inline">{contact.contact_id.slice(0, 8)}</span>
                </div>
                <div className="contact-meta">
                  {contact.identities.length === 0 ? (
                    <span className="hint-inline">尚未绑定渠道身份</span>
                  ) : (
                    contact.identities.map((identity) => (
                      <span key={`${identity.account_id}:${identity.native_sender_id}`} className="mono">
                        {identity.account_id} / {identity.native_sender_id}
                        {identity.display_name === null ? "" : `（${identity.display_name}）`}
                      </span>
                    ))
                  )}
                </div>
                <div className="grant-checks">
                  {CONTACT_CAPABILITY_CATEGORIES.map((category) => (
                    <label key={category} className="checkbox-row inline">
                      <input
                        type="checkbox"
                        checked={categories.includes(category)}
                        onChange={() =>
                          setDrafts({
                            ...drafts,
                            [contact.contact_id]: toggleCategory(categories, category),
                          })
                        }
                      />
                      {contactCategoryLabel(category)}
                    </label>
                  ))}
                </div>
                <p className="hint-inline">当前授权：{grantSelectionSummary(categories)}</p>
              </div>
              <div className="contact-actions">
                <Button
                  variant="primary"
                  disabled={busy === contact.contact_id}
                  onClick={() => void saveGrants(contact)}
                >
                  {busy === contact.contact_id ? "保存中…" : "保存授权"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="ambiguity-block">
        <h5>身份歧义待裁决</h5>
        {ambiguities.length === 0 ? (
          <p className="hint-inline">没有待裁决的身份歧义。</p>
        ) : (
          <ul className="ambiguity-list">
            {ambiguities.map((ambiguity) => (
              <li key={ambiguity.ambiguity_id} className="ambiguity-row">
                <div>
                  <div className="mono">
                    {ambiguity.account_id} / {ambiguity.native_sender_id}
                  </div>
                  <div className="hint-inline">
                    候选：{ambiguity.candidate_contact_ids.length} 个 · 发生于 {relativeTime(ambiguity.created_at, nowMs)}
                  </div>
                </div>
                <select
                  value={choices[ambiguity.ambiguity_id] ?? ambiguity.candidate_contact_ids[0] ?? ""}
                  onChange={(event) =>
                    setChoices({ ...choices, [ambiguity.ambiguity_id]: event.target.value })
                  }
                >
                  {ambiguity.candidate_contact_ids.map((contactId) => {
                    const contact = contacts.find((candidate) => candidate.contact_id === contactId);
                    return (
                      <option key={contactId} value={contactId}>
                        {contact?.display_name ?? contactId}
                      </option>
                    );
                  })}
                </select>
                <Button
                  disabled={busy === ambiguity.ambiguity_id}
                  onClick={() => void resolveAmbiguity(ambiguity)}
                >
                  选择此人
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
