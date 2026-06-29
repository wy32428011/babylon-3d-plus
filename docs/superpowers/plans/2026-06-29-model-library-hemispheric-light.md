# Model Library Hemispheric Light Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将半球光加入 Project 模型库内置资源卡片，并从 Toolbar 中移除半球光创建入口。

**Architecture:** 复用现有内置资源拖拽 payload，不新增资源系统分支。模型库统一承载六类内置基础资源，Toolbar 只保留编辑工具、吸附、删除、撤销/重做、保存/加载等通用编辑操作。

**Tech Stack:** React、TypeScript、Zustand、CSS/HTML Drag and Drop、Markdown。

---

## 文件结构与职责

- 修改：`src/editor/assets/AssetDatabase.ts`
  - 扩展内置灯光拖拽 payload，允许 `hemispheric`。
- 修改：`src/editor/panels/ProjectPanel.tsx`
  - 在模型库内置资源列表加入 `半球光`。
- 修改：`src/editor/ui/Toolbar.tsx`
  - 移除半球光图标和 `onCreateHemisphericLight` prop。
- 修改：`src/editor/layout/EditorLayout.tsx`
  - 移除传给 Toolbar 的半球光创建回调和对应 store selector。
- 修改：`README.md`
  - 同步模型库六类内置资源、Toolbar 行为和最近完成记录。

## 执行任务

### Task 1: 扩展内置资源 payload

**Files:**
- Modify: `src/editor/assets/AssetDatabase.ts`

- [ ] **Step 1: 允许半球光 payload**

将内置灯光 payload 改为：

```ts
export type BuiltInAssetDragPayload =
  | { kind: 'mesh'; meshKind: 'cube' | 'sphere' | 'plane' }
  | { kind: 'light'; lightKind: 'hemispheric' | 'directional' | 'point' };
```

- [ ] **Step 2: 更新解码白名单**

将 lightKind 校验改为：

```ts
if (lightKind !== 'hemispheric' && lightKind !== 'directional' && lightKind !== 'point') return null;
```

### Task 2: 模型库新增半球光卡片

**Files:**
- Modify: `src/editor/panels/ProjectPanel.tsx`

- [ ] **Step 1: 添加内置半球光条目**

在 `BUILT_IN_MODEL_LIBRARY_ITEMS` 中地面后加入：

```ts
{ id: 'builtin-hemispheric-light', name: '半球光', icon: 'marker', builtIn: { kind: 'light', lightKind: 'hemispheric' } },
```

Expected: 点击半球光卡片调用现有 `createLight('hemispheric')` 分支，拖拽落点使用现有 Scene View 内置资源 drop 分支。

### Task 3: 从 Toolbar 移除半球光入口

**Files:**
- Modify: `src/editor/ui/Toolbar.tsx`
- Modify: `src/editor/layout/EditorLayout.tsx`

- [ ] **Step 1: 删除 Toolbar 半球光图标映射和 prop**

删除：

```ts
hemisphericLight: '◐',
onCreateHemisphericLight: () => void;
```

- [ ] **Step 2: 删除 Toolbar 半球光按钮**

删除：

```tsx
<ToolbarIconButton icon={TOOLBAR_ICONS.hemisphericLight} label="创建半球光" onClick={props.onCreateHemisphericLight} />
```

- [ ] **Step 3: 清理 EditorLayout 传参**

删除：

```ts
const createLight = useEditorStore((state) => state.createLight);
```

删除 Toolbar prop：

```tsx
onCreateHemisphericLight={() => createLight('hemispheric')}
```

### Task 4: 更新 README 并验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新模型库内置资源描述**

将五类内置资源改为六类：立方体、球体、地面、半球光、方向光、点光源。

- [ ] **Step 2: 删除 Toolbar 半球光操作说明**

基础操作中不再说明从 Toolbar 创建半球光，改为从模型库创建六类内置资源。

- [ ] **Step 3: 更新最近完成**

在最近完成顶部加入：

```markdown
- 2026-06-29：模型库新增半球光内置资源卡片，Toolbar 移除最后一个创建类按钮，基础对象与常用灯光统一从模型库创建。
```

- [ ] **Step 4: 运行类型检查**

Run:

```bash
npm run typecheck
```

Expected: `tsc -b` 通过，退出码为 0。

- [ ] **Step 5: 运行 diff 检查**

Run:

```bash
git diff --check -- src/editor/assets/AssetDatabase.ts src/editor/panels/ProjectPanel.tsx src/editor/ui/Toolbar.tsx src/editor/layout/EditorLayout.tsx README.md docs/superpowers/plans/2026-06-29-model-library-hemispheric-light.md
```

Expected: 不出现 whitespace error；Windows 行尾提示不视为失败。

## 自审记录

- 规格覆盖：覆盖半球光加入模型库、拖拽 payload 支持、Toolbar 移除半球光入口、README 更新与验证。
- 占位扫描：没有 `TBD`、`TODO`、`implement later`、`fill in details`、`???` 等占位内容。
- 类型一致性：`hemispheric` 使用现有 `LightKind` 值，与 `createLight`、`createLightEntity` 一致。
- 提交策略：当前会话未收到显式 git commit 请求，因此计划不包含提交步骤。
