import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type SkillPackageRowView, type SkillPackageUpgradePreview } from "./api.ts";
import { Badge } from "./design-system/primitives/Badge.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";

/**
 * Skill 包管理页（票 M7-B-T3 补齐，FR-B7/B10）。
 *
 * 三件事在这一页说清楚：
 *   1. **安装不执行脚本**：`npm install --ignore-scripts`，页面上直说；
 *   2. **升级必须先看 diff**：点「升级」先拿预览（202），扩权时额外要一次确认；
 *   3. **卸载保留审计**：配置与目录删掉，账本事件永久保留。
 */
export function SkillPackagesView({ base }: { base: string }) {
  const [packages, setPackages] = useState<SkillPackageRowView[]>([]);
  const [spec, setSpec] = useState("");
  const [preview, setPreview] = useState<SkillPackageUpgradePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await api.listSkillPackages(base);
    setPackages(result.packages);
  }, [base]);

  useEffect(() => {
    void refresh().catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : String(err));
    });
  }, [refresh]);

  async function install() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.installSkillPackage(base, spec.trim());
      setNotice(`已安装 ${result.package.package_name}@${result.package.version}（未执行 postinstall 脚本）。`);
      setSpec("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function checkUpgrade(packageName: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const result = await api.upgradeSkillPackage(base, packageName);
      if ("diff" in result) {
        setPreview(result);
      } else {
        setNotice(`${packageName} 已是最新或已升级。`);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyUpgrade(acceptWidening: boolean) {
    if (preview === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.upgradeSkillPackage(base, preview.package_name, {
        confirm: true,
        acceptPermissionWidening: acceptWidening,
      });
      if ("package" in result) {
        setNotice(
          `${result.package.package_name} 已升级到 ${result.package.version}` +
            (acceptWidening ? "（已接受权限扩大）" : "。"),
        );
      }
      setPreview(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uninstall(packageName: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.uninstallSkillPackage(base, packageName);
      setNotice(
        result.removed
          ? `已卸载 ${packageName}${result.capability_disabled ? "（能力已禁用）" : ""}。审计记录保留。`
          : `未找到 ${packageName}。`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="skill-pkg-view">
      <GlassSurface variant="elevated" className="skill-install">
        <header className="skill-install__head">
          <h3>安装技能包（npm）</h3>
        </header>
        <p className="skill-install__hint">
          只接受 npm 包名（可带版本）。安装时强制 <code>--ignore-scripts</code>：包的
          postinstall 脚本不会执行。包内必须带 <code>morrow.skill.json</code>，
          含可执行入口的包还必须声明 <code>sandbox</code> 与 <code>tests</code>。
        </p>
        <label className="skill-install__label" htmlFor="pkg-spec">
          包名
        </label>
        <input
          id="pkg-spec"
          className="skill-install__input"
          placeholder="morrow-skill-pdf@1.0.0 或 @scope/skill"
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
        />
        <div className="skill-install__actions">
          <Button variant="primary" disabled={busy || spec.trim().length === 0} onClick={() => void install()}>
            安装
          </Button>
        </div>
      </GlassSurface>

      <GlassSurface variant="elevated" className="skill-install">
        <header className="skill-install__head">
          <h3>已安装的技能包</h3>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
            刷新
          </Button>
        </header>
        {packages.length === 0 ? (
          <p className="skill-install__hint">还没有安装任何技能包。</p>
        ) : (
          <ul className="skill-install__list">
            {packages.map((pkg) => (
              <li key={pkg.package_name}>
                <div className="skill-install__proposal-head">
                  <strong>{pkg.package_name}</strong>
                  <Badge tone="dim">v{pkg.version}</Badge>
                  <Badge tone={pkg.has_entry ? "warn" : "ok"}>{pkg.has_entry ? "含可执行入口" : "声明式"}</Badge>
                  <Badge tone={pkg.status === "installed" ? "ok" : "muted"}>{pkg.status}</Badge>
                </div>
                <p className="skill-install__hint">
                  能力：<code>{pkg.capability}</code> · 哈希：{pkg.source_hash.slice(0, 20)}…
                </p>
                <p className="skill-install__hint">
                  权限：{JSON.stringify(pkg.permissions)}
                </p>
                <div className="skill-install__actions">
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void checkUpgrade(pkg.package_name)}>
                    检查升级
                  </Button>
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => void uninstall(pkg.package_name)}>
                    卸载
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </GlassSurface>

      {preview === null ? null : (
        <GlassSurface variant="elevated" className="skill-install__proposal">
          <div className="skill-install__proposal-head">
            <strong>升级预览：{preview.package_name}</strong>
            <Badge tone={preview.diff.widens ? "warn" : "ok"}>
              {preview.from_version} → {preview.to_version}
            </Badge>
          </div>
          {preview.diff.widens ? (
            <p className="skill-install__warning">
              新版本请求**额外权限**：{preview.diff.added.map((item) => `${item.dimension}: ${item.value}`).join("；")}。
              继续升级需要显式接受扩权。
            </p>
          ) : (
            <p className="skill-install__hint">权限没有扩大。</p>
          )}
          {preview.diff.removed.length > 0 ? (
            <p className="skill-install__hint">
              收窄/移除：{preview.diff.removed.map((item) => `${item.dimension}: ${item.value}`).join("；")}
            </p>
          ) : null}
          <div className="skill-install__actions">
            <Button variant="primary" disabled={busy} onClick={() => void applyUpgrade(preview.diff.widens)}>
              {preview.diff.widens ? "确认升级并接受扩权" : "确认升级"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
              取消
            </Button>
          </div>
        </GlassSurface>
      )}

      {notice === null ? null : <p className="skill-install__notice">{notice}</p>}
      {error === null ? null : <p className="skill-install__error">{error}</p>}
    </div>
  );
}
