# Infinite Ground Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Scene View 的地面网格改成视觉无限范围，同时保留世界原点呼吸光晕。

**Architecture:** 继续把地面网格作为 Babylon viewport 的编辑器辅助层，不写入 `SceneDocument`。通过扩大网格尺寸并在每帧按相机位置重定位网格中心，制造无限网格视觉；呼吸光晕保持在世界原点，作为场景中心参考。

**Tech Stack:** Electron、Vite、React、TypeScript、Babylon.js。

---

## File Structure

- Modify: `src/runtime/babylon/createEngine.ts`
  - 调整网格尺寸和 subdivisions。
  - 新增网格跟随相机的按格吸附重定位逻辑。
- Modify: `README.md`
  - 更新地面辅助层说明，明确网格为视觉无限。

## Task 1: Make Ground Grid Visually Infinite

**Files:**
- Modify: `src/runtime/babylon/createEngine.ts`

- [x] **Step 1: Add grid spacing constant and enlarge grid**

在 `src/runtime/babylon/createEngine.ts` 中，将常量：

```ts
const GRID_SIZE = 40;
const GRID_SUBDIVISIONS = 40;
```

替换为：

```ts
const GRID_SIZE = 240;
const GRID_SUBDIVISIONS = 240;
const GRID_SPACING = GRID_SIZE / GRID_SUBDIVISIONS;
```

- [x] **Step 2: Add snap helper**

在 `createEditorGround` 函数之前加入：

```ts
/** 按网格间距吸附位置，保证网格跟随相机时仍然对齐世界坐标。 */
function snapToGrid(value: number): number {
  return Math.round(value / GRID_SPACING) * GRID_SPACING;
}
```

- [x] **Step 3: Reposition grid in render loop**

在 `createEditorGround` 的 `scene.onBeforeRenderObservable.add(() => { ... })` 回调中，计算 `pulse` 之前加入：

```ts
    const cameraPosition = scene.activeCamera?.position;
    if (cameraPosition) {
      grid.position.x = snapToGrid(cameraPosition.x);
      grid.position.z = snapToGrid(cameraPosition.z);
    }
```

最终回调应类似：

```ts
  scene.onBeforeRenderObservable.add(() => {
    const cameraPosition = scene.activeCamera?.position;
    if (cameraPosition) {
      grid.position.x = snapToGrid(cameraPosition.x);
      grid.position.z = snapToGrid(cameraPosition.z);
    }

    const pulse = (Math.sin(performance.now() * BREATHING_SPEED) + 1) / 2;
    gridMaterial.alpha = GRID_ALPHA_BASE + pulse * GRID_ALPHA_PULSE;
    glowMaterial.alpha = GLOW_ALPHA_BASE + pulse * GLOW_ALPHA_PULSE;
    glow.scaling.set(1 + pulse * 0.08, 1 + pulse * 0.08, 1 + pulse * 0.08);
  });
```

- [x] **Step 4: Verify typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit 0。

## Task 2: Update Documentation

**Files:**
- Modify: `README.md`

- [x] **Step 1: Update current feature description**

将当前功能中的地面辅助层条目：

```md
- 编辑器地面辅助层：Scene View 显示科技蓝地面网格，并带有低强度呼吸光晕效果，辅助层不参与选中、保存、加载或撤销/重做。
```

替换为：

```md
- 编辑器地面辅助层：Scene View 显示视觉无限的科技蓝地面网格，并在世界原点保留低强度呼吸光晕效果，辅助层不参与选中、保存、加载或撤销/重做。
```

- [x] **Step 2: Update recent completion section**

在“最近完成”顶部加入：

```md
- 2026-06-28：将 Scene View 地面网格升级为随相机重定位的视觉无限网格，并保留世界原点呼吸光晕。
```

- [x] **Step 3: Verify build**

Run:

```bash
npm run build
```

Expected: exit 0；允许 Vite 输出 Babylon 大 chunk warning。

## Self-Review

- Spec coverage: 已覆盖视觉无限、按相机重定位、世界原点光晕保留、不写入 SceneDocument、README 更新和构建验证。
- Placeholder scan: 无 TBD/TODO/implement later。
- Type consistency: 新增 `GRID_SPACING` 与 `snapToGrid(value: number): number` 均在 `createEngine.ts` 内部使用，不影响外部 API。
