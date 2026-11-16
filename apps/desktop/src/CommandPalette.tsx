/**
 * `/` 命令面板组件（票 M7-B-T5 / Issue #69）。
 *
 * 组件只做装配与 I/O：状态与判定全部来自 `command-palette.ts`（纯函数，可单测）。
 * 键盘交互在这里实现（DOM 事件无法在 node:test 里直接验，边界逻辑已下沉到 moveIndex）。
 */
import { useEffect, useRef } from "react";
import { Badge } from "./design-system/primitives/Badge.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";
import {
  moveIndex,
  sourceLabel,
  type PaletteEntry,
  type PaletteSkill,
  type PaletteState,
} from "./command-palette.ts";

export interface CommandPaletteProps {
  state: PaletteState;
  entries: PaletteEntry[];
  skills: PaletteSkill[];
  /** 选中的条目（用于确认时执行） */
  onConfirm(entry: PaletteEntry): void;
  onMove(index: number): void;
  onClose(): void;
}

/** 技能徽标：命令不显示来源，技能标出来源（内置/包/MCP） */
function entryBadge(entry: PaletteEntry) {
  if (entry.kind === "command") {
    return entry.pending ? <Badge tone="muted">即将支持</Badge> : <Badge tone="dim">命令</Badge>;
  }
  return <Badge tone="dim">{sourceLabel(entry.source as "builtin" | "package" | "mcp")}</Badge>;
}

export function CommandPalette({
  state,
  entries,
  onConfirm,
  onMove,
  onClose,
}: CommandPaletteProps) {
  const listRef = useRef<HTMLUListElement>(null);

  // 选中项滚入可视区：键盘移动时列表可能超出面板高度
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${state.index}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [state.index]);

  if (!state.open) return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = moveIndex(state.index, offset, entries.length);
      if (next >= 0) onMove(next);
      return;
    }
    if (event.key === "Enter") {
      const selected = entries[state.index];
      if (selected !== undefined) {
        event.preventDefault();
        onConfirm(selected);
      }
      // 空列表不拦 Enter：让输入框正常换行/发送，避免"回车无事发生"
    }
  };

  return (
    <GlassSurface variant="elevated" className="palette" onKeyDown={onKeyDown} tabIndex={-1}>
      <div className="palette-head">
        <span className="palette-query">/{state.query}</span>
        <span className="palette-hint">↑↓ 选择 · Enter 执行 · Esc 关闭</span>
      </div>
      {entries.length === 0 ? (
        <div className="palette-empty">没有匹配的命令或技能。试试 /memory 或 /skill。</div>
      ) : (
        <ul className="palette-list" ref={listRef} role="listbox">
          {entries.map((entry, index) => (
            <li
              key={`${entry.kind}-${entry.id}`}
              data-index={index}
              role="option"
              aria-selected={index === state.index}
              className={`palette-item${index === state.index ? " selected" : ""}`}
              onMouseEnter={() => onMove(index)}
              onClick={() => onConfirm(entry)}
            >
              <span className={`palette-label palette-${entry.kind}`}>{entry.label}</span>
              <span className="palette-desc">{entry.description}</span>
              {entryBadge(entry)}
            </li>
          ))}
        </ul>
      )}
    </GlassSurface>
  );
}
