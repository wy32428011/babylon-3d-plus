# 俯视图状态化 + 正交相机切换重构方案

## 1. 背景与现状

当前"俯视图"是**一次性事件**，不是状态：

- Toolbar "俯"按钮 → `EditorLayout.onSetTopView` → store `requestCameraTopView()` 生成一次性请求对象（`CameraTopViewRequest { id }`）→ `SceneViewPanel` 消费请求 → `viewport.setTopView()` 把 `ArcRotateCamera` 的 `alpha = -PI/2`、`beta ≈ 0`。
- 执行完后没有任何状态记录"当前处于俯视"；用户无法区分/退出俯视，只能手动旋转回来。
- 相机只有一个 `ArcRotateCamera`（`createEngine.ts:458`），全局无任何正交相机代码。
- 缩放在透视模式下由 `radius` 驱动；正交模式下 `radius` 不影响视觉取景，需要额外映射。

关键文件：

| 文件 | 现状 |
|------|------|
| `src/editor/store/editorStore.ts:164-166, 231, 1530-1547` | `CameraTopViewRequest` 一次性请求/消费模式 |
| `src/editor/ui/Toolbar.tsx:434-437` | "俯"按钮，普通触发按钮 |
| `src/editor/layout/EditorLayout.tsx:57, 239` | 透传 `requestCameraTopView` |
| `src/editor/panels/SceneViewPanel.tsx:451-460` | 消费请求，调 `viewport.setTopView()` |
| `src/runtime/babylon/createEngine.ts:60-72, 371-375, 551-554` | `setTopView()` 改 alpha/beta；`BabylonViewport.camera: ArcRotateCamera` |

## 2. 目标

1. **俯视成为一个持久状态**：进入俯视后保持俯视，直到用户显式退出；退出时恢复进入前的轨道位姿。
2. **俯视状态下可切换投影**：透视 ↔ 正交，正交为俯视的主要使用场景（CAD 底图建模）。
3. **最小侵入**：复用现有相机实例与交互链路，不引入第二相机。

## 3. 核心设计决策

### 3.1 状态模型：两个独立维度

```
cameraOrientation: 'orbit' | 'top'        // 视角朝向状态
cameraProjection:  'perspective' | 'orthographic'  // 投影状态
```

- 俯视（`orientation = 'top'`）与投影（`projection`）解耦。正交虽主要在俯视下使用，但机制上不限制轨道视角下也可用（CAD 编辑器常见行为），实现成本为零。
- 不采用单枚举 `'orbit' | 'top-perspective' | 'top-orthographic'`：两个维度组合扩展性差（后续加前/左/右视图会爆炸）。

### 3.2 相机实现：同一 ArcRotateCamera 切换 `camera.mode`

**不新建第二个相机**。Babylon 的 `ArcRotateCamera` 原生支持：

```ts
camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
camera.orthoLeft / orthoRight / orthoTop / orthoBottom = ...;
```

理由：

- `scene.activeCamera` 不变 → Gizmo（`TransformGizmoController` 的 `GizmoManager`/`UtilityLayerRenderer`）、`SceneRuntime.pickEntityIdAtCanvasPoint`、`getGroundPointAtCanvasPoint`、键盘漫游（WASD）全部零改动。双相机方案则每一环都要处理切换/重绑。
- `scene.pick` / `createPickingRay` 本身兼容正交相机。
- 位姿模型（alpha/beta/radius/target）不变 → `hasCameraPoseChanged`、`getCameraPose`、`applyCameraPose`、序列化零改动。

**正交缩放适配**（唯一的技术难点）：正交模式下滚轮改变 `radius` 无视觉效果。在 `onAfterCheckInputsObservable` 中把 `radius` 同步为 ortho 边界，使缩放/平移手感与透视一致：

```ts
// 伪代码：orthoHalfHeight 与透视取景范围对齐
const halfHeight = Math.tan(camera.fov / 2) * camera.radius;
const halfWidth = halfHeight * (canvas.width / canvas.height);
camera.orthoTop = halfHeight;  camera.orthoBottom = -halfHeight;
camera.orthoRight = halfWidth; camera.orthoLeft = -halfWidth;
```

注意 canvas resize 时需重算（宽高比项）。`minZ/maxZ`、radius 上下限逻辑保持不变。

### 3.3 俯视进出位姿管理

- 进入俯视：记录当前 `{ alpha, beta }` 到 viewport 内部变量，再套用俯视角度（沿用现有 `EDITOR_CAMERA_TOP_VIEW_ALPHA / BETA_FALLBACK`）。`target`/`radius` 保持，取景范围不变（沿用现有语义）。
- 退出俯视：恢复记录的 `{ alpha, beta }`。
- 用户在俯视状态下手动旋转（beta 偏离 0）→ 视为退出俯视状态？**方案：俯视锁定旋转输入**。俯视期间设置 `lowerBetaLimit = upperBetaLimit = 0.01`，禁止旋转，只允许平移/缩放；退出后恢复原来的 beta 限制。这样"俯视是状态"语义最清晰，也符合 CAD 底图建模场景（俯视就是为 2D 平面操作）。旋转即退出的隐式行为容易引发状态不一致。

### 3.4 状态是否持久化

不写入 `.scene.json`。视图朝向/投影是编辑器会话状态，不属于场景内容。`SceneCameraSettings.savedPose` 与序列化（`SceneSerializer.ts`）不动。

## 4. 详细改动清单

### 4.1 Store（`src/editor/store/editorStore.ts`）

删除一次性请求，改为持久状态：

- 删除 `CameraTopViewRequest` 类型、`cameraTopViewRequest` state、`requestCameraTopView` / `consumeCameraTopViewRequest` action。
- 新增：

```ts
export type CameraOrientation = 'orbit' | 'top';
export type CameraProjection = 'perspective' | 'orthographic';

// state
cameraOrientation: CameraOrientation;        // 默认 'orbit'
cameraProjection: CameraProjection;          // 默认 'perspective'

// actions
setCameraOrientation: (orientation: CameraOrientation) => void;
setCameraProjection: (projection: CameraProjection) => void;
toggleCameraOrientation / toggleCameraProjection  // 可选便捷 action
```

- 日志沿用 `prependLog`（"已切换为俯视视角。"/"已切换为正交投影。"等）。
- 参考：`cameraResetRequest`/`cameraPoseSaveRequest` 仍是一次性语义，保留不动。本次只替换 topView 这条链路。

### 4.2 Viewport API（`src/runtime/babylon/createEngine.ts`）

`BabylonViewport` 接口：

```ts
// 删除
setTopView: () => void;
// 新增
setCameraOrientation: (orientation: CameraOrientation) => void;
setCameraProjection: (projection: CameraProjection) => void;
```

实现要点：

- `setCameraOrientation('top')`：缓存当前 alpha/beta → `applyTopCameraView`（现有函数复用）→ 锁定 beta 上下限；`'orbit'`：恢复缓存位姿 → 解除 beta 锁定。
- `setCameraProjection('orthographic')`：`camera.mode = Camera.ORTHOGRAPHIC_CAMERA`，挂接 radius→ortho 同步 observer（`onAfterCheckInputsObservable`）+ resize 监听；`'perspective'`：`camera.mode = Camera.PERSPECTIVE_CAMERA`，移除 observer。
- 组合行为：`orientation='top' + projection='orthographic'` 即目标态；其余组合自然成立。
- `camera` 字段类型保持 `ArcRotateCamera`，对外无 breaking change。
- `createCameraFlyKeyControls`、`applyCameraSensitivity`、`setViewDistance`、`focusOnBounds` 不动。

### 4.3 SceneViewPanel（`src/editor/panels/SceneViewPanel.tsx`）

- 删除 451-460 的 `cameraTopViewRequest` 消费 effect。
- 新增两个 effect，订阅 store 状态直接驱动 viewport：

```ts
const cameraOrientation = useEditorStore((s) => s.cameraOrientation);
const cameraProjection = useEditorStore((s) => s.cameraProjection);

useEffect(() => { viewportRef.current?.setCameraOrientation(cameraOrientation); }, [cameraOrientation]);
useEffect(() => { viewportRef.current?.setCameraProjection(cameraProjection); }, [cameraProjection]);
```

状态驱动的 effect 天然幂等，无需请求 id 与 consume。

### 4.4 Toolbar（`src/editor/ui/Toolbar.tsx` + `EditorLayout.tsx`）

- "俯"按钮改为**切换态按钮**：`active = cameraOrientation === 'top'`，点击调 `setCameraOrientation(active ? 'orbit' : 'top')`，激活时高亮（`ToolbarIconButton` 若无 active 样式需加一个 variant）。
- 新增投影切换按钮（图标如 `⊞`/ortho 图标）：`active = cameraProjection === 'orthographic'`，点击切换。建议仅在 `cameraOrientation === 'top'` 时显示/启用，保持工具栏简洁。
- `EditorLayout` 透传 props 同步更新：`onSetTopView` → 传 `cameraOrientation` + `setCameraOrientation` + `cameraProjection` + `setCameraProjection`。

### 4.5 快捷键（可选，建议一并做）

`EditorLayout` 现有快捷键体系中加：`Num 5` 或 `O` 切换投影、`Num 0` 或 `T` 切换俯视。注意现有 `E/R/T` 已被变换工具占用（commit 0c9be4b），避开 `T`，建议俯视用 `Num 0` 或 `V`。

### 4.6 不改动的环节（验证确认）

| 环节 | 不需要改的原因 |
|------|----------------|
| `TransformGizmoController` | 同一相机实例，`activeCamera` 不变 |
| `SceneRuntime` 拾取/地面射线 | `scene.pick`/`createPickingRay` 兼容正交 |
| 键盘漫游 WASD | 改的是 position/target，正交下平移有效 |
| 网格 ShaderMaterial | `worldViewProjection` 与投影类型无关 |
| `SceneSerializer` / `SceneCameraPose` | 视图状态不入场景文件 |
| `PlayerApp` | 播放器用默认透视，不受影响 |

## 5. 风险与验证点

1. **正交缩放手感**：radius→ortho 映射系数（`tan(fov/2) * radius`）需实测调整，保证进入正交瞬间取景范围不跳变。
2. **canvas resize**：正交边界依赖宽高比，resize 后必须重算，否则画面拉伸。
3. **俯视状态下切投影再退出**：四个组合（orbit/top × persp/ortho）进出均需验证位姿恢复正确。
4. **Gizmo 尺寸**：正交下 Gizmo 屏幕尺寸由 Babylon 内部处理，需人工确认不会过大/过小。
5. **运行预览（MQTT）**：运行期间冻结编辑写入，相机交互是否允许切换视图模式——建议允许（只读视角操作），在 Toolbar 运行态下确认按钮不被禁用误伤。

## 6. 实施步骤

1. Store：删 topView 请求链路，加 `cameraOrientation`/`cameraProjection` 状态与 action。
2. `createEngine.ts`：实现 `setCameraOrientation`/`setCameraProjection`（含 ortho 缩放同步、beta 锁定、位姿缓存恢复）。
3. `SceneViewPanel`：换成状态订阅 effect。
4. `Toolbar`/`EditorLayout`：按钮切换态 + 新投影按钮。
5. `npm run typecheck` + 手测六个组合路径（进出俯视 × 透视/正交 × 缩放/平移/拾取/Gizmo 拖拽）。
