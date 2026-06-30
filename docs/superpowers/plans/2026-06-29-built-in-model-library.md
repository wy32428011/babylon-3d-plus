# Built-in Model Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Project 面板模型库中加入立方体、球体、地面、方向光、点光源五个内置资源卡片，并支持点击创建和拖拽到 Scene View 按落点创建。

**Architecture:** 采用内置资源卡片方案，不把内置对象伪装成外部 `AssetEntry`。`AssetDatabase.ts` 增加独立内置拖拽 payload，`editorStore.ts` 与 `SceneDocument.ts` 扩展创建方法支持可选放置位置，`ProjectPanel.tsx` 展示并发起内置项点击/拖拽，`SceneViewPanel.tsx` 在 drop 时区分真实模型和内置资源。

**Tech Stack:** React、TypeScript、Zustand、Babylon.js、CSS/HTML Drag and Drop、Markdown。

---

## 规格来源

- 设计规格：`docs/superpowers/specs/2026-06-29-built-in-model-library-design.md`
- 已确认交互：点击原点/默认位置创建，拖拽到 Scene View 按 `y = 0` 地面落点创建。
- 已确认边界：Toolbar 创建按钮保留；真实模型卡片行为不回归。

## 文件结构与职责

- 修改：`src/editor/assets/AssetDatabase.ts`
  - 职责：定义资源拖拽 payload 编解码。
  - 本次新增内置资源 MIME、payload 类型、编码和安全解析函数。

- 修改：`src/editor/model/SceneDocument.ts`
  - 职责：创建编辑器实体工厂。
  - 本次让 `createMeshEntity` 与 `createLightEntity` 支持可选位置。

- 修改：`src/editor/store/editorStore.ts`
  - 职责：编辑器状态与命令入口。
  - 本次让 `createMesh` 与 `createLight` 支持可选放置位置。

- 修改：`src/editor/panels/ProjectPanel.tsx`
  - 职责：展示资源库卡片并发起点击/拖拽行为。
  - 本次新增模型库内置卡片，并在导入真实模型后仍保留内置卡片。

- 修改：`src/editor/panels/SceneViewPanel.tsx`
  - 职责：处理 Scene 画布点击选择和拖拽放置。
  - 本次新增内置资源 drop 解析和按落点创建逻辑。

- 修改：`README.md`
  - 职责：记录项目当前功能、操作方式、限制与最近完成。
  - 本次记录模型库内置基础对象能力。

## 执行任务

### Task 1: 新增内置资源拖拽 payload

**Files:**
- Modify: `src/editor/assets/AssetDatabase.ts:1-87`

- [x] **Step 1: 添加内置资源类型和 MIME 常量**

在 `MODEL_ASSET_DRAG_MIME_TYPE` 下方加入：

```ts
export const BUILT_IN_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-built-in-asset';

export type BuiltInAssetDragPayload =
  | { kind: 'mesh'; meshKind: 'cube' | 'sphere' | 'plane' }
  | { kind: 'light'; lightKind: 'directional' | 'point' };
```

- [x] **Step 2: 添加编码函数**

在 `encodeModelAssetDragPayload` 后加入：

```ts
export function encodeBuiltInAssetDragPayload(payload: BuiltInAssetDragPayload): string {
  return JSON.stringify(payload);
}
```

- [x] **Step 3: 添加解码函数**

在 `decodeModelAssetDragPayload` 后加入：

```ts
export function decodeBuiltInAssetDragPayload(rawPayload: string): BuiltInAssetDragPayload | null {
  try {
    const payload: unknown = JSON.parse(rawPayload);
    if (!isRecord(payload)) return null;

    if (payload.kind === 'mesh') {
      const meshKind = payload.meshKind;
      if (meshKind !== 'cube' && meshKind !== 'sphere' && meshKind !== 'plane') return null;
      return { kind: 'mesh', meshKind };
    }

    if (payload.kind === 'light') {
      const lightKind = payload.lightKind;
      if (lightKind !== 'directional' && lightKind !== 'point') return null;
      return { kind: 'light', lightKind };
    }

    return null;
  } catch {
    return null;
  }
}
```

- [x] **Step 4: 静态检查**

Run:

```bash
git diff -- src/editor/assets/AssetDatabase.ts
```

Expected: diff 只新增内置资源 MIME、payload 类型和编解码函数，不改变真实模型 `AssetEntry` 解析行为。

### Task 2: 支持创建实体时传入放置位置

**Files:**
- Modify: `src/editor/model/SceneDocument.ts:25-70`
- Modify: `src/editor/store/editorStore.ts:53-67`
- Modify: `src/editor/store/editorStore.ts:220-244`

- [x] **Step 1: 修改 Mesh 实体工厂**

将 `createMeshEntity` 签名和 position 改为：

```ts
export function createMeshEntity(meshKind: MeshKind, position: Vector3Data = vector3()): Entity {
  const id = createId('entity');
  const displayName = meshKind.charAt(0).toUpperCase() + meshKind.slice(1);

  return {
    id,
    name: displayName,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: vector3(position.x, position.y, position.z),
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      meshRenderer: {
        meshKind,
        materialColor: '#8ab4f8',
      },
    },
  };
}
```

- [x] **Step 2: 修改 Light 实体工厂**

将 `createLightEntity` 签名和默认位置改为：

```ts
export function createLightEntity(lightKind: LightKind, position?: Vector3Data): Entity {
  const id = createId('entity');
  const displayName = `${lightKind.charAt(0).toUpperCase()}${lightKind.slice(1)} Light`;
  const defaultPosition = lightKind === 'hemispheric' ? vector3(0, 2, 0) : vector3(0, 3, 0);
  const lightPosition = position ? vector3(position.x, position.y, position.z) : defaultPosition;

  return {
    id,
    name: displayName,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: lightPosition,
        rotation: vector3(),
        scale: vector3(1, 1, 1),
      },
      light: {
        lightKind,
        intensity: 0.8,
      },
    },
  };
}
```

- [x] **Step 3: 修改 store 类型签名**

将 `EditorState` 中创建方法改为：

```ts
createMesh: (meshKind: MeshKind, placementPosition?: Vector3Data) => void;
createLight: (lightKind: LightKind, placementPosition?: Vector3Data) => void;
```

- [x] **Step 4: 修改 store 实现**

将 `createMesh` 与 `createLight` 改为：

```ts
createMesh: (meshKind, placementPosition) => {
  const entity = createMeshEntity(meshKind, sanitizeVector3(placementPosition));
  const command = createEntityCommand(entity);

  set((state) => {
    const result = executeCommand(state.scene, state.history, command);
    return {
      ...result,
      logs: prependLog(state.logs, command.label),
    };
  });
},
createLight: (lightKind, placementPosition) => {
  const entity = createLightEntity(lightKind, placementPosition ? sanitizeVector3(placementPosition) : undefined);
  const command = createEntityCommand(entity);

  set((state) => {
    const result = executeCommand(state.scene, state.history, command);
    return {
      ...result,
      logs: prependLog(state.logs, command.label),
    };
  });
},
```

- [x] **Step 5: 静态检查**

Run:

```bash
git diff -- src/editor/model/SceneDocument.ts src/editor/store/editorStore.ts
```

Expected: diff 只扩展可选位置参数，未传位置的 Toolbar 调用仍兼容。

### Task 3: 在模型库展示并处理内置资源卡片

**Files:**
- Modify: `src/editor/panels/ProjectPanel.tsx:1-344`

- [x] **Step 1: 更新 imports**

将资源 import 改为：

```ts
import {
  BUILT_IN_ASSET_DRAG_MIME_TYPE,
  encodeBuiltInAssetDragPayload,
  encodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
  type AssetEntry,
  type BuiltInAssetDragPayload,
} from '../assets/AssetDatabase';
```

同时从 store 类型中引入 `LightKind` 和 `MeshKind` 已在当前文件可从 model components 引入：

```ts
import type { LightKind, MeshKind } from '../model/components';
```

- [x] **Step 2: 扩展资源项类型**

将 `ProjectLibraryItem` 改为：

```ts
type BuiltInProjectLibraryItem = {
  id: string;
  name: string;
  icon: string;
  builtIn: BuiltInAssetDragPayload;
};

type ImportedProjectLibraryItem = {
  id: string;
  name: string;
  icon: string;
  asset: AssetEntry;
};

type PlaceholderProjectLibraryItem = {
  id: string;
  name: string;
  icon: string;
};

type ProjectLibraryItem = BuiltInProjectLibraryItem | ImportedProjectLibraryItem | PlaceholderProjectLibraryItem;
```

- [x] **Step 3: 增加内置模型库条目**

在 `PROJECT_LIBRARIES` 前加入：

```ts
const BUILT_IN_MODEL_LIBRARY_ITEMS: BuiltInProjectLibraryItem[] = [
  { id: 'builtin-cube', name: '立方体', icon: 'cube', builtIn: { kind: 'mesh', meshKind: 'cube' } },
  { id: 'builtin-sphere', name: '球体', icon: 'ring', builtIn: { kind: 'mesh', meshKind: 'sphere' } },
  { id: 'builtin-plane', name: '地面', icon: 'panel', builtIn: { kind: 'mesh', meshKind: 'plane' } },
  { id: 'builtin-directional-light', name: '方向光', icon: 'marker', builtIn: { kind: 'light', lightKind: 'directional' } },
  { id: 'builtin-point-light', name: '点光源', icon: 'marker', builtIn: { kind: 'light', lightKind: 'point' } },
];
```

- [x] **Step 4: 让真实模型项类型明确**

将 `createModelLibraryItems` 返回类型保持 `ProjectLibraryItem[]`，内容不变但返回 imported 结构：

```ts
function createModelLibraryItems(modelAssets: AssetEntry[]): ImportedProjectLibraryItem[] {
  return modelAssets.map((asset) => ({
    id: asset.id,
    name: asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, ''),
    icon: 'cube',
    asset,
  }));
}
```

- [x] **Step 5: 增加类型守卫**

在 `getModelUnitTitle` 前加入：

```ts
function isBuiltInProjectLibraryItem(item: ProjectLibraryItem): item is BuiltInProjectLibraryItem {
  return 'builtIn' in item;
}

function isImportedProjectLibraryItem(item: ProjectLibraryItem): item is ImportedProjectLibraryItem {
  return 'asset' in item;
}
```

- [x] **Step 6: 接入 store 创建方法**

在 `ProjectPanel` 内已有：

```ts
const importModelAsset = useEditorStore((state) => state.importModelAsset);
```

下方新增：

```ts
const createMesh = useEditorStore((state) => state.createMesh);
const createLight = useEditorStore((state) => state.createLight);
```

- [x] **Step 7: 合并内置项与真实模型项**

将 `activeItems` 中模型库逻辑改为：

```ts
const activeItems = useMemo(() => {
  if (activeLibrary.key === 'model') {
    return hasImportedModelFolder
      ? [...BUILT_IN_MODEL_LIBRARY_ITEMS, ...createModelLibraryItems(modelAssets)]
      : BUILT_IN_MODEL_LIBRARY_ITEMS;
  }

  return activeLibrary.items;
}, [activeLibrary, hasImportedModelFolder, modelAssets]);
```

- [x] **Step 8: 修改点击处理**

将 `handleResourceCardClick` 改为：

```ts
function handleResourceCardClick(item: ProjectLibraryItem): void {
  if (isBuiltInProjectLibraryItem(item)) {
    if (item.builtIn.kind === 'mesh') {
      createMesh(item.builtIn.meshKind as MeshKind);
      return;
    }

    createLight(item.builtIn.lightKind as LightKind);
    return;
  }

  if (isImportedProjectLibraryItem(item)) {
    importModelAsset(item.asset);
  }
}
```

- [x] **Step 9: 修改拖拽处理**

将 `handleResourceCardDragStart` 改为：

```ts
function handleResourceCardDragStart(event: DragEvent<HTMLButtonElement>, item: ProjectLibraryItem): void {
  if (isBuiltInProjectLibraryItem(item)) {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(BUILT_IN_ASSET_DRAG_MIME_TYPE, encodeBuiltInAssetDragPayload(item.builtIn));
    event.dataTransfer.setData('text/plain', item.name);
    return;
  }

  if (isImportedProjectLibraryItem(item)) {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(MODEL_ASSET_DRAG_MIME_TYPE, encodeModelAssetDragPayload(item.asset));
    event.dataTransfer.setData('text/plain', item.name);
    return;
  }

  event.preventDefault();
}
```

- [x] **Step 10: 修改卡片渲染状态**

在 `activeItems.map` 中将：

```ts
const isImportedModel = Boolean(item.asset);
```

改为：

```ts
const isBuiltInItem = isBuiltInProjectLibraryItem(item);
const isImportedModel = isImportedProjectLibraryItem(item);
const isActionableItem = isBuiltInItem || isImportedModel;
```

并将按钮属性改为：

```tsx
className={isActionableItem ? 'resource-card resource-card-clickable' : 'resource-card'}
disabled={!isActionableItem}
draggable={isActionableItem}
```

将 `title` 改为：

```tsx
title={
  isBuiltInItem
    ? `点击创建或拖拽到 Scene：${item.name}`
    : isImportedModel
      ? `点击导入或拖拽到 Scene：${item.name}，${getModelUnitTitle(item.asset)}`
      : '占位资源，功能后续接入'
}
```

- [x] **Step 11: 静态检查**

Run:

```bash
git diff -- src/editor/panels/ProjectPanel.tsx
```

Expected: 模型库默认条目从占位模型改为五个内置对象；导入模型后列表为内置项加真实模型项；非模型库页签仍展示占位项。

### Task 4: Scene View 支持内置资源 drop

**Files:**
- Modify: `src/editor/panels/SceneViewPanel.tsx:1-161`

- [x] **Step 1: 更新 imports**

将资产 import 改为：

```ts
import {
  BUILT_IN_ASSET_DRAG_MIME_TYPE,
  decodeBuiltInAssetDragPayload,
  decodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
} from '../assets/AssetDatabase';
```

- [x] **Step 2: 从 store 取创建方法**

在 `importModelAsset` 附近新增：

```ts
const createMesh = useEditorStore((state) => state.createMesh);
const createLight = useEditorStore((state) => state.createLight);
```

- [x] **Step 3: 修改 dragover 判断**

将 `handleCanvasDragOver` 改为：

```ts
function handleCanvasDragOver(event: DragEvent<HTMLCanvasElement>): void {
  const hasSupportedPayload =
    event.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE) ||
    event.dataTransfer.types.includes(BUILT_IN_ASSET_DRAG_MIME_TYPE);
  if (!hasSupportedPayload) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}
```

- [x] **Step 4: 修改 drop 逻辑**

将 `handleCanvasDrop` 改为：

```ts
function handleCanvasDrop(event: DragEvent<HTMLCanvasElement>): void {
  const placementPosition = runtimeRef.current?.getGroundPointAtCanvasPoint(
    event.clientX,
    event.clientY,
    event.currentTarget,
  ) ?? { x: 0, y: 0, z: 0 };

  const rawModelPayload = event.dataTransfer.getData(MODEL_ASSET_DRAG_MIME_TYPE);
  const modelAsset = decodeModelAssetDragPayload(rawModelPayload);
  if (modelAsset) {
    event.preventDefault();
    clickSnapshotRef.current = null;
    importModelAsset(modelAsset, placementPosition);
    return;
  }

  const rawBuiltInPayload = event.dataTransfer.getData(BUILT_IN_ASSET_DRAG_MIME_TYPE);
  const builtInAsset = decodeBuiltInAssetDragPayload(rawBuiltInPayload);
  if (!builtInAsset) return;

  event.preventDefault();
  clickSnapshotRef.current = null;

  if (builtInAsset.kind === 'mesh') {
    createMesh(builtInAsset.meshKind, placementPosition);
    return;
  }

  createLight(builtInAsset.lightKind, placementPosition);
}
```

- [x] **Step 5: 静态检查**

Run:

```bash
git diff -- src/editor/panels/SceneViewPanel.tsx
```

Expected: 真实模型 drop 路径仍存在；新增内置资源 drop 路径；投射落点逻辑复用同一份 `placementPosition`。

### Task 5: 更新 README 并验证

**Files:**
- Modify: `README.md:8-130`

- [x] **Step 1: 更新当前功能**

将 Project 资源库外观条目补充为：

```markdown
- Project 资源库外观：底部 Project 面板已切换为资源库浏览器样式，并将图库区域固定加高到约 `260px`，包含模型库、POI库、主题库、组合库、环境库、图表库、图片库七个页签，以及筛选占位行和横向资源卡片；模型库内置立方体、球体、地面、方向光、点光源五类基础对象，并支持导入模型文件夹展示项目内模型卡片。
```

- [x] **Step 2: 更新基础操作**

在“浏览资源库外观”后新增一条：

```markdown
- 创建内置资源：模型库内置立方体、球体、地面、方向光、点光源卡片；点击卡片会在默认位置创建对象，拖拽到 Scene View 会按鼠标释放位置投射到地面平面并创建对象。
```

- [x] **Step 3: 更新资源库功能边界**

将资源库功能边界开头改为：

```markdown
- 资源库功能边界：模型库当前支持内置基础对象创建与真实模型文件夹导入；同名模型包再次导入会覆盖项目目录中对应模型包，其余资源库仍为样式占位。
```

保留后续 Electron preload 说明。

- [x] **Step 4: 更新最近完成**

在最近完成顶部插入：

```markdown
- 2026-06-29：模型库新增立方体、球体、地面、方向光、点光源五个内置资源卡片，支持点击创建和拖拽到 Scene View 按落点创建。
```

- [x] **Step 5: 运行类型检查**

Run:

```bash
npm run typecheck
```

Expected: `tsc -b` 通过，退出码为 0。

- [x] **Step 6: 运行 diff 检查**

Run:

```bash
git diff --check -- src/editor/assets/AssetDatabase.ts src/editor/model/SceneDocument.ts src/editor/store/editorStore.ts src/editor/panels/ProjectPanel.tsx src/editor/panels/SceneViewPanel.tsx README.md docs/superpowers/specs/2026-06-29-built-in-model-library-design.md docs/superpowers/plans/2026-06-29-built-in-model-library.md
```

Expected: 不出现 whitespace error；如有 Windows 行尾提示，记录但不视为失败。

- [x] **Step 7: 可选浏览器验证**

如果需要实际观察 UI，启动 Vite 后使用 Playwright MCP 验证模型库默认出现五个内置卡片：立方体、球体、地面、方向光、点光源。

Expected: 五个文字均可在 Project 模型库中看到，点击至少一个内置卡片后 Hierarchy 出现对应实体。

## 自审记录

- 规格覆盖：计划覆盖内置项展示、点击创建、拖拽放置、Toolbar 保留、真实模型不回归、README 更新与验证。
- 占位扫描：本文没有 `TBD`、`TODO`、`implement later`、`fill in details`、`???` 等占位内容。
- 类型一致性：`BuiltInAssetDragPayload`、`BUILT_IN_ASSET_DRAG_MIME_TYPE`、`createMesh`、`createLight`、`MeshKind`、`LightKind` 等名称在各任务中保持一致。
- 提交策略：当前会话未收到显式 git commit 请求，因此计划不包含提交步骤。
