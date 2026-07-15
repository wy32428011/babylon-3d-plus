# 模型库 Box 米制拖拽实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让模型库内置 Box 拖入场景后按米制尺寸表达并以底面落地。

**Architecture:** 保持 `Transform.scale` 和场景序列化不变，新增 1 米 Box 基准常量，在资源卡片、Inspector UI 与 Scene View 拖拽落点边界复用。运行时继续创建单位 Box，只把硬编码 `1` 替换为有米制语义的常量。

**Tech Stack:** TypeScript、React、Zustand、Babylon.js、Markdown。

---

### Task 1: 集中 Box 米制基准

**Files:**
- Create: `src/editor/model/builtInMeshGeometry.ts`
- Modify: `src/runtime/babylon/SceneRuntime.ts`

- [x] 新增 `BUILT_IN_BOX_SIZE_METERS = 1` 和 cube 地面中心偏移函数，使用中文注释说明单位契约。
- [x] `SceneRuntime.createMesh` 使用常量创建 Box，保持现有几何大小不变。

### Task 2: 拖拽落地与 Inspector 米制表达

**Files:**
- Modify: `src/editor/panels/SceneViewPanel.tsx`
- Modify: `src/editor/panels/InspectorPanel.tsx`
- Modify: `src/editor/assets/projectLibrary.ts`

- [x] cube drop 的位置 Y 增加 `0.5 m`，其它内置 Mesh 路径不变。
- [x] cube 的 Transform scale legend 显示为 `size (m)`；其它实体仍显示 `scale`。
- [x] Box 卡片副标题显示 `1 m × 1 m × 1 m`。

### Task 3: 文档与验证

**Files:**
- Modify: `README.md`

- [x] 更新内置 Box 的米制尺寸和拖拽落地说明，并追加 2026-07-14 完成记录。
- [x] 运行 `npm run typecheck`、`npm run build` 和目标文件 `git diff --check`。
- [x] 审查工作区差异，确认未覆盖已有未提交改动。
