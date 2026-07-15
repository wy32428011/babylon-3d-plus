# Environment Root Model Folder Import Implementation Plan

> **状态：已被环境单 GLB 导入方案取代。** 环境库不再调用文件夹导入；本文完成的根目录扫描兼容仅继续服务普通模型文件夹入口。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复环境模型选择目录直接包含单个 GLB/GLTF 时扫描结果为空的问题。

**Architecture:** 保留现有 IPC、分库和项目复制链路，仅在 `scanModelFolder()` 增加“所选目录本身就是模型包”的优先识别。识别成功后直接返回，识别失败时保留诊断并继续原有一级子目录扫描。

**Tech Stack:** Electron、Node.js `fs/path`、TypeScript、现有模型包扫描器。

---

### Task 1: 固化根因与边界

**Files:**
- Reference: `electron/ipc/modelPackageScanner.ts`
- Reference: `electron/ipc/assetIpc.ts`
- Reference: `electron/ipc/projectAssetStore.ts`

- [x] **Step 1: 复现实际目录扫描为空**

Run:

```bash
node --input-type=module -e "import('./dist-electron/ipc/modelPackageScanner.js').then(async ({scanModelFolder}) => console.log(JSON.stringify(await scanModelFolder('F:/3d-models/envModels'), null, 2)))"
```

Expected before fix: `assets` 和 `skipped` 都为空。

- [x] **Step 2: 验证既有单包扫描器可以识别同一目录**

Run:

```bash
node --input-type=module -e "import('./dist-electron/ipc/modelPackageScanner.js').then(async ({scanModelPackage}) => console.log(JSON.stringify(await scanModelPackage('F:/3d-models/envModels'), null, 2)))"
```

Expected: 返回 `866新厂房_Optimized.glb` 对应资产。

### Task 2: 修复根目录模型包识别

**Files:**
- Modify: `electron/ipc/modelPackageScanner.ts:646-668`

- [x] **Step 1: 在根部存在模型文件时优先扫描所选目录**

实现要求：

```ts
const hasRootModelFile = entries.some((entry) => entry.isFile() && isModelFile(entry.name));

if (hasRootModelFile) {
  try {
    const rootPackageResult = await scanModelPackage(rootPath);
    if (rootPackageResult.asset) {
      return { assets: [rootPackageResult.asset], skipped: [] };
    }
    if (rootPackageResult.skipped) skipped.push(rootPackageResult.skipped);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    skipped.push({ packagePath: rootPath, reason: `扫描失败：${message}` });
  }
}
```

- [x] **Step 2: 保留原有一级子目录扫描**

根目录未识别成有效包时，继续遍历 `packageDirectories`，确保旧模型库目录结构不回归。

### Task 3: 更新使用文档

**Files:**
- Modify: `README.md`

- [x] **Step 1: 补充根目录模型包规则**

明确模型/环境模型导入同时支持：

1. 所选目录直接包含一个可判定主模型的 `.glb/.gltf`；
2. 所选目录下包含多个一级模型包子目录。

- [x] **Step 2: 在最近完成中记录修复**

记录 `F:\3d-models\envModels\866新厂房_Optimized.glb` 根目录扫描为空的根因和兼容方案。

### Task 4: 验证与审查

**Files:**
- Verify: `electron/ipc/modelPackageScanner.ts`
- Verify: `dist-electron/ipc/modelPackageScanner.js`
- Verify: `README.md`

- [x] **Step 1: 构建 Electron 产物**

Run: `npm run build:electron`

Expected: exit code `0`。

- [x] **Step 2: 重新扫描实际环境模型目录**

Run:

```bash
node --input-type=module -e "import('./dist-electron/ipc/modelPackageScanner.js').then(async ({scanModelFolder}) => console.log(JSON.stringify(await scanModelFolder('F:/3d-models/envModels'), null, 2)))"
```

Expected: 返回且仅返回 `866新厂房_Optimized.glb`。

- [x] **Step 3: 执行静态验证**

Run:

```bash
npm run typecheck
git diff --check
```

Expected: 两条命令均以 `0` 退出。

- [x] **Step 4: 交叉审查**

确认改动未触碰 `libraryKind`、项目资产索引结构、`sceneSettings.environment` 和现有 CAD/安装包未提交改动。
