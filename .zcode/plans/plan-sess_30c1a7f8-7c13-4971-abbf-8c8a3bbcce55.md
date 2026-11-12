# Morrow 液态玻璃改造 · 第一阶段（Design Tokens + 基础组件 + Chat 核心页）

## Context

- 当前 `main` 工作区只有文档，真实 UI 在链接 worktree `Morrow-wt/integration`（分支 `integration/m0`）。
- 前端为 Tauri 2 + React 19 + Vite 6，样式集中在单个 `apps/desktop/src/styles.css`（2413 行、383 个选择器、仅 9 个 CSS 变量），无组件库、无深色模式、无 backdrop-filter、无 focus-visible / reduced-motion / 降级处理。
- 目标：按 `liquid-glass-ui-design-system-ai-agent.md` 落地 Apple Liquid Glass-inspired 设计系统，内容优先，只让导航、工具条、浮动控件成为玻璃层；分阶段推进，本阶段只做全局 tokens、基础组件和 Chat 页，视觉验收通过后再推广。

## 已确认决策

1. 从 `integration/m0` 新建分支 `ui/liquid-glass`，独立 worktree 位于 `/Users/wys3300/Desktop/project/Morrow-wt/liquid-glass`。
2. 首个核心页面：Chat 会话工作区。
3. 品牌主色改为规范默认的 `#3478F6`。
4. 本阶段同时实现 light/dark 双主题，并在顶栏加主题切换。

## 实施步骤

### 0. 建立工作分支与基线

```bash
git -C /Users/wys3300/Desktop/project/Morrow worktree add \
  /Users/wys3300/Desktop/project/Morrow-wt/liquid-glass -b ui/liquid-glass integration/m0
```

- 在新 worktree 执行 `pnpm install`（worktree 不共享 node_modules）。
- 将 `liquid-glass-ui-design-system-ai-agent.md` 复制为新分支根目录的 `UI_DESIGN_SYSTEM.md`，作为后续 UI 工作的长期规范（规范 §13 的建议），单独提交。
- 先跑一次 `pnpm --filter @morrow/desktop typecheck` 确认基线通过。

### 1. 全局 Design Tokens

新增 `apps/desktop/src/design-system/tokens.css`，在 `main.tsx` 中先于 `styles.css` 导入。

- 颜色：规范第 2.1 节的 light/dark `--color-canvas / canvas-subtle / surface / surface-secondary / text-primary / text-secondary / text-tertiary / border / separator / accent / success / warning / danger`；accent 取 `#3478F6`（dark `#75A7FF`）。
- 补齐规范未给出声明、但实现必需的派生 token：`--color-on-accent`、`--color-accent-soft`、success/warning/danger 的 `-soft` / `-border`、`--color-info` / `--color-run`（现有 tone-* 需要）。
- 玻璃材质：`--glass-blur: 24px`、`--glass-saturation: 165%`、`--glass-bg`、`--glass-bg-strong`、`--glass-border`、`--glass-highlight`、`--glass-shadow`、无 filter 降级背景；light/dark 分别定义。
- 圆角 `--radius-xs…2xl / pill`（6/10/14/18/24/30/999）、间距 `--space-1…12`（4–48）、字号字重、字体栈、动效 `--ease-standard: cubic-bezier(0.2,0.8,0.2,1)` 与 120/160/220/260ms 时长、`--focus-ring`。
- `color-scheme: light`，`[data-theme="dark"]` 下切为 `dark`。
- 在 `styles.css` 的 `:root` 建立**兼容别名**，让现有 170 处 `var(--...)` 零改动继续工作：
  `--bg→--color-canvas`、`--panel→--color-surface`、`--border→--color-border`、`--text→--color-text-primary`、`--text-dim→--color-text-secondary`、`--accent→--color-accent`、`--accent-soft→--color-accent-soft`、`--error→--color-danger`、`--error-soft→--color-danger-soft`。
- 仅做颜色字面量替换（不改布局）：把 `styles.css` 中 20 余个重复的 success/warning/danger/info hex 归并到上述 token（如 `#2e7d32`、`#c77700`、`#f3c1bd`、`#4c8dd0`），使未改造页面在深色模式下也不至于出现浅色硬编码残留。

### 2. 主题基础设施

- 新增 `src/design-system/theme.ts`：`Theme = "light" | "dark"`；初始值读 `localStorage["morrow.theme"]`，缺省跟随 `prefers-color-scheme`；`applyTheme()` 设置 `document.documentElement.dataset.theme`。
- `main.tsx` 在 `createRoot` 之前调用 `applyTheme(getInitialTheme())`，避免首帧闪烁。
- 新增 `src/design-system/ThemeToggle.tsx`：内联 SVG 太阳/月亮线性图标（18px、stroke 1.75，不使用 emoji），`aria-label` + `title`，复用 Button 的 iconOnly ghost 变体。
- 顶栏右侧放置切换按钮，切换后写回 localStorage。

### 3. 基础组件（`src/design-system/primitives/`）

只建本阶段实际使用、并可被后续页面复用的最小集：

- `GlassSurface.tsx`：`variant: regular | elevated | clear`，支持 `as: header | aside | div | nav | footer`，输出 `.glass-surface` 及修饰类；统一封装 blur、边框、阴影、顶部高光、降级规则。
- `Button.tsx`：`variant: primary | secondary | ghost | danger | nav`、`size: sm | md`、`iconOnly`、`loading`、`selected`；仍输出现有 `.btn` / `.btn.primary` / `.nav-item` 类名，保证未迁移页面自动继承新样式；补齐 hover/focus-visible/active/disabled。
- `Badge.tsx`：`tone: ok | run | warn | error | idle | dim | muted`，输出现有 `.badge.tone-*`，替代 Chat 中手写模板字符串。
- 组件文件沿用项目风格：中文短注释、`.tsx` 后缀导入、无新依赖。
- `Field / Input / Select / Dialog` 暂不创建，等 Task/Settings 阶段按实际需求落地，避免死代码。

### 4. Chat 页与应用外壳改造

- `App.tsx`
  - 顶栏改为浮动 Regular Glass 条：高度 48px、外边距 10px 12px、`--radius-lg`，标题、导航、主题切换三段布局；导航用 Button `nav` 变体，保留当前选中态语义。
  - 保留现有 boot/loading/error 结构与所有业务回调，不改 view 切换逻辑。
- 全局背景
  - `body` 使用 `--color-canvas`，叠加两处极低饱和的 accent 径向渐变（规范允许的“非常克制的渐变”），为玻璃提供可折射的层次；不使用彩虹/霓虹渐变。
- `SessionList.tsx` + 侧栏
  - 侧栏改为浮动玻璃面板：`--radius-xl`、外边距、`--glass-bg`；会话项 `--radius-md`，选中态用低饱和 accent 背景；新建会话按钮改为主按钮 sm。
- `ChatView.tsx`
  - 状态条改为轻量状态 chip（圆点 + 文本，不只靠颜色）。
  - 任务卡改为标准材质卡片（`.surface`），hover 仅轻微抬升，玻璃不用于内容卡。
  - 用户气泡：`--color-accent` 实底 + `--color-on-accent`，非对称圆角（18/18/6/18）；助手气泡：标准 surface + 边框 + 非对称圆角，保证正文对比度。
  - 工具事件行、agent.error、代码块保持标准材质，仅统一 radius/border/字体。
  - 输入区改为浮动玻璃条：外边距、`--radius-xl`、`--glass-bg-strong`；textarea 背景透明、文字高对比，发送按钮为实底主按钮。
  - DOM 结构、ref、SSE/发送/轮询逻辑、ARIA 与文案全部保持原样，只替换 className 与样式。
- 其余页面（Task/Settings/Health）本阶段只继承全局 token 与按钮配色，不做结构改造。

### 5. 交互、可访问性与降级

- 全局 `:focus-visible`：2px accent 描边 + 2px offset，覆盖所有 button/input/textarea/select。
- 交互过渡统一 120–180ms，仅动 opacity/transform/背景色；不加入浮动、呼吸、弹跳动画。
- `@media (prefers-reduced-motion: reduce)`：关闭过渡与 blink 动画（保留静态光标）。
- `@supports not ((backdrop-filter: blur(1px)))`：玻璃层回落到 `--glass-bg-fallback`（0.96/0.97 不透明）。
- `@media (prefers-reduced-transparency: reduce)`、`@media (prefers-contrast: more)`：关闭 blur、使用不透明材质、加强边框。
- 对比度核对：正文/次要文字 ≥ 4.5:1；`--color-text-tertiary` 仅用于时间戳等非关键信息。
- 限制每屏玻璃层数量为顶栏、侧栏、输入区 3 处，避免性能退化。

### 6. 验证（视觉验收门）

1. `pnpm --filter @morrow/runtime build`，再 `pnpm --filter @morrow/desktop dev`（127.0.0.1:1420）。
2. 启动 `apps/runtime/scripts/dev-fixture.ts`，通过 `?runtime=http://127.0.0.1:<port>` 打开 Chat，产生消息、工具事件、任务卡等真实状态。
3. 用浏览器逐项检查并截图：1120×760 与最小 720×480，light/dark 各一组；确认顶栏、侧栏、输入区出现 backdrop blur，内容区无玻璃，文字可读。
4. 键盘 Tab 走查顶栏、侧栏、输入区，确认 focus 可见；刷新后主题保持；切换深色后 Chat 全部状态无浅色残留。
5. 检查控制台无报错；DevTools 确认 `backdrop-filter` 计算值生效；临时禁用该属性验证降级背景。
6. 运行 `pnpm --filter @morrow/desktop typecheck` 与 `pnpm --filter @morrow/desktop test`（typecheck + node:test；cargo 测试若耗时过长单独执行并如实报告）。
7. 交付说明：变更文件、材质决策、已覆盖/未覆盖状态、两档窗口与双主题验证结果、遗留问题（Task/Settings 尚未做结构改造，深色模式仅完成 token 迁移、未做逐页视觉验收）。

## 后续阶段（本次不做）

- 第二阶段：Task 视图（DAG/事件流/检查点）复用已建立的 tokens 与 primitives。
- 第三阶段：Settings（Provider/能力/设备/渠道）与 Health，同时补齐 Field/Input/Select/Dialog/Sheet 等表单与浮层组件。
- 第四阶段：全量状态与响应式收口、规范文档回写。

## 风险与约束

- 新 worktree 需要独立 `pnpm install`；Tauri cargo 测试可能较慢，必要时拆开执行。
- 主色从深藏青改亮蓝会影响所有页面观感，属于已确认的预期变化；本阶段只保证 Chat 与外壳的视觉完整度。
- 不改任何业务逻辑、API、状态管理或依赖；不引入组件库、图标库或 Apple 专有资源。
