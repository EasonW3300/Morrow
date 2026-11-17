import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type SkillInstallConfig, type SkillInstallProposal } from "./api.ts";
import { Badge } from "./design-system/primitives/Badge.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";
import {
  confirmDisabledReason,
  docSourceDisabledReason,
  escalationWarnings,
  formatBytes,
  materializePathHint,
  proposalPermissionLines,
  proposalStatusBadge,
  publicFetchExplanation,
  sourceKindLabel,
} from "./skill-install-ui.ts";

/**
 * 智能安装页（票 M7-B-T4 / Issue #72，FR-B9/B12）。
 *
 * 四道门在 UI 上的呈现：
 *   1. 提案：选来源（上传/粘贴/URL）→ 生成提案（此时无任何落地）
 *   2. 预览：权限清单 + 归途说明 + 示例调用 + 不确定点（含超权警告）
 *   3. 确认：显式点「确认并落地」，非 pending 状态不可点
 *   4. 落地：显示产物（Skill 待批准 / 工厂请求）
 *
 * 出网限制在页面上**主动说明**（公网默认关闭 + 如何开启），而不是等用户贴了链接才报错。
 */
export function SkillInstallView({ base }: { base: string }) {
  const [config, setConfig] = useState<SkillInstallConfig | null>(null);
  const [proposals, setProposals] = useState<SkillInstallProposal[]>([]);
  const [sourceKind, setSourceKind] = useState<"upload" | "paste" | "url">("paste");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [selected, setSelected] = useState<SkillInstallProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [configResult, listResult] = await Promise.all([
      api.getSkillInstallConfig(base),
      api.listSkillInstallProposals(base),
    ]);
    setConfig(configResult);
    setProposals(listResult.proposals);
  }, [base]);

  useEffect(() => {
    void refresh().catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : String(err));
    });
  }, [refresh]);

  async function generate() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.proposeSkillInstall(base, {
        sourceKind,
        ...(sourceKind === "url" ? { url: url.trim() } : { text }),
        ...(sourceKind === "upload" && fileName.trim().length > 0 ? { fileName: fileName.trim() } : {}),
      });
      setSelected(result.proposal);
      setNotice("提案已生成。请检查权限清单与示例调用后再决定是否落地。");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.confirmSkillInstallProposal(base, selected.proposal_id);
      setSelected(result.proposal);
      if (result.materialized_as?.kind === "skill") {
        setNotice("已创建 Skill 提案（待批准后才可调用）。");
      } else if (result.materialized_as?.kind === "factory_request") {
        setNotice(`已提交给能力工厂（request ${result.materialized_as.id.slice(0, 8)}…）：先生成再沙箱验证，通过后还需你确认。`);
      } else {
        setError(result.error_message ?? "落地失败（原因未知）");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.rejectSkillInstallProposal(base, selected.proposal_id, "Owner 在安装页拒绝");
      setSelected(result.proposal);
      setNotice("已拒绝该提案，未产生任何产物。");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  const disabled = docSourceDisabledReason({ sourceKind, text, url, busy });
  const confirmReason = confirmDisabledReason(selected, busy);
  const escalations = selected === null ? [] : escalationWarnings(selected);
  const badge = selected === null ? null : proposalStatusBadge(selected.status);

  return (
    <div className="skill-install-view">
      <GlassSurface variant="elevated" className="skill-install">
        <header className="skill-install__head">
          <h3>智能安装</h3>
        </header>
        <p className="skill-install__hint">
          给一份文档（说明、README、API 文档），Morrow 会读完之后给你一份<strong>安装提案</strong>：
          需要哪些能力、要不要新建工具、要什么权限、怎么调用。提案要你确认后才会落地。
        </p>
        {config === null ? null : (
          <p className="skill-install__hint">
            {publicFetchExplanation(config.allow_public_network)} 单次 ≤{formatBytes(config.max_bytes)}，
            超时 {Math.round(config.timeout_ms / 1000)}s。
          </p>
        )}

        <div className="skill-install__sources">
          {(["paste", "upload", "url"] as const).map((kind) => (
            <Button
              key={kind}
              variant={sourceKind === kind ? "primary" : "ghost"}
              size="sm"
              disabled={busy}
              onClick={() => setSourceKind(kind)}
            >
              {sourceKindLabel(kind)}
            </Button>
          ))}
        </div>

        {sourceKind === "url" ? (
          <>
            <label className="skill-install__label" htmlFor="doc-url">
              文档 URL（仅 https）
            </label>
            <input
              id="doc-url"
              className="skill-install__input"
              placeholder="https://intranet.example.com/docs/api.md"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </>
        ) : (
          <>
            {sourceKind === "upload" ? (
              <>
                <label className="skill-install__label" htmlFor="doc-name">
                  文件名（可选，仅用于标识来源）
                </label>
                <input
                  id="doc-name"
                  className="skill-install__input"
                  placeholder="pdf-guide.md"
                  value={fileName}
                  onChange={(event) => setFileName(event.target.value)}
                />
              </>
            ) : null}
            <label className="skill-install__label" htmlFor="doc-text">
              文档内容
            </label>
            <textarea
              id="doc-text"
              className="skill-install__input"
              rows={8}
              placeholder="把文档正文粘贴到这里（至少 40 字符）"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </>
        )}

        <div className="skill-install__actions">
          <Button variant="primary" disabled={disabled !== null} onClick={() => void generate()}>
            生成提案
          </Button>
        </div>
        {disabled === null ? null : <p className="skill-install__hint">{disabled}</p>}
      </GlassSurface>

      {selected === null || badge === null ? null : (
        <GlassSurface variant="elevated" className="skill-install__proposal">
          <div className="skill-install__proposal-head">
            <strong>{selected.title}</strong>
            <Badge tone={badge.tone as never}>{badge.label}</Badge>
            <Badge tone="dim">{sourceKindLabel(selected.source_kind)}</Badge>
          </div>
          <p className="skill-install__hint">
            {selected.description}　·　来源：{selected.source_ref}（{formatBytes(selected.source_bytes)}）
          </p>

          <h4>权限清单</h4>
          <ul className="skill-install__list">
            {proposalPermissionLines(selected.permissions).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <h4>用到的现有能力</h4>
          {selected.capabilities.length === 0 ? (
            <p className="skill-install__hint">（无：全部需要新建）</p>
          ) : (
            <ul className="skill-install__list">
              {selected.capabilities.map((ref) => (
                <li key={ref.capability}>
                  <code>{ref.capability}</code> —— {ref.purpose}
                </li>
              ))}
            </ul>
          )}

          <h4>示例调用</h4>
          <ul className="skill-install__list">
            {selected.examples.map((example) => (
              <li key={example.request}>
                输入：{example.request} → 期望：{example.expected}
              </li>
            ))}
          </ul>

          <p className="skill-install__hint">{materializePathHint(selected)}</p>

          {escalations.map((warning) => (
            <p key={warning} className="skill-install__warning">
              {warning}
            </p>
          ))}

          {selected.uncertainties.length === 0 ? null : (
            <>
              <h4>不确定点</h4>
              <ul className="skill-install__list">
                {selected.uncertainties
                  .filter((item) => !item.includes("超出当前授权面"))
                  .map((item) => (
                    <li key={item}>{item}</li>
                  ))}
              </ul>
            </>
          )}

          {selected.materialized_as === null ? null : (
            <p className="skill-install__hint">
              产物：{selected.materialized_as.kind === "skill" ? "Skill（待批准）" : "能力工厂请求"} ·{" "}
              {selected.materialized_as.id}
            </p>
          )}
          {selected.error === null ? null : <p className="skill-install__warning">失败原因：{selected.error}</p>}

          <div className="skill-install__actions">
            <Button variant="primary" disabled={confirmReason !== null} onClick={() => void confirm()}>
              确认并落地
            </Button>
            <Button variant="ghost" disabled={busy || selected.status !== "pending"} onClick={() => void reject()}>
              拒绝
            </Button>
          </div>
          {confirmReason === null ? null : <p className="skill-install__hint">{confirmReason}</p>}
        </GlassSurface>
      )}

      <GlassSurface variant="elevated" className="skill-install">
        <header className="skill-install__head">
          <h3>提案记录</h3>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
            刷新
          </Button>
        </header>
        {proposals.length === 0 ? (
          <p className="skill-install__hint">还没有提案。</p>
        ) : (
          <ul className="skill-install__list">
            {proposals.map((proposal) => {
              const status = proposalStatusBadge(proposal.status);
              return (
                <li key={proposal.proposal_id}>
                  <button
                    type="button"
                    className="skill-install__row"
                    onClick={() => {
                      setSelected(proposal);
                      setNotice(null);
                    }}
                  >
                    <span>{proposal.title}</span>
                    <Badge tone={status.tone as never}>{status.label}</Badge>
                    <Badge tone="dim">{sourceKindLabel(proposal.source_kind)}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </GlassSurface>

      {notice === null ? null : <p className="skill-install__notice">{notice}</p>}
      {error === null ? null : <p className="skill-install__error">{error}</p>}
    </div>
  );
}
