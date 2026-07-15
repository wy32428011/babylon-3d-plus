# 项目全链路米制单位契约实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让内置模型、普通模型、模型生成器、环境模型与 CAD 图纸统一以米进入场景，并保留旧场景兼容和单位审计信息。

**Architecture:** 保持 `1 scene unit = 1 m` 与 Transform 契约不变。模型类资产在内容根节点应用源单位缩放；CAD 在解析阶段把坐标转换为米；环境配置和 CAD 组件持久化必要的单位元数据。

**Tech Stack:** TypeScript、React、Zustand、Electron、Babylon.js、Vite SSR smoke、Markdown。

---

### Task 1: 建立可失败的单位契约 smoke

**Files:**
- Create: `scripts/smoke-meter-unit-contract.mjs`
- Modify: `package.json`

- [x] 覆盖 CAD yard、unitless + `$MEASUREMENT`、环境 cm/mm 持久化、旧环境场景米制回填和内置几何常量。
- [x] 运行 `npm run smoke:units`，确认当前实现因环境单位缺失与 CAD 单位覆盖不完整而失败。

### Task 2: 集中内置模型米制几何

**Files:**
- Modify: `src/editor/model/builtInMeshGeometry.ts`
- Modify: `src/runtime/babylon/SceneRuntime.ts`
- Modify: `src/editor/assets/projectLibrary.ts`
- Modify: `src/editor/panels/InspectorPanel.tsx`

- [x] 为 Cube/Sphere/Plane 定义米制基准尺寸和中文说明。
- [x] 普通内置 Mesh 与模型生成器内置输出共用同一常量。
- [x] 资源卡片和 Inspector 显示实际米制基准，保留 scale 无量纲语义。

### Task 3: 补齐环境模型单位链路

**Files:**
- Modify: `src/editor/model/SceneDocument.ts`
- Modify: `src/editor/assets/environmentAssets.ts`
- Modify: `src/editor/project/SceneSerializer.ts`
- Modify: `src/runtime/babylon/SceneRuntime.ts`
- Modify: `src/editor/panels/SceneSettingsPanel.tsx`

- [x] `SceneEnvironmentSettings` 保存 `lengthUnit + unitScaleToMeters`。
- [x] 资产到环境配置时按源单位建立标准米制换算。
- [x] 旧场景缺失字段默认 `meter / 1`，非法组合拒绝。
- [x] Runtime 在环境根节点应用单位缩放，单位变化触发重建。
- [x] UI 展示当前环境源单位与换算系数。

### Task 4: 完整覆盖 CAD 单位识别与审计

**Files:**
- Create: `src/editor/cad/cadUnits.ts`
- Modify: `src/editor/cad/cadReference.ts`
- Modify: `src/editor/cad/cadReferenceLargeDxf.ts`
- Modify: `src/editor/model/components.ts`
- Modify: `src/editor/project/SceneSerializer.ts`
- Modify: `src/editor/store/editorStore.ts`
- Modify: `src/editor/panels/InspectorPanel.tsx`

- [x] 实现 `$INSUNITS` 0–24 到米的标准映射。
- [x] unitless/缺失单位读取 `$MEASUREMENT`，最终 fallback 明确记录。
- [x] 普通与大文件解析复用同一单位解析器。
- [x] CAD 组件保存单位代码、名称和判定来源，旧场景安全回填。
- [x] Inspector 与导入日志展示来源单位到米的转换。

### Task 5: 收紧模型资产单位边界

**Files:**
- Modify: `src/editor/model/sceneUnits.ts`
- Modify: `src/editor/store/editorStore.ts`
- Modify: `src/editor/model/modelGenerator.ts`

- [x] 增加从受支持 `lengthUnit` 生成标准换算信息的公共函数。
- [x] 普通导入、重新导入刷新和模型生成器目标不直接信任外部换算系数。

### Task 6: 文档与验证

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-14-project-wide-meter-unit-contract.md`

- [x] 更新项目全链路米制契约、环境模型和 CAD fallback 说明。
- [x] 运行 `npm run smoke:units`、`npm run typecheck`、`npm run build`、`git diff --check`。
- [x] 对照规格逐项核验，并确认没有覆盖工作树已有改动。
- [x] 清理本任务启动的进程和临时文件。


## 完成验证记录

- `npm run smoke:units`：通过；覆盖 `$INSUNITS` 1–24、`$MEASUREMENT` 英制推断、毫米 fallback、普通/大文件 CAD 一致性、环境 cm 换算、旧环境场景米制回填、内置 Cube/Sphere/Plane 尺寸与落地偏移。
- `npm run typecheck`：通过。
- `npm run build`：通过；renderer、CAD Worker 与 Electron TypeScript 均构建成功，仅保留既有大 chunk 警告。
- 目标文件 `git diff --check`：通过。
- 多智能体代码审查：未发现 P0/P1/P2；当前仓库原本存在大量无关未提交改动，本次未执行重置、提交或清理用户已有文件。
- 资源回收：单位 smoke 内部 Vite server 已关闭，`5173`/`4173` 无监听，本次子代理均已关闭；未终止机器上与本任务无关的 Node/Chrome/Edge 进程。
