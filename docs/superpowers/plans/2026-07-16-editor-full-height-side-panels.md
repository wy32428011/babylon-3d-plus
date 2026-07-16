# Editor Full-Height Side Panels Implementation Plan

> **For agentic workers:** 按清单完成最小布局重排、文档同步、构建验证和浏览器几何检查；不修改面板业务逻辑。

**Goal:** 让 Hierarchy 与 Inspector 延伸至底部，并让 Project/Console 只占 Scene 中间列宽度。

**Architecture:** 保留现有三列 `.workspace`，把 Project/Console 的 `.bottomWorkspace` 移入 `.centerColumn`，中间列改为 Scene + Project 两行；根 `.editorShell` 改为 Toolbar + workspace 两行。所有面板内部组件、store、Babylon runtime 与响应式宽度保持不变。

**Tech Stack:** React、TypeScript、CSS Modules、Vite、Electron、Playwright CLI。

---

### Task 1: 重排编辑器布局组合

**Files:**
- Modify: `src/editor/layout/EditorLayout.tsx:242-260`

- [x] 将 `.bottomWorkspace` 从 `.workspace` 外部移动到 `.centerColumn` 内部，紧跟 `SceneViewPanel`。
- [x] 保留 `ProjectPanel` 与 `ConsolePanel` 的现有 props 和回调，不改运行预览只读逻辑。
- [x] 删除不再需要的 `.bottomBar` JSX 包装层。

### Task 2: 调整两行根布局和中间列高度

**Files:**
- Modify: `src/editor/layout/EditorLayout.module.css:1-58`

- [x] 将 `.editorShell` 改为 `48px minmax(0, 1fr)` 两行。
- [x] 保持 `.workspace` 当前三列宽度不变。
- [x] 将 `.centerColumn` 改为 `minmax(0, 1fr) clamp(300px, 38vh, 460px)` 两行。
- [x] 删除 `.bottomBar` 规则，并给 `.bottomWorkspace` 增加 `overflow: hidden`、顶部分隔线及完整尺寸边界。

### Task 3: 同步项目文档

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/specs/2026-07-16-editor-full-height-side-panels-design.md`
- Create: `docs/superpowers/plans/2026-07-16-editor-full-height-side-panels.md`

- [x] 更新“Unity-like 五面板布局”，明确左右面板贯通到底、Project/Console 与 Scene 等宽。
- [x] 更新“Project 资源库外观”和“主布局自适应”说明，移除“全宽底部”歧义。
- [x] 在“最近完成”增加 2026-07-16 布局调整记录。

### Task 4: 验证布局与构建

**Files:**
- Verify: `src/editor/layout/EditorLayout.tsx`
- Verify: `src/editor/layout/EditorLayout.module.css`
- Verify: `README.md`

- [x] 运行 `npm run typecheck`，退出码 0。
- [x] 运行 `npm run build`，退出码 0；仅保留既有 Vite 大 chunk 警告。
- [x] 启动短生命周期 Vite 开发服务器，使用 Playwright CLI 检查 Hierarchy/Inspector 底边与 workspace 一致，Project/Console 左右边界与 Scene 一致，并保存截图到 `output/playwright/`。
- [x] 运行 `git diff --check`，无空白错误。
- [x] 关闭本次 Playwright 会话和 Vite 进程，不清理用户原有进程。

## 验证结果

- `npm run typecheck`：通过，`tsc -b` 退出码 0。
- `npm run build`：通过，覆盖 TypeScript project build、Vite production build 与 Electron TypeScript build；仅输出既有大 chunk 警告。
- Vite 首次尝试 `5173` 时返回 `EACCES`；系统端口排除表确认 `5173` 位于 `5142–5241`，随后直接调用本地 Vite CLI 在 `12000` 端口完成验证。
- Playwright `1365×768`：Hierarchy/Inspector/Console 底边距视口均为 `1px` 边框差；Project 与 Console 相对 Scene 的左右边界差均为 `0px`，几何检查 `pass: true`。
- Playwright `1024×640`：Hierarchy/Inspector/Console 底边距视口均为 `1px` 边框差；Project 与 Console 相对 Scene 的左右边界差均为 `0px`，几何检查 `pass: true`。
- 截图：`output/playwright/editor-full-height-side-panels-1365x768.png`、`output/playwright/editor-full-height-side-panels-1024x640.png`。
- 浏览器控制台仅有既有 `favicon.ico` 404，无布局或运行时异常。
- 独立规格审查确认核心布局满足目标；独立代码质量审查结论 `APPROVED`。
- `git diff --check`：通过。
