import { useState } from "react";
import { ApiError } from "./api.ts";
import { useConfirm } from "./design-system/ConfirmDialog.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";
import {
  cloneConfirmMessage,
  draftToWorkspaceBody,
  emptyWorkspaceDraft,
  needsCloneConfirm,
  type WorkspaceDraft,
  type WorkspaceSource,
} from "./workspace-ui.ts";

/**
 * 新建会话向导（票 M7-A-T4 / Issue #61）：标题 + 工作区步骤（本地目录 / GitHub 仓库 /
 * 不绑定；GitHub 可指定基线与新分支）。clone 属网络动作，提交前经应用内确认框确认一次。
 * 会话创建与工作区绑定由父组件执行（先创建拿 session id，再绑定——分支缺省名依赖它）。
 */
export function NewSessionDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (title: string | undefined, draft: WorkspaceDraft) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState<WorkspaceDraft>(emptyWorkspaceDraft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  if (!open) return null;

  const update = (patch: Partial<WorkspaceDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const close = (): void => {
    if (busy) return;
    setTitle("");
    setDraft(emptyWorkspaceDraft());
    setError(null);
    onClose();
  };

  const submit = async (): Promise<void> => {
    const converted = draftToWorkspaceBody(draft);
    if (!converted.ok) {
      setError(converted.message);
      return;
    }
    if (needsCloneConfirm(draft.source)) {
      const ok = await confirm({
        title: "从 GitHub 获取仓库？",
        message: cloneConfirmMessage(draft.repoUrl.trim()),
        confirmLabel: "继续",
        cancelLabel: "取消",
        tone: "primary",
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(title.trim().length === 0 ? undefined : title.trim(), draft);
      setTitle("");
      setDraft(emptyWorkspaceDraft());
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={close}>
      <GlassSurface
        variant="elevated"
        className="modal-card new-session-card"
        role="dialog"
        aria-modal="true"
        aria-label="新建会话"
        onClick={(event) => event.stopPropagation()}
      >
        <h3>新建会话</h3>
        <label className="field">
          <span className="field-label">会话标题（可选）</span>
          <input
            autoFocus
            value={title}
            placeholder="例如：修 auth 分支"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <fieldset className="workspace-source">
          <legend className="field-label">工作区</legend>
          {([
            ["none", "不绑定", "普通聊天，不接触项目目录"],
            ["local", "本地目录", "在已有的项目目录里工作"],
            ["github", "GitHub 仓库", "本地有副本则关联，否则 clone 到 ~/.morrow/workspaces/"],
          ] as const).map(([source, label, hint]) => (
            <label key={source} className={draft.source === source ? "workspace-option selected" : "workspace-option"}>
              <input
                type="radio"
                name="workspace-source"
                value={source}
                checked={draft.source === source}
                onChange={() => update({ source: source as WorkspaceSource })}
              />
              <span>
                <span className="workspace-option-title">{label}</span>
                <span className="workspace-option-hint">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {draft.source === "local" && (
          <label className="field">
            <span className="field-label">本地项目目录</span>
            <input
              value={draft.localPath}
              placeholder="/Users/me/projects/my-app"
              spellCheck={false}
              onChange={(event) => update({ localPath: event.target.value })}
            />
          </label>
        )}

        {draft.source === "github" && (
          <>
            <label className="field">
              <span className="field-label">仓库地址</span>
              <input
                value={draft.repoUrl}
                placeholder="https://github.com/owner/repo.git"
                spellCheck={false}
                onChange={(event) => update({ repoUrl: event.target.value })}
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span className="field-label">基线分支（可选）</span>
                <input
                  value={draft.baseBranch}
                  placeholder="默认主分支（origin/HEAD）"
                  spellCheck={false}
                  onChange={(event) => update({ baseBranch: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">新分支（可选）</span>
                <input
                  value={draft.newBranch}
                  placeholder="默认 morrow/<会话短 id>"
                  spellCheck={false}
                  onChange={(event) => update({ newBranch: event.target.value })}
                />
              </label>
            </div>
            <p className="hint-inline">
              clone 前会再确认一次；需访问私有仓库时请先在设置里填 GitHub PAT 或执行 gh auth login。
            </p>
          </>
        )}

        {error !== null && <div className="banner-error" role="alert">{error}</div>}
        <div className="form-actions">
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? "创建中…" : "创建并绑定"}
          </Button>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
        </div>
      </GlassSurface>
      {confirmDialog}
    </div>
  );
}
