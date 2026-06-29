# Ground Grid Glow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Babylon Scene View 中显示科技蓝地面网格，并带有低强度呼吸光晕效果。

**Architecture:** 地面网格是编辑器辅助视觉层，只在 Babylon viewport 初始化时创建，不写入 `SceneDocument`，不参与选中、保存、加载或 Undo/Redo。辅助层由独立函数创建，并在 Scene/Engine 生命周期内随 viewport 自动释放。

**Tech Stack:** Electron、Vite、React、TypeScript、Babylon.js。

---

## File Structure

- Modify: `src/runtime/babylon/createEngine.ts`
  - 负责创建 Babylon Engine、Scene、Camera、默认灯光。
  - 新增编辑器地面辅助层创建逻辑。
- Modify: `README.md`
  - 记录 Scene View 新增地面网格与呼吸光晕辅助视觉。

## Task 1: Add Editor Ground Grid Helper

**Files:**
- Modify: `src/runtime/babylon/createEngine.ts`

- [ ] **Step 1: Add Babylon imports**

在 `src/runtime/babylon/createEngine.ts` 中，把现有导入：

```ts
import { ArcRotateCamera, Engine, HemisphericLight, Scene, Vector3 } from '@babylonjs/core';
```

替换为：

```ts
import {
  ArcRotateCamera,
  Color3,
  Engine,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
```

- [ ] **Step 2: Add ground helper constants**

在 `BabylonViewport` 类型定义之后加入：

```ts
const GRID_SIZE = 40;
const GRID_SUBDIVISIONS = 40;
const GRID_ALPHA_BASE = 0.18;
const GRID_ALPHA_PULSE = 0.08;
const GLOW_ALPHA_BASE = 0.16;
const GLOW_ALPHA_PULSE = 0.12;
const BREATHING_SPEED = 0.0018;
```

- [ ] **Step 3: Add editor ground helper function**

在 `createBabylonViewport` 函数之前加入：

```ts
/** 创建编辑器辅助地面网格和呼吸光晕；该辅助层不进入 SceneDocument，也不可被拾取选中。 */
function createEditorGround(scene: Scene): void {
  const grid = MeshBuilder.CreateGround(
    'EditorGroundGrid',
    {
      width: GRID_SIZE,
      height: GRID_SIZE,
      subdivisions: GRID_SUBDIVISIONS,
    },
    scene,
  );
  grid.isPickable = false;

  const gridMaterial = new StandardMaterial('EditorGroundGridMaterial', scene);
  gridMaterial.diffuseColor = Color3.FromHexString('#4fa8ff');
  gridMaterial.emissiveColor = Color3.FromHexString('#1e6fb5');
  gridMaterial.alpha = GRID_ALPHA_BASE;
  gridMaterial.wireframe = true;
  gridMaterial.backFaceCulling = false;
  grid.material = gridMaterial;

  const glow = MeshBuilder.CreateDisc(
    'EditorGroundGlow',
    {
      radius: 5.5,
      tessellation: 96,
      sideOrientation: MeshBuilder.DOUBLESIDE,
    },
    scene,
  );
  glow.rotation.x = Math.PI / 2;
  glow.position.y = 0.012;
  glow.isPickable = false;

  const glowMaterial = new StandardMaterial('EditorGroundGlowMaterial', scene);
  glowMaterial.diffuseColor = Color3.FromHexString('#4fa8ff');
  glowMaterial.emissiveColor = Color3.FromHexString('#4fa8ff');
  glowMaterial.alpha = GLOW_ALPHA_BASE;
  glowMaterial.backFaceCulling = false;
  glow.material = glowMaterial;

  scene.onBeforeRenderObservable.add(() => {
    const pulse = (Math.sin(performance.now() * BREATHING_SPEED) + 1) / 2;
    gridMaterial.alpha = GRID_ALPHA_BASE + pulse * GRID_ALPHA_PULSE;
    glowMaterial.alpha = GLOW_ALPHA_BASE + pulse * GLOW_ALPHA_PULSE;
    glow.scaling.set(1 + pulse * 0.08, 1 + pulse * 0.08, 1 + pulse * 0.08);
  });
}
```

- [ ] **Step 4: Call helper during viewport creation**

在 `createBabylonViewport` 中，创建默认灯光之后、`engine.runRenderLoop` 之前加入：

```ts
  createEditorGround(scene);
```

最终相关片段应为：

```ts
  const light = new HemisphericLight('EditorLight', new Vector3(0, 1, 0), scene);
  light.intensity = 0.8;

  createEditorGround(scene);

  engine.runRenderLoop(() => {
    scene.render();
  });
```

- [ ] **Step 5: Verify typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit 0。

## Task 2: Update Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update current features**

在“当前功能”中，紧跟 Babylon Scene View 条目后加入：

```md
- 编辑器地面辅助层：Scene View 显示科技蓝地面网格，并带有低强度呼吸光晕效果，辅助层不参与选中、保存、加载或撤销/重做。
```

- [ ] **Step 2: Update recent completion section**

在“最近完成”顶部加入：

```md
- 2026-06-28：补齐 Scene View 科技蓝地面网格与呼吸光晕辅助视觉，并保持其独立于场景保存/加载数据。
```

- [ ] **Step 3: Verify build**

Run:

```bash
npm run build
```

Expected: exit 0；允许 Vite 输出 Babylon 大 chunk warning。

## Self-Review

- Spec coverage: 已覆盖地面网格、呼吸光晕、不写入 SceneDocument、不可拾取、README 更新和构建验证。
- Placeholder scan: 无 TBD/TODO/implement later。
- Type consistency: 新增函数只依赖 `Scene`，不修改 `BabylonViewport` 类型，不影响现有调用方。
