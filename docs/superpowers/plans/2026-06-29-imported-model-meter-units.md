# Imported Model Meter Units Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让导入模型根据 `meta.json.lengthUnit` 自动换算到米制场景，保证模型最终尺寸符合 `1 scene unit = 1 m`。

**Architecture:** 在 Electron 扫描层解析模型包 `meta.json.lengthUnit`，归一化为 `meter/centimeter/millimeter` 与 `unitScaleToMeters`，并通过 `AssetEntry`、项目资产索引、`ModelAssetComponent` 持久化到场景。Babylon 运行时只对导入模型 root 叠加单位基准缩放，用户可见 Transform.scale 仍表示额外缩放比例。

**Tech Stack:** Electron、TypeScript NodeNext、React 19、Zustand、Babylon.js、Vite。

---

## File Structure

- Modify: `electron/types.ts`
  - 为主进程 `AssetEntry` 增加模型源单位字段。
- Create: `electron/modelUnits.ts`
  - 主进程使用的模型单位归一化与换算表。
- Modify: `electron/ipc/modelPackageScanner.ts`
  - 从 `meta.json.lengthUnit` 读取源单位，写入扫描出的 `AssetEntry`，不支持单位时跳过模型包。
- Modify: `electron/ipc/projectAssetStore.ts`
  - 读取/写入项目资产索引时保留并校验单位字段。
- Modify: `src/vite-env.d.ts`
  - 同步 renderer 全局 `AssetEntry` 类型。
- Modify: `src/editor/assets/AssetDatabase.ts`
  - 同步 renderer 模块内 `AssetEntry` 类型。
- Modify: `src/editor/model/sceneUnits.ts`
  - 增加 renderer 侧模型源单位类型、默认值、换算表与格式化辅助。
- Modify: `src/editor/model/components.ts`
  - `ModelAssetComponent` 增加 `lengthUnit` 和 `unitScaleToMeters`。
- Modify: `src/editor/model/SceneDocument.ts`
  - `createModelEntity()` 接收模型单位参数并默认按米。
- Modify: `src/editor/store/editorStore.ts`
  - 导入模型实体时把 `AssetEntry` 上的单位字段传入 `createModelEntity()`。
- Modify: `src/editor/project/SceneSerializer.ts`
  - 序列化/反序列化模型单位字段，兼容旧场景缺失字段。
- Modify: `src/runtime/babylon/SceneRuntime.ts`
  - 导入模型 root 叠加 `unitScaleToMeters`，基础 Mesh 不受影响。
- Modify: `src/editor/panels/ProjectPanel.tsx`
  - 模型卡片 title 显示源单位到米的换算。
- Modify: `src/editor/panels/InspectorPanel.tsx`
  - Model Asset 区域显示源单位与换算系数。
- Modify: `README.md`
  - 文档说明 `meta.json.lengthUnit` 支持值、默认行为、跳过规则和 scale 语义。

## Task 1: Add Unit Types and Normalizers

**Files:**
- Modify: `electron/types.ts`
- Create: `electron/modelUnits.ts`
- Modify: `src/vite-env.d.ts`
- Modify: `src/editor/assets/AssetDatabase.ts`
- Modify: `src/editor/model/sceneUnits.ts`

- [ ] **Step 1: Extend Electron AssetEntry type**

In `electron/types.ts`, add this type before `AssetEntry`:

```ts
export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';
```

Then add these optional fields to `AssetEntry`:

```ts
  lengthUnit?: ModelSourceLengthUnit;
  unitScaleToMeters?: number;
```

- [ ] **Step 2: Create Electron unit normalizer**

Create `electron/modelUnits.ts`:

```ts
import type { ModelSourceLengthUnit } from './types.js';

export type ModelLengthUnitInfo = {
  lengthUnit: ModelSourceLengthUnit;
  unitScaleToMeters: number;
};

export const DEFAULT_MODEL_LENGTH_UNIT_INFO: ModelLengthUnitInfo = {
  lengthUnit: 'meter',
  unitScaleToMeters: 1,
};

const MODEL_LENGTH_UNIT_ALIASES: Record<string, ModelLengthUnitInfo> = {
  meter: DEFAULT_MODEL_LENGTH_UNIT_INFO,
  m: DEFAULT_MODEL_LENGTH_UNIT_INFO,
  centimeter: { lengthUnit: 'centimeter', unitScaleToMeters: 0.01 },
  cm: { lengthUnit: 'centimeter', unitScaleToMeters: 0.01 },
  millimeter: { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 },
  mm: { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 },
};

export function normalizeModelLengthUnit(value: unknown): ModelLengthUnitInfo | null {
  if (value === undefined) return DEFAULT_MODEL_LENGTH_UNIT_INFO;
  if (typeof value !== 'string') return null;

  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) return DEFAULT_MODEL_LENGTH_UNIT_INFO;

  return MODEL_LENGTH_UNIT_ALIASES[normalizedValue] ?? null;
}

export function isValidModelUnitScaleToMeters(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
```

- [ ] **Step 3: Extend renderer global AssetEntry type**

In `src/vite-env.d.ts`, add:

```ts
type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';
```

before `type AssetEntry`, then add to `AssetEntry`:

```ts
  lengthUnit?: ModelSourceLengthUnit;
  unitScaleToMeters?: number;
```

- [ ] **Step 4: Extend renderer module AssetEntry type**

In `src/editor/assets/AssetDatabase.ts`, add:

```ts
export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';
```

before `AssetEntry`, then add to `AssetEntry`:

```ts
  lengthUnit?: ModelSourceLengthUnit;
  unitScaleToMeters?: number;
```

- [ ] **Step 5: Extend scene unit helpers**

Append to `src/editor/model/sceneUnits.ts`:

```ts
export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';

export type ModelLengthUnitInfo = {
  lengthUnit: ModelSourceLengthUnit;
  unitScaleToMeters: number;
};

export const DEFAULT_MODEL_LENGTH_UNIT_INFO: ModelLengthUnitInfo = {
  lengthUnit: 'meter',
  unitScaleToMeters: 1,
};

const MODEL_LENGTH_UNIT_LABELS: Record<ModelSourceLengthUnit, string> = {
  meter: 'meter',
  centimeter: 'centimeter',
  millimeter: 'millimeter',
};

const MODEL_UNIT_SCALE_TO_METERS: Record<ModelSourceLengthUnit, number> = {
  meter: 1,
  centimeter: 0.01,
  millimeter: 0.001,
};

export function normalizeModelLengthUnitInfo(lengthUnit: unknown, unitScaleToMeters: unknown): ModelLengthUnitInfo {
  if (lengthUnit === undefined && unitScaleToMeters === undefined) return DEFAULT_MODEL_LENGTH_UNIT_INFO;
  if (lengthUnit !== 'meter' && lengthUnit !== 'centimeter' && lengthUnit !== 'millimeter') {
    throw new Error('模型单位不受支持。');
  }

  const expectedScale = MODEL_UNIT_SCALE_TO_METERS[lengthUnit];
  if (unitScaleToMeters !== expectedScale) {
    throw new Error('模型单位换算系数不匹配。');
  }

  return { lengthUnit, unitScaleToMeters: expectedScale };
}

export function formatModelLengthUnit(lengthUnit: ModelSourceLengthUnit): string {
  return MODEL_LENGTH_UNIT_LABELS[lengthUnit];
}
```

## Task 2: Parse and Persist Model Unit Metadata in Electron

**Files:**
- Modify: `electron/ipc/modelPackageScanner.ts`
- Modify: `electron/ipc/projectAssetStore.ts`

- [ ] **Step 1: Import unit helpers in scanner**

In `electron/ipc/modelPackageScanner.ts`, add:

```ts
import { normalizeModelLengthUnit, type ModelLengthUnitInfo } from '../modelUnits.js';
```

- [ ] **Step 2: Extend metadata type**

Replace:

```ts
type ModelPackageMetadata = {
  displayName?: string;
};
```

with:

```ts
type ModelPackageMetadata = ModelLengthUnitInfo & {
  displayName?: string;
};
```

- [ ] **Step 3: Read lengthUnit from meta.json**

In `readModelPackageMetadata`, replace the successful return with:

```ts
    const unitInfo = normalizeModelLengthUnit(isPlainObject(parsed) ? parsed.lengthUnit : undefined);
    if (!unitInfo) {
      throw new Error(`模型单位不受支持：${isPlainObject(parsed) ? String(parsed.lengthUnit) : 'unknown'}`);
    }

    return {
      metadataPath,
      displayName: extractDisplayNameFromMetadata(parsed),
      ...unitInfo,
    };
```

Replace the catch block with:

```ts
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('模型单位不受支持：')) {
      throw error;
    }

    return { ...DEFAULT_MODEL_LENGTH_UNIT_INFO };
  }
```

Also import `DEFAULT_MODEL_LENGTH_UNIT_INFO` in Step 1 import.

- [ ] **Step 4: Write unit fields to scanned AssetEntry**

In `scanModelPackage`, add to the returned `asset`:

```ts
      lengthUnit: metadata.lengthUnit,
      unitScaleToMeters: metadata.unitScaleToMeters,
```

- [ ] **Step 5: Preserve unit fields in project asset index**

In `electron/ipc/projectAssetStore.ts`, import:

```ts
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, isValidModelUnitScaleToMeters } from '../modelUnits.js';
```

In `normalizeIndexedAsset`, after `scriptPaths`, add:

```ts
  const lengthUnit =
    asset.lengthUnit === 'meter' || asset.lengthUnit === 'centimeter' || asset.lengthUnit === 'millimeter'
      ? asset.lengthUnit
      : DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit;
  const unitScaleToMeters = isValidModelUnitScaleToMeters(asset.unitScaleToMeters)
    ? asset.unitScaleToMeters
    : DEFAULT_MODEL_LENGTH_UNIT_INFO.unitScaleToMeters;
```

Then add these fields to the returned asset:

```ts
    lengthUnit,
    unitScaleToMeters,
```

## Task 3: Persist Unit Metadata in Scene Model Components

**Files:**
- Modify: `src/editor/model/components.ts`
- Modify: `src/editor/model/SceneDocument.ts`
- Modify: `src/editor/store/editorStore.ts`
- Modify: `src/editor/project/SceneSerializer.ts`

- [ ] **Step 1: Extend ModelAssetComponent**

In `src/editor/model/components.ts`, import:

```ts
import type { ModelSourceLengthUnit } from './sceneUnits';
```

Then add to `ModelAssetComponent`:

```ts
  lengthUnit: ModelSourceLengthUnit;
  unitScaleToMeters: number;
```

- [ ] **Step 2: Update createModelEntity signature**

In `src/editor/model/SceneDocument.ts`, import:

```ts
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, type ModelLengthUnitInfo } from './sceneUnits';
```

Change signature to:

```ts
export function createModelEntity(
  sourcePath: string,
  sourceUrl: string,
  displayName: string,
  unitInfo: ModelLengthUnitInfo = DEFAULT_MODEL_LENGTH_UNIT_INFO,
): Entity {
```

Then add to `modelAsset`:

```ts
        lengthUnit: unitInfo.lengthUnit,
        unitScaleToMeters: unitInfo.unitScaleToMeters,
```

- [ ] **Step 3: Pass asset unit info from store**

In `src/editor/store/editorStore.ts`, import:

```ts
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, type ModelLengthUnitInfo } from '../model/sceneUnits';
```

Inside `importModelAsset`, before `createModelEntity`, add:

```ts
    const unitInfo: ModelLengthUnitInfo = {
      lengthUnit: asset.lengthUnit ?? DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit,
      unitScaleToMeters: asset.unitScaleToMeters ?? DEFAULT_MODEL_LENGTH_UNIT_INFO.unitScaleToMeters,
    };
```

Then call:

```ts
    const entity = createModelEntity(asset.path, asset.sourceUrl, displayName, unitInfo);
```

- [ ] **Step 4: Normalize model units during scene load**

In `src/editor/project/SceneSerializer.ts`, import:

```ts
import { normalizeModelLengthUnitInfo } from '../model/sceneUnits';
```

In `normalizeModelAsset`, after `sourceUrl` validation, add:

```ts
  const unitInfo = normalizeModelLengthUnitInfo(modelAsset.lengthUnit, modelAsset.unitScaleToMeters);
```

Then return:

```ts
  return {
    sourcePath,
    sourceUrl,
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
  };
```

## Task 4: Apply Model Unit Scaling in Runtime and UI

**Files:**
- Modify: `src/runtime/babylon/SceneRuntime.ts`
- Modify: `src/editor/panels/ProjectPanel.tsx`
- Modify: `src/editor/panels/InspectorPanel.tsx`

- [ ] **Step 1: Add model-specific transform helper**

In `src/runtime/babylon/SceneRuntime.ts`, add this method after `applyTransform`:

```ts
  /** 将导入模型源单位换算到米，再叠加用户 Transform 缩放。 */
  private applyModelTransform(target: TransformNode, transform: TransformComponent, unitScaleToMeters: number): void {
    target.position = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    target.rotation = new Vector3(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    target.scaling = new Vector3(
      transform.scale.x * unitScaleToMeters,
      transform.scale.y * unitScaleToMeters,
      transform.scale.z * unitScaleToMeters,
    );
  }
```

Replace both `this.applyTransform(..., entity.components.transform)` calls in `syncModelEntity` with:

```ts
this.applyModelTransform(rootOrCurrentRoot, entity.components.transform, modelAsset.unitScaleToMeters)
```

Use `current.root` for current model and `root` for newly created model.

- [ ] **Step 2: Format Project model title**

In `src/editor/panels/ProjectPanel.tsx`, import:

```ts
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, formatModelLengthUnit } from '../model/sceneUnits';
```

Add helper before `ProjectPanel`:

```ts
function getModelUnitTitle(asset: AssetEntry): string {
  const lengthUnit = asset.lengthUnit ?? DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit;
  return `源单位：${formatModelLengthUnit(lengthUnit)} → m`;
}
```

Replace the model card title with:

```tsx
title={isImportedModel && item.asset ? `导入模型：${item.name}，${getModelUnitTitle(item.asset)}` : '占位资源，功能后续接入'}
```

- [ ] **Step 3: Show model unit info in Inspector**

In `src/editor/panels/InspectorPanel.tsx`, import:

```ts
import { formatModelLengthUnit } from '../model/sceneUnits';
```

Inside `Model Asset` fieldset after the path paragraph, add:

```tsx
          <p className="muted">源单位：{formatModelLengthUnit(modelAsset.lengthUnit)}</p>
          <p className="muted">换算到米：×{modelAsset.unitScaleToMeters}</p>
```

## Task 5: Update Documentation and Verify

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README model import feature**

Update the model folder import bullet to mention `meta.json.lengthUnit` and supported units.

- [ ] **Step 2: Add recent completion entry**

Add:

```markdown
- 2026-06-29：导入模型支持读取 `meta.json.lengthUnit`，将 meter/cm/mm 源模型自动换算到米制场景，保持 `scale = 1` 表示不额外缩放。
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit 0 with `tsc -b` output and no TypeScript errors.

- [ ] **Step 4: Static requirement check**

Search for:

```text
lengthUnit
unitScaleToMeters
normalizeModelLengthUnit
applyModelTransform
meta.json.lengthUnit
```

Expected: results cover Electron scanner, asset index, renderer types, model component, serializer, runtime, UI and README.
