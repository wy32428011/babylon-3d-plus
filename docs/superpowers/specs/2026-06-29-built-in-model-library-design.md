# 模型库内置基础对象设计规格

## 背景

当前编辑器已经支持通过 Toolbar 创建基础对象与灯光，也支持在 Project 面板的模型库中展示真实导入模型，并支持点击导入或拖拽到 Scene View 后按落点放置。用户希望将立方体、球体、地面、方向光、点光源作为内置模型放在模型库中，让这些常用基础对象也能从资源库入口创建。

## 已确认需求

- 内置项放在现有 Project 面板的“模型库”页签中。
- 内置项包括：立方体、球体、地面、方向光、点光源。
- 点击内置卡片时在默认位置创建对象。
- 拖拽内置卡片到 Scene View 时，按鼠标释放位置投射到 `y = 0` 地面平面创建对象。
- Toolbar 上现有创建按钮保留，不在本次移除。
- 真实模型卡片现有点击导入与拖拽放置行为保持不变。

## 推荐方案

采用“模型库内置资源卡片”方案。

核心做法：

- 在 `ProjectPanel.tsx` 中把模型库条目扩展为两类：内置条目与真实模型资产条目。
- 内置条目不伪装成 `AssetEntry`，避免灯光和基础 Mesh 被误认为外部 glTF/GLB 文件。
- 为内置条目新增独立拖拽 payload 与 MIME 类型。
- 在 store 层扩展创建方法，支持创建 Mesh/Light 时传入可选放置位置。
- 在 `SceneViewPanel.tsx` 的 drop 逻辑中同时识别真实模型资产 payload 和内置资源 payload。

## 架构边界

### `ProjectPanel.tsx`

负责展示内置资源卡片和真实模型卡片。

模型库默认显示内置项：

- 立方体
- 球体
- 地面
- 方向光
- 点光源

当项目已经导入真实模型包后，模型库列表显示：

1. 内置项；
2. 已导入模型项。

内置项和真实模型项共享现有卡片视觉样式，但通过数据字段区分行为。

### `AssetDatabase.ts`

继续负责真实模型资产拖拽 payload。

新增内置资源 payload 类型与工具函数：

```ts
export const BUILT_IN_ASSET_DRAG_MIME_TYPE = 'application/x-babylon-editor-built-in-asset';

type BuiltInAssetDragPayload =
  | { kind: 'mesh'; meshKind: 'cube' | 'sphere' | 'plane' }
  | { kind: 'light'; lightKind: 'directional' | 'point' };
```

提供：

- `encodeBuiltInAssetDragPayload(payload)`
- `decodeBuiltInAssetDragPayload(rawPayload)`

解析失败时返回 `null`。

### `editorStore.ts`

扩展现有创建方法签名：

```ts
createMesh: (meshKind: MeshKind, placementPosition?: Vector3Data) => void;
createLight: (lightKind: LightKind, placementPosition?: Vector3Data) => void;
```

未传 `placementPosition` 时保持现有默认行为。

传入 `placementPosition` 时：

- Mesh 使用该位置。
- Light 使用该位置，光源类型和默认强度保持不变。

### `SceneDocument.ts`

扩展实体工厂函数：

```ts
createMeshEntity(meshKind: MeshKind, position?: Vector3Data): Entity;
createLightEntity(lightKind: LightKind, position?: Vector3Data): Entity;
```

不改变实体结构，不新增组件类型。

### `SceneViewPanel.tsx`

现有 drop 逻辑先识别真实模型资产。

新增识别内置资源 payload：

- `mesh`：调用 `createMesh(meshKind, placementPosition)`。
- `light`：调用 `createLight(lightKind, placementPosition)`。

`dragover` 允许真实模型 MIME 和内置资源 MIME 两种类型。

## 组件行为

### 点击行为

- 点击立方体：创建 Cube，位置为默认原点。
- 点击球体：创建 Sphere，位置为默认原点。
- 点击地面：创建 Plane，位置为默认原点。
- 点击方向光：创建 Directional Light，位置为现有默认灯光位置。
- 点击点光源：创建 Point Light，位置为现有默认灯光位置。

### 拖拽行为

- 拖拽立方体、球体、地面到 Scene View：按释放位置投射到 `y = 0` 地面平面创建 Mesh。
- 拖拽方向光、点光源到 Scene View：按释放位置创建 Light。
- 如果投射失败，回退到 `{ x: 0, y: 0, z: 0 }`。

### 导入模型后的列表行为

导入真实模型后，模型库不再只显示导入模型，而是显示：

1. 内置基础对象；
2. 真实导入模型。

内置项始终位于模型库前部。

## 错误处理

- 内置拖拽 payload JSON 解析失败时忽略该 drop。
- payload 类型不在白名单内时忽略。
- 真实模型 payload 与内置资源 payload 互不复用，避免误解析。
- 内置资源不依赖 Electron preload，本地文件能力不可用时仍可创建。
- 真实模型导入按钮、项目资产加载和 `editor-asset://` 逻辑保持不变。

## 验证计划

轻量验证：

1. TypeScript 类型检查通过。
2. 默认模型库显示五个内置项。
3. 点击立方体、球体、地面能创建对应 Mesh 并选中。
4. 点击方向光、点光源能创建对应 Light 并选中。
5. 内置项可被拖拽，Scene View 能接受内置资源 MIME 类型。
6. 拖拽内置 Mesh 到 Scene View 能按落点创建。
7. 拖拽方向光、点光源到 Scene View 能按落点创建。
8. 真实模型卡片点击和拖拽行为不回归。
9. README 记录模型库包含内置基础对象与真实导入模型。

## 成功标准

- 模型库中可见立方体、球体、地面、方向光、点光源五个内置卡片。
- Toolbar 现有创建按钮仍然保留并可用。
- 内置卡片点击创建实体。
- 内置卡片拖拽到 Scene View 后按落点创建实体。
- 真实导入模型列表与内置项可以共存。
- 没有把内置灯光或基础 Mesh 伪装成外部模型资产。
