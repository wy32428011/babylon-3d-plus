# Imported Model Parameters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 稳定并补齐导入模型参数化配置链路：读取 `meta.json.modelParameters`，在 Inspector 展示参数，修改参数后实时驱动 Babylon 模型外观，并支持撤销/重做与保存/加载。

**Architecture:** 采用安全 JSON schema，不执行模型包脚本。Electron 只做轻量 schema 入口筛选并透传配置，renderer 负责完整归一化、参数值 sanitize、Inspector 表单和 SceneRuntime 绑定应用。场景文档保存 `parameterConfig` 快照与每个模型实例的 `parameterValues`，运行时通过 baseline 重置避免外观状态累积污染。

**Tech Stack:** Electron IPC、React、TypeScript、Zustand、Babylon.js、JSON DSL、Markdown。

---

## 规格来源

- 设计规格：`docs/superpowers/specs/2026-06-30-imported-model-parameters-design.md`
- 已确认配置格式：沿用 `meta.json.modelParameters`
- 已确认 schema：`babylon-editor.model-parameters`，`version: 1`
- 已确认安全边界：不执行任意 JS，不允许远程/绝对/逃逸贴图路径

## 文件结构与职责

- 修改/确认：`src/editor/model/modelParameters.ts`
  - 职责：定义参数 schema 类型、归一化配置、sanitize 参数值、默认值和比较/克隆工具。

- 修改/确认：`electron/ipc/modelPackageScanner.ts`
  - 职责：读取模型包 `meta.json`，轻量筛选 `modelParameters` 并写入 `AssetEntry.parameterConfig`。

- 修改/确认：`electron/ipc/projectAssetStore.ts`
  - 职责：项目资产索引持久化时保留 `parameterConfig`。

- 修改/确认：`electron/types.ts`、`src/vite-env.d.ts`、`src/editor/assets/AssetDatabase.ts`
  - 职责：跨 Electron/preload/renderer 保留参数配置字段，并在 renderer 安全归一化。

- 修改/确认：`src/editor/model/components.ts`、`src/editor/model/SceneDocument.ts`
  - 职责：模型实体组件包含 `parameterConfig` 与 `parameterValues`，导入模型时创建默认参数值。

- 修改/确认：`src/editor/project/SceneSerializer.ts`
  - 职责：保存/加载场景时保留并归一化参数配置和值。

- 修改/确认：`src/editor/commands/entityCommands.ts`、`src/editor/store/editorStore.ts`
  - 职责：参数值 preview、commit、撤销/重做和日志。

- 修改/确认：`src/editor/panels/InspectorPanel.tsx`、`src/editor/panels/ModelParametersInspector.tsx`
  - 职责：选中导入模型时展示参数表单并处理实时预览/提交。

- 修改/确认：`src/runtime/babylon/SceneRuntime.ts`
  - 职责：根据参数配置把参数值应用到 Babylon node/mesh/material，并安全处理贴图和 baseline。

- 修改/确认：`README.md`
  - 职责：记录参数化模型使用方式、能力边界、限制和最近完成。

## 执行任务

### Task 1: 固化模型参数 schema 与归一化工具

**Files:**
- Modify: `src/editor/model/modelParameters.ts`

- [x] **Step 1: 确认参数类型定义完整**

`src/editor/model/modelParameters.ts` 应包含以下核心类型；若缺失或名称不一致，按此补齐：

```ts
import type { Vector3Data } from './math';

export type ModelParameterType = 'number' | 'color' | 'boolean' | 'enum' | 'vector3' | 'texture';

export type ModelParameterPrimitiveValue = number | string | boolean;
export type ModelParameterVector3Value = Vector3Data;
export type ModelParameterValue = ModelParameterPrimitiveValue | ModelParameterVector3Value;
export type ModelParameterValues = Record<string, ModelParameterValue>;

export type ModelParameterOption = {
  value: string;
  label: string;
};

type BaseModelParameterDefinition = {
  key: string;
  label: string;
  unit?: string;
};

export type ModelNumberParameterDefinition = BaseModelParameterDefinition & {
  type: 'number';
  defaultValue: number;
  min?: number;
  max?: number;
  step?: number;
};

export type ModelColorParameterDefinition = BaseModelParameterDefinition & {
  type: 'color';
  defaultValue: string;
};

export type ModelBooleanParameterDefinition = BaseModelParameterDefinition & {
  type: 'boolean';
  defaultValue: boolean;
};

export type ModelEnumParameterDefinition = BaseModelParameterDefinition & {
  type: 'enum';
  defaultValue: string;
  options: ModelParameterOption[];
};

export type ModelVector3ParameterDefinition = BaseModelParameterDefinition & {
  type: 'vector3';
  defaultValue: Vector3Data;
  min?: number;
  max?: number;
  step?: number;
};

export type ModelTextureParameterDefinition = BaseModelParameterDefinition & {
  type: 'texture';
  defaultValue: string;
  options?: ModelParameterOption[];
  allowedExtensions?: string[];
};

export type ModelParameterDefinition =
  | ModelNumberParameterDefinition
  | ModelColorParameterDefinition
  | ModelBooleanParameterDefinition
  | ModelEnumParameterDefinition
  | ModelVector3ParameterDefinition
  | ModelTextureParameterDefinition;
```

- [x] **Step 2: 确认 target、binding、rule 与表达式类型完整**

同一文件应包含：

```ts
export type ModelExpression =
  | number
  | string
  | boolean
  | Vector3Data
  | { param: string }
  | { vector3: [ModelExpression, ModelExpression, ModelExpression] }
  | {
      op:
        | 'add'
        | 'sub'
        | 'mul'
        | 'div'
        | 'min'
        | 'max'
        | 'clamp'
        | 'lerp'
        | 'eq'
        | 'neq'
        | 'gt'
        | 'gte'
        | 'lt'
        | 'lte'
        | 'and'
        | 'or'
        | 'not'
        | 'if';
      args: ModelExpression[];
    };

export type ModelParameterTarget =
  | { kind: 'node'; name: string }
  | { kind: 'mesh'; name: string }
  | { kind: 'material'; name: string };

export type ModelParameterBindableProperty =
  | 'visible'
  | 'position'
  | 'rotation'
  | 'scaling'
  | 'baseColor'
  | 'emissiveColor'
  | 'alpha'
  | 'baseTexture';

export type ModelParameterBinding = {
  target: ModelParameterTarget;
  property: ModelParameterBindableProperty;
  value: ModelExpression;
};

export type ModelParameterRule = {
  when: ModelExpression;
  set: ModelParameterBinding[];
};

export type ModelParameterConfig = {
  schema: 'babylon-editor.model-parameters';
  version: 1;
  parameters: ModelParameterDefinition[];
  bindings: ModelParameterBinding[];
  rules?: ModelParameterRule[];
};
```

- [x] **Step 3: 确认安全贴图路径校验**

同一文件应包含并使用以下规则：

```ts
const SAFE_TEXTURE_EXTENSION_PATTERN = /\.(png|jpe?g|webp)$/i;
const FORBIDDEN_TEXTURE_PREFIX_PATTERN = /^(?:[a-z]+:|\/|\\)/i;

function isSafeTexturePath(value: string, allowedExtensions?: string[]): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('..') || FORBIDDEN_TEXTURE_PREFIX_PATTERN.test(trimmed)) return false;

  const extensions = allowedExtensions?.length ? allowedExtensions : ['.png', '.jpg', '.jpeg', '.webp'];
  if (!extensions.some((extension) => trimmed.toLowerCase().endsWith(extension.toLowerCase()))) return false;

  return SAFE_TEXTURE_EXTENSION_PATTERN.test(trimmed);
}
```

Expected: `../a.png`、`C:\\a.png`、`https://x/a.png`、`data:image/png` 均不能通过。

- [x] **Step 4: 确认参数值 sanitize 逻辑**

同一文件应导出：

```ts
export function sanitizeModelParameterValue(
  definition: ModelParameterDefinition,
  value: unknown,
): ModelParameterValue {
  if (definition.type === 'number') {
    const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : definition.defaultValue;
    return clampNumber(numberValue, definition.min, definition.max);
  }

  if (definition.type === 'color') {
    return typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value : definition.defaultValue;
  }

  if (definition.type === 'boolean') {
    return typeof value === 'boolean' ? value : definition.defaultValue;
  }

  if (definition.type === 'enum') {
    return typeof value === 'string' && definition.options.some((option) => option.value === value)
      ? value
      : definition.defaultValue;
  }

  if (definition.type === 'vector3') {
    const vector = isVector3Data(value) ? value : definition.defaultValue;
    return {
      x: clampNumber(vector.x, definition.min, definition.max),
      y: clampNumber(vector.y, definition.min, definition.max),
      z: clampNumber(vector.z, definition.min, definition.max),
    };
  }

  if (typeof value === 'string' && isSafeTexturePath(value, definition.allowedExtensions)) {
    return value.trim().replace(/\\/g, '/');
  }

  return definition.defaultValue;
}
```

- [x] **Step 5: 确认默认值、克隆、比较工具**

同一文件应导出：

```ts
export function createDefaultModelParameterValues(config: ModelParameterConfig): ModelParameterValues {
  return config.parameters.reduce<ModelParameterValues>((values, definition) => {
    values[definition.key] = sanitizeModelParameterValue(definition, definition.defaultValue);
    return values;
  }, {});
}

export function sanitizeModelParameterValues(
  config: ModelParameterConfig,
  values: unknown,
): ModelParameterValues {
  const sourceValues = isPlainObject(values) ? values : {};

  return config.parameters.reduce<ModelParameterValues>((nextValues, definition) => {
    nextValues[definition.key] = sanitizeModelParameterValue(definition, sourceValues[definition.key]);
    return nextValues;
  }, {});
}

export function cloneModelParameterValues(values: ModelParameterValues): ModelParameterValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, isVector3Data(value) ? cloneVector3(value) : value]),
  );
}

export function areModelParameterValuesEqual(left: ModelParameterValues, right: ModelParameterValues): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (isVector3Data(leftValue) && isVector3Data(rightValue)) {
      return leftValue.x === rightValue.x && leftValue.y === rightValue.y && leftValue.z === rightValue.z;
    }

    return leftValue === rightValue;
  });
}
```

- [x] **Step 6: 确认配置归一化入口**

同一文件应导出：

```ts
export function normalizeModelParameterConfig(value: unknown): ModelParameterConfig | null {
  if (!isPlainObject(value) || value.schema !== MODEL_PARAMETER_SCHEMA || value.version !== 1) return null;
  if (!Array.isArray(value.parameters) || !Array.isArray(value.bindings)) return null;
  if (value.parameters.length > 64 || value.bindings.length > 256) return null;

  const parameters = value.parameters.map(normalizeParameterDefinition);
  if (!parameters.every(Boolean)) return null;

  const normalizedParameters = parameters as ModelParameterDefinition[];
  const parameterKeys = new Set<string>();
  for (const parameter of normalizedParameters) {
    if (parameterKeys.has(parameter.key)) return null;
    parameterKeys.add(parameter.key);
  }

  const bindings = value.bindings.map(normalizeBinding);
  if (!bindings.every(Boolean)) return null;

  const rulesSource = Array.isArray(value.rules) ? value.rules : [];
  if (rulesSource.length > 128) return null;
  const rules = rulesSource.map(normalizeRule);
  if (!rules.every(Boolean)) return null;

  return {
    schema: MODEL_PARAMETER_SCHEMA,
    version: 1,
    parameters: normalizedParameters,
    bindings: bindings as ModelParameterBinding[],
    ...(rules.length > 0 ? { rules: rules as ModelParameterRule[] } : {}),
  };
}
```

- [x] **Step 7: 静态检查**

Run:

```bash
git diff -- src/editor/model/modelParameters.ts
```

Expected: 该文件只包含参数 schema、归一化与 sanitize 工具，不依赖 React、Zustand、Electron 或 Babylon 运行时对象。

### Task 2: 打通 Electron 模型包扫描与资产索引透传

**Files:**
- Modify: `electron/types.ts`
- Modify: `electron/ipc/modelPackageScanner.ts`
- Modify: `electron/ipc/projectAssetStore.ts`
- Modify: `src/vite-env.d.ts`
- Modify: `src/editor/assets/AssetDatabase.ts`

- [x] **Step 1: Electron AssetEntry 增加参数配置字段**

在 `electron/types.ts` 的 `AssetEntry` 中确认包含：

```ts
export type AssetEntry = {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  kind: 'folder' | 'model' | 'texture' | 'scene' | 'unknown';
  packagePath?: string;
  metadataPath?: string;
  scriptPaths?: string[];
  displayName?: string;
  lengthUnit?: ModelSourceLengthUnit;
  unitScaleToMeters?: number;
  parameterConfig?: unknown;
};
```

Electron 层保持 `unknown`，不引入 renderer 的模型参数类型，避免主进程依赖 renderer 代码。

- [x] **Step 2: 扫描 meta.json 时提取模型参数配置**

在 `electron/ipc/modelPackageScanner.ts` 中确认包含：

```ts
function extractModelParameterConfigFromMetadata(metadata: unknown): unknown | undefined {
  if (!isPlainObject(metadata) || !isPlainObject(metadata.modelParameters)) return undefined;

  const config = metadata.modelParameters;
  if (config.schema !== 'babylon-editor.model-parameters' || config.version !== 1) return undefined;
  if (!Array.isArray(config.parameters) || !Array.isArray(config.bindings)) return undefined;
  if (config.parameters.length > 64 || config.bindings.length > 256) return undefined;
  if (Array.isArray(config.rules) && config.rules.length > 128) return undefined;

  return config;
}
```

- [x] **Step 3: 将 parameterConfig 写入扫描结果**

在 `readModelPackageMetadata()` 的返回对象中确认包含：

```ts
return {
  metadataPath,
  displayName: extractDisplayNameFromMetadata(parsed),
  parameterConfig: extractModelParameterConfigFromMetadata(parsed),
  ...unitInfo,
};
```

在 `scanModelPackage()` 的 asset 中确认包含：

```ts
parameterConfig: metadata.parameterConfig,
```

- [x] **Step 4: 项目资产索引保留 parameterConfig**

在 `electron/ipc/projectAssetStore.ts` 的资产归一化逻辑中确认包含：

```ts
parameterConfig: isPlainObject(asset.parameterConfig) ? asset.parameterConfig : undefined,
```

Expected: 已导入到项目目录的模型包再次打开项目后，模型库卡片仍保留参数配置。

- [x] **Step 5: renderer 全局类型保留 parameterConfig**

在 `src/vite-env.d.ts` 中确认 `AssetEntry` 包含：

```ts
type ModelParameterConfig = import('./editor/model/modelParameters').ModelParameterConfig;

parameterConfig?: ModelParameterConfig;
```

- [x] **Step 6: renderer AssetDatabase 解码时 normalize 配置**

在 `src/editor/assets/AssetDatabase.ts` 确认包含：

```ts
import type { ModelParameterConfig } from '../model/modelParameters';
import { normalizeModelParameterConfig } from '../model/modelParameters';

export type AssetEntry = {
  // ...existing fields
  parameterConfig?: ModelParameterConfig;
};
```

并在 `decodeModelAssetDragPayload()` 中确认包含：

```ts
const parameterConfig = normalizeModelParameterConfig(payload.parameterConfig);
if (parameterConfig) asset.parameterConfig = parameterConfig;
```

- [x] **Step 7: 静态检查**

Run:

```bash
git diff -- electron/types.ts electron/ipc/modelPackageScanner.ts electron/ipc/projectAssetStore.ts src/vite-env.d.ts src/editor/assets/AssetDatabase.ts
```

Expected: Electron 层只透传 `unknown`，renderer 层才使用 `normalizeModelParameterConfig()` 得到强类型配置。

### Task 3: 让模型实体保存参数配置和值

**Files:**
- Modify: `src/editor/model/components.ts`
- Modify: `src/editor/model/SceneDocument.ts`
- Modify: `src/editor/store/editorStore.ts`
- Modify: `src/editor/project/SceneSerializer.ts`

- [x] **Step 1: ModelAssetComponent 增加参数字段**

在 `src/editor/model/components.ts` 中确认：

```ts
import type { ModelParameterConfig, ModelParameterValues } from './modelParameters';

export type ModelAssetComponent = {
  sourcePath: string;
  sourceUrl: string;
  lengthUnit: ModelSourceLengthUnit;
  unitScaleToMeters: number;
  parameterConfig?: ModelParameterConfig;
  parameterValues?: ModelParameterValues;
};
```

- [x] **Step 2: createModelEntity 接收参数配置并生成默认值**

在 `src/editor/model/SceneDocument.ts` 中确认导入：

```ts
import { createDefaultModelParameterValues, type ModelParameterConfig } from './modelParameters';
```

并确认 `createModelEntity` 签名包含：

```ts
export function createModelEntity(
  sourcePath: string,
  sourceUrl: string,
  displayName: string,
  unitInfo: ModelLengthUnitInfo = DEFAULT_MODEL_LENGTH_UNIT_INFO,
  position: Vector3Data = vector3(),
  parameterConfig?: ModelParameterConfig,
): Entity {
```

`modelAsset` 应包含：

```ts
modelAsset: {
  sourcePath,
  sourceUrl,
  lengthUnit: unitInfo.lengthUnit,
  unitScaleToMeters: unitInfo.unitScaleToMeters,
  ...(parameterConfig ? {
    parameterConfig,
    parameterValues: createDefaultModelParameterValues(parameterConfig),
  } : {}),
},
```

- [x] **Step 3: importModelAsset 传入参数配置**

在 `src/editor/store/editorStore.ts` 的 `importModelAsset` 中确认：

```ts
const entity = createModelEntity(
  asset.path,
  asset.sourceUrl,
  displayName,
  unitInfo,
  sanitizeVector3(placementPosition),
  normalizeModelParameterConfig(asset.parameterConfig) ?? undefined,
);
```

- [x] **Step 4: 场景加载时归一化参数配置和值**

在 `src/editor/project/SceneSerializer.ts` 中确认导入：

```ts
import { createDefaultModelParameterValues, normalizeModelParameterConfig, sanitizeModelParameterValues } from '../model/modelParameters';
```

并在 `normalizeModelAsset()` 中确认：

```ts
const parameterConfig = normalizeModelParameterConfig(modelAsset.parameterConfig);
const parameterValues = parameterConfig
  ? 'parameterValues' in modelAsset
    ? sanitizeModelParameterValues(parameterConfig, modelAsset.parameterValues)
    : createDefaultModelParameterValues(parameterConfig)
  : undefined;

return {
  sourcePath,
  sourceUrl,
  lengthUnit: unitInfo.lengthUnit,
  unitScaleToMeters: unitInfo.unitScaleToMeters,
  ...(parameterConfig ? { parameterConfig, parameterValues } : {}),
};
```

- [x] **Step 5: 静态检查**

Run:

```bash
git diff -- src/editor/model/components.ts src/editor/model/SceneDocument.ts src/editor/store/editorStore.ts src/editor/project/SceneSerializer.ts
```

Expected: 模型实体保存 `parameterConfig` 快照和 `parameterValues` 实例值；旧场景缺少参数字段仍可加载为普通模型。

### Task 4: 接入参数值撤销/重做与实时 preview

**Files:**
- Modify: `src/editor/commands/entityCommands.ts`
- Modify: `src/editor/store/editorStore.ts`

- [x] **Step 1: 增加参数值更新命令**

在 `src/editor/commands/entityCommands.ts` 中确认导入：

```ts
import type { ModelParameterValues } from '../model/modelParameters';
```

并确认导出命令：

```ts
export function updateModelParameterValuesCommand(
  entityId: string,
  before: ModelParameterValues,
  after: ModelParameterValues,
): EditorCommand {
  return {
    label: '更新模型参数',
    execute: (scene) => updateModelParameterValues(scene, entityId, after),
    undo: (scene) => updateModelParameterValues(scene, entityId, before),
  };
}
```

- [x] **Step 2: 增加不可变更新 helper**

同一文件中确认包含：

```ts
function updateModelParameterValues(
  scene: SceneDocument,
  entityId: string,
  parameterValues: ModelParameterValues,
): SceneDocument {
  const entity = scene.entities[entityId];
  const modelAsset = entity?.components.modelAsset;
  if (!entity || !modelAsset?.parameterConfig) return scene;

  return {
    ...scene,
    entities: {
      ...scene.entities,
      [entityId]: {
        ...entity,
        components: {
          ...entity.components,
          modelAsset: {
            ...modelAsset,
            parameterValues,
          },
        },
      },
    },
  };
}
```

- [x] **Step 3: EditorState 增加三个参数方法**

在 `src/editor/store/editorStore.ts` 的 `EditorState` 中确认包含：

```ts
updateSelectedModelParameterValue: (key: string, value: ModelParameterValue) => void;
previewSelectedModelParameterValue: (key: string, value: ModelParameterValue) => void;
commitSelectedModelParameterValues: (before: ModelParameterValues, after: ModelParameterValues) => void;
```

- [x] **Step 4: 增加 selected 参数 helper**

同一文件中确认包含：

```ts
function getSelectedModelParameterValues(state: EditorState): ModelParameterValues | null {
  const modelAsset = getSelectedEntity(state)?.components.modelAsset;
  if (!modelAsset?.parameterConfig) return null;

  return cloneModelParameterValues(modelAsset.parameterValues ?? {});
}

function patchModelParameterValue(
  values: ModelParameterValues,
  key: string,
  value: ModelParameterValue,
): ModelParameterValues {
  return {
    ...cloneModelParameterValues(values),
    [key]: value,
  };
}

function sanitizeSelectedModelParameterValue(
  state: EditorState,
  key: string,
  value: ModelParameterValue,
): ModelParameterValue | null {
  const modelAsset = getSelectedEntity(state)?.components.modelAsset;
  const definition = findModelParameterDefinition(modelAsset?.parameterConfig, key);
  if (!definition) return null;

  return sanitizeModelParameterValue(definition, value);
}
```

- [x] **Step 5: 实现 updateSelectedModelParameterValue**

同一文件 store 实现中确认包含：

```ts
updateSelectedModelParameterValue: (key, value) => {
  set((state) => {
    const entity = getSelectedEntity(state);
    const modelAsset = entity?.components.modelAsset;
    if (!entity || !modelAsset?.parameterConfig) return state;

    const sanitizedValue = sanitizeSelectedModelParameterValue(state, key, value);
    if (sanitizedValue === null) return state;

    const before = getSelectedModelParameterValues(state);
    if (!before) return state;

    const after = patchModelParameterValue(before, key, sanitizedValue);
    if (areModelParameterValuesEqual(before, after)) return state;

    const command = updateModelParameterValuesCommand(entity.id, before, after);
    const result = executeCommand(state.scene, state.history, command);

    return {
      ...result,
      logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
    };
  });
},
```

- [x] **Step 6: 实现 previewSelectedModelParameterValue**

同一文件 store 实现中确认包含直接改场景但不写 history 的 preview：

```ts
previewSelectedModelParameterValue: (key, value) => {
  set((state) => {
    const entity = getSelectedEntity(state);
    const modelAsset = entity?.components.modelAsset;
    if (!entity || !modelAsset?.parameterConfig) return state;

    const sanitizedValue = sanitizeSelectedModelParameterValue(state, key, value);
    if (sanitizedValue === null) return state;

    const before = getSelectedModelParameterValues(state);
    if (!before) return state;

    const after = patchModelParameterValue(before, key, sanitizedValue);
    if (areModelParameterValuesEqual(before, after)) return state;

    return {
      scene: {
        ...state.scene,
        entities: {
          ...state.scene.entities,
          [entity.id]: {
            ...entity,
            components: {
              ...entity.components,
              modelAsset: {
                ...modelAsset,
                parameterValues: after,
              },
            },
          },
        },
      },
    };
  });
},
```

- [x] **Step 7: 实现 commitSelectedModelParameterValues**

同一文件 store 实现中确认包含：

```ts
commitSelectedModelParameterValues: (before, after) => {
  if (areModelParameterValuesEqual(before, after)) return;

  set((state) => {
    const entity = getSelectedEntity(state);
    const modelAsset = entity?.components.modelAsset;
    if (!entity || !modelAsset?.parameterConfig) return state;

    const sanitizedBefore = sanitizeModelParameterValues(modelAsset.parameterConfig, before);
    const sanitizedAfter = sanitizeModelParameterValues(modelAsset.parameterConfig, after);
    if (areModelParameterValuesEqual(sanitizedBefore, sanitizedAfter)) return state;

    const command = updateModelParameterValuesCommand(entity.id, sanitizedBefore, sanitizedAfter);
    const result = executeCommand(state.scene, state.history, command);

    return {
      ...result,
      logs: prependLog(state.logs, `${command.label}: ${entity.name}`),
    };
  });
},
```

- [x] **Step 8: 静态检查**

Run:

```bash
git diff -- src/editor/commands/entityCommands.ts src/editor/store/editorStore.ts
```

Expected: `previewSelectedModelParameterValue` 不写 command history；`updateSelectedModelParameterValue` 和 `commitSelectedModelParameterValues` 写入撤销/重做命令。

### Task 5: Inspector 展示模型参数表单

**Files:**
- Create/Modify: `src/editor/panels/ModelParametersInspector.tsx`
- Modify: `src/editor/panels/InspectorPanel.tsx`
- Modify: `src/styles/global.css`

- [x] **Step 1: 创建或确认 ModelParametersInspector props 与基础 helper**

`src/editor/panels/ModelParametersInspector.tsx` 应包含：

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelAssetComponent } from '../model/components';
import type {
  ModelParameterDefinition,
  ModelParameterValue,
  ModelParameterValues,
  ModelVector3ParameterDefinition,
} from '../model/modelParameters';
import {
  cloneModelParameterValues,
  createDefaultModelParameterValues,
  sanitizeModelParameterValue,
} from '../model/modelParameters';
import type { Vector3Data } from '../model/math';
import { useEditorStore } from '../store/editorStore';

type ModelParametersInspectorProps = {
  modelAsset: ModelAssetComponent;
};

type DraftValues = Record<string, string>;

const axes: Array<keyof Vector3Data> = ['x', 'y', 'z'];

function isVector3Value(value: ModelParameterValue | undefined): value is Vector3Data {
  return typeof value === 'object' && value !== null && 'x' in value && 'y' in value && 'z' in value;
}

function getParameterValues(modelAsset: ModelAssetComponent): ModelParameterValues {
  if (!modelAsset.parameterConfig) return {};
  return modelAsset.parameterValues ?? createDefaultModelParameterValues(modelAsset.parameterConfig);
}
```

- [x] **Step 2: 实现连续编辑生命周期**

同一组件内应包含：

```tsx
const updateSelectedModelParameterValue = useEditorStore((state) => state.updateSelectedModelParameterValue);
const previewSelectedModelParameterValue = useEditorStore((state) => state.previewSelectedModelParameterValue);
const commitSelectedModelParameterValues = useEditorStore((state) => state.commitSelectedModelParameterValues);
const [draftValues, setDraftValues] = useState<DraftValues>({});
const beforeEditValuesRef = useRef<ModelParameterValues | null>(null);

const config = modelAsset.parameterConfig;
const values = getParameterValues(modelAsset);

useEffect(() => {
  setDraftValues({});
  beforeEditValuesRef.current = null;
}, [modelAsset.sourcePath, config]);

function beginContinuousEdit() {
  if (!beforeEditValuesRef.current) {
    beforeEditValuesRef.current = cloneModelParameterValues(values);
  }
}

function commitContinuousEdit() {
  const before = beforeEditValuesRef.current;
  if (!before) return;

  beforeEditValuesRef.current = null;
  setDraftValues({});
  commitSelectedModelParameterValues(before, cloneModelParameterValues(values));
}

function cancelContinuousEdit() {
  const before = beforeEditValuesRef.current;
  if (!before) return;

  beforeEditValuesRef.current = null;
  setDraftValues({});
  for (const [key, value] of Object.entries(before)) {
    previewSelectedModelParameterValue(key, value);
  }
}

function handleContinuousKeyDown(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') {
    event.currentTarget.blur();
    return;
  }

  if (event.key === 'Escape') {
    cancelContinuousEdit();
    event.currentTarget.blur();
  }
}

function previewValue(definition: ModelParameterDefinition, rawValue: unknown) {
  beginContinuousEdit();
  previewSelectedModelParameterValue(definition.key, sanitizeModelParameterValue(definition, rawValue));
}
```

- [x] **Step 3: 实现 number/color/boolean/enum 参数控件**

同一组件内应包含四类 renderer：

```tsx
function renderNumberParameter(definition: ModelParameterDefinition & { type: 'number' }) {
  const draftKey = getContinuousDraftKey(definition.key);
  const currentValue = values[definition.key];
  const draft = draftValues[draftKey] ?? formatValue(currentValue);

  return (
    <label className="number-row" key={definition.key}>
      <span>{definition.label}</span>
      <input
        type="number"
        min={definition.min}
        max={definition.max}
        step={definition.step ?? 0.1}
        value={draft}
        onBlur={commitContinuousEdit}
        onChange={(event) => {
          const rawValue = event.target.value;
          setDraftValues((drafts) => ({ ...drafts, [draftKey]: rawValue }));
          if (rawValue === '') return;

          const nextValue = Number(rawValue);
          if (Number.isFinite(nextValue)) previewValue(definition, nextValue);
        }}
        onFocus={beginContinuousEdit}
        onKeyDown={handleContinuousKeyDown}
      />
    </label>
  );
}

function renderColorParameter(definition: ModelParameterDefinition & { type: 'color' }) {
  return (
    <label className="inspector-row" key={definition.key}>
      <span>{definition.label}</span>
      <input
        type="color"
        value={formatValue(values[definition.key])}
        onBlur={commitContinuousEdit}
        onChange={(event) => previewValue(definition, event.target.value)}
        onFocus={beginContinuousEdit}
        onKeyDown={handleContinuousKeyDown}
      />
    </label>
  );
}

function renderBooleanParameter(definition: ModelParameterDefinition & { type: 'boolean' }) {
  return (
    <label className="inspector-row" key={definition.key}>
      <span>{definition.label}</span>
      <input
        type="checkbox"
        checked={values[definition.key] === true}
        onChange={(event) => updateSelectedModelParameterValue(definition.key, event.target.checked)}
      />
    </label>
  );
}

function renderEnumParameter(definition: ModelParameterDefinition & { type: 'enum' }) {
  return (
    <label className="inspector-row" key={definition.key}>
      <span>{definition.label}</span>
      <select
        value={formatValue(values[definition.key])}
        onChange={(event) => updateSelectedModelParameterValue(definition.key, event.target.value)}
      >
        {definition.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
```

- [x] **Step 4: 实现 vector3 参数控件**

同一组件内应包含：

```tsx
function renderVector3Parameter(definition: ModelVector3ParameterDefinition) {
  const currentValue = values[definition.key];

  return (
    <fieldset className="transform-fieldset model-parameter-vector" key={definition.key}>
      <legend>{definition.label}{definition.unit ? ` (${definition.unit})` : ''}</legend>
      {axes.map((axis) => {
        const draftKey = getContinuousDraftKey(definition.key, axis);
        const draft = draftValues[draftKey] ?? String(getVectorAxisValue(currentValue, axis));

        return (
          <label className="number-row" key={draftKey}>
            <span>{axis.toUpperCase()}</span>
            <input
              type="number"
              min={definition.min}
              max={definition.max}
              step={definition.step ?? 0.1}
              value={draft}
              onBlur={commitContinuousEdit}
              onChange={(event) => {
                const rawValue = event.target.value;
                setDraftValues((drafts) => ({ ...drafts, [draftKey]: rawValue }));
                if (rawValue === '') return;

                const nextAxisValue = Number(rawValue);
                if (!Number.isFinite(nextAxisValue)) return;

                const vectorValue: Vector3Data = isVector3Value(currentValue)
                  ? { ...currentValue, [axis]: nextAxisValue }
                  : { ...definition.defaultValue, [axis]: nextAxisValue };
                previewValue(definition, vectorValue);
              }}
              onFocus={beginContinuousEdit}
              onKeyDown={handleContinuousKeyDown}
            />
          </label>
        );
      })}
    </fieldset>
  );
}
```

- [x] **Step 5: 实现 texture 参数控件**

同一组件内应包含：

```tsx
function renderTextureParameter(definition: ModelParameterDefinition & { type: 'texture' }) {
  if (definition.options?.length) {
    return (
      <label className="inspector-row" key={definition.key}>
        <span>{definition.label}</span>
        <select
          value={formatValue(values[definition.key])}
          onChange={(event) => updateSelectedModelParameterValue(definition.key, event.target.value)}
        >
          {definition.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="inspector-row" key={definition.key}>
      <span>{definition.label}</span>
      <input
        type="text"
        value={formatValue(values[definition.key])}
        onChange={(event) => updateSelectedModelParameterValue(definition.key, event.target.value)}
      />
    </label>
  );
}
```

- [x] **Step 6: 输出模型参数 fieldset**

组件结尾应包含：

```tsx
function renderParameter(definition: ModelParameterDefinition) {
  if (definition.type === 'number') return renderNumberParameter(definition);
  if (definition.type === 'color') return renderColorParameter(definition);
  if (definition.type === 'boolean') return renderBooleanParameter(definition);
  if (definition.type === 'enum') return renderEnumParameter(definition);
  if (definition.type === 'vector3') return renderVector3Parameter(definition);
  return renderTextureParameter(definition);
}

return (
  <fieldset className="transform-fieldset">
    <legend>模型参数</legend>
    {config.parameters.map(renderParameter)}
  </fieldset>
);
```

- [x] **Step 7: InspectorPanel 接入模型参数组件**

在 `src/editor/panels/InspectorPanel.tsx` 中确认导入：

```ts
import { ModelParametersInspector } from './ModelParametersInspector';
```

在 `modelAsset` 分支中确认包含：

```tsx
{modelAsset ? (
  <>
    <fieldset className="transform-fieldset">
      <legend>Model Asset</legend>
      <p className="muted asset-path" title={modelAsset.sourcePath}>{modelAsset.sourcePath}</p>
      <p className="muted">源单位：{formatModelLengthUnit(modelAsset.lengthUnit)}</p>
      <p className="muted">换算到米：×{modelAsset.unitScaleToMeters}</p>
    </fieldset>
    <ModelParametersInspector modelAsset={modelAsset} />
  </>
) : null}
```

- [x] **Step 8: 样式检查**

确认 `src/styles/global.css` 中已有 `.inspector-row`、`.number-row`、`.transform-fieldset` 样式。若 `vector3` 参数行过挤，新增最小样式：

```css
.model-parameter-vector {
  gap: 6px;
}
```

- [x] **Step 9: 静态检查**

Run:

```bash
git diff -- src/editor/panels/ModelParametersInspector.tsx src/editor/panels/InspectorPanel.tsx src/styles/global.css
```

Expected: Inspector 只在导入模型实体上展示模型参数；基础 Mesh、Light 不出现“模型参数”。

### Task 6: SceneRuntime 实时应用参数绑定

**Files:**
- Modify: `src/runtime/babylon/SceneRuntime.ts`

- [x] **Step 1: 确认 ModelRuntimeEntry 记录参数 baseline 与贴图缓存**

在 `SceneRuntime.ts` 中确认类型包含：

```ts
type ModelRuntimeEntry = {
  sourceUrl: string;
  root: TransformNode;
  contentRoot: TransformNode;
  container: AssetContainer | null;
  meshes: AbstractMesh[];
  highlighted: boolean;
  loadToken: number;
  parameterSignature: string;
  parameterBaseline: Map<string, ModelParameterBaselineValue>;
  textureCache: Map<string, Texture>;
};

type ModelParameterRuntimeTarget = AbstractMesh | TransformNode | Material;
type ModelParameterBaselineValue = boolean | number | string | Vector3Data | Texture | null;
```

- [x] **Step 2: 模型同步时调用 applyModelParameters**

在模型加载完成和场景同步路径中确认调用：

```ts
this.applyModelParameters(entity, current);
```

Expected: 模型初次加载完成后应用参数；后续 `parameterValues` 变化时再次应用参数。

- [x] **Step 3: 实现 applyModelParameters**

确认包含：

```ts
private applyModelParameters(entity: Entity, model: ModelRuntimeEntry): void {
  const modelAsset = entity.components.modelAsset;
  if (!modelAsset?.parameterConfig || !modelAsset.parameterValues || !model.container) return;

  const signature = JSON.stringify({ config: modelAsset.parameterConfig, values: modelAsset.parameterValues });
  if (model.parameterSignature === signature) return;
  model.parameterSignature = signature;

  this.resetModelParameterTargets(model);

  for (const binding of modelAsset.parameterConfig.bindings) {
    this.applyModelParameterBinding(binding, modelAsset.parameterValues, modelAsset, model);
  }

  for (const rule of modelAsset.parameterConfig.rules ?? []) {
    if (this.evaluateBooleanExpression(rule.when, modelAsset.parameterValues)) {
      for (const binding of rule.set) {
        this.applyModelParameterBinding(binding, modelAsset.parameterValues, modelAsset, model);
      }
    }
  }
}
```

- [x] **Step 4: 实现 target 解析**

确认包含：

```ts
private resolveModelParameterTargets(binding: ModelParameterBinding, model: ModelRuntimeEntry): ModelParameterRuntimeTarget[] {
  if (binding.target.kind === 'material') {
    const materials = new Map<string, Material>();
    for (const mesh of model.meshes) {
      if (mesh.material?.name === binding.target.name) materials.set(mesh.material.uniqueId.toString(), mesh.material);
    }
    return [...materials.values()];
  }

  if (binding.target.kind === 'mesh') {
    return model.meshes.filter((mesh) => mesh.name === binding.target.name);
  }

  return (model.container?.transformNodes ?? []).filter((node) => node.name === binding.target.name);
}
```

- [x] **Step 5: 实现 baseline 记录与恢复**

确认 `rememberModelParameterBaseline()` 对不同 target 正确收窄：

```ts
if (property === 'visible') {
  if (target instanceof AbstractMesh) {
    model.parameterBaseline.set(key, target.isVisible);
    return;
  }

  if (target instanceof TransformNode) {
    model.parameterBaseline.set(key, target.isEnabled());
  }
  return;
}
```

同时确认 `restoreModelParameterBaseline()` 包含：

```ts
if (property === 'visible' && typeof value === 'boolean') {
  if (target instanceof AbstractMesh) target.isVisible = value;
  if (target instanceof TransformNode) target.setEnabled(value);
  return;
}

if ((property === 'position' || property === 'rotation' || property === 'scaling') && this.isVector3Value(value) && target instanceof TransformNode) {
  target[property] = new Vector3(value.x, value.y, value.z);
  return;
}

if ((property === 'baseColor' || property === 'emissiveColor') && typeof value === 'string' && target instanceof Material) {
  this.applyMaterialColor(target, property, value);
  return;
}

if (property === 'alpha' && typeof value === 'number' && target instanceof Material) {
  target.alpha = value;
  return;
}

if (property === 'baseTexture' && target instanceof Material) {
  this.applyMaterialTexture(target, value instanceof Texture ? value : null);
}
```

- [x] **Step 6: 实现参数值应用**

确认 `applyModelParameterValueToTarget()` 包含：

```ts
if (property === 'visible') {
  if (typeof value !== 'boolean') return;
  if (target instanceof AbstractMesh) target.isVisible = value;
  if (target instanceof TransformNode) target.setEnabled(value);
  return;
}

if (property === 'position' || property === 'rotation' || property === 'scaling') {
  if (!this.isVector3Value(value) || !(target instanceof TransformNode)) return;
  target[property] = new Vector3(value.x, value.y, value.z);
  return;
}

if (property === 'baseColor' || property === 'emissiveColor') {
  if (typeof value !== 'string' || !(target instanceof Material)) return;
  this.applyMaterialColor(target, property, value);
  return;
}

if (property === 'alpha') {
  if (typeof value !== 'number' || !(target instanceof Material)) return;
  target.alpha = Math.min(1, Math.max(0, value));
  return;
}

if (property === 'baseTexture') {
  if (typeof value !== 'string' || !(target instanceof Material)) return;
  const texture = this.loadOrReuseTexture(value, modelAsset, model);
  if (texture) this.applyMaterialTexture(target, texture);
}
```

- [x] **Step 7: 实现表达式求值**

确认 `evaluateModelExpression()` 支持：

```ts
if (typeof expression === 'number') return Number.isFinite(expression) ? expression : null;
if (typeof expression === 'string' || typeof expression === 'boolean') return expression;
if (this.isVector3Value(expression)) return expression;

if ('param' in expression) {
  return values[expression.param] ?? null;
}

if ('vector3' in expression) {
  const [x, y, z] = expression.vector3.map((item) => this.evaluateModelExpression(item, values));
  return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? { x, y, z } : null;
}
```

并确认 `op` 分支支持 `add/sub/mul/div/min/max/clamp/lerp/eq/neq/gt/gte/lt/lte/and/or/not/if`。

- [x] **Step 8: 确认 Vector3 type guard 接收 unknown**

为避免 baseline 中的 Babylon `Texture` 触发类型错误，确认签名为：

```ts
private isVector3Value(value: unknown): value is Vector3Data {
```

- [x] **Step 9: 确认材质与贴图应用**

确认 `applyMaterialTexture()` 同时支持 StandardMaterial 与 PBRMaterial：

```ts
private applyMaterialTexture(material: Material, texture: Texture | null): void {
  if (material instanceof StandardMaterial) {
    material.diffuseTexture = texture;
    return;
  }

  if (material instanceof PBRMaterial) {
    material.albedoTexture = texture;
  }
}
```

贴图加载应使用模型包路径和缓存，不允许外部 URL。

- [x] **Step 10: 静态检查**

Run:

```bash
git diff -- src/runtime/babylon/SceneRuntime.ts
```

Expected: runtime 不执行任意脚本；目标找不到或类型不匹配时跳过；baseline 恢复在每次参数应用前执行。

### Task 7: 更新 README 和示例说明

**Files:**
- Modify: `README.md`

- [x] **Step 1: 当前功能加入参数化模型说明**

在 `## 当前功能` 中确认包含：

```markdown
- 参数化模型：模型包 `meta.json.modelParameters` 可声明 number、color、boolean、enum、vector3、texture 参数，以及绑定到模型节点、网格或材质的安全 JSON DSL；选中带参数配置的导入模型后，Inspector 会显示“模型参数”区域，修改参数会通过场景文档实时驱动 Babylon 模型外观变化，并支持随场景保存/加载与撤销/重做。
```

- [x] **Step 2: 基础操作加入参数编辑说明**

在 `## 基础操作` 的编辑属性条目中确认包含：

```markdown
- 编辑属性：在 Inspector 中修改名称、Transform、材质颜色或灯光属性；选中带 `modelParameters` 的导入模型时，可在“模型参数”中编辑尺寸、颜色、显隐、规格、向量偏移或贴图等参数，场景外观会实时更新。
```

- [x] **Step 3: 场景文件说明加入参数持久化**

在 `## 场景文件说明` 中确认包含：

```markdown
- 带参数化配置的模型实体会额外保存 `modelAsset.parameterConfig` 与 `modelAsset.parameterValues`：前者是从模型包 `meta.json.modelParameters` 归一化得到的参数 schema 与 binding 快照，后者是当前场景实例的参数值。旧场景缺少这些字段时仍按普通导入模型兼容加载。
```

- [x] **Step 4: 当前限制加入安全边界**

在 `## 当前限制` 中确认包含：

```markdown
- 参数化模型依赖模型包中稳定的节点、网格或材质名称；安全 DSL 只支持 JSON AST 中的白名单运算和白名单属性绑定，不执行任意 JavaScript/TypeScript。贴图参数只允许模型包内 `.png`、`.jpg`、`.jpeg`、`.webp` 相对路径，不支持绝对路径、网络 URL、`data:` 或 `../` 路径逃逸。
```

- [x] **Step 5: 最近完成加入记录**

在 `## 最近完成` 顶部确认包含：

```markdown
- 2026-06-30：导入模型新增参数化配置链路，支持读取 `meta.json.modelParameters`，在 Inspector 展示 number、color、boolean、enum、vector3、texture 参数，并通过安全 JSON DSL 实时驱动模型节点、网格、材质和贴图外观变化。
```

- [x] **Step 6: README 静态检查**

Run:

```bash
git diff -- README.md
```

Expected: README 说明当前真实能力，不承诺脚本执行、贴图选择器、远程 URL 或高级动画绑定。

### Task 8: 最终验证

**Files:**
- Verify all files above

- [x] **Step 1: 运行 TypeScript 类型检查**

Run:

```bash
npm run typecheck
```

Expected: `tsc -b` 通过，退出码为 0。

- [x] **Step 2: 运行 diff 空白检查**

Run:

```bash
git diff --check -- src/editor/model/modelParameters.ts electron/types.ts electron/ipc/modelPackageScanner.ts electron/ipc/projectAssetStore.ts src/vite-env.d.ts src/editor/assets/AssetDatabase.ts src/editor/model/components.ts src/editor/model/SceneDocument.ts src/editor/project/SceneSerializer.ts src/editor/commands/entityCommands.ts src/editor/store/editorStore.ts src/editor/panels/InspectorPanel.tsx src/editor/panels/ModelParametersInspector.tsx src/runtime/babylon/SceneRuntime.ts README.md docs/superpowers/specs/2026-06-30-imported-model-parameters-design.md docs/superpowers/plans/2026-06-30-imported-model-parameters.md
```

Expected: 不出现 whitespace error；Windows LF/CRLF warning 不视为失败。

- [x] **Step 3: 静态关键词检查**

Run:

```bash
rg -n "modelParameters|parameterConfig|parameterValues|ModelParametersInspector|applyModelParameters" src electron README.md
```

Expected: 关键词覆盖 Electron 扫描、资产解码、SceneDocument/store/serializer、Inspector、SceneRuntime 和 README。

- [x] **Step 4: 安全边界检查**

Run:

```bash
rg -n "eval\(|new Function|import\(|https?://|data:image|\.\.\/" src/editor src/runtime electron
```

Expected: 参数化模型实现中不出现 `eval(` 或 `new Function`；如果搜到 `import(`、URL 或 `../`，确认不是参数化模型贴图执行路径。

- [x] **Step 5: 可选手工验证**

如果需要实际观察 UI，准备一个模型包 `meta.json`：

```json
{
  "displayName": "参数化示例设备",
  "lengthUnit": "meter",
  "modelParameters": {
    "schema": "babylon-editor.model-parameters",
    "version": 1,
    "parameters": [
      { "key": "bodyColor", "label": "主体颜色", "type": "color", "defaultValue": "#2f80ed" },
      { "key": "height", "label": "高度", "type": "number", "defaultValue": 1, "min": 0.5, "max": 3, "step": 0.1 },
      { "key": "visible", "label": "显示主体", "type": "boolean", "defaultValue": true }
    ],
    "bindings": [
      {
        "target": { "kind": "material", "name": "BodyMaterial" },
        "property": "baseColor",
        "value": { "param": "bodyColor" }
      },
      {
        "target": { "kind": "mesh", "name": "Body" },
        "property": "scaling",
        "value": { "vector3": [1, { "param": "height" }, 1] }
      },
      {
        "target": { "kind": "mesh", "name": "Body" },
        "property": "visible",
        "value": { "param": "visible" }
      }
    ]
  }
}
```

启动 Electron：

```bash
npm run dev:electron
```

Expected:

- 导入模型文件夹后模型卡片可见。
- 点击卡片导入场景。
- 选中模型后 Inspector 显示“模型参数”。
- 修改颜色，模型材质颜色实时变化。
- 修改高度，模型缩放实时变化。
- 切换显示主体，模型显隐实时变化。
- 撤销/重做可以回退/恢复参数值。
- 保存并重新加载场景后参数值保留。

验证记录：

- `npm run typecheck` 已执行，`tsc -b` 通过。
- `git diff --check -- src electron README.md docs/superpowers/specs/2026-06-30-imported-model-parameters-design.md docs/superpowers/plans/2026-06-30-imported-model-parameters.md` 已执行，只有 Windows LF/CRLF warning，没有 whitespace error。
- 静态关键词检查已执行，`modelParameters|parameterConfig|parameterValues|ModelParametersInspector|applyModelParameters` 在 Electron、renderer、runtime、Inspector 和文档链路中均有覆盖。
- 未启动 `npm run dev:electron` 做 UI 手工验证；该步骤保留为可选人工验收流程。

## 自审记录

- 规格覆盖：计划覆盖 schema、Electron 扫描、资产索引、renderer 归一化、实体创建、场景持久化、Inspector 表单、撤销/重做、运行时绑定、安全边界、README 和验证。
- 占位扫描：本文没有未完成标记、待补内容或含糊占位句。
- 类型一致性：`parameterConfig`、`parameterValues`、`ModelParameterConfig`、`ModelParameterValues`、`ModelParametersInspector`、`applyModelParameters` 命名与规格一致。
- 提交策略：当前会话未收到显式 git commit 请求，因此计划不包含提交步骤。
