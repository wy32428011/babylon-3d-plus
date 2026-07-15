# Environment GLB File Import and Left Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将环境库改为直接导入单个 GLB，并在应用到环境属性后把整个环境模型稳定放到世界原点左侧。

**Architecture:** 新增环境 GLB 专用 IPC 和项目存储函数，内部把单个 GLB 保存为 `Assets/Environments/<stem>/file.glb` 的独立包，继续复用现有资产索引和环境配置。Babylon 运行时根据环境模型世界包围盒计算负 X 放置偏移，不扩展场景保存结构。

**Tech Stack:** Electron IPC、Node.js `fs/path`、React、TypeScript、Babylon.js。

---

### Task 1: 新增环境 GLB 文件导入类型和 preload API

**Files:**
- Modify: `electron/types.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/preload.cts`
- Modify: `src/vite-env.d.ts`

- [x] **Step 1: 定义单文件导入结果**

新增 `ImportEnvironmentModelFileResult`：

```ts
export type ImportEnvironmentModelFileResult = {
  canceled: boolean;
  filePath: string | null;
  projectRoot: string | null;
  importedAsset: ProjectModelAssetEntry | null;
  projectAssets: ProjectModelAssetEntry[];
};
```

- [x] **Step 2: 暴露 renderer API**

新增：

```ts
importEnvironmentModelFile: (): Promise<ImportEnvironmentModelFileResult> =>
  ipcRenderer.invoke('assets:importEnvironmentModelFile')
```

### Task 2: 实现项目内单文件环境包复制

**Files:**
- Modify: `electron/ipc/projectAssetStore.ts`

- [x] **Step 1: 新增导入结果内部类型**

结果包含 `importedAsset` 和完整 `projectAssets`。

- [x] **Step 2: 新增安全暂存复制流程**

目标目录：

```text
Assets/Environments/<safe stem>/
```

先复制到同级临时目录，成功后再替换目标目录；若源文件已是目标文件则跳过复制。

- [x] **Step 3: 扫描项目副本并写入索引**

调用 `scanModelPackage(targetPackagePath)`，补齐：

```ts
{
  assetRevision: createProjectAssetRevision(),
  kind: 'model',
  libraryKind: 'environment',
}
```

只替换环境库中同 `id` 或同 `packagePath` 的记录。

### Task 3: 新增环境 GLB IPC 并限制旧文件夹入口

**Files:**
- Modify: `electron/ipc/assetIpc.ts`

- [x] **Step 1: 新增 `assets:importEnvironmentModelFile`**

文件选择器配置：

```ts
{
  title: '选择环境 GLB 模型',
  properties: ['openFile'],
  filters: [{ name: 'GLB 环境模型', extensions: ['glb'] }],
}
```

- [x] **Step 2: 校验文件并调用项目存储**

必须验证扩展名、`stat.isFile()` 和项目目录。

- [x] **Step 3: 普通模型文件夹入口只接受 `libraryKind: 'model'`**

若收到 `environment`，返回“环境模型请直接选择 GLB 文件导入”的明确错误。

### Task 4: 更新 Project 环境库交互

**Files:**
- Modify: `src/editor/panels/ProjectPanel.tsx`
- Modify: `src/editor/panels/SceneSettingsPanel.tsx`

- [x] **Step 1: 拆分普通模型和环境模型导入函数**

普通模型继续调用 `importModelFolder({ libraryKind: 'model' })`；环境模型调用 `importEnvironmentModelFile()`。

- [x] **Step 2: 更新按钮和状态文案**

- 模型库：`导入模型文件夹`
- 环境库：`导入环境 GLB`
- 空环境库：`请先导入环境 GLB 文件`

- [x] **Step 3: 保持环境卡片专用拖拽 MIME 和分库校验**

不修改现有 `ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE` 安全边界。

### Task 5: 实现包围盒自适应原点左侧放置

**Files:**
- Create: `src/runtime/babylon/environmentPlacement.ts`
- Modify: `src/runtime/babylon/SceneRuntime.ts`

- [x] **Step 1: 创建纯计算函数**

导出 `calculateEnvironmentOriginLeftOffset(minimum, maximum)`，正常返回：

```ts
{
  x: -2 - maximum.x,
  y: -minimum.y,
  z: -(minimum.z + maximum.z) / 2,
}
```

非法包围盒返回 `null`。

- [x] **Step 2: 汇总环境 Mesh 世界包围盒**

只统计 `getTotalVertices() > 0` 且包围盒有限的 Mesh。

- [x] **Step 3: 应用放置偏移**

在 `parentTopLevelEnvironmentNodes()` 后调用放置方法；无有效包围盒时回退到 `root.position.x = -10`。

### Task 6: 更新文档和生成产物

**Files:**
- Modify: `README.md`
- Regenerate: `dist-electron/**/*`

- [x] **Step 1: 更新环境导入说明**

删除环境库“导入文件夹”描述，说明用户直接选择 `.glb`，内部保存为项目环境单文件包。

- [x] **Step 2: 记录负 X 包围盒放置规则**

说明右边界 `X=-2m`、底部 `Y=0`、Z 居中，且环境模型不进入 Hierarchy。

- [x] **Step 3: 重新生成 Electron 产物**

Run: `npm run build:electron`

### Task 7: 验证和交叉审查

**Files:**
- Verify: all modified files

- [x] **Step 1: 验证真实 GLB 项目复制**

使用 `F:\3d-models\envModels\866新厂房_Optimized.glb` 和临时项目目录，确认生成独立环境包、`libraryKind: 'environment'` 和 v2 索引。

- [x] **Step 2: 验证放置计算边界**

使用有限包围盒确认右边界移动到 `-2m`；使用非法包围盒确认返回 `null`。

- [x] **Step 3: 执行静态与构建验证**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

- [x] **Step 4: 子代理交叉审查**

重点检查旧环境索引兼容、同名覆盖安全、环境模型不进入实体层级和未污染现有 CAD/安装包改动。

### Task 8: 交叉审查后的事务与重导刷新补强

**Files:**
- Modify: `electron/ipc/modelPackageScanner.ts`
- Modify: `electron/ipc/projectAssetStore.ts`
- Modify: `src/editor/assets/environmentAssets.ts`
- Modify: `src/runtime/assets/editorAssetUrl.ts`
- Modify: `src/editor/panels/ProjectPanel.tsx`
- Modify: `README.md`

- [x] **Step 1: 在替换正式包前校验 GLB 结构**

校验 GLB magic、版本 2、声明总长度、JSON 首块和所有 chunk 边界；源文件和项目暂存副本都必须通过。

- [x] **Step 2: 将同名覆盖改为事务式目录切换**

读取旧索引后，使用 `staging -> backup -> target` 切换；正式包扫描或索引写入失败时恢复旧目录和旧索引，成功后再清理备份。

- [x] **Step 3: 用 assetRevision 版本化环境 URL**

不新增场景字段，在现有 `sourceUrl` 上写入 `assetRevision` 查询参数；本地 URL 解码忽略查询参数，开发模式映射继续保留查询字符串。

- [x] **Step 4: 同包重导时自动刷新当前环境**

Project 面板检测当前环境 `packagePath` 与重导资产相同后，重新构建环境配置并触发 Babylon 容器重载。

- [x] **Step 5: 回归验证审查问题**

修复前确认“索引异常后旧包被覆盖”和“不同 revision URL 不变”两个脚本失败；修复后同一脚本通过，并重新执行真实 GLB、类型检查、生产构建和差异检查。

