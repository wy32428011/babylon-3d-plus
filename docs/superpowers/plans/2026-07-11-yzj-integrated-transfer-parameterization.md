# YZJ 一体式顶升移载参数化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Completed steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让 YZJ `chainLength` 表达为画面左侧固定、只向画面右侧单向伸长；顶升组件独立控制尺寸与位置，并通过业务元数据记录入料侧和出料侧。

**Architecture:** 修改外置 `yzj.model.ts` 与 `meta.json` 参数契约，不改 GLB；通过现有 `ExternalModelScriptRuntime` 执行几何和 metadata 写入，模型绝不生成箭头、标记 Mesh 或额外材质；复用 `output/playwright` 夹具完成结构断言和视觉矩阵。

**Tech Stack:** TypeScript、Babylon.js、Electron/Vite、Playwright 视觉页。

---

### Task 1: 收敛 YZJ 参数元数据

**Files:**
- Modify: `F:\3d-models\models\YZJ\meta.json`
- Modify: `F:\3d-models\models\Assets\Models\YZJ\meta.json`
- Modify: `F:\3d-babylon-editor\output\playwright\yzj-assets\meta.json`

- [x] 新增 `platformPosition` number 参数，默认 `0`，范围 `-100..100`，步长 `0.05`。
- [x] 新增 `infeedSide/outfeedSide` enum 参数及四侧中文选项。
- [x] 同步 `parameterScripts.fields`、`parameterScripts.values` 和 `modelParameters.parameters`。
- [x] 校验三份 meta JSON 可解析且字节一致。

### Task 2: 修复主体与顶升组件几何语义

**Files:**
- Modify: `F:\3d-models\models\YZJ\yzj.model.ts`
- Modify: `F:\3d-models\models\Assets\Models\YZJ\yzj.model.ts`
- Modify: `F:\3d-babylon-editor\output\playwright\yzj-assets\yzj.model.ts`
- Modify: `F:\3d-babylon-editor\output\playwright\yzj-assets\yzj.model.txt`

- [x] 把主体长度映射改为画面左侧固定、只向画面右侧单向伸长。
- [x] 让 `platformLength` 同时控制 `Ban.4` 与 `GT.3`，并采用中心锚定。
- [x] 让 `chainLength` 不再参与 `GT.3` 长度缩放。
- [x] 新增顶升组件位置约束和 `platformPosition` 同步位移。
- [x] 保持 `chainWidth` 对平台宽度和辊筒阵列覆盖宽度的联动。

### Task 3: 增加入料/出料侧定位

**Files:**
- Modify: same `yzj.model.ts` files as Task 2

- [x] 归一化四侧枚举并写入 `metadata.logisticsFlow`。
- [x] 入/出侧只通过模型局部业务元数据表达，不生成箭头、标记 Mesh 或额外材质。
- [x] 参数刷新和 `onStop` 只维护 metadata 恢复，不残留方向可视节点。
- [x] 确认模型旋转后四侧枚举仍按局部轴解释，方向可视节点数量保持为 0。

### Task 4: 更新静态与视觉验证

**Files:**
- Modify: `F:\3d-babylon-editor\output\playwright\validate-yzj-static.mjs`
- Modify: `F:\3d-babylon-editor\output\playwright\yzj-visual-check.html`
- Replace/Update: `F:\3d-babylon-editor\output\playwright\yzj-left-anchor-check.html`（入口可保留旧文件名，断言必须改为右侧单向伸长）
- Modify: `F:\3d-babylon-editor\output\playwright\yzj-platform-length-check.html`
- Create: `F:\3d-babylon-editor\docs\yzj-parameter-visual-validation.md`

- [x] 静态校验断言改为左侧固定、右侧单向伸长、顶升组件独立、新参数存在和三份文件一致。
- [x] 视觉矩阵覆盖默认、右侧单向加长、加宽、顶升正/负偏移、不同入出侧和旋转组合。
- [x] 位置联动案例使用 `platformPosition: -0.20m → +0.35m` 并记录中心差 `0.55m`；`platformPosition = -0.35m` 单独作为左侧边界约束案例，预期被约束到约 `-0.237m`。
- [x] 浏览器读取报告对象，断言尺寸、中心、metadata 和方向可视节点为 0。
- [x] 保存最终视觉截图 `yzj-right-extension-visual.png` 并记录报告数值；未实际生成前不得在文档中写入通过结论。

### Task 5: 文档、构建与清理

**Files:**
- Modify: `F:\3d-babylon-editor\README.md`

- [x] 更新 README 的 YZJ 参数语义和 2026-07-11 变更记录。
- [x] 运行模型脚本 TypeScript 转译、JSON 解析、模型包扫描、`npm run typecheck`、`npm run build`、`git diff --check`。
- [x] 启动 Vite/Electron 或视觉验证页，完成截图与人工视觉复核。
- [x] 终止本次启动的 Vite、Electron、Playwright/Chrome 进程，保留用户原有无关进程。
