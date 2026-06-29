# Gallery Layout Height Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将底部 Project 图库区域固定加高到 `260px`，让资源库卡片和名称完整展示，并同步更新 README 记录。

**Architecture:** 采用最小布局调整方案，只修改 `EditorLayout.module.css` 顶层 CSS Grid 的第三行高度，不改变 React 组件树、编辑器 store、Babylon 运行时或资源库静态数据。README 作为项目状态文档同步记录图库高度调整，保持后续维护者能理解当前布局取舍。

**Tech Stack:** Electron、Vite、React、TypeScript、CSS Modules、Babylon.js、Markdown。

---

## 规格来源

- 已通过规格：`docs/superpowers/specs/2026-06-28-gallery-layout-design.md`
- 用户确认方案：C 方案，底部图库固定加高到约 `260px`
- 当前根因：`src/editor/layout/EditorLayout.module.css` 中 `.editorShell` 的 `grid-template-rows` 第三行仍为 `180px`，不足以完整容纳资源库页签、筛选行、资源卡片和底部留白。

## 文件结构与职责

- 修改：`src/editor/layout/EditorLayout.module.css`
  - 职责：定义编辑器顶层三行布局和左右/中/底部区域分配。
  - 本次只调整 `.editorShell` 的 `grid-template-rows`，将底部行从 `180px` 改为 `260px`。

- 修改：`README.md`
  - 职责：记录项目当前功能、限制和最近完成事项。
  - 本次补充底部 Project 图库区域已加高到 `260px`，说明资源卡片完整展示的目标和资源库功能边界不变。

- 不修改：`src/editor/panels/ProjectPanel.tsx`
  - 原因：资源库页签、筛选占位行、资源卡片结构已符合规格；问题来自外层底部区域高度不足，不需要改组件逻辑。

- 不修改：`src/styles/global.css`
  - 原因：资源卡片尺寸、页签高度、筛选行高度均维持现状；本次通过外层布局解决裁切问题。

## 执行任务

### Task 1: 调整编辑器底部图库高度

**Files:**
- Modify: `src/editor/layout/EditorLayout.module.css:1-7`

- [ ] **Step 1: 确认当前布局高度**

打开 `src/editor/layout/EditorLayout.module.css`，确认 `.editorShell` 当前内容为：

```css
.editorShell {
  display: grid;
  grid-template-rows: 48px minmax(0, 1fr) 180px;
  width: 100vw;
  height: 100vh;
  background: #1e1e1e;
  color: #d7d7d7;
}
```

预期：第三行高度是 `180px`，这是底部图库展示不完整的直接原因。

- [ ] **Step 2: 将底部行高改为 260px**

把 `.editorShell` 改为：

```css
.editorShell {
  display: grid;
  grid-template-rows: 48px minmax(0, 1fr) 260px;
  width: 100vw;
  height: 100vh;
  background: #1e1e1e;
  color: #d7d7d7;
}
```

注意：不要修改 `.workspace`、`.centerColumn`、`.bottomBar` 或其它布局选择器。`.bottomBar` 继续保持 `overflow: hidden`，因为加高后资源库内容应能在分配空间内完整展示。

- [ ] **Step 3: 做静态差异检查**

Run:

```bash
git diff -- src/editor/layout/EditorLayout.module.css
```

Expected: 只看到 `grid-template-rows` 从 `48px minmax(0, 1fr) 180px` 变为 `48px minmax(0, 1fr) 260px`。

示例预期 diff：

```diff
 .editorShell {
   display: grid;
-  grid-template-rows: 48px minmax(0, 1fr) 180px;
+  grid-template-rows: 48px minmax(0, 1fr) 260px;
   width: 100vw;
   height: 100vh;
```

### Task 2: 更新 README 项目说明

**Files:**
- Modify: `README.md:27-28`
- Modify: `README.md:71-72`
- Modify: `README.md:107-111`

- [ ] **Step 1: 更新“当前功能”中的 Project 资源库描述**

将当前功能列表中的 Project 资源库条目从：

```markdown
- Project 资源库外观：底部 Project 面板已切换为资源库浏览器样式，包含模型库、POI库、主题库、组合库、环境库、图表库、图片库七个页签，以及筛选占位行和横向资源卡片占位。
```

改为：

```markdown
- Project 资源库外观：底部 Project 面板已切换为资源库浏览器样式，并将图库区域固定加高到约 `260px`，包含模型库、POI库、主题库、组合库、环境库、图表库、图片库七个页签，以及筛选占位行和横向资源卡片占位，可完整展示资源卡片与名称。
```

- [ ] **Step 2: 更新“基础操作”中的资源库浏览说明**

将基础操作列表中的资源库浏览条目从：

```markdown
- 浏览资源库外观：在 Project 面板中点击 `模型库`、`POI库`、`主题库`、`组合库`、`环境库`、`图表库`、`图片库` 页签，可切换不同资源库的占位展示。
```

改为：

```markdown
- 浏览资源库外观：底部图库区域固定加高到约 `260px`，在 Project 面板中点击 `模型库`、`POI库`、`主题库`、`组合库`、`环境库`、`图表库`、`图片库` 页签，可切换不同资源库的占位展示。
```

保留下一条资源库功能边界说明不变：

```markdown
- 资源库功能边界：当前搜索框和资源卡片仅作为样式占位，不执行真实搜索、扫描、加载或导入。
```

- [ ] **Step 3: 更新“最近完成”记录**

在 `## 最近完成` 下方、现有 2026-06-28 记录之前，插入新记录：

```markdown
- 2026-06-28：将底部 Project 图库区域固定加高到约 `260px`，让资源卡片、资源名称和底部空间完整可见。
```

插入后该段应类似：

```markdown
## 最近完成

- 2026-06-28：将底部 Project 图库区域固定加高到约 `260px`，让资源卡片、资源名称和底部空间完整可见。
- 2026-06-28：将底部 Project 面板切换为资源库浏览器外观，补齐七类资源库页签、筛选占位行和横向资源卡片占位。
- 2026-06-28：将 Scene View 地面网格升级为随相机重定位的视觉无限网格，并保留世界原点呼吸光晕。
- 2026-06-28：补齐 Scene View 科技蓝地面网格与呼吸光晕辅助视觉，并保持其独立于场景保存/加载数据。
```

- [ ] **Step 4: 做 README 差异检查**

Run:

```bash
git diff -- README.md
```

Expected:

- 当前功能中 Project 资源库外观增加 `260px` 和完整展示说明。
- 基础操作中资源库浏览说明增加底部图库加高说明。
- 最近完成中新增一条 2026-06-28 记录。
- 不改变“资源库功能边界”和“当前限制”中关于真实资源功能未接入的说明。

### Task 3: 轻量验证与交付检查

**Files:**
- Verify: `src/editor/layout/EditorLayout.module.css`
- Verify: `README.md`

- [ ] **Step 1: 检查关键文本是否存在**

Run:

```bash
git diff -- src/editor/layout/EditorLayout.module.css README.md
```

Expected: diff 中同时包含：

```diff
+  grid-template-rows: 48px minmax(0, 1fr) 260px;
```

以及 README 中的：

```markdown
约 `260px`
```

- [ ] **Step 2: 按用户偏好跳过自动测试**

本项目用户全局要求为“不需要进行测试，浪费token”。本次是 CSS 布局常量与 README 文案调整，不涉及 TypeScript 类型、运行时数据流或 Babylon 同步逻辑，因此不新增自动测试、不运行完整构建。

需要在最终交付说明中如实写明：

```text
未运行自动测试；本次仅做 CSS 布局常量与 README 文档更新，并通过 diff 检查确认改动范围。
```

- [ ] **Step 3: 可选人工启动检查**

如果用户要求实际看图或截图，再执行启动检查。执行前必须按用户全局要求清理残留任务相关进程：

```powershell
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*claude*' -or $_.CommandLine -like '*claude*' } | Stop-Process -Force -Confirm:$false
```

然后启动：

```bash
npm run dev:electron
```

Expected: Electron 编辑器启动后，底部 Project 图库区域明显高于修改前，资源卡片和名称完整可见。

本步骤是可选项，不作为默认执行步骤，因为用户明确要求不浪费 token 做测试。

- [ ] **Step 4: 最终交付说明**

最终回复需要包含：

```markdown
已完成：
- 将底部 Project 图库区域从 `180px` 加高到 `260px`。
- 更新 README，记录图库区域加高与功能边界。

验证：
- 已通过 `git diff` 检查确认只改布局高度和 README 文档。
- 未运行自动测试；本次为 CSS 常量与文档调整，且用户要求不进行测试。
```

## 自审记录

- 规格覆盖：计划覆盖了 `260px` 固定加高、保持五面板结构、不改 ProjectPanel、不接真实资源功能、README 更新与验证说明。
- 占位扫描：本文没有 `TBD`、`TODO`、`implement later`、`fill in details`、`???` 等占位内容。
- 类型与命名一致性：文件路径、CSS 选择器 `.editorShell`、属性名 `grid-template-rows`、README 章节名均与当前项目一致。
