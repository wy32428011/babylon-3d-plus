# Model Folder Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为模型库添加“导入模型文件夹”能力，扫描 `F:\3d-models\models` 这类一级模型包目录，显示真实模型卡片，并支持点击导入到 Scene。

**Architecture:** Electron 主进程负责目录选择、一级模型包扫描、`meta.json` 读取和 `editor-asset://` 授权；preload 暴露受控 `importModelFolder()` API；React `ProjectPanel` 只消费安全的 `AssetEntry[]` 并复用现有 `editorStore.importModelAsset()` 导入模型。第一版引用原目录，不复制资源，只读取元数据，不执行 `.model.ts`。

**Tech Stack:** Electron IPC、Node.js `fs/path`、Vite、React、TypeScript、Zustand、CSS、Babylon.js。

---

## 规格来源

- 已通过规格：`docs/superpowers/specs/2026-06-28-model-folder-import-design.md`
- 用户确认范围：引用原目录、只读 `meta.json`、记录 `.model.ts` 路径但不执行、只扫描模型根目录下一级子目录。
- 参考目录：`F:\3d-models\models`

## 文件结构与职责

- Modify: `electron/types.ts`
  - 扩展 `AssetEntry` 可选模型包字段。
  - 新增 `ImportModelFolderSkippedEntry` 和 `ImportModelFolderResult` 类型。

- Modify: `src/editor/assets/AssetDatabase.ts`
  - 同步 renderer 侧 `AssetEntry` 类型字段。

- Modify: `src/vite-env.d.ts`
  - 同步全局 `AssetEntry`、`ImportModelFolderResult` 类型和 `window.editorApi.importModelFolder()` 声明。

- Modify: `electron/preload.ts`
  - 暴露 `importModelFolder()`，转发到 `assets:importModelFolder` IPC。

- Modify: `electron/ipc/assetIpc.ts`
  - 新增模型包扫描辅助函数。
  - 新增 `assets:importModelFolder` handler。
  - 保留现有 `assets:scan` 行为不变。

- Modify: `src/editor/model/SceneDocument.ts`
  - 让 `createModelEntity()` 使用 `asset.displayName` 传入的友好名称时保持现有参数结构不变；如果实现时选择在调用处传 displayName，则本文件不需要改。

- Modify: `src/editor/store/editorStore.ts`
  - 在 `importModelAsset()` 中优先使用 `asset.displayName` 作为实体名称，回退到去扩展名后的 `asset.name`。
  - 继续要求 `asset.kind === 'model'`。

- Modify: `src/editor/panels/ProjectPanel.tsx`
  - 模型库页签增加“导入模型文件夹”按钮。
  - 模型库显示扫描出的真实模型卡片。
  - 点击真实模型卡片调用 `importModelAsset(asset)`。
  - 其他资源库页签保持占位。

- Modify: `src/styles/global.css`
  - 为导入按钮、状态文案、可点击模型卡片和空状态补充样式。

- Modify: `README.md`
  - 记录模型库支持导入模型文件夹。
  - 记录当前边界：引用原目录、不复制、只读 `meta.json`、不执行 `.model.ts`。

## 执行任务

### Task 1: 扩展共享类型和 preload API

**Files:**
- Modify: `electron/types.ts:30-36`
- Modify: `src/editor/assets/AssetDatabase.ts:1-6`
- Modify: `src/vite-env.d.ts:27-42`
- Modify: `electron/preload.ts:1-16`

- [ ] **Step 1: 扩展 `electron/types.ts` 中的资产类型**

将 `AssetEntry` 替换为以下结构，并在其后新增导入结果类型：

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
};

export type ImportModelFolderSkippedEntry = {
  packagePath: string;
  reason: string;
};

export type ImportModelFolderResult = {
  canceled: boolean;
  rootPath: string | null;
  assets: AssetEntry[];
  skipped: ImportModelFolderSkippedEntry[];
};
```

- [ ] **Step 2: 同步 `src/editor/assets/AssetDatabase.ts` 类型**

将文件内容替换为：

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
};
```

- [ ] **Step 3: 同步 `src/vite-env.d.ts` 类型和 API 声明**

在 `AssetEntry` 后添加：

```ts
type ImportModelFolderSkippedEntry = {
  packagePath: string;
  reason: string;
};

type ImportModelFolderResult = {
  canceled: boolean;
  rootPath: string | null;
  assets: AssetEntry[];
  skipped: ImportModelFolderSkippedEntry[];
};
```

同时把全局 API 声明改为：

```ts
interface Window {
  editorApi: {
    version: string;
    saveScene: (request: SaveSceneRequest) => Promise<SaveSceneResult>;
    loadScene: () => Promise<LoadSceneResult>;
    readTextFile: (request: ReadTextFileRequest) => Promise<ReadTextFileResult>;
    scanAssets: () => Promise<AssetEntry[]>;
    importModelFolder: () => Promise<ImportModelFolderResult>;
  };
}
```

- [ ] **Step 4: 更新 `electron/preload.ts` 导入和桥接 API**

把 import type 列表改为包含 `ImportModelFolderResult`：

```ts
import type {
  AssetEntry,
  ImportModelFolderResult,
  LoadSceneResult,
  ReadTextFileRequest,
  ReadTextFileResult,
  SaveSceneRequest,
  SaveSceneResult,
} from './types.js';
```

把 `contextBridge.exposeInMainWorld` 中的对象改为：

```ts
contextBridge.exposeInMainWorld('editorApi', {
  version: '0.1.0',
  saveScene: (request: SaveSceneRequest): Promise<SaveSceneResult> => ipcRenderer.invoke('scene:save', request),
  loadScene: (): Promise<LoadSceneResult> => ipcRenderer.invoke('scene:load'),
  readTextFile: (request: ReadTextFileRequest): Promise<ReadTextFileResult> => ipcRenderer.invoke('file:readText', request),
  scanAssets: (): Promise<AssetEntry[]> => ipcRenderer.invoke('assets:scan'),
  importModelFolder: (): Promise<ImportModelFolderResult> => ipcRenderer.invoke('assets:importModelFolder'),
});
```

- [ ] **Step 5: 静态检查目标文本**

Run:

```bash
rg "ImportModelFolderResult|importModelFolder|packagePath|displayName" electron/types.ts electron/preload.ts src/vite-env.d.ts src/editor/assets/AssetDatabase.ts
```

Expected: 输出包含四个文件中的新增类型字段和 API 名称。

### Task 2: 新增 Electron 模型包扫描 IPC

**Files:**
- Modify: `electron/ipc/assetIpc.ts:1-63`

- [ ] **Step 1: 更新 import 类型**

将顶部 import 从：

```ts
import type { AssetEntry } from '../types.js';
```

改为：

```ts
import type { AssetEntry, ImportModelFolderResult, ImportModelFolderSkippedEntry } from '../types.js';
```

保留现有：

```ts
import { dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorizeAssetRoot, authorizeSceneFile, encodeAssetUrl } from './assetRegistry.js';
```

- [ ] **Step 2: 在 `getAssetKind()` 后新增模型包扫描常量和类型**

插入：

```ts
const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);

type ModelPackageMetadata = {
  displayName?: string;
};

type ModelPackageScanResult = {
  asset?: AssetEntry;
  skipped?: ImportModelFolderSkippedEntry;
};
```

- [ ] **Step 3: 新增纯辅助函数 `isPlainObject()`**

插入：

```ts
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
```

- [ ] **Step 4: 新增 `isModelFile()`**

插入：

```ts
function isModelFile(fileName: string): boolean {
  return MODEL_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}
```

- [ ] **Step 5: 新增 `selectPrimaryModelFile()`**

插入：

```ts
function selectPrimaryModelFile(packagePath: string, fileNames: string[]): string | null {
  const modelFileNames = fileNames.filter(isModelFile);

  if (modelFileNames.length === 0) return null;

  const packageName = path.basename(packagePath).toLowerCase();
  const sameNameModel = modelFileNames.find((fileName) => path.parse(fileName).name.toLowerCase() === packageName);

  if (sameNameModel) {
    return path.join(packagePath, sameNameModel);
  }

  if (modelFileNames.length === 1) {
    return path.join(packagePath, modelFileNames[0]);
  }

  return null;
}
```

- [ ] **Step 6: 新增 `extractDisplayNameFromMetadata()`**

插入：

```ts
function extractDisplayNameFromMetadata(metadata: unknown): string | undefined {
  if (!isPlainObject(metadata) || !Array.isArray(metadata.parameterScripts)) return undefined;

  for (const script of metadata.parameterScripts) {
    if (!isPlainObject(script)) continue;

    const values = script.values;
    if (isPlainObject(values)) {
      const deviceName = values.deviceName;
      if (isPlainObject(deviceName) && typeof deviceName.value === 'string' && deviceName.value.trim()) {
        return deviceName.value.trim();
      }
    }

    const fields = script.fields;
    if (Array.isArray(fields)) {
      const deviceNameField = fields.find((field) => isPlainObject(field) && field.key === 'deviceName');
      if (
        isPlainObject(deviceNameField) &&
        typeof deviceNameField.defaultValue === 'string' &&
        deviceNameField.defaultValue.trim()
      ) {
        return deviceNameField.defaultValue.trim();
      }
    }
  }

  return undefined;
}
```

- [ ] **Step 7: 新增 `readModelPackageMetadata()`**

插入：

```ts
async function readModelPackageMetadata(packagePath: string): Promise<ModelPackageMetadata & { metadataPath?: string }> {
  const metadataPath = path.join(packagePath, 'meta.json');

  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    return {
      metadataPath,
      displayName: extractDisplayNameFromMetadata(parsed),
    };
  } catch {
    return {};
  }
}
```

- [ ] **Step 8: 新增 `findModelScripts()`**

插入：

```ts
function findModelScripts(packagePath: string, fileNames: string[]): string[] {
  return fileNames
    .filter((fileName) => fileName.toLowerCase().endsWith('.model.ts'))
    .map((fileName) => path.join(packagePath, fileName));
}
```

- [ ] **Step 9: 新增 `scanModelPackage()`**

插入：

```ts
async function scanModelPackage(packagePath: string): Promise<ModelPackageScanResult> {
  const entries = await fs.readdir(packagePath, { withFileTypes: true });
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const modelFilePath = selectPrimaryModelFile(packagePath, fileNames);

  if (!modelFilePath) {
    const modelCount = fileNames.filter(isModelFile).length;
    return {
      skipped: {
        packagePath,
        reason: modelCount > 1 ? '存在多个模型文件，无法判断主模型。' : '未发现 .glb/.gltf 模型文件。',
      },
    };
  }

  const metadata = await readModelPackageMetadata(packagePath);
  const scriptPaths = findModelScripts(packagePath, fileNames);
  const modelFileName = path.basename(modelFilePath);
  const packageName = path.basename(packagePath);

  return {
    asset: {
      id: modelFilePath,
      name: modelFileName,
      path: modelFilePath,
      sourceUrl: encodeAssetUrl(modelFilePath),
      kind: 'model',
      packagePath,
      metadataPath: metadata.metadataPath,
      scriptPaths,
      displayName: metadata.displayName ?? packageName ?? path.parse(modelFileName).name,
    },
  };
}
```

- [ ] **Step 10: 新增 `scanModelFolder()`**

插入：

```ts
async function scanModelFolder(rootPath: string): Promise<{ assets: AssetEntry[]; skipped: ImportModelFolderSkippedEntry[] }> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const packageDirectories = entries.filter((entry) => entry.isDirectory());
  const assets: AssetEntry[] = [];
  const skipped: ImportModelFolderSkippedEntry[] = [];

  for (const entry of packageDirectories) {
    const packagePath = path.join(rootPath, entry.name);

    try {
      const result = await scanModelPackage(packagePath);
      if (result.asset) assets.push(result.asset);
      if (result.skipped) skipped.push(result.skipped);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push({ packagePath, reason: `扫描失败：${message}` });
    }
  }

  return { assets, skipped };
}
```

- [ ] **Step 11: 在 `registerAssetIpc()` 中新增 IPC handler**

在现有 `ipcMain.handle('assets:scan', ...)` 后添加：

```ts
  ipcMain.handle('assets:importModelFolder', async (): Promise<ImportModelFolderResult> => {
    const result = await dialog.showOpenDialog({
      title: '选择模型文件夹',
      properties: ['openDirectory'],
    });

    const [rootPath] = result.filePaths;

    if (result.canceled || !rootPath) {
      return { canceled: true, rootPath: null, assets: [], skipped: [] };
    }

    authorizeAssetRoot(rootPath);
    const { assets, skipped } = await scanModelFolder(rootPath);

    return {
      canceled: false,
      rootPath,
      assets,
      skipped,
    };
  });
```

- [ ] **Step 12: 静态检查关键 handler 和函数**

Run:

```bash
rg "assets:importModelFolder|scanModelFolder|scanModelPackage|selectPrimaryModelFile|extractDisplayNameFromMetadata" electron/ipc/assetIpc.ts
```

Expected: 输出包含新增 IPC 和所有扫描辅助函数。

### Task 3: 让模型导入使用友好展示名

**Files:**
- Modify: `src/editor/store/editorStore.ts:238-250`

- [ ] **Step 1: 更新 `importModelAsset()` 的显示名选择逻辑**

将当前实现：

```ts
  importModelAsset: (asset) => {
    if (asset.kind !== 'model') return;

    const entity = createModelEntity(asset.path, asset.sourceUrl, asset.name.replace(/\.(gltf|glb)$/i, ''));
    const command = createEntityCommand(entity);
```

改为：

```ts
  importModelAsset: (asset) => {
    if (asset.kind !== 'model') return;

    const displayName = asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, '');
    const entity = createModelEntity(asset.path, asset.sourceUrl, displayName);
    const command = createEntityCommand(entity);
```

- [ ] **Step 2: 保留现有日志**

确认函数末尾仍保留：

```ts
        logs: prependLog(state.logs, `导入模型：${asset.name}`),
```

第一版日志继续记录真实模型文件名，实体名称使用友好展示名。

- [ ] **Step 3: 静态检查 displayName 使用**

Run:

```bash
rg "asset.displayName|导入模型：" src/editor/store/editorStore.ts
```

Expected: 输出包含 `asset.displayName?.trim()` 和 `导入模型：${asset.name}`。

### Task 4: 改造 ProjectPanel 模型库 UI

**Files:**
- Modify: `src/editor/panels/ProjectPanel.tsx:1-164`

- [ ] **Step 1: 更新导入和类型**

保持现有：

```ts
import { useMemo, useState } from 'react';
```

将 `ProjectLibraryItem` 扩展为可携带资产：

```ts
type ProjectLibraryItem = {
  id: string;
  name: string;
  icon: string;
  asset?: AssetEntry;
};
```

- [ ] **Step 2: 新增资源库运行状态类型**

在 `ProjectLibrary` 类型后添加：

```ts
type ModelFolderStatus = {
  message: string;
  kind: 'info' | 'error';
};
```

- [ ] **Step 3: 新增 `createModelLibraryItems()`**

在 `PROJECT_LIBRARIES` 后添加：

```ts
function createModelLibraryItems(modelAssets: AssetEntry[]): ProjectLibraryItem[] {
  return modelAssets.map((asset) => ({
    id: asset.id,
    name: asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, ''),
    icon: 'cube',
    asset,
  }));
}
```

- [ ] **Step 4: 新增 store 选择器和本地状态**

在 `ProjectPanel()` 内部最前面加入：

```ts
  const importModelAsset = useEditorStore((state) => state.importModelAsset);
  const pushLog = useEditorStore((state) => state.pushLog);
  const [activeLibraryKey, setActiveLibraryKey] = useState<ProjectLibraryKey>('model');
  const [modelAssets, setModelAssets] = useState<AssetEntry[]>([]);
  const [isImportingModelFolder, setIsImportingModelFolder] = useState(false);
  const [modelFolderStatus, setModelFolderStatus] = useState<ModelFolderStatus | null>(null);
```

同时在文件顶部添加 store import：

```ts
import { useEditorStore } from '../store/editorStore';
```

删除原来的单行：

```ts
  const [activeLibraryKey, setActiveLibraryKey] = useState<ProjectLibraryKey>('model');
```

- [ ] **Step 5: 更新 `activeLibrary` 计算**

把当前 `activeLibrary` useMemo 改为：

```ts
  const activeLibrary = useMemo(
    () => PROJECT_LIBRARIES.find((library) => library.key === activeLibraryKey) ?? PROJECT_LIBRARIES[0],
    [activeLibraryKey],
  );

  const activeItems = useMemo(() => {
    if (activeLibrary.key === 'model' && modelAssets.length > 0) {
      return createModelLibraryItems(modelAssets);
    }

    return activeLibrary.items;
  }, [activeLibrary, modelAssets]);
```

- [ ] **Step 6: 新增 `handleImportModelFolder()`**

在 `activeItems` 后添加：

```ts
  async function handleImportModelFolder(): Promise<void> {
    setIsImportingModelFolder(true);
    setModelFolderStatus({ message: '正在扫描模型文件夹...', kind: 'info' });

    try {
      const result = await window.editorApi.importModelFolder();

      if (result.canceled) {
        setModelFolderStatus(null);
        return;
      }

      setModelAssets(result.assets);

      const skippedSuffix = result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个目录` : '';
      const rootLabel = result.rootPath ?? '模型文件夹';
      const message = `模型文件夹已导入：${rootLabel}，发现 ${result.assets.length} 个模型${skippedSuffix}。`;
      setModelFolderStatus({ message, kind: 'info' });
      pushLog(message);

      if (result.assets.length === 0) {
        setModelFolderStatus({ message: '未发现可导入模型包。', kind: 'info' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusMessage = `导入模型文件夹失败：${message}`;
      setModelFolderStatus({ message: statusMessage, kind: 'error' });
      pushLog(statusMessage);
    } finally {
      setIsImportingModelFolder(false);
    }
  }
```

- [ ] **Step 7: 新增 `handleResourceCardClick()`**

在 `handleImportModelFolder()` 后添加：

```ts
  function handleResourceCardClick(item: ProjectLibraryItem): void {
    if (!item.asset) return;
    importModelAsset(item.asset);
  }
```

- [ ] **Step 8: 更新筛选行 JSX**

将当前筛选行：

```tsx
      <div className="library-filter-row" aria-label={`${activeLibrary.label}筛选占位`}>
        <label className="library-filter-label" htmlFor="project-library-search">
          {activeLibrary.searchLabel}
        </label>
        <input
          className="library-filter-input"
          id="project-library-search"
          placeholder={activeLibrary.searchPlaceholder}
          readOnly
          type="text"
          value=""
        />
      </div>
```

替换为：

```tsx
      <div className="library-filter-row" aria-label={`${activeLibrary.label}筛选占位`}>
        <label className="library-filter-label" htmlFor="project-library-search">
          {activeLibrary.searchLabel}
        </label>
        <input
          className="library-filter-input"
          id="project-library-search"
          placeholder={activeLibrary.searchPlaceholder}
          readOnly
          type="text"
          value=""
        />
        {activeLibrary.key === 'model' ? (
          <button
            className="library-import-button"
            disabled={isImportingModelFolder}
            onClick={() => void handleImportModelFolder()}
            type="button"
          >
            {isImportingModelFolder ? '扫描中...' : '导入模型文件夹'}
          </button>
        ) : null}
      </div>
```

- [ ] **Step 9: 更新资源卡片 JSX**

将资源卡片列表：

```tsx
      <div className="resource-card-list" aria-label={`${activeLibrary.label}资源占位列表`}>
        {activeLibrary.items.map((item) => (
          <button className="resource-card" disabled key={item.id} title="占位资源，功能后续接入" type="button">
            <span className="resource-card-preview">
              <ResourceIcon icon={item.icon} />
            </span>
            <strong className="resource-card-name">{item.name}</strong>
          </button>
        ))}
      </div>
```

替换为：

```tsx
      <div className="resource-card-list" aria-label={`${activeLibrary.label}资源列表`}>
        {activeItems.map((item) => {
          const isImportedModel = Boolean(item.asset);

          return (
            <button
              className={isImportedModel ? 'resource-card resource-card-clickable' : 'resource-card'}
              disabled={!isImportedModel}
              key={item.id}
              onClick={() => handleResourceCardClick(item)}
              title={isImportedModel ? `导入模型：${item.name}` : '占位资源，功能后续接入'}
              type="button"
            >
              <span className="resource-card-preview">
                <ResourceIcon icon={item.icon} />
              </span>
              <strong className="resource-card-name">{item.name}</strong>
            </button>
          );
        })}
      </div>
```

- [ ] **Step 10: 在卡片列表后显示状态文案**

在 `</div>` 卡片列表后添加：

```tsx
      {activeLibrary.key === 'model' && modelFolderStatus ? (
        <p className={`library-status library-status-${modelFolderStatus.kind}`}>{modelFolderStatus.message}</p>
      ) : null}
```

- [ ] **Step 11: 静态检查 ProjectPanel 新关键字**

Run:

```bash
rg "importModelFolder|library-import-button|resource-card-clickable|modelFolderStatus|createModelLibraryItems" src/editor/panels/ProjectPanel.tsx
```

Expected: 输出包含导入按钮、状态、真实模型卡片和 API 调用相关代码。

### Task 5: 补充资源库样式

**Files:**
- Modify: `src/styles/global.css:244-336`

- [ ] **Step 1: 让筛选行右侧按钮靠右**

在 `.project-library .library-filter-input::placeholder` 后添加：

```css
.project-library .library-import-button {
  flex: 0 0 auto;
  height: 28px;
  margin-left: auto;
  padding: 0 12px;
  border: 1px solid #167c86;
  border-radius: 3px;
  color: #dffcff;
  background: #14535b;
  font-size: 13px;
}

.project-library .library-import-button:hover:not(:disabled) {
  border-color: #20dce9;
  background: #176b75;
}

.project-library .library-import-button:disabled {
  color: #8aa8ab;
  cursor: wait;
  opacity: 0.72;
}
```

- [ ] **Step 2: 增加可点击资源卡片样式**

在 `.project-library .resource-card:disabled` 后添加：

```css
.project-library .resource-card-clickable {
  cursor: pointer;
}

.project-library .resource-card-clickable:hover {
  border-color: #19c7d4;
  background: #3b4547;
  box-shadow: 0 0 0 1px rgb(25 199 212 / 26%);
}
```

- [ ] **Step 3: 增加模型库状态文案样式**

在 `.project-library .resource-card-name` 后添加：

```css
.project-library .library-status {
  margin: 0;
  padding: 0 14px 8px;
  color: #9fb7bb;
  font-size: 12px;
}

.project-library .library-status-error {
  color: #ff9c9c;
}
```

- [ ] **Step 4: 静态检查 CSS 类名**

Run:

```bash
rg "library-import-button|resource-card-clickable|library-status" src/styles/global.css
```

Expected: 输出包含三个新增样式块。

### Task 6: 更新 README 文档

**Files:**
- Modify: `README.md:27-28`
- Modify: `README.md:71-72`
- Modify: `README.md:99-103`
- Modify: `README.md:107-111`

- [ ] **Step 1: 更新“当前功能”中的 Project 资源库外观条目**

将 Project 资源库外观条目更新为：

```markdown
- Project 资源库外观：底部 Project 面板已切换为资源库浏览器样式，并将图库区域固定加高到约 `260px`，包含模型库、POI库、主题库、组合库、环境库、图表库、图片库七个页签，以及筛选占位行和横向资源卡片；模型库支持导入模型文件夹并展示真实模型卡片。
```

- [ ] **Step 2: 在“当前功能”中新增模型文件夹导入条目**

在 Project 资源库外观条目后添加：

```markdown
- 模型文件夹导入：模型库可选择类似 `F:\3d-models\models` 的模型根目录，扫描一级模型包中的 `.glb/.gltf`、读取 `meta.json` 展示名称，并引用原目录通过 `editor-asset://` 加载模型。
```

- [ ] **Step 3: 更新“基础操作”资源库说明**

将资源库浏览说明更新为：

```markdown
- 浏览资源库外观：底部图库区域固定加高到约 `260px`，在 Project 面板中点击 `模型库`、`POI库`、`主题库`、`组合库`、`环境库`、`图表库`、`图片库` 页签，可切换不同资源库展示；模型库可点击 `导入模型文件夹` 扫描本地模型包。
```

- [ ] **Step 4: 更新“资源库功能边界”说明**

将资源库功能边界改为：

```markdown
- 资源库功能边界：当前只有模型库接入导入模型文件夹能力；导入方式为引用原目录，不复制资源；第一版只读取 `meta.json` 并记录 `.model.ts` 路径，不执行脚本、不生成参数 Inspector，其余资源库仍为样式占位。
```

- [ ] **Step 5: 更新“当前限制”中的 Project 资源库限制**

将当前限制中的 Project 资源库条目更新为：

```markdown
- Project 资源库当前只有模型库接入本地模型文件夹扫描；POI、主题、组合、环境、图表、图片仍为占位展示，暂未接入真实搜索过滤、资源加载、拖拽或导入。
```

- [ ] **Step 6: 在“最近完成”新增记录**

在 `## 最近完成` 下方新增：

```markdown
- 2026-06-28：为模型库新增导入模型文件夹设计与实现入口，支持扫描一级模型包、读取 `meta.json` 展示名，并通过 `editor-asset://` 引用原目录模型。
```

- [ ] **Step 7: 静态检查 README 关键边界**

Run:

```bash
rg "导入模型文件夹|引用原目录|meta.json|不执行脚本|F:\\3d-models\\models" README.md
```

Expected: 输出包含模型文件夹导入功能、引用原目录、只读 `meta.json`、不执行脚本和参考目录说明。

### Task 7: 轻量验证和人工检查指引

**Files:**
- Verify: `electron/types.ts`
- Verify: `electron/preload.ts`
- Verify: `electron/ipc/assetIpc.ts`
- Verify: `src/vite-env.d.ts`
- Verify: `src/editor/assets/AssetDatabase.ts`
- Verify: `src/editor/store/editorStore.ts`
- Verify: `src/editor/panels/ProjectPanel.tsx`
- Verify: `src/styles/global.css`
- Verify: `README.md`

- [ ] **Step 1: 检查关键代码路径是否全部存在**

Run:

```bash
rg "assets:importModelFolder|importModelFolder|ImportModelFolderResult|scanModelPackage|resource-card-clickable|library-import-button|asset.displayName" electron src README.md
```

Expected: 输出覆盖 Electron IPC、preload/types、ProjectPanel、store、CSS 和 README。

- [ ] **Step 2: 按用户偏好跳过自动测试和构建**

用户全局要求包含“不需要进行测试，浪费token”。因此默认不运行 `npm run typecheck`、`npm run build` 或 Electron 启动验证。

最终交付时必须如实说明：

```text
未运行自动测试或构建；本次按用户要求仅做静态内容检查。功能涉及 TypeScript/Electron IPC，若需要运行级验证，建议后续执行 npm run typecheck 或启动 Electron 人工确认。
```

- [ ] **Step 3: 可选人工启动检查**

如果用户要求看实际效果，再执行该步骤。启动前按用户全局要求清理当前任务相关进程：

```powershell
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*claude*' -or $_.CommandLine -like '*claude*' } | Stop-Process -Force -Confirm:$false
```

然后启动：

```bash
npm run dev:electron
```

人工检查路径：

1. 打开模型库页签。
2. 点击 `导入模型文件夹`。
3. 选择 `F:\3d-models\models`。
4. 确认模型库出现 `RGV`、`LED`、`Stacker`、`Shelf`、`链条机`、`辊道机` 等真实模型卡片。
5. 点击一个模型卡片。
6. 确认 Scene 中出现模型实体。
7. 确认 Console 出现导入日志。

- [ ] **Step 4: 最终交付说明**

最终回复需要包含：

```markdown
已完成：
- 新增 `window.editorApi.importModelFolder()` 和 `assets:importModelFolder` IPC。
- 模型库支持选择模型根目录并扫描一级模型包。
- 模型卡片可点击导入场景，实体名称优先使用 `meta.json` 的设备名称。
- README 已记录引用原目录、只读 `meta.json`、不执行 `.model.ts` 的边界。

验证：
- 已通过静态内容检查确认关键代码路径存在。
- 未运行自动测试或构建；按用户要求跳过。
```

## 自审记录

- 规格覆盖：计划覆盖了 IPC/preload/types、一级模型包扫描、主模型识别、`meta.json` 展示名、`.model.ts` 不执行、ProjectPanel 真实模型卡片、点击导入、README 边界和轻量验证。
- 占位扫描：本文没有 `TBD`、`TODO`、`implement later`、`fill in details`、`???` 等占位内容。
- 类型一致性：`AssetEntry`、`ImportModelFolderSkippedEntry`、`ImportModelFolderResult`、`importModelFolder()`、`assets:importModelFolder`、`displayName`、`packagePath`、`metadataPath`、`scriptPaths` 在所有任务中命名一致。
