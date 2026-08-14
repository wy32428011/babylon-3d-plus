# 发布 Viewer 场景加载蒙版 Implementation Plan

**Goal:** 发布后的独立 Web Viewer 打开场景后，在配置读取、场景文档解析、引擎创建、模型与环境资源加载全部落定前，持续显示与编辑器一致的品牌全屏蒙版（ZENDING Logo 蓝色填充、蓝色进度条、百分数与阶段详情）。

**Architecture:** 抽取编辑器已验证的蒙版为共享组件 `SceneLoadingMask`（含品牌资源与样式），编辑器与发布 Viewer 复用同一视觉；Viewer 侧新增纯函数进度映射 `playerLoadingProgress`，由启动里程碑与 SceneRuntime 模型/环境资源加载单元共同驱动，并增加 120 秒超时兜底。

**Tech Stack:** React 19、TypeScript、CSS Modules、Node test runner、Playwright。

---

### Task 1: 共享品牌蒙版组件

**Files:**
- Create: `src/shared/ui/SceneLoadingMask.tsx`
- Create: `src/shared/ui/SceneLoadingMask.module.css`
- Modify: `src/editor/loading/ScenePreparationOverlay.tsx`（收敛为订阅 + 焦点管理，渲染共享组件）
- Delete: `src/editor/loading/ScenePreparationOverlay.module.css`（迁移至共享目录）
- Modify: `tests/editor/scenePreparationInteractionGateContract.test.ts`（aria-busy 断言移至共享组件）

- [x] **Step 1: 抽取共享组件**
- [x] **Step 2: 编辑器保持焦点/aria 契约并通过契约测试**

### Task 2: 发布 Viewer 进度映射与接入

**Files:**
- Create: `src/player/playerLoadingProgress.ts`
- Create: `tests/digitalTwin/playerLoadingProgress.test.ts`
- Modify: `src/player/PlayerApp.tsx`
- Modify: `src/player/player.css`
- Modify: `src/runtime/babylon/SceneRuntime.ts`（模型/环境加载单元进度上报，含环境并行单元）

- [x] **Step 1: 纯函数进度映射与 8 个单测**
- [x] **Step 2: PlayerApp 以共享全屏蒙版替换底部进度条**
- [x] **Step 3: 首次加载完成标记 + 120 秒超时兜底**

### Task 3: 文档、审查与验证

**Files:**
- Modify: `README.md`
- Modify: `design/qa.md`

- [x] **Step 1: 文档更新**
- [x] **Step 2: 验证**
  - `node --experimental-strip-types --test tests/digitalTwin/playerLoadingProgress.test.ts`（8/8）
  - 编辑器/播放器相关测试 32/32 通过
  - `npm run typecheck`、`npm run build`（编辑器 + Viewer + Electron）通过
  - Playwright 真实浏览器（硬件 WebGL）：蒙版显示、进度推进、模型阶段详情、收起时机
