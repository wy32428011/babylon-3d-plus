# Scene View 可视范围工具栏配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Scene View 默认可视范围从固定相机距离升级为 Toolbar 可配置档位。

**Architecture:** 沿用现有 `gridSettings` 数据流：Toolbar 发起配置变更，`editorStore` 保存状态，`SceneViewPanel` 监听状态并调用 Babylon viewport 方法，runtime 最终设置 `ArcRotateCamera.radius`。该功能不进入 `SceneDocument`，只属于编辑器视图偏好。

**Tech Stack:** React、TypeScript、Zustand、Babylon.js、Vite/Electron。

---

## File Structure

- Modify: `src/runtime/babylon/createEngine.ts`
  - 定义可视范围档位、默认档位与相机设置类型。
  - 给 `BabylonViewport` 增加 `setCameraSettings(settings)`。
  - 初始化相机时使用默认档位半径。
- Modify: `src/editor/store/editorStore.ts`
  - 保存 `cameraSettings`。
  - 新增 `setCameraViewRange(viewRangeKey)`，并进行枚举校验。
- Modify: `src/editor/ui/Toolbar.tsx`
  - 接收 `cameraSettings` 与 `onSetCameraViewRange`。
  - 新增“视野”下拉框。
- Modify: `src/editor/layout/EditorLayout.tsx`
  - 从 store 取出相机配置与 setter，传给 Toolbar。
- Modify: `src/editor/panels/SceneViewPanel.tsx`
  - 监听 `cameraSettings`，同步到 Babylon viewport。
- Modify: `README.md`
  - 更新当前功能、基础操作、最近完成。

---

### Task 1: Runtime camera settings

**Files:**
- Modify: `src/runtime/babylon/createEngine.ts`

- [ ] **Step 1: Add camera range types and constants**

Add these exports near grid settings:

```ts
export type EditorCameraViewRangeKey = 'near' | 'standard' | 'far' | 'overview';

export type EditorCameraViewRange = {
  key: EditorCameraViewRangeKey;
  label: string;
  radiusMeters: number;
};

export type EditorCameraSettings = {
  viewRangeKey: EditorCameraViewRangeKey;
};

export const EDITOR_CAMERA_VIEW_RANGES: readonly EditorCameraViewRange[] = [
  { key: 'near', label: '近景', radiusMeters: 8 },
  { key: 'standard', label: '标准', radiusMeters: 18 },
  { key: 'far', label: '远景', radiusMeters: 32 },
  { key: 'overview', label: '全景', radiusMeters: 50 },
];

export const DEFAULT_EDITOR_CAMERA_SETTINGS: EditorCameraSettings = {
  viewRangeKey: 'standard',
};
```

- [ ] **Step 2: Add helper and viewport method**

Add helper:

```ts
function getCameraViewRangeRadius(settings: EditorCameraSettings): number {
  return EDITOR_CAMERA_VIEW_RANGES.find((range) => range.key === settings.viewRangeKey)?.radiusMeters ?? 18;
}
```

Extend `BabylonViewport`:

```ts
setCameraSettings: (settings: EditorCameraSettings) => void;
```

Initialize camera radius using:

```ts
getCameraViewRangeRadius(DEFAULT_EDITOR_CAMERA_SETTINGS)
```

Return method:

```ts
setCameraSettings: (settings) => {
  camera.radius = getCameraViewRangeRadius(settings);
},
```

---

### Task 2: Store camera settings

**Files:**
- Modify: `src/editor/store/editorStore.ts`

- [ ] **Step 1: Import camera settings exports**

Import:

```ts
DEFAULT_EDITOR_CAMERA_SETTINGS,
EDITOR_CAMERA_VIEW_RANGES,
type EditorCameraSettings,
type EditorCameraViewRangeKey,
```

- [ ] **Step 2: Extend state**

Add to `EditorState`:

```ts
cameraSettings: EditorCameraSettings;
setCameraViewRange: (viewRangeKey: EditorCameraViewRangeKey) => void;
```

Add sanitizer:

```ts
function sanitizeCameraViewRangeKey(value: EditorCameraViewRangeKey): EditorCameraViewRangeKey {
  return EDITOR_CAMERA_VIEW_RANGES.some((range) => range.key === value)
    ? value
    : DEFAULT_EDITOR_CAMERA_SETTINGS.viewRangeKey;
}
```

Add initial state:

```ts
cameraSettings: DEFAULT_EDITOR_CAMERA_SETTINGS,
```

Add action:

```ts
setCameraViewRange: (viewRangeKey) => {
  set((state) => {
    const nextViewRangeKey = sanitizeCameraViewRangeKey(viewRangeKey);
    if (state.cameraSettings.viewRangeKey === nextViewRangeKey) return state;

    const label = EDITOR_CAMERA_VIEW_RANGES.find((range) => range.key === nextViewRangeKey)?.label ?? '标准';
    return {
      cameraSettings: {
        viewRangeKey: nextViewRangeKey,
      },
      logs: prependLog(state.logs, `Scene View 可视范围：${label}。`),
    };
  });
},
```

---

### Task 3: Toolbar control

**Files:**
- Modify: `src/editor/ui/Toolbar.tsx`
- Modify: `src/editor/layout/EditorLayout.tsx`

- [ ] **Step 1: Add Toolbar props and handler**

Toolbar imports:

```ts
EditorCameraSettings,
EditorCameraViewRangeKey,
```

Import constant:

```ts
EDITOR_CAMERA_VIEW_RANGES
```

Props:

```ts
cameraSettings: EditorCameraSettings;
onSetCameraViewRange: (viewRangeKey: EditorCameraViewRangeKey) => void;
```

Handler:

```ts
function handleCameraViewRangeChange(rawValue: string): void {
  const nextRange = EDITOR_CAMERA_VIEW_RANGES.find((range) => range.key === rawValue);
  if (!nextRange) return;

  props.onSetCameraViewRange(nextRange.key);
}
```

- [ ] **Step 2: Add select after grid controls**

```tsx
<label className="toolbar-select">
  <span>视野</span>
  <select
    value={props.cameraSettings.viewRangeKey}
    onChange={(event) => handleCameraViewRangeChange(event.target.value)}
  >
    {EDITOR_CAMERA_VIEW_RANGES.map((range) => (
      <option key={range.key} value={range.key}>
        {range.label}
      </option>
    ))}
  </select>
</label>
```

- [ ] **Step 3: Wire EditorLayout**

Read from store:

```ts
const cameraSettings = useEditorStore((state) => state.cameraSettings);
const setCameraViewRange = useEditorStore((state) => state.setCameraViewRange);
```

Pass to Toolbar:

```tsx
cameraSettings={cameraSettings}
onSetCameraViewRange={setCameraViewRange}
```

---

### Task 4: Scene View sync

**Files:**
- Modify: `src/editor/panels/SceneViewPanel.tsx`

- [ ] **Step 1: Read camera settings**

```ts
const cameraSettings = useEditorStore((state) => state.cameraSettings);
```

- [ ] **Step 2: Sync to viewport**

```ts
useEffect(() => {
  viewportRef.current?.setCameraSettings(cameraSettings);
}, [cameraSettings]);
```

---

### Task 5: Documentation and verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

Document:
- 当前功能：Scene View 默认视野可在 Toolbar 中配置。
- 基础操作：通过 Toolbar “视野”下拉选择近景、标准、远景、全景。
- 最近完成：记录 2026-06-29 新增 Toolbar 可视范围档位。

- [ ] **Step 2: Verify build**

Run:

```bash
npm run build
```

Expected:
- TypeScript build succeeds.
- Vite build succeeds.
- Electron TypeScript build succeeds.
- Vite chunk size warning is acceptable and unrelated to this change.
