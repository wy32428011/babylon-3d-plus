# Scene-global Model Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkboxes for tracking.

**Goal:** 保留可拖拽的模型生成器 POI 配置标记，同时让它统一管理全场景输送机、堆垛机和仓储流自动货物，且任何货物都不继承 POI Transform。

**Architecture:** 模型生成器实体继续承载配置和编辑标记；SceneRuntime 选择场景中第一个生成器作为全局配置源。新增可复用的运行时输出宿主，让仓储活动货物和普通设备货物共用内置 Mesh/导入模型加载、替换、脚本与释放逻辑；普通设备无模板时保留旧 Box 回退。

**Tech Stack:** React、Zustand、TypeScript、Babylon.js、现有 SceneSerializer 与 MQTT telemetry runtime。

---

### Task 1: 固化单例与编辑态语义

**Files:**
- Modify: `src/editor/store/editorStore.ts`
- Modify: `src/editor/panels/InspectorPanel.tsx`

- [x] 创建模型生成器前查找已有实例；存在时只选中并记录提示。
- [x] 在复制、粘贴和阵列路径中阻止模型生成器产生副本。
- [x] Inspector 增加中文说明，明确 Transform 只控制编辑态标记。

### Task 2: 抽象全局模板解析与输出宿主

**Files:**
- Create: `src/runtime/babylon/modelGeneratorRuntime.ts`
- Modify: `src/runtime/babylon/SceneRuntime.ts`

- [x] 提供纯函数按 `sourceId/deviceType/assetCode/fields` 解析规则，未命中时回退共享模板。
- [x] 在 SceneRuntime 中登记统一输出宿主，复用目标签名、加载 token、失败回退、模型参数、外置脚本和资源释放。
- [x] 生成器 marker root 与 warehouse output root 分离，生成输出不可拾取且不参与实体包围盒。

### Task 3: 接管普通 Conveyor 与 Stacker 自动货物

**Files:**
- Modify: `src/runtime/babylon/SceneRuntime.ts`

- [x] 将 `StackerCargoRuntimeEntry`、`ConveyorCargoRuntimeEntry` 改为独立货物根节点 + 生成输出宿主 + 默认 Box 回退。
- [x] 每帧按当前设备快照独立解析全局模板，并在原支撑点替换输出。
- [x] 将旧默认 Box 中心坐标换算为统一底部支撑点；locator 落位使用盒体底面。
- [x] 把普通货物加入外置脚本查找、运行上下文、预览清理和 Runtime dispose 链路。

### Task 4: 收紧全局运行时选择与仓储流

**Files:**
- Modify: `src/runtime/babylon/SceneRuntime.ts`

- [x] 按 `scene.entityIds` 选择首个生成器为全局配置源，多生成器只记录一次冲突诊断。
- [x] 仅活动生成器执行 `warehouseFlow`；其它生成器只显示配置标记。
- [x] 仓储活动输出使用独立世界根节点，存入库位后继续沿用现有 cargo 脱离和状态机。
- [x] 配置源变化、删除或预览结束时释放全部普通与仓储自动货物。

### Task 5: 更新场景和文档

**Files:**
- Modify: `README.md`
- Modify: `docs/stacker-warehouse-flow.md`
- Modify: `docs/superpowers/specs/2026-07-14-model-generator-signal-only-output-design.md`
- Modify: `F:\3d-projects\Stacker MQTT Demo.scene.json` only if wording/config normalization is required

- [x] 删除“在生成器位置生成”的旧描述，记录 POI 仅是配置标记。
- [x] 说明普通 conveyor/stacker 与 warehouseFlow 共用全局模板，位置始终由设备/流程锚点提供。
- [x] README 追加本次变更记录。

### Task 6: 验证与清理

**Files:**
- Verify only

- [x] 运行 `npm run typecheck`，确认 TypeScript 构建图无错误。
- [x] 运行 `npm run build`，确认 Renderer 和 Electron 构建成功。
- [x] 运行只读场景解析脚本，确认示例场景仍只有一个模型生成器且绑定 ID 完整。
- [x] 运行 `git diff --check` 并检查 `git status --short`。
- [x] 回收本任务启动的子代理及残留验证进程。
