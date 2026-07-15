# POI Built-in EFF Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or equivalent bounded execution. Steps use checkbox syntax for tracking.

**Goal:** 在 POI 库内置 15 个可创建、可编辑、可持久化并由 Babylon 实时渲染的工业 EFF 特效。

**Architecture:** 使用统一 `PoiEffectComponent` 和声明式预设表承载 15 个类型；编辑器层复用现有 BuiltIn 拖拽、Zustand 命令和 SceneSerializer；Babylon 层由独立 `PoiEffectRuntime` 管理稳定实体根节点、拾取壳、粒子/几何资源及单一逐帧观察者。

**Tech Stack:** TypeScript 6、React 19、Zustand 5、Babylon.js 9、Electron 42。

---

### Task 1: EFF 类型、预设和实体工厂

**Files:**
- Create: `src/editor/model/poiEffect.ts`
- Modify: `src/editor/model/components.ts`
- Modify: `src/editor/model/SceneDocument.ts`

- [x] 定义 15 个稳定 `PoiEffectKind`。
- [x] 定义统一 `PoiEffectComponent`。
- [x] 提供中文名称、默认颜色、强度、速度、密度和卡片图标的预设表。
- [x] 提供类型守卫、数值/颜色归一化和默认组件工厂。
- [x] 新增 `createPoiEffectEntity()`，Transform 使用米制场景默认值。

### Task 2: 序列化、命令和 Store

**Files:**
- Modify: `src/editor/project/SceneSerializer.ts`
- Modify: `src/editor/commands/entityCommands.ts`
- Modify: `src/editor/store/editorStore.ts`

- [x] 将 `poiEffect` 加入组件白名单和运行时组件判断。
- [x] 新增严格反序列化和参数范围归一化。
- [x] 复制实体时深拷贝 `poiEffect`。
- [x] 新增可撤销 `updatePoiEffectCommand`。
- [x] 新增 `createPoiEffect` 与 `updateSelectedPoiEffect` Store action。

### Task 3: POI 资源卡片和拖拽创建

**Files:**
- Modify: `src/editor/assets/AssetDatabase.ts`
- Modify: `src/editor/assets/projectLibrary.ts`
- Modify: `src/editor/panels/ProjectPanel.tsx`
- Modify: `src/editor/panels/SceneViewPanel.tsx`

- [x] 扩展 BuiltIn 拖拽载荷支持 `poi-effect`。
- [x] 在 POI 库登记 15 个可操作卡片，保留现有模型生成器。
- [x] 点击卡片创建特效。
- [x] 拖入 Scene View 时按地面交点创建特效。

### Task 4: Inspector 通用编辑器

**Files:**
- Create: `src/editor/panels/PoiEffectInspector.tsx`
- Modify: `src/editor/panels/InspectorPanel.tsx`
- Modify: `src/styles/global.css`

- [x] 提供特效类型、启用状态、主/辅颜色、强度、速度和密度编辑。
- [x] 类型切换应用对应预设默认值。
- [x] 明确 Transform 的位置、方向和尺寸语义。
- [x] 保持紧凑布局和中文维护注释。

### Task 5: Babylon EFF 运行时

**Files:**
- Create: `src/runtime/babylon/effects/PoiEffectRuntime.ts`
- Modify: `src/runtime/babylon/SceneRuntime.ts`

- [x] 实现稳定根节点、透明拾取壳、签名重建和统一资源释放。
- [x] 实现报警脉冲光圈、旋转警示灯、定位光柱、雷达扫描圈。
- [x] 实现火焰、烟雾、火花、蒸汽泄漏、气体泄漏、水流喷射。
- [x] 实现管线粒子、管线箭头、货物目标框、输送箭头、疏散路线。
- [x] 接入 Gizmo、拾取、包围盒、显隐、锁定、选择和 SceneRuntime dispose。

### Task 6: 文档和验证

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-15-poi-built-in-eff-effects-design.md`

- [x] 记录 15 个 EFF、创建方式、Inspector 参数和性能语义。
- [x] 执行 `npm run typecheck`。
- [x] 执行 `npm run build`。
- [x] 执行 `git diff --check` 并检查改动文件清单。
- [x] 清理本任务启动的 Node、Vite、Electron 或浏览器验证进程。

