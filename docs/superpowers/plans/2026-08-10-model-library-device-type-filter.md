# Model Library Device Type Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为数字孪生编辑器 Project 模型库增加基于模型包 `deviceType` 的下拉筛选，并与现有名称筛选组合生效。

**Architecture:** 新增一个无 UI、无文件读取依赖的纯函数模块，从现有 `parameterScriptMetadata` 安全提取设备类型并生成选项；`ProjectPanel` 只负责筛选状态、组合条件和控件渲染。保持 `AssetEntry`、Electron IPC、资产索引和模型包格式不变，现有模型无需重新导入。

**Tech Stack:** React 19、TypeScript、原生 `select`、Node.js `node:test`、CSS。

---

## 文件结构

- Create: `src/editor/assets/modelLibraryDeviceTypeFilter.ts`
  - 安全读取 `parameterScriptMetadata`。
  - 提取模型 `deviceType`。
  - 生成去重、中文排序后的类型选项。
  - 判断资源卡片是否匹配选中的设备类型。
- Create: `tests/digitalTwin/modelLibraryDeviceTypeFilter.test.ts`
  - 覆盖元数据提取、优先级、非法输入、去重排序和无类型卡片排除。
- Modify: `tests/digitalTwin/projectLibraryTabs.test.ts`
  - 增加 ProjectPanel 类型筛选 UI、状态重置、组合筛选和样式契约测试。
- Modify: `src/editor/panels/ProjectPanel.tsx`
  - 增加类型筛选状态、选项、失效选择复位、AND 筛选和模型库专用下拉框。
- Modify: `src/styles/global.css`
  - 增加下拉框样式，并复用现有筛选输入框视觉规则。
- Modify: `README.md`
  - 在 Project 资源库能力说明中补充模型名称与设备类型组合筛选。

### Task 1: 实现设备类型提取与匹配纯函数

**Files:**
- Create: `tests/digitalTwin/modelLibraryDeviceTypeFilter.test.ts`
- Create: `src/editor/assets/modelLibraryDeviceTypeFilter.ts`

- [ ] **Step 1: 编写失败的纯函数测试**

创建 `tests/digitalTwin/modelLibraryDeviceTypeFilter.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createModelDeviceTypeOptions,
  getModelDeviceType,
  matchesModelDeviceType,
} from '../../src/editor/assets/modelLibraryDeviceTypeFilter.ts';

function createAsset(parameterScriptMetadata: unknown[]) {
  return { parameterScriptMetadata };
}

test('优先从 values.deviceType.value 提取模型类型', () => {
  const asset = createAsset([{
    values: { deviceType: { value: ' 输送 ' } },
    fields: [{ key: 'deviceType', defaultValue: '货物' }],
  }]);

  assert.equal(getModelDeviceType(asset), '输送');
});

test('values 缺失时从 deviceType 字段默认值提取模型类型', () => {
  const asset = createAsset([{
    fields: [{ key: 'deviceType', defaultValue: ' 多穿库 ' }],
  }]);

  assert.equal(getModelDeviceType(asset), '多穿库');
});

test('跳过非法和空白元数据并读取第一个有效类型', () => {
  const asset = createAsset([
    null,
    { values: { deviceType: { value: '   ' } } },
    { fields: [{ key: 'deviceType', defaultValue: 12 }] },
    { values: { deviceType: { value: '堆垛机' } } },
  ]);

  assert.equal(getModelDeviceType(asset), '堆垛机');
  assert.equal(getModelDeviceType({}), null);
});

test('类型选项去除空值、去重并按中文顺序排列', () => {
  const assets = [
    createAsset([{ values: { deviceType: { value: '输送' } } }]),
    createAsset([{ fields: [{ key: 'deviceType', defaultValue: '多穿库' }] }]),
    createAsset([{ values: { deviceType: { value: '输送' } } }]),
    createAsset([{ values: { deviceType: { value: '堆垛机' } } }]),
    createAsset([]),
  ];

  assert.deepEqual(createModelDeviceTypeOptions(assets), ['堆垛机', '多穿库', '输送']);
});

test('具体类型只匹配声明了相同 deviceType 的模型卡片', () => {
  const importedModel = {
    name: '辊道机',
    asset: {
      kind: 'model',
      parameterScriptMetadata: [{ values: { deviceType: { value: '输送' } } }],
    },
  };
  const unclassifiedModel = { name: '普通模型', asset: { kind: 'model' } };
  const builtInModel = { name: '立方体', builtIn: { kind: 'mesh', meshKind: 'cube' } };

  assert.equal(matchesModelDeviceType(importedModel, ''), true);
  assert.equal(matchesModelDeviceType(importedModel, '输送'), true);
  assert.equal(matchesModelDeviceType(importedModel, '多穿库'), false);
  assert.equal(matchesModelDeviceType(unclassifiedModel, '输送'), false);
  assert.equal(matchesModelDeviceType(builtInModel, '输送'), false);
});
```

- [ ] **Step 2: 运行测试并确认因模块缺失而失败**

Run:

```powershell
node --experimental-strip-types --test tests/digitalTwin/modelLibraryDeviceTypeFilter.test.ts
```

Expected: FAIL，错误包含无法找到 `modelLibraryDeviceTypeFilter.ts`。

- [ ] **Step 3: 编写最小纯函数实现**

创建 `src/editor/assets/modelLibraryDeviceTypeFilter.ts`：

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function getScriptDeviceType(script: unknown): string | null {
  if (!isRecord(script)) return null;

  if (isRecord(script.values)) {
    const deviceType = script.values.deviceType;
    if (isRecord(deviceType)) {
      const currentValue = readNonEmptyString(deviceType.value);
      if (currentValue) return currentValue;
    }
  }

  if (!Array.isArray(script.fields)) return null;
  for (const field of script.fields) {
    if (!isRecord(field) || field.key !== 'deviceType') continue;
    const defaultValue = readNonEmptyString(field.defaultValue);
    if (defaultValue) return defaultValue;
  }

  return null;
}

/** 从模型包参数脚本元数据中读取第一个有效设备类型。 */
export function getModelDeviceType(asset: unknown): string | null {
  if (!isRecord(asset) || !Array.isArray(asset.parameterScriptMetadata)) return null;

  for (const script of asset.parameterScriptMetadata) {
    const deviceType = getScriptDeviceType(script);
    if (deviceType) return deviceType;
  }

  return null;
}

/** 生成模型库设备类型选项，空值不进入下拉框。 */
export function createModelDeviceTypeOptions(assets: readonly unknown[]): string[] {
  const deviceTypes = new Set<string>();
  for (const asset of assets) {
    const deviceType = getModelDeviceType(asset);
    if (deviceType) deviceTypes.add(deviceType);
  }

  return [...deviceTypes].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

/** “全部类型”匹配所有卡片；具体类型只匹配声明了相同类型的模型资产。 */
export function matchesModelDeviceType(item: unknown, selectedDeviceType: string): boolean {
  const normalizedSelection = selectedDeviceType.trim();
  if (!normalizedSelection) return true;
  if (!isRecord(item) || !isRecord(item.asset) || item.asset.kind !== 'model') return false;

  return getModelDeviceType(item.asset) === normalizedSelection;
}
```

- [ ] **Step 4: 运行纯函数测试并确认通过**

Run:

```powershell
node --experimental-strip-types --test tests/digitalTwin/modelLibraryDeviceTypeFilter.test.ts
```

Expected: 5 tests PASS，0 failures。

- [ ] **Step 5: 提交纯函数与测试**

```powershell
git add -- src/editor/assets/modelLibraryDeviceTypeFilter.ts tests/digitalTwin/modelLibraryDeviceTypeFilter.test.ts
git commit -m "feat: add model device type filter helpers"
```

### Task 2: 将类型筛选接入 Project 模型库

**Files:**
- Modify: `tests/digitalTwin/projectLibraryTabs.test.ts`
- Modify: `src/editor/panels/ProjectPanel.tsx`
- Modify: `src/styles/global.css`

- [ ] **Step 1: 为 ProjectPanel 类型筛选契约编写失败测试**

在 `tests/digitalTwin/projectLibraryTabs.test.ts` 顶部增加：

```ts
const GLOBAL_STYLE_PATH = 'src/styles/global.css';
```

追加测试：

```ts
test('模型库提供 deviceType 下拉筛选并与名称筛选组合生效', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');
  const styles = readFileSync(GLOBAL_STYLE_PATH, 'utf8');

  assert.ok(source.includes("from '../assets/modelLibraryDeviceTypeFilter'"));
  assert.ok(source.includes("const [modelDeviceTypeFilter, setModelDeviceTypeFilter] = useState('')"));
  assert.ok(source.includes('createModelDeviceTypeOptions(modelAssets)'));
  assert.ok(source.includes("activeLibrary.key === 'model' && !modelDeviceTypes.includes(modelDeviceTypeFilter)"));
  assert.ok(source.includes('matchesModelDeviceType(item, modelDeviceTypeFilter)'));
  assert.ok(source.includes('id="project-library-model-type"'));
  assert.ok(source.includes('<option value="">全部类型</option>'));
  assert.ok(source.includes('未找到符合当前筛选条件的资源'));
  assert.match(styles, /\.project-library \.library-filter-select/);
});

test('切换资源库或聚焦模型卡片时重置模型类型筛选', () => {
  const source = readFileSync(PROJECT_PANEL_PATH, 'utf8');

  const resetCalls = source.match(/setModelDeviceTypeFilter\(''\)/g) ?? [];
  assert.ok(resetCalls.length >= 2, 'Tab 切换和模型聚焦至少各有一次类型重置');
});
```

- [ ] **Step 2: 运行契约测试并确认失败**

Run:

```powershell
node --experimental-strip-types --test tests/digitalTwin/projectLibraryTabs.test.ts
```

Expected: 新增的两个测试 FAIL，现有测试保持 PASS。

- [ ] **Step 3: 在 ProjectPanel 引入纯函数并增加筛选状态**

在 `src/editor/panels/ProjectPanel.tsx` 的资源库 import 后增加：

```ts
import {
  createModelDeviceTypeOptions,
  matchesModelDeviceType,
} from '../assets/modelLibraryDeviceTypeFilter';
```

在名称筛选状态后增加：

```ts
const [modelDeviceTypeFilter, setModelDeviceTypeFilter] = useState('');
```

在 `modelAssets` 后增加类型选项：

```ts
const modelDeviceTypes = useMemo(
  () => createModelDeviceTypeOptions(modelAssets),
  [modelAssets],
);
```

- [ ] **Step 4: 增加失效类型复位和 AND 筛选逻辑**

在 `activeLibrary` 的 `useMemo` 声明之后增加，确保依赖数组读取状态时变量已经初始化：

```ts
useEffect(() => {
  if (
    activeLibrary.key === 'model'
    && modelDeviceTypeFilter
    && !modelDeviceTypes.includes(modelDeviceTypeFilter)
  ) {
    setModelDeviceTypeFilter('');
  }
}, [activeLibrary.key, modelDeviceTypeFilter, modelDeviceTypes]);
```

将现有 `filteredItems` 计算替换为：

```ts
const normalizedLibraryFilter = libraryFilterText.trim().toLowerCase();
const hasActiveLibraryFilter = Boolean(normalizedLibraryFilter)
  || (activeLibrary.key === 'model' && Boolean(modelDeviceTypeFilter));
const filteredItems = useMemo(() => {
  if (!hasActiveLibraryFilter) return activeItems;

  return activeItems.filter((item) => {
    const matchesName = !normalizedLibraryFilter
      || item.name.toLowerCase().includes(normalizedLibraryFilter)
      || (isSyncedImageProjectLibraryItem(item)
        && `${item.syncedImage.iconKey} ${item.syncedImage.category ?? ''}`
          .toLowerCase()
          .includes(normalizedLibraryFilter));
    if (!matchesName) return false;

    return activeLibrary.key !== 'model'
      || matchesModelDeviceType(item, modelDeviceTypeFilter);
  });
}, [
  activeItems,
  activeLibrary.key,
  hasActiveLibraryFilter,
  modelDeviceTypeFilter,
  normalizedLibraryFilter,
]);
```

- [ ] **Step 5: 在状态重置路径中清空类型筛选**

在场景模型聚焦 effect 的以下代码后：

```ts
setActiveLibraryKey('model');
setLibraryFilterText('');
```

增加：

```ts
setModelDeviceTypeFilter('');
```

在资源库 Tab 点击处理器中，将重置逻辑改为：

```ts
onClick={() => {
  setActiveLibraryKey(library.key);
  setLibraryFilterText('');
  setModelDeviceTypeFilter('');
}}
```

- [ ] **Step 6: 渲染模型类型下拉框并更新空状态**

在名称输入框之后增加：

```tsx
{activeLibrary.key === 'model' ? (
  <>
    <label className="library-filter-label" htmlFor="project-library-model-type">
      模型类型
    </label>
    <select
      className="library-filter-select"
      id="project-library-model-type"
      onChange={(event) => setModelDeviceTypeFilter(event.target.value)}
      value={modelDeviceTypeFilter}
    >
      <option value="">全部类型</option>
      {modelDeviceTypes.map((deviceType) => (
        <option key={deviceType} value={deviceType}>{deviceType}</option>
      ))}
    </select>
  </>
) : null}
```

将空状态判断和提示替换为：

```tsx
{filteredItems.length === 0 && hasActiveLibraryFilter ? (
  <p className="library-empty-state">未找到符合当前筛选条件的资源</p>
) : null}
```

- [ ] **Step 7: 增加与名称输入框一致的下拉框样式**

在 `src/styles/global.css` 中将输入框通用样式选择器改为：

```css
.project-library .library-filter-input,
.project-library .library-filter-select {
  height: 28px;
  padding: 0 10px;
  border: 1px solid #474747;
  color: #d7d7d7;
  background: #202020;
  outline: none;
}

.project-library .library-filter-input {
  width: 188px;
}

.project-library .library-filter-select {
  width: 132px;
}
```

保留现有 `.library-filter-input::placeholder` 规则不变。

- [ ] **Step 8: 运行 ProjectPanel 契约测试和纯函数测试**

Run:

```powershell
node --experimental-strip-types --test tests/digitalTwin/modelLibraryDeviceTypeFilter.test.ts tests/digitalTwin/projectLibraryTabs.test.ts
```

Expected: 11 tests PASS，0 failures。

- [ ] **Step 9: 运行 TypeScript 类型检查**

Run:

```powershell
npm run typecheck
```

Expected: exit code 0，无 TypeScript 错误。

- [ ] **Step 10: 提交 ProjectPanel 集成**

```powershell
git add -- src/editor/panels/ProjectPanel.tsx src/styles/global.css tests/digitalTwin/projectLibraryTabs.test.ts
git commit -m "feat: filter model library by device type"
```

### Task 3: 更新用户文档并完成回归验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 Project 资源库能力说明**

在 README 的 Project 资源库外观或模型库能力段落中补充：

```markdown
模型库支持按模型名称和模型包 `deviceType` 组合筛选；类型选项来自当前模型资产元数据，内置对象和未声明类型的模型仅在“全部类型”下显示。
```

不要修改模型包格式、资产同步协议或其他无关文档段落。

- [ ] **Step 2: 运行数字孪生单元测试**

Run:

```powershell
npm run test:digital-twin:unit
```

Expected: 所有 `tests/digitalTwin/*.test.ts` 测试 PASS。

- [ ] **Step 3: 再次运行类型检查**

Run:

```powershell
npm run typecheck
```

Expected: exit code 0，无 TypeScript 错误。

- [ ] **Step 4: 检查格式、差异和工作区状态**

Run:

```powershell
git diff --check
git diff --stat
git status --short
```

Expected:

- `git diff --check` 无错误。
- 差异只包含 README 文档更新；前两项任务的代码已经分别提交。
- 无临时脚本、构建产物或调试文件。

- [ ] **Step 5: 使用 code-reviewer 技能复核全部代码改动**

复核重点：

- 元数据防御式读取是否会抛异常。
- 名称和类型是否严格按 AND 关系执行。
- 图片库原有 `iconKey/category` 名称扩展搜索是否保留。
- Tab 切换、模型卡片聚焦和类型选项失效三条复位路径是否完整。
- 内置模型和无类型模型在具体类型下是否被排除。
- 未修改资产索引、IPC 或拖拽协议。

发现问题时先增加或调整失败测试，再做最小修复并重新运行相关验证。

- [ ] **Step 6: 提交文档更新**

```powershell
git add -- README.md
git commit -m "docs: document model type filtering"
```

- [ ] **Step 7: 最终验证提交状态**

Run:

```powershell
git status --short
git log -4 --oneline
```

Expected: 工作区干净，最近提交依次包含纯函数、ProjectPanel 集成和 README 更新。
