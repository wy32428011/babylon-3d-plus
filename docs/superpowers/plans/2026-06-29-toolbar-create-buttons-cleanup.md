# Toolbar Create Buttons Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除 Toolbar 中已迁移到模型库的五个创建按钮，保留半球光创建入口。

**Architecture:** 只收缩 Toolbar 组件接口和 EditorLayout 传参，不改变 store、模型库、Scene View 或命令历史。README 同步更新基础操作和最近完成记录，确保文档入口与实际 UI 一致。

**Tech Stack:** React、TypeScript、Zustand、Markdown。

---

## 文件结构与职责

- 修改：`src/editor/ui/Toolbar.tsx`
  - 删除五个已迁移创建按钮及对应 props。
  - 保留半球光创建按钮。

- 修改：`src/editor/layout/EditorLayout.tsx`
  - 删除不再传给 Toolbar 的 `createMesh` selector 和五个创建回调。
  - 保留 `createLight` 用于半球光。

- 修改：`README.md`
  - 更新基础操作说明。
  - 新增最近完成记录。

## 执行任务

### Task 1: 收缩 Toolbar 创建按钮接口

**Files:**
- Modify: `src/editor/ui/Toolbar.tsx:19-138`

- [ ] **Step 1: 删除 ToolbarProps 中五个 props**

删除：

```ts
onCreateCube: () => void;
onCreateSphere: () => void;
onCreatePlane: () => void;
onCreateDirectionalLight: () => void;
onCreatePointLight: () => void;
```

保留：

```ts
onCreateHemisphericLight: () => void;
```

- [ ] **Step 2: 删除 JSX 中五个按钮**

删除：

```tsx
<button onClick={props.onCreateCube}>创建立方体</button>
<button onClick={props.onCreateSphere}>创建球体</button>
<button onClick={props.onCreatePlane}>创建平面</button>
<button onClick={props.onCreateDirectionalLight}>创建方向光</button>
<button onClick={props.onCreatePointLight}>创建点光源</button>
```

保留：

```tsx
<button onClick={props.onCreateHemisphericLight}>创建半球光</button>
```

### Task 2: 清理 EditorLayout 传参

**Files:**
- Modify: `src/editor/layout/EditorLayout.tsx:26-93`

- [ ] **Step 1: 删除 createMesh selector**

删除：

```ts
const createMesh = useEditorStore((state) => state.createMesh);
```

保留：

```ts
const createLight = useEditorStore((state) => state.createLight);
```

- [ ] **Step 2: 删除 Toolbar 五个 props**

删除：

```tsx
onCreateCube={() => createMesh('cube')}
onCreateSphere={() => createMesh('sphere')}
onCreatePlane={() => createMesh('plane')}
onCreateDirectionalLight={() => createLight('directional')}
onCreatePointLight={() => createLight('point')}
```

保留：

```tsx
onCreateHemisphericLight={() => createLight('hemispheric')}
```

### Task 3: 更新 README 与验证

**Files:**
- Modify: `README.md:64-120`

- [ ] **Step 1: 更新基础操作创建说明**

删除：

```markdown
- 创建对象：点击顶部工具栏的 `创建立方体`、`创建球体`、`创建平面`。
- 创建灯光：点击顶部工具栏的 `创建半球光`、`创建方向光`、`创建点光源`。
```

改为：

```markdown
- 创建半球光：点击顶部工具栏的 `创建半球光`。
- 创建基础对象与常用灯光：在模型库中点击或拖拽 `立方体`、`球体`、`地面`、`方向光`、`点光源` 内置资源卡片。
```

- [ ] **Step 2: 更新最近完成**

在 `## 最近完成` 顶部插入：

```markdown
- 2026-06-29：移除 Toolbar 中已迁移到模型库的立方体、球体、地面、方向光、点光源创建按钮，保留半球光创建入口。
```

- [ ] **Step 3: 运行类型检查**

Run:

```bash
npm run typecheck
```

Expected: `tsc -b` 通过，退出码为 0。

- [ ] **Step 4: 运行 diff 检查**

Run:

```bash
git diff --check -- src/editor/ui/Toolbar.tsx src/editor/layout/EditorLayout.tsx README.md docs/superpowers/specs/2026-06-29-toolbar-create-buttons-cleanup-design.md docs/superpowers/plans/2026-06-29-toolbar-create-buttons-cleanup.md
```

Expected: 不出现 whitespace error；Windows 行尾提示不视为失败。

- [ ] **Step 5: 浏览器验证**

启动 Vite 并检查：

- Toolbar 不显示 `创建立方体`、`创建球体`、`创建平面`、`创建方向光`、`创建点光源`。
- Toolbar 仍显示 `创建半球光`。
- 模型库仍显示 `立方体`、`球体`、`地面`、`方向光`、`点光源`。

## 自审记录

- 规格覆盖：覆盖五个按钮移除、半球光保留、EditorLayout 传参清理、README 更新和验证。
- 占位扫描：没有占位符。
- 类型一致性：`onCreateHemisphericLight` 保留，其他五个 create props 删除。
- 提交策略：当前会话未收到显式 git commit 请求，因此不包含提交步骤。
