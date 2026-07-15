# YZJ MQTT 前后端方向参数 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为一体式顶升移载模型增加独立 MQTT 前端/后端方向参数，并让仓储运行时按该映射解释前后光电的空间位置。

**Architecture:** YZJ 模型包负责声明模型局部方向并写入 `metadata.logisticsFlow`；通用 MQTT 层继续只归一协议字段；`SceneRuntime` 负责把模型局部前后端转换为世界锚点。旧模型包没有新字段时保留现有入料到出料路径。

**Tech Stack:** TypeScript、Babylon.js、模型包 `meta.json`、Electron 项目资产索引。

---

### Task 1: 扩展 YZJ 参数与 metadata 契约

**Files:**
- Modify: `F:\3d-models\models\YZJ\yzj.model.ts`
- Modify: `F:\3d-models\models\YZJ\meta.json`

- [x] 在 `ParametricModelParamsComponent` 增加 `frontSide = "right"` 与 `backSide = "left"`，使用中文标签 `MQTT 前端方向`、`MQTT 后端方向`。
- [x] 在 `DEFAULT_VALUES` 增加相同默认值，确保脚本运行时和 Inspector schema 一致。
- [x] 扩展 `applyFlowDirection()`，在 `logisticsFlow` 中写入 `frontSide/backSide`。
- [x] 在 `meta.json` 的 `parameterScripts[0].fields`、`values`、`modelParameters.parameters` 三处加入同一 enum 契约。

### Task 2: 让仓储运行时消费显式前后端

**Files:**
- Modify: `F:\3d-babylon-editor\src\runtime\babylon\SceneRuntime.ts`

- [x] 扩展 `WarehouseConveyorAnchors`，保存可选的 `front/back` 世界锚点和是否存在显式 MQTT 端点映射。
- [x] 扩展 `readWarehouseConveyorFlowSides()`，优先从 `metadata.logisticsFlow` 读取 `frontSide/backSide`，再从脚本参数快照读取；只有两端都合法且不同才视为显式映射。
- [x] `resolveWarehouseConveyorAnchors()` 同时计算入料、出料、前端、后端锚点；显式字段存在但无效时返回 `null`，禁止错误联动。
- [x] 入库可视路径显式映射时使用 `front → back`，出库可视路径显式映射时使用 `back → front`；旧包继续使用 `infeed → outfeed`。
- [x] `spanMeters` 与协调器进度使用实际选中的前后端跨度。

### Task 3: 同步模型副本与项目资产索引

**Files:**
- Modify: `F:\3d-models\models\Assets\Models\YZJ\yzj.model.ts`
- Modify: `F:\3d-models\models\Assets\Models\YZJ\meta.json`
- Modify: `F:\3d-babylon-editor\output\playwright\yzj-assets\yzj.model.ts`
- Modify: `F:\3d-babylon-editor\output\playwright\yzj-assets\yzj.model.txt`
- Modify: `F:\3d-babylon-editor\output\playwright\yzj-assets\meta.json`
- Modify: `F:\3d-babylon-editor\output\playwright\validate-yzj-static.mjs`
- Modify: `F:\3d-models\models\.babylon-editor\asset-index.json`

- [x] 从源包复制脚本和元数据到当前项目副本、浏览器 `.ts/.txt` 夹具，避免真实加载入口与源码镜像漂移。
- [x] 重新生成或定向更新 YZJ 资产索引条目的脚本 metadata、参数 schema 和 `assetRevision`。
- [x] 保持 GLB 文件不变。

### Task 4: 更新文档

**Files:**
- Modify: `F:\3d-babylon-editor\README.md`
- Modify: `F:\3d-babylon-editor\docs\yzj-parameter-visual-validation.md`

- [x] 说明入/出料侧与 MQTT 前/后端是独立语义。
- [x] 记录 `frontSide/backSide` 默认值、局部轴映射、1004/1005 配置方式和错误映射的 fail-closed 行为。
- [x] 在最近完成记录中补充本次功能。

### Task 5: 定向验证与清理

- [x] 用 TypeScript `transpileModule` 验证 YZJ 外置脚本语法。
- [x] 解析三份 `meta.json`，断言新参数在三套 schema 中一致。
- [x] 比较三份 `.ts`、浏览器 `.txt` 加载镜像和三份元数据 SHA-256。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `git diff --check` 并复核只修改目标切片。
- [x] 检查并关闭本次任务新启动的 Node/浏览器/子代理进程，不清理用户原有 IDE/服务进程。


