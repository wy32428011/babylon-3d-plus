# 场景准备进度蒙版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 数字孪生编辑器打开场景后，在模型同步、场景资产刷新、运行时模型加载与 Geometry 合批全部落定前持续显示带百分数的品牌进度蒙版。

**Architecture:** 新增与场景文档解耦的外部进度状态机，使用 `sceneSessionId` 隔离过期异步事件。`ProjectPanel` 上报数据中台模型同步和资产热刷新，`SceneViewPanel` 根据模型测量状态与实际 thinInstance 指标上报运行时准备度，`EditorLayout` 订阅并渲染全编辑器蒙版。

**Tech Stack:** React 19、TypeScript、Zustand 既有场景 Store、Node test runner、CSS Modules。

---

### Task 1: 场景准备进度状态机

**Files:**
- Create: `src/editor/loading/scenePreparationProgress.ts`
- Test: `tests/editor/scenePreparationProgress.test.ts`

- [x] **Step 1: Write the failing test**

覆盖模型同步分数映射、刷新门控、运行时加载/合批门控、百分比单调与失败收口。

- [x] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/editor/scenePreparationProgress.test.ts`
Expected: FAIL，因为进度状态机模块尚不存在。

- [x] **Step 3: Write minimal implementation**

实现纯 reducer、外部订阅 Store 和按 `sceneSessionId` 丢弃过期事件的上报 API；只有模型同步已决、资产刷新完成、运行时模型全部落定且合批达到预期时才允许到达 100%。

- [x] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/editor/scenePreparationProgress.test.ts`
Expected: PASS。

### Task 2: 接入模型同步与场景资产刷新

**Files:**
- Modify: `src/editor/panels/ProjectPanel.tsx`

- [x] **Step 1: Report model synchronization**

将既有 `DataPlatformModelSyncProgress` 的阶段和数量上报状态机；`failed` 作为带警告的已决状态，避免永久遮罩。

- [x] **Step 2: Gate scene asset refresh**

同步完成后 `loadProjectAssets(true)` 开始时上报刷新中，Promise 落定后上报成功或失败；无模型同步时在初始资源加载完成后按短暂发现窗口标记跳过同步。

### Task 3: 接入 Babylon 模型加载与 Geometry 合批

**Files:**
- Modify: `src/editor/panels/SceneViewPanel.tsx`

- [x] **Step 1: Observe runtime readiness**

按帧节流读取全部导入模型的 `getModelMeasurement()`，统计 loading/settled；读取 `getPerformanceMetrics().modelArrayBatchEntityCount`，并与派生编辑态文档中的可见 `modelArrayInstance` 及其源模型数量对齐合批进度。

- [x] **Step 2: Publish stable completion**

运行时在连续两个采样周期满足模型全部落定且合批达到预期后上报完成；场景或资产修订变化时启动新一代运行时门控。

### Task 4: 品牌进度蒙版

**Files:**
- Create: `src/editor/loading/ScenePreparationOverlay.tsx`
- Create: `src/editor/loading/ScenePreparationOverlay.module.css`
- Modify: `src/editor/layout/EditorLayout.tsx`
- Modify: `src/editor/layout/EditorLayout.module.css`
- Add: `src/assets/branding/zending-scene-loading-logo.png`

- [x] **Step 1: Render accessible overlay**

在编辑器壳顶层渲染 `role="progressbar"`、阶段说明、详情、百分数与蓝色填充条，遮罩拦截全部鼠标交互。

- [x] **Step 2: Apply referenced branding**

复用用户提供的透明 ZENDING 图片；进度填充采用科技蓝，不更改现有品牌资产。

### Task 5: 文档、审查与验证

**Files:**
- Modify: `README.md`

- [x] **Step 1: Document user-visible behavior**

在数据中台资源同步说明中补充场景准备蒙版的开始、结束与失败收口行为。

- [x] **Step 2: Review diff**

检查过期事件、定时器释放、React 重渲染、可访问性、错误路径和未授权接口变化。

- [x] **Step 3: Run verification**

Run: `node --experimental-strip-types --test tests/editor/scenePreparationProgress.test.ts tests/editor/scenePreparationRuntimeMonitorContract.test.ts tests/editor/scenePreparationInteractionGateContract.test.ts tests/editor/scenePreparationProjectPanelContract.test.ts tests/dataPlatform/modelPreloadProgressGateContract.test.ts`

Run: `npm run typecheck`

Run: `npm run build`

Expected: 全部退出码为 0。

验证结果：定向测试 22/22 通过，类型检查和生产构建退出码均为 0；`git diff --check` 无空白错误。Playwright 冷启动验证确认蒙版覆盖完整视口、焦点和键盘输入被拦截、首次准备完成后消失，同一场景再次同步和刷新时会重新出现并再次收口。
