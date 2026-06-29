# Layout Responsive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让编辑器主布局在窗口缩小到 `1024×640` 时仍保持 Toolbar、Hierarchy、Scene、Console、Inspector 与 Project 可见，并通过面板内部滚动承接溢出。

**Architecture:** 采用 CSS 弹性轨道方案，只调整布局样式和 README 文档，不新增 React 状态、不实现拖拽分隔条、不实现面板折叠。`EditorLayout.module.css` 负责顶层 Grid 轨道自适应，`global.css` 负责通用面板、Toolbar 与 Project 内部溢出边界，`README.md` 记录功能范围与限制。

**Tech Stack:** Electron、Vite、React、TypeScript、CSS Modules、CSS Grid、Babylon.js、Markdown。

---

## 规格来源

- 设计规格：`docs/superpowers/specs/2026-06-29-layout-responsive-design.md`
- 已确认方向：保持五面板都可见。
- 最小适配目标：`1024×640`。
- 非目标：拖拽分隔条、面板折叠、自动隐藏、响应式字体密度模式。

## 文件结构与职责

- 修改：`src/editor/layout/EditorLayout.module.css`
  - 职责：定义编辑器顶层三行布局、三列工作区布局、Scene/Console 中心列布局。
  - 本次将固定宽高改为 `clamp()` 与 `minmax()` 组合，并补充 Grid 子项最小尺寸边界。

- 修改：`src/styles/global.css`
  - 职责：定义全局窗口、Toolbar、通用面板、Project 资源库等通用样式。
  - 本次移除 `body` 的固定最小宽高，补充 Toolbar、面板和 Project 页签的内部滚动策略。

- 修改：`README.md`
  - 职责：记录当前功能、基础操作、限制和最近完成事项。
  - 本次记录主布局自动自适应能力，并说明不包含拖拽分隔条和面板折叠。

- 不修改：`src/editor/layout/EditorLayout.tsx`
  - 原因：组件组合边界已经清晰，本次不新增布局状态或拖拽逻辑。

- 不修改：`src/editor/panels/SceneViewPanel.tsx`
  - 原因：当前已经通过 `window.resize` 调用 Babylon `engine.resize()`，本次只处理窗口尺寸变化，不处理非窗口容器变化。

## 执行任务

### Task 1: 调整顶层 Grid 为弹性轨道

**Files:**
- Modify: `src/editor/layout/EditorLayout.module.css:1-41`

- [ ] **Step 1: 确认当前固定布局轨道**

打开 `src/editor/layout/EditorLayout.module.css`，确认当前关键内容为：

```css
.editorShell {
  display: grid;
  grid-template-rows: 48px minmax(0, 1fr) 260px;
  width: 100vw;
  height: 100vh;
  background: #1e1e1e;
  color: #d7d7d7;
}

.workspace {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr) 320px;
  min-height: 0;
  border-top: 1px solid #111;
  border-bottom: 1px solid #111;
}

.centerColumn {
  display: grid;
  grid-template-rows: minmax(0, 1fr) 150px;
}
```

预期：底部 Project、左右栏、Console 仍使用固定尺寸。

- [ ] **Step 2: 改为弹性布局轨道**

将 `src/editor/layout/EditorLayout.module.css` 更新为：

```css
.editorShell {
  display: grid;
  grid-template-rows: 48px minmax(0, 1fr) clamp(180px, 28vh, 260px);
  width: 100vw;
  height: 100vh;
  min-width: 0;
  min-height: 0;
  background: #1e1e1e;
  color: #d7d7d7;
}

.workspace {
  display: grid;
  grid-template-columns: clamp(180px, 22vw, 260px) minmax(360px, 1fr) clamp(220px, 26vw, 320px);
  min-width: 0;
  min-height: 0;
  border-top: 1px solid #111;
  border-bottom: 1px solid #111;
}

.leftColumn,
.rightColumn,
.centerColumn,
.bottomBar {
  min-width: 0;
  min-height: 0;
  border-color: #111;
}

.leftColumn {
  border-right: 1px solid #111;
}

.rightColumn {
  border-left: 1px solid #111;
}

.centerColumn {
  display: grid;
  grid-template-rows: minmax(0, 1fr) clamp(96px, 18vh, 150px);
}

.bottomBar {
  overflow: hidden;
}
```

- [ ] **Step 3: 检查该文件差异**

Run:

```bash
git diff -- src/editor/layout/EditorLayout.module.css
```

Expected: diff 只涉及 `.editorShell`、`.workspace`、`.centerColumn` 的轨道定义，以及 `.editorShell` / `.workspace` 的 `min-width`、`min-height` 边界补充。

### Task 2: 调整全局窗口与面板溢出策略

**Files:**
- Modify: `src/styles/global.css:10-15`
- Modify: `src/styles/global.css:46-54`
- Modify: `src/styles/global.css:118-124`
- Modify: `src/styles/global.css:203-208`

- [ ] **Step 1: 移除 body 固定最小宽高**

将当前 `body`：

```css
body {
  margin: 0;
  min-width: 1180px;
  min-height: 720px;
  overflow: hidden;
}
```

改为：

```css
body {
  width: 100vw;
  height: 100vh;
  margin: 0;
  overflow: hidden;
}
```

- [ ] **Step 2: 让 Toolbar 通过横向滚动承接溢出**

将当前 `.toolbar`：

```css
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid #111;
  background: #2d2d30;
  white-space: nowrap;
}
```

改为：

```css
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0 12px;
  border-bottom: 1px solid #111;
  background: #2d2d30;
  white-space: nowrap;
}
```

- [ ] **Step 3: 补充通用面板 Grid 子项边界**

将当前 `.panel, .scene-panel`：

```css
.panel,
.scene-panel {
  height: 100%;
  padding: 10px;
  overflow: auto;
  background: #252526;
}
```

改为：

```css
.panel,
.scene-panel {
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 10px;
  overflow: auto;
  background: #252526;
}
```

- [ ] **Step 4: 让 Project 页签横向滚动**

将当前 `.project-library .library-tabs`：

```css
.project-library .library-tabs {
  display: flex;
  min-width: 0;
  border-bottom: 1px solid #121212;
  background: #171717;
}
```

改为：

```css
.project-library .library-tabs {
  display: flex;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid #121212;
  background: #171717;
}
```

- [ ] **Step 5: 检查全局样式差异**

Run:

```bash
git diff -- src/styles/global.css
```

Expected: diff 只涉及 `body`、`.toolbar`、`.panel, .scene-panel`、`.project-library .library-tabs` 四个区域，不改变资源卡片尺寸、不改变 Inspector 表单结构、不改变 Scene canvas 尺寸规则。

### Task 3: 更新 README 功能与限制说明

**Files:**
- Modify: `README.md:10-31`
- Modify: `README.md:63-76`
- Modify: `README.md:105-111`
- Modify: `README.md:113-124`

- [ ] **Step 1: 更新“当前功能”的五面板布局描述**

将当前功能中的：

```markdown
- Unity-like 五面板布局：包含 Hierarchy、Scene、Inspector、Project、Console 五个核心编辑器区域。
```

改为：

```markdown
- Unity-like 五面板布局：包含 Hierarchy、Scene、Inspector、Project、Console 五个核心编辑器区域，并支持根据窗口尺寸自动自适应；在约 `1024×640` 及以上窗口中保持五面板可见，Toolbar、Project 页签与资源卡片通过内部横向滚动承接溢出。
```

- [ ] **Step 2: 更新“基础操作”的资源库浏览说明**

将当前基础操作中的：

```markdown
- 浏览资源库外观：底部图库区域固定加高到约 `260px`，在 Project 面板中点击 `模型库`、`POI库`、`主题库`、`组合库`、`环境库`、`图表库`、`图片库` 页签，可切换不同资源库展示；模型库可点击 `导入模型文件夹` 扫描本地模型包，首次导入会选择项目目录，模型包会复制到该项目的 `Assets/Models` 下；导入模型 `scale = 1` 表示不额外缩放，源单位到米的换算会自动生效。
```

改为：

```markdown
- 浏览资源库外观：底部图库区域会根据窗口高度在约 `180px` 到 `260px` 之间自适应，在 Project 面板中点击 `模型库`、`POI库`、`主题库`、`组合库`、`环境库`、`图表库`、`图片库` 页签，可切换不同资源库展示；小窗口下页签和资源卡片通过横向滚动访问；模型库可点击 `导入模型文件夹` 扫描本地模型包，首次导入会选择项目目录，模型包会复制到该项目的 `Assets/Models` 下；导入模型 `scale = 1` 表示不额外缩放，源单位到米的换算会自动生效。
```

- [ ] **Step 3: 更新“当前限制”增加非目标边界**

在 `## 当前限制` 下、Project 资源库限制之后插入：

```markdown
- 主布局自适应当前只包含随窗口尺寸自动调整，不包含拖拽分隔条、面板折叠或用户自定义布局保存；小于约 `1024×640` 的窗口会继续尽量收缩，但不保证所有内容舒适可读。
```

插入后该段应包含：

```markdown
- Project 资源库当前只有模型库接入项目目录持久化与真实模型拖拽放置；POI、主题、组合、环境、图表、图片仍为占位展示，暂未接入真实搜索过滤、资源加载、拖拽或导入。
- 主布局自适应当前只包含随窗口尺寸自动调整，不包含拖拽分隔条、面板折叠或用户自定义布局保存；小于约 `1024×640` 的窗口会继续尽量收缩，但不保证所有内容舒适可读。
- 纹理、图片、图表、POI、主题、组合与环境资源目前只作为资源库占位分类展示，暂未建立真实数据模型。
```

- [ ] **Step 4: 更新“最近完成”记录**

在 `## 最近完成` 下方现有 2026-06-29 记录之前插入：

```markdown
- 2026-06-29：编辑器主布局支持根据窗口尺寸自动自适应，在约 `1024×640` 及以上窗口中保持五面板可见，并通过 Toolbar、Project 页签和资源卡片内部横向滚动承接溢出。
```

插入后该段应类似：

```markdown
## 最近完成

- 2026-06-29：编辑器主布局支持根据窗口尺寸自动自适应，在约 `1024×640` 及以上窗口中保持五面板可见，并通过 Toolbar、Project 页签和资源卡片内部横向滚动承接溢出。
- 2026-06-29：模型库真实模型卡片支持拖拽到 Scene View，并按鼠标释放位置投射到地面平面创建模型实体。
```

- [ ] **Step 5: 检查 README 差异**

Run:

```bash
git diff -- README.md
```

Expected:

- “当前功能”中五面板布局增加自动自适应说明。
- “基础操作”中 Project 高度从固定 `260px` 更新为 `180px` 到 `260px` 自适应。
- “当前限制”中明确不包含拖拽分隔条、面板折叠或用户自定义布局保存。
- “最近完成”中新增 2026-06-29 自适应布局记录。

### Task 4: 轻量验证与交付检查

**Files:**
- Verify: `src/editor/layout/EditorLayout.module.css`
- Verify: `src/styles/global.css`
- Verify: `README.md`
- Verify: `docs/superpowers/specs/2026-06-29-layout-responsive-design.md`
- Verify: `docs/superpowers/plans/2026-06-29-layout-responsive.md`

- [ ] **Step 1: 检查完整差异范围**

Run:

```bash
git diff -- src/editor/layout/EditorLayout.module.css src/styles/global.css README.md docs/superpowers/specs/2026-06-29-layout-responsive-design.md docs/superpowers/plans/2026-06-29-layout-responsive.md
```

Expected: diff 只包含响应式布局 CSS、README 文档、设计规格与实施计划。

- [ ] **Step 2: 执行轻量类型边界检查**

本次 CSS 与 Markdown 改动不应影响 TypeScript 类型。若需要做最轻量自动验证，运行：

```bash
npm run typecheck
```

Expected: TypeScript 项目检查通过。若用户明确要求跳过测试，可不运行；但最终交付必须如实说明是否运行。

- [ ] **Step 3: 可选视觉验证**

如果需要实际观察窗口效果，按用户资源回收要求先清理当前任务相关进程，再启动应用。PowerShell 命令：

```powershell
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*claude*' -or $_.CommandLine -like '*claude*' } | Stop-Process -Force -Confirm:$false
```

然后启动：

```bash
npm run dev:electron
```

Expected:

- `1365×768` 附近窗口下五面板完整可见。
- `1024×640` 附近窗口下五面板仍可见。
- Toolbar 可横向滚动。
- Project 页签和资源卡片可横向滚动。
- Scene 面板占据中心剩余空间。

- [ ] **Step 4: 最终交付说明**

最终回复需要包含：

```markdown
已完成：
- 写入响应式布局设计规格与实施计划。
- 将顶层布局改为 CSS 弹性轨道。
- 移除全局固定最小窗口尺寸。
- 为 Toolbar、面板与 Project 页签补充内部滚动边界。
- 更新 README 记录功能范围与限制。

验证：
- 说明已运行或未运行的验证命令。
- 如果未运行自动验证，明确原因。
```

## 自审记录

- 规格覆盖：计划覆盖了 `1024×640` 最小目标、五面板可见、CSS 弹性轨道、Toolbar/Project 横向滚动、README 更新、非目标边界与轻量验证。
- 占位扫描：本文没有 `TBD`、`TODO`、`implement later`、`fill in details`、`???` 等占位内容。
- 类型与命名一致性：文件路径、CSS 选择器 `.editorShell`、`.workspace`、`.centerColumn`、`.toolbar`、`.panel`、`.scene-panel`、`.project-library .library-tabs` 均与当前项目一致。
- 提交策略：当前会话未收到显式 git commit 请求，因此计划不包含提交步骤；实施完成后只报告工作树改动与验证结果。
