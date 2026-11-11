import { useEffect, useState } from "react";
import { api, type ChannelSecretsView } from "../api.ts";
import {
  buildSecretsPayload,
  channelDisplayName,
  credentialFieldLabel,
  credentialFormInitial,
  credentialSummary,
  validateCredentialForm,
  type CredentialFieldErrors,
} from "../channel-ui.ts";
import { GlassSurface } from "../design-system/primitives/GlassSurface.tsx";
import { Button } from "../design-system/primitives/Button.tsx";
import { readableError } from "./shared.ts";

/** 飞书/QQ 凭据表单：显示 configured 投影，只提交新填写的值 */
export function ChannelCredentialsForm({
  base,
  channelId,
  onClose,
  onSaved,
}: {
  base: string;
  channelId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [view, setView] = useState<ChannelSecretsView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<CredentialFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    api
      .getChannelSecrets(base, channelId)
      .then((loaded) => {
        if (cancelled) return;
        setView(loaded);
        setValues(credentialFormInitial(loaded));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(readableError(err, "读取凭据投影失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [base, channelId]);

  const save = async () => {
    if (view === null || saving) return;
    const nextErrors = validateCredentialForm(view, values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const payload = buildSecretsPayload(values);
    if (Object.keys(payload).length === 0) {
      setError("没有填写任何字段；空值表示保持现有凭据不变。");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.putChannelSecrets(base, channelId, payload);
      setView(updated);
      setValues(credentialFormInitial(updated));
      setMessage("已写入系统凭据库（不回显）。");
      await onSaved();
    } catch (err) {
      setError(readableError(err, "保存凭据失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <GlassSurface
        variant="elevated"
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="渠道凭据配置"
        onClick={(event) => event.stopPropagation()}
      >
        <h3>配置凭据：{channelDisplayName(channelId)}</h3>
        <p className="modal-lead">
          凭据只写系统凭据库（SecretStore），界面只显示「已配置」投影；保存后不会回显任何密钥。
          留空表示保持现有值不变。
        </p>
        {error !== null && <div className="banner-error">{error}</div>}
        {view === null ? (
          <p className="empty-note">正在读取凭据投影…</p>
        ) : (
          <>
            <p className="hint-inline">{credentialSummary(view)}</p>
            <div className="form-grid">
              {view.fields.map((field) => (
                <label className="field" key={field.field}>
                  <span className="field-label">
                    {credentialFieldLabel(field.field)}
                    {field.required ? "（必填）" : ""}
                    {field.configured && <span className="badge badge-tone-ok">已配置（不回显）</span>}
                  </span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={values[field.field] ?? ""}
                    placeholder={field.configured ? "••••••••（留空保持不变）" : "请输入"}
                    onChange={(event) => setValues({ ...values, [field.field]: event.target.value })}
                  />
                  {errors[field.field] !== undefined ? (
                    <span className="field-error">{errors[field.field]}</span>
                  ) : null}
                </label>
              ))}
            </div>
            {message !== null && <p className="hint-inline tone-ok-text">{message}</p>}
            <div className="form-actions">
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? "保存中…" : "保存凭据"}
              </Button>
              <Button onClick={onClose} disabled={saving}>
                关闭
              </Button>
            </div>
          </>
        )}
      </GlassSurface>
    </div>
  );
}
