# Transform Gizmo MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Babylon Electron Unity-like Editor 中实现 Move / Rotate / Scale 三模式 Transform Gizmo，并保证拖拽结束只写入一条 Undo/Redo 历史。

**Architecture:** 继续以 `SceneDocument` 作为唯一编辑状态来源，Babylon mesh 只作为 runtime 显示对象。拖拽中通过 store preview 实时更新 scene 但不写 history；拖拽结束通过现有 command history 提交整组 Transform command。

**Tech Stack:** React、TypeScript、Zustand、Babylon.js GizmoManager/PositionGizmo/RotationGizmo/ScaleGizmo、Electron/Vite 现有工程。

---

## Scope Boundary

本计划只实现 Transform Gizmo MVP：Toolbar 工具切换、Scene View 中选中对象 gizmo attach、Move/Rotate/Scale 拖拽预览、拖拽结束单条 Undo/Redo 提交。

本计划不实现：Scene View 点击选中、多选、局部/全局坐标切换、吸附、快捷键 W/E/R、glTF 导入、Prefab/GUID、Play Mode、脚本组件。

## File Structure Map

- Modify: `src/editor/model/components.ts`  
  复用 `TransformComponent`，如需统一工具类型可不改此文件，优先在 store 定义轻量 `TransformTool`。

- Modify: `src/editor/commands/entityCommands.ts`  
  复用/加强 `updateTransformCommand(entityId, before, after)`，确保整组 Transform command 适用于 gizmo commit。

- Modify: `src/editor/store/editorStore.ts`  
  增加 `transformTool`、`setTransformTool`、`previewSelectedTransform`、`commitSelectedTransform`，并保留现有 Inspector 单轴编辑、Undo/Redo、Save/Load 行为。

- Modify: `src/runtime/babylon/SceneRuntime.ts`  
  增加 `getMeshByEntityId(entityId)`，并为 mesh metadata 写入 `editorEntityId`，便于 gizmo attach 与后续点击选中扩展。

- Create: `src/runtime/babylon/TransformGizmoController.ts`  
  管理 Babylon gizmo 生命周期、模式切换、mesh attach/detach、drag start/drag/drag end 回调。

- Modify: `src/editor/panels/SceneViewPanel.tsx`  
  初始化和释放 `TransformGizmoController`，把 selected mesh、当前工具、preview/commit callbacks 接入 runtime。

- Modify: `src/editor/ui/Toolbar.tsx`  
  增加 Move / Rotate / Scale 按钮 props 与 UI。

- Modify: `src/editor/layout/EditorLayout.tsx`  
  从 store 读取 `transformTool` / `setTransformTool` 并传给 Toolbar。

- Modify: `src/styles/global.css`  
  增加 toolbar tool button active 样式；如现有按钮样式可复用，则只加最小 CSS。

- Modify: `README.md`  
  把 Transform Gizmo 从“后续路线”移动到当前功能，并保留更高级 gizmo 能力在后续路线。

---

## Task 1: Extend Store for Transform Tool, Preview, and Commit

**Files:**
- Modify: `src/editor/store/editorStore.ts`
- Reference: `src/editor/commands/entityCommands.ts`

- [ ] **Step 1: Add shared TransformTool type and helpers in store**

Modify `src/editor/store/editorStore.ts` near existing `TransformField`:

```ts
type TransformField = 'position' | 'rotation' | 'scale';
export type TransformTool = 'translate' | 'rotate' | 'scale';
```

Add helper functions after `cloneTransform`:

```ts
function isFiniteVector3(vector: Vector3Data): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isFiniteTransform(transform: TransformComponent): boolean {
  return (
    isFiniteVector3(transform.position) &&
    isFiniteVector3(transform.rotation) &&
    isFiniteVector3(transform.scale)
  );
}

function areVector3Equal(left: Vector3Data, right: Vector3Data): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function areTransformsEqual(left: TransformComponent, right: TransformComponent): boolean {
  return (
    areVector3Equal(left.position, right.position) &&
    areVector3Equal(left.rotation, right.rotation) &&
    areVector3Equal(left.scale, right.scale)
  );
}
```

- [ ] **Step 2: Extend EditorState**

Modify `EditorState` in `src/editor/store/editorStore.ts`:

```ts
type EditorState = {
  scene: SceneDocument;
  history: CommandHistory;
  logs: EditorLog[];
  transformTool: TransformTool;
  setTransformTool: (tool: TransformTool) => void;
  createMesh: (meshKind: MeshKind) => void;
  selectEntity: (entityId: string | null) => void;
  updateSelectedTransform: (field: TransformField, axis: keyof Vector3Data, value: number) => void;
  previewSelectedTransform: (transform: TransformComponent) => void;
  commitSelectedTransform: (before: TransformComponent, after: TransformComponent) => void;
  undo: () => void;
  redo: () => void;
  saveScene: () => Promise<void>;
  loadScene: () => Promise<void>;
  pushLog: (message: string) => void;
};
```

- [ ] **Step 3: Add transformTool and setTransformTool implementation**

Add initial state and action inside `useEditorStore` object:

```ts
transformTool: 'translate',
setTransformTool: (tool) => {
  set((state) => ({
    transformTool: tool,
    logs: prependLog(state.logs, `切换工具：${tool}`),
  }));
},
```

- [ ] **Step 4: Add previewSelectedTransform implementation**

Add this method before `undo`:

```ts
previewSelectedTransform: (transform) => {
  if (!isFiniteTransform(transform)) return;

  set((state) => {
    const selectedId = state.scene.selectedEntityId;
    if (!selectedId) return state;

    const entity = state.scene.entities[selectedId];
    if (!entity) return state;

    if (areTransformsEqual(entity.components.transform, transform)) return state;

    return {
      scene: {
        ...state.scene,
        entities: {
          ...state.scene.entities,
          [selectedId]: {
            ...entity,
            components: {
              ...entity.components,
              transform: cloneTransform(transform),
            },
          },
        },
      },
    };
  });
},
```

- [ ] **Step 5: Add commitSelectedTransform implementation**

Add this method after `previewSelectedTransform`:

```ts
commitSelectedTransform: (before, after) => {
  if (!isFiniteTransform(before) || !isFiniteTransform(after)) return;
  if (areTransformsEqual(before, after)) return;

  set((state) => {
    const selectedId = state.scene.selectedEntityId;
    if (!selectedId) return state;

    const entity = state.scene.entities[selectedId];
    if (!entity) return state;

    const command = updateTransformCommand(selectedId, cloneTransform(before), cloneTransform(after));
    const result = executeCommand(state.scene, state.history, command);

    return {
      ...result,
      logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
    };
  });
},
```

- [ ] **Step 6: Verify store compiles**

Run:

```bash
npm run typecheck
```

Expected: `tsc -b` exits with code 0.

---

## Task 2: Expose Mesh Lookup from SceneRuntime

**Files:**
- Modify: `src/runtime/babylon/SceneRuntime.ts`

- [ ] **Step 1: Add public mesh lookup method**

Add this method inside `SceneRuntime` after constructor:

```ts
  getMeshByEntityId(entityId: string | null): Mesh | null {
    if (!entityId) return null;
    return this.meshes.get(entityId) ?? null;
  }
```

- [ ] **Step 2: Add entity metadata to created meshes**

Modify each mesh creation branch in `createMesh(entity)` so metadata includes both `editorMeshKind` and `editorEntityId`:

```ts
mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
```

Apply this exact metadata shape for sphere, plane, and cube branches.

- [ ] **Step 3: Verify runtime compiles**

Run:

```bash
npm run typecheck
```

Expected: typecheck passes.

---

## Task 3: Create TransformGizmoController

**Files:**
- Create: `src/runtime/babylon/TransformGizmoController.ts`

- [ ] **Step 1: Create controller types and transform conversion helpers**

Create `src/runtime/babylon/TransformGizmoController.ts`:

```ts
import {
  AbstractMesh,
  GizmoManager,
  Observer,
  PointerInfo,
  Scene,
  UtilityLayerRenderer,
} from '@babylonjs/core';
import type { TransformComponent } from '../../editor/model/components';
import type { TransformTool } from '../../editor/store/editorStore';

type DragCallbacks = {
  previewTransform: (transform: TransformComponent) => void;
  commitTransform: (before: TransformComponent, after: TransformComponent) => void;
};

function transformFromMesh(mesh: AbstractMesh): TransformComponent {
  return {
    position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
    rotation: { x: mesh.rotation.x, y: mesh.rotation.y, z: mesh.rotation.z },
    scale: { x: mesh.scaling.x, y: mesh.scaling.y, z: mesh.scaling.z },
  };
}

function isFiniteVector(vector: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isFiniteTransform(transform: TransformComponent): boolean {
  return isFiniteVector(transform.position) && isFiniteVector(transform.rotation) && isFiniteVector(transform.scale);
}
```

- [ ] **Step 2: Implement controller class**

Append this class to the same file:

```ts
export class TransformGizmoController {
  private readonly utilityLayer: UtilityLayerRenderer;
  private readonly gizmoManager: GizmoManager;
  private attachedMesh: AbstractMesh | null = null;
  private dragStartTransform: TransformComponent | null = null;
  private pointerObserver: Observer<PointerInfo> | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly callbacks: DragCallbacks,
  ) {
    this.utilityLayer = new UtilityLayerRenderer(scene);
    this.gizmoManager = new GizmoManager(scene, 1, this.utilityLayer);
    this.gizmoManager.usePointerToAttachGizmos = false;
    this.setTool('translate');
    this.pointerObserver = this.scene.onPointerObservable.add(() => {
      this.previewAttachedTransform();
    });
  }

  setTool(tool: TransformTool): void {
    this.gizmoManager.positionGizmoEnabled = tool === 'translate';
    this.gizmoManager.rotationGizmoEnabled = tool === 'rotate';
    this.gizmoManager.scaleGizmoEnabled = tool === 'scale';
  }

  attachToMesh(mesh: AbstractMesh | null): void {
    if (this.attachedMesh === mesh) return;
    this.commitActiveDrag();
    this.attachedMesh = mesh;
    this.gizmoManager.attachToMesh(mesh);
    this.dragStartTransform = mesh ? transformFromMesh(mesh) : null;
  }

  beginDragSnapshot(): void {
    if (!this.attachedMesh) return;
    this.dragStartTransform = transformFromMesh(this.attachedMesh);
  }

  previewAttachedTransform(): void {
    if (!this.attachedMesh) return;
    const transform = transformFromMesh(this.attachedMesh);
    if (!isFiniteTransform(transform)) return;
    this.callbacks.previewTransform(transform);
  }

  commitActiveDrag(): void {
    if (!this.attachedMesh || !this.dragStartTransform) return;
    const after = transformFromMesh(this.attachedMesh);
    if (!isFiniteTransform(after)) return;
    this.callbacks.commitTransform(this.dragStartTransform, after);
    this.dragStartTransform = after;
  }

  dispose(): void {
    this.commitActiveDrag();
    if (this.pointerObserver) {
      this.scene.onPointerObservable.remove(this.pointerObserver);
      this.pointerObserver = null;
    }
    this.gizmoManager.attachToMesh(null);
    this.gizmoManager.dispose();
    this.utilityLayer.dispose();
    this.attachedMesh = null;
    this.dragStartTransform = null;
  }
}
```

- [ ] **Step 3: Verify controller compiles**

Run:

```bash
npm run typecheck
```

Expected: If Babylon type names differ, adjust imports to the installed Babylon 9.12 API while preserving class responsibilities.

---

## Task 4: Wire Gizmo Controller into SceneViewPanel

**Files:**
- Modify: `src/editor/panels/SceneViewPanel.tsx`

- [ ] **Step 1: Import controller and store actions**

Modify imports in `SceneViewPanel.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { createBabylonViewport, type BabylonViewport } from '../../runtime/babylon/createEngine';
import { SceneRuntime } from '../../runtime/babylon/SceneRuntime';
import { TransformGizmoController } from '../../runtime/babylon/TransformGizmoController';
import { useEditorStore } from '../store/editorStore';
```

- [ ] **Step 2: Add gizmo ref and store subscriptions**

Inside `SceneViewPanel` add refs and selectors:

```tsx
  const gizmoRef = useRef<TransformGizmoController | null>(null);
  const sceneDocument = useEditorStore((state) => state.scene);
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);
  const transformTool = useEditorStore((state) => state.transformTool);
  const previewSelectedTransform = useEditorStore((state) => state.previewSelectedTransform);
  const commitSelectedTransform = useEditorStore((state) => state.commitSelectedTransform);
```

Remove the duplicate old `sceneDocument` selector if present.

- [ ] **Step 3: Initialize TransformGizmoController with viewport**

In the mount effect after creating `runtime`:

```tsx
    const gizmo = new TransformGizmoController(viewport.scene, {
      previewTransform: previewSelectedTransform,
      commitTransform: commitSelectedTransform,
    });
    gizmoRef.current = gizmo;
```

In cleanup before `runtime.dispose()`:

```tsx
      gizmo.dispose();
```

And set `gizmoRef.current = null`.

The cleanup block should remain:

```tsx
    return () => {
      window.removeEventListener('resize', resize);
      gizmo.dispose();
      runtime.dispose();
      viewport.engine.dispose();
      viewportRef.current = null;
      runtimeRef.current = null;
      gizmoRef.current = null;
    };
```

- [ ] **Step 4: Sync scene and attach selected mesh**

Replace the existing scene sync effect with:

```tsx
  useEffect(() => {
    const runtime = runtimeRef.current;
    const gizmo = gizmoRef.current;
    if (!runtime || !gizmo) return;

    runtime.sync(sceneDocument);
    const selectedMesh = runtime.getMeshByEntityId(selectedEntityId);
    gizmo.attachToMesh(selectedMesh);
  }, [sceneDocument, selectedEntityId]);
```

Add a separate tool effect:

```tsx
  useEffect(() => {
    gizmoRef.current?.setTool(transformTool);
  }, [transformTool]);
```

- [ ] **Step 5: Verify SceneViewPanel compiles**

Run:

```bash
npm run typecheck
```

Expected: typecheck passes.

---

## Task 5: Add Toolbar Tool Buttons

**Files:**
- Modify: `src/editor/ui/Toolbar.tsx`
- Modify: `src/editor/layout/EditorLayout.tsx`
- Modify: `src/styles/global.css`

- [ ] **Step 1: Extend Toolbar props**

Modify `src/editor/ui/Toolbar.tsx`:

```tsx
import type { TransformTool } from '../store/editorStore';

type ToolbarProps = {
  transformTool: TransformTool;
  onSetTransformTool: (tool: TransformTool) => void;
  onCreateCube: () => void;
  onCreateSphere: () => void;
  onCreatePlane: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSaveScene: () => void;
  onLoadScene: () => void;
  canUndo: boolean;
  canRedo: boolean;
};
```

- [ ] **Step 2: Add Move/Rotate/Scale buttons**

Inside `<header className="toolbar">`, after the title and before Cube:

```tsx
      <button
        className={props.transformTool === 'translate' ? 'toolbar-button active' : 'toolbar-button'}
        onClick={() => props.onSetTransformTool('translate')}
      >
        Move
      </button>
      <button
        className={props.transformTool === 'rotate' ? 'toolbar-button active' : 'toolbar-button'}
        onClick={() => props.onSetTransformTool('rotate')}
      >
        Rotate
      </button>
      <button
        className={props.transformTool === 'scale' ? 'toolbar-button active' : 'toolbar-button'}
        onClick={() => props.onSetTransformTool('scale')}
      >
        Scale
      </button>
```

- [ ] **Step 3: Wire layout to store tool state**

Modify `src/editor/layout/EditorLayout.tsx` inside `EditorLayout`:

```tsx
  const transformTool = useEditorStore((state) => state.transformTool);
  const setTransformTool = useEditorStore((state) => state.setTransformTool);
```

Pass props to Toolbar:

```tsx
        transformTool={transformTool}
        onSetTransformTool={setTransformTool}
```

Keep existing create/undo/redo/save/load props unchanged.

- [ ] **Step 4: Add active button styles**

Append to `src/styles/global.css`:

```css
.toolbar-button.active {
  border-color: #f7d774;
  color: #1e1e1e;
  background: #f7d774;
}
```

- [ ] **Step 5: Verify toolbar compiles**

Run:

```bash
npm run typecheck
```

Expected: typecheck passes and Toolbar receives all required props.

---

## Task 6: Update README for Transform Gizmo

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add Transform Gizmo to current features**

In `README.md` under `## 当前功能`, add this bullet after Inspector Transform editing:

```md
- Transform Gizmo：Scene View 中支持 Move、Rotate、Scale 三种可视化操控模式，拖拽结束后写入 Undo/Redo 历史。
```

- [ ] **Step 2: Adjust future roadmap**

In `## 后续路线`, replace the Transform Gizmo bullet with a more advanced follow-up:

```md
- Gizmo 高级能力：补充 Scene View 点击选中、W/E/R 快捷键、局部/全局坐标切换与吸附。
```

- [ ] **Step 3: Verify README is truthful**

Confirm README does not claim these are implemented:

- Scene View 点击选中
- W/E/R 快捷键
- 局部/全局坐标
- 吸附
- 多选

No command is required for markdown-only changes, but run typecheck before task completion because the feature changed code in earlier tasks:

```bash
npm run typecheck
```

Expected: typecheck passes.

---

## Task 7: Final Verification

**Files:**
- No code files expected unless fixing discovered issues.

- [ ] **Step 1: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: `tsc -b` exits with code 0.

- [ ] **Step 2: Run build**

Run:

```bash
npm run build
```

Expected: build exits with code 0. Babylon/Vite chunk size warning is acceptable if exit code is 0.

- [ ] **Step 3: Verify renderer path**

Run the app using the most reliable available path.

Preferred:

```bash
npm run dev:electron
```

If Electron binary download still prevents native GUI launch, use Vite renderer as fallback and clearly report the limitation:

```bash
npm run dev
```

Expected observable behavior:

1. Create Cube.
2. Select Cube in Hierarchy.
3. Scene View shows a Transform Gizmo attached to Cube.
4. Move / Rotate / Scale buttons switch visible gizmo mode.
5. Drag Move gizmo and observe Inspector position changes.
6. Drag Rotate gizmo and observe Inspector rotation changes.
7. Drag Scale gizmo and observe Inspector scale changes.
8. Undo once after a drag reverts that whole drag.
9. Redo restores the drag result.
10. Save scene and load it again; Transform values persist.

- [ ] **Step 4: Verify non-goals remain unimplemented**

Check manually or by code search that this task did not implement:

```text
Scene View 点击选中
快捷键 W/E/R
吸附
多选
Prefab/GUID
glTF 导入
Play Mode
```

- [ ] **Step 5: Report verification honestly**

If native Electron GUI could not launch because Electron binary download remains unavailable, report:

```text
Electron 原生窗口未完整验证：Electron binary 下载/安装仍不可用。本轮通过 Vite renderer 路径验证 UI/runtime 行为；真实 native dialog/window 路径需在 Electron binary 可用后补测。
```

---

## Self-Review

### Spec coverage

- 三模式 Move / Rotate / Scale：Task 3、Task 4、Task 5 覆盖。
- Toolbar 切换工具：Task 5 覆盖。
- 选中对象 attach gizmo：Task 2、Task 3、Task 4 覆盖。
- 拖拽 preview 不进 history：Task 1、Task 3 覆盖。
- 拖拽结束单条 Undo/Redo：Task 1、Task 3、Task 7 覆盖。
- README 更新：Task 6 覆盖。
- 非目标范围：Task 7 覆盖。

### Placeholder scan

本计划没有 `TBD`、`TODO`、`implement later` 等占位项。每个修改步骤都给出具体文件、代码或命令。

### Type consistency

- `TransformTool` 在 `editorStore.ts` 导出，`Toolbar.tsx` 与 `TransformGizmoController.ts` 复用同一类型。
- `TransformComponent` 继续来自 `src/editor/model/components.ts`。
- `previewSelectedTransform` 与 `commitSelectedTransform` 使用整组 `TransformComponent`。
- `SceneRuntime.getMeshByEntityId` 返回 Babylon `Mesh | null`，供 `SceneViewPanel` attach gizmo 使用。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-18-transform-gizmo-mvp.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, faster iteration for this multi-file runtime/UI feature.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.
