# Scene Meter Units Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将编辑器长度单位统一定义为米，更新 UI 标注、地面网格语义、场景保存元数据与 README 文档。

**Architecture:** 采用轻量“米制底座”方案：新增集中式单位常量模块，所有 UI、运行时注释和场景序列化均引用该模块表达 `1 scene unit = 1 m`。场景文件保存时写入 `units.length = "meter"`，加载时兼容旧版无 `units` 文件，并拒绝未知单位。

**Tech Stack:** React 19、TypeScript 6、Zustand、Babylon.js、Electron、Vite。

---

## File Structure

- Create: `src/editor/model/sceneUnits.ts`
  - 负责集中定义当前场景长度单位、单位符号和单位标签。
- Modify: `src/editor/panels/InspectorPanel.tsx`
  - 在 Transform 中只为 `position` 显示米单位。
- Modify: `src/editor/ui/Toolbar.tsx`
  - 在位置吸附输入上显示米单位。
- Modify: `src/runtime/babylon/createEngine.ts`
  - 将地面网格常量命名与注释改为米语义，不改变视觉效果。
- Modify: `src/editor/project/SceneSerializer.ts`
  - 保存场景时写入单位元数据；加载时兼容旧格式并校验单位。
- Modify: `README.md`
  - 记录米制单位约定、UI 含义、地面网格含义和场景文件兼容策略。

## Task 1: Add Central Scene Unit Constants

**Files:**
- Create: `src/editor/model/sceneUnits.ts`

- [ ] **Step 1: Create the unit constants module**

Create `src/editor/model/sceneUnits.ts` with this exact content:

```ts
export const SCENE_LENGTH_UNIT = 'meter';
export const SCENE_LENGTH_UNIT_SYMBOL = 'm';
export const SCENE_LENGTH_UNIT_LABEL = '米';

export type SceneLengthUnit = typeof SCENE_LENGTH_UNIT;
```

- [ ] **Step 2: Static self-check**

Confirm the file exports exactly one storage unit value and does not include cm/mm conversion helpers.

Expected:

```text
SCENE_LENGTH_UNIT === 'meter'
SCENE_LENGTH_UNIT_SYMBOL === 'm'
SCENE_LENGTH_UNIT_LABEL === '米'
```

## Task 2: Label Meter-Based Length Inputs in UI

**Files:**
- Modify: `src/editor/panels/InspectorPanel.tsx`
- Modify: `src/editor/ui/Toolbar.tsx`

- [ ] **Step 1: Import the unit symbol in Inspector**

In `src/editor/panels/InspectorPanel.tsx`, add this import near the existing imports:

```ts
import { SCENE_LENGTH_UNIT_SYMBOL } from '../model/sceneUnits';
```

- [ ] **Step 2: Add a Transform legend helper**

In `src/editor/panels/InspectorPanel.tsx`, after the `lightKinds` constant, add:

```ts
function getTransformLegend(field: TransformField): string {
  if (field === 'position') return `${field} (${SCENE_LENGTH_UNIT_SYMBOL})`;

  return field;
}
```

- [ ] **Step 3: Use the helper for Transform fieldsets**

In `src/editor/panels/InspectorPanel.tsx`, replace:

```tsx
<legend>{field}</legend>
```

with:

```tsx
<legend>{getTransformLegend(field)}</legend>
```

- [ ] **Step 4: Import the unit symbol in Toolbar**

In `src/editor/ui/Toolbar.tsx`, add this import after the type import block:

```ts
import { SCENE_LENGTH_UNIT_SYMBOL } from '../model/sceneUnits';
```

- [ ] **Step 5: Label only the position snap input with meters**

In `src/editor/ui/Toolbar.tsx`, replace:

```tsx
<span>位置</span>
```

with:

```tsx
<span>{`位置 (${SCENE_LENGTH_UNIT_SYMBOL})`}</span>
```

Do not modify the `旋转` or `缩放` labels.

- [ ] **Step 6: Static self-check**

Check the UI changes manually:

```text
Inspector position legend includes (m).
Inspector rotation legend does not include (m).
Inspector scale legend does not include (m).
Toolbar position snap label includes (m).
Toolbar rotation and scale snap labels do not include (m).
```

## Task 3: Make Ground Grid Meter Semantics Explicit

**Files:**
- Modify: `src/runtime/babylon/createEngine.ts`

- [ ] **Step 1: Import the unit symbol**

In `src/runtime/babylon/createEngine.ts`, add this import after the Babylon import block:

```ts
import { SCENE_LENGTH_UNIT_SYMBOL } from '../../editor/model/sceneUnits';
```

- [ ] **Step 2: Rename grid constants to meter-based names**

Replace:

```ts
const GRID_SIZE = 240;
const GRID_SUBDIVISIONS = 240;
const GRID_SPACING = GRID_SIZE / GRID_SUBDIVISIONS;
```

with:

```ts
const GRID_SIZE_METERS = 240;
const GRID_SUBDIVISIONS = 240;
const GRID_SPACING_METERS = GRID_SIZE_METERS / GRID_SUBDIVISIONS;
```

- [ ] **Step 3: Update snapToGrid to use meter spacing**

Replace:

```ts
/** 按网格间距吸附位置，保证网格跟随相机时仍然对齐世界坐标。 */
function snapToGrid(value: number): number {
  return Math.round(value / GRID_SPACING) * GRID_SPACING;
}
```

with:

```ts
/** 按米制网格间距吸附位置，保证网格跟随相机时仍然对齐世界坐标。 */
function snapToGrid(value: number): number {
  return Math.round(value / GRID_SPACING_METERS) * GRID_SPACING_METERS;
}
```

- [ ] **Step 4: Update ground creation dimensions**

Replace:

```ts
width: GRID_SIZE,
height: GRID_SIZE,
```

with:

```ts
width: GRID_SIZE_METERS,
height: GRID_SIZE_METERS,
```

- [ ] **Step 5: Add a concise meter semantics comment**

Replace the comment above `createEditorGround`:

```ts
/** 创建编辑器辅助地面网格和呼吸光晕；该辅助层不进入 SceneDocument，也不可被拾取选中。 */
```

with:

```ts
/** 创建编辑器辅助地面网格和呼吸光晕；网格每小格表示 1 m，该辅助层不进入 SceneDocument，也不可被拾取选中。 */
```

- [ ] **Step 6: Preserve the unit import usage**

Add this comment after `GRID_SPACING_METERS` so the imported symbol is used and the source of the unit is explicit:

```ts
/** 当前 Scene View 地面网格以米为长度单位，单位符号来自集中式单位定义。 */
const GRID_LENGTH_UNIT_SYMBOL = SCENE_LENGTH_UNIT_SYMBOL;
```

Then update the `createEditorGround` comment from Step 5 to interpolate only in text is not possible in comments, so add this runtime-free statement at the start of `createEditorGround`:

```ts
void GRID_LENGTH_UNIT_SYMBOL;
```

This keeps the centralized unit dependency visible without changing runtime behavior.

- [ ] **Step 7: Static self-check**

Confirm no visual constants changed in value:

```text
GRID_SIZE_METERS === 240
GRID_SUBDIVISIONS === 240
GRID_SPACING_METERS === 1
```

## Task 4: Save and Validate Scene Unit Metadata

**Files:**
- Modify: `src/editor/project/SceneSerializer.ts`

- [ ] **Step 1: Import the scene unit constant and type**

In `src/editor/project/SceneSerializer.ts`, add this import near the model imports:

```ts
import { SCENE_LENGTH_UNIT, type SceneLengthUnit } from '../model/sceneUnits';
```

- [ ] **Step 2: Add scene file unit types**

Replace:

```ts
type SceneFileDocument = {
  version: number;
  scene?: unknown;
};
```

with:

```ts
type SceneFileUnits = {
  length: SceneLengthUnit;
};

type SceneFileDocument = {
  version: number;
  units: SceneFileUnits;
  scene?: unknown;
};
```

- [ ] **Step 3: Serialize units metadata**

Replace:

```ts
export function serializeScene(scene: SceneDocument): string {
  return JSON.stringify({ version: 1, scene }, null, 2);
}
```

with:

```ts
export function serializeScene(scene: SceneDocument): string {
  return JSON.stringify({ version: 1, units: { length: SCENE_LENGTH_UNIT }, scene }, null, 2);
}
```

- [ ] **Step 4: Accept old and new file shapes**

Replace `assertSceneFileDocument` with this exact function:

```ts
function assertSceneFileDocument(value: unknown): SceneFileDocument {
  const document = assertPlainObject(value);
  const keys = Object.keys(document);
  const hasLegacyShape = keys.length === 2 && keys.includes('version') && keys.includes('scene');
  const hasUnitsShape = keys.length === 3 && keys.includes('version') && keys.includes('units') && keys.includes('scene');

  if ((!hasLegacyShape && !hasUnitsShape) || document.version !== 1) {
    throwUnsupportedSceneFileError();
  }

  const units = hasUnitsShape ? normalizeSceneFileUnits(document.units) : { length: SCENE_LENGTH_UNIT };

  return { version: 1, units, scene: document.scene };
}
```

- [ ] **Step 5: Add units normalization**

Add this function immediately after `assertSceneFileDocument`:

```ts
function normalizeSceneFileUnits(value: unknown): SceneFileUnits {
  const units = assertPlainObject(value);
  const keys = Object.keys(units);

  if (keys.length !== 1 || units.length !== SCENE_LENGTH_UNIT) {
    throwUnsupportedSceneFileError();
  }

  return { length: SCENE_LENGTH_UNIT };
}
```

- [ ] **Step 6: Static self-check for serializer behavior**

Review the serializer logic and confirm these cases:

```text
serializeScene(scene) outputs version + units + scene.
{ version: 1, scene } is accepted and treated as meter.
{ version: 1, units: { length: 'meter' }, scene } is accepted.
{ version: 1, units: { length: 'centimeter' }, scene } is rejected.
{ version: 1, units: {}, scene } is rejected.
{ version: 1, units: 'meter', scene } is rejected.
```

## Task 5: Update README Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update current features**

In `README.md`, add this bullet after the Babylon Scene View bullet:

```markdown
- 米制场景单位：编辑器约定 `1 scene unit = 1 m`，Inspector 中 position、位置吸附步长与地面网格均按米解释。
```

- [ ] **Step 2: Update ground grid feature wording**

Replace the existing ground grid bullet:

```markdown
- 编辑器地面辅助层：Scene View 显示视觉无限的科技蓝地面网格，并在世界原点保留低强度呼吸光晕效果，辅助层不参与选中、保存、加载或撤销/重做。
```

with:

```markdown
- 编辑器地面辅助层：Scene View 显示视觉无限的科技蓝地面网格，默认每小格表示 `1 m`，并在世界原点保留低强度呼吸光晕效果；辅助层不参与选中、保存、加载或撤销/重做。
```

- [ ] **Step 3: Update basic operations**

Replace:

```markdown
- 开启吸附：勾选 `吸附`，并调整位置、旋转、缩放步长。
```

with:

```markdown
- 开启吸附：勾选 `吸附`，并调整位置、旋转、缩放步长；其中位置步长单位为 `m`。
```

- [ ] **Step 4: Update scene file notes**

In the “场景文件的核心约定” list, add these bullets after the version bullet:

```markdown
- 长度单位固定为米：`1 scene unit = 1 m`。
- 新保存的场景文件会写入 `units.length = "meter"`；旧版没有 `units` 字段的场景文件会按米兼容加载。
```

- [ ] **Step 5: Update recent completion log**

In “最近完成”, add this bullet at the top:

```markdown
- 2026-06-29：将场景长度单位明确为米，新增场景文件单位元数据，并在 Inspector、位置吸附与地面网格文档中统一米制语义。
```

- [ ] **Step 6: Static documentation self-check**

Confirm README documents all user-visible semantics:

```text
1 scene unit = 1 m is documented.
Inspector position is implied as meter-based.
Position snap step is documented as m.
Ground grid cell is documented as 1 m.
.scene.json units.length = "meter" is documented.
Old files without units are documented as meter-compatible.
```

## Task 6: Final Cross-Check

**Files:**
- Review only: `src/editor/model/sceneUnits.ts`
- Review only: `src/editor/panels/InspectorPanel.tsx`
- Review only: `src/editor/ui/Toolbar.tsx`
- Review only: `src/runtime/babylon/createEngine.ts`
- Review only: `src/editor/project/SceneSerializer.ts`
- Review only: `README.md`

- [ ] **Step 1: Search for scattered unit literals**

Search modified source files for direct `meter` or `(m)` literals outside `sceneUnits.ts` and intentional JSON output. Expected result:

```text
No repeated UI hardcoding of meter symbols outside centralized unit constants.
SceneSerializer may reference SCENE_LENGTH_UNIT but should not hardcode 'meter'.
README may contain user-facing documentation literals.
```

- [ ] **Step 2: Check Transform semantics**

Confirm:

```text
position is length and shows m.
rotation is not length and does not show m.
scale is dimensionless and does not show m.
No numeric Transform values are multiplied or divided.
```

- [ ] **Step 3: Check scene file compatibility**

Confirm:

```text
serializeScene writes units.length = SCENE_LENGTH_UNIT.
deserializeScene accepts old version 1 files without units.
deserializeScene rejects unknown units.
```

- [ ] **Step 4: Confirm no full test command was run by default**

Because the user explicitly instructed not to run tests to save tokens, do not run full test commands by default. If a future type error is suspected, ask for permission or run the smallest necessary command only when needed.

Expected:

```text
No npm run build or full test suite is required for this implementation handoff.
```
