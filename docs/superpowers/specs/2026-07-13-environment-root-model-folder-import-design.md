# 环境模型根目录导入修复设计

> **状态：已被取代。** 环境库已改为直接选择单个 GLB，当前方案见 `2026-07-13-environment-glb-file-import-left-placement-design.md`。本文仅保留普通模型文件夹“根目录本身就是模型包”的扫描兼容背景。

## 背景

环境模型目录 `F:\3d-models\envModels` 直接包含 `866新厂房_Optimized.glb`。当前导入入口调用 `scanModelFolder()`，但该函数只扫描所选目录的一级子目录，导致根目录中的 GLB 被静默忽略，最终返回空资产列表。

## 目标

- 选择一个本身直接包含 `.glb/.gltf` 的目录时，允许把该目录作为单个模型包导入。
- 保持现有“所选目录包含多个一级模型包子目录”的导入方式不变。
- 保持普通模型库与环境模型库的 `libraryKind`、`Assets/Models`、`Assets/Environments` 分库边界不变。
- 保持模型包复制、项目资产索引和运行时加载链路不变。

## 非目标

- 本次不把多个根级模型文件自动拆分成多个模型包；多个文件仍沿用现有主模型判定规则，无法确定主模型时给出跳过原因。
- 不修改 `meta.json`、`sceneSettings.environment` 或环境运行时数据结构。
- 不重构当前模型包扫描器和项目资产存储架构。

## 方案比较

### 方案 A：根目录优先按模型包扫描（采用）

当所选目录根部存在 `.glb/.gltf` 时，先调用既有 `scanModelPackage(rootPath)`。识别到主模型后直接返回该资产，不再继续扫描子目录，避免把纹理、缓存等资源目录误判为独立模型包。

优点：改动最小，完全复用现有模型选择、元数据、单位、缩略图和脚本扫描逻辑；复制到项目时仍以完整目录为模型包，兼容 GLTF 伴随资源。

### 方案 B：UI 改为选择单个模型文件

新增文件选择 IPC，并为 GLB/GLTF 单独实现资源复制。该方案会扩大 preload、类型、IPC 与项目存储改动范围，且 GLTF 外部资源复制规则更复杂，本次不采用。

### 方案 C：要求用户手工增加子目录

无需代码修改，但不符合“选择环境模型文件夹”的用户直觉，且当前静默失败缺乏可诊断性，本次不采用。

## 数据流

1. Project 环境库调用 `importModelFolder({ libraryKind: 'environment' })`。
2. Electron 选择 `F:\3d-models\envModels`。
3. `scanModelFolder()` 发现根部模型文件，调用 `scanModelPackage(rootPath)`。
4. 扫描器识别 `866新厂房_Optimized.glb`，返回以 `envModels` 为包目录的资产。
5. `importModelPackagesIntoProject()` 将完整目录复制到项目 `Assets/Environments/envModels`。
6. 复制后的包重新扫描并以 `libraryKind: 'environment'` 写入 v2 项目资产索引。

## 错误处理

- 根目录有多个模型且无法判断主模型时，沿用既有“存在多个模型文件，无法判断主模型”跳过原因。
- 根目录扫描失败时记录明确的根目录扫描失败原因，再继续执行既有一级子目录扫描，避免阻断原有批量模型包导入。
- 根目录识别成功后立即返回，避免重复扫描其资源子目录。

## 验证标准

- 修复前，实际路径扫描结果为 `assets: []`。
- 修复后，同一路径应返回一个资产，模型文件为 `866新厂房_Optimized.glb`，包路径为 `F:\3d-models\envModels`。
- 原有一级子目录模型包扫描逻辑保持可用。
- `npm run typecheck`、`npm run build:electron`、`git diff --check` 通过。
