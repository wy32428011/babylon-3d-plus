# YZJ Direction Arrow Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or equivalent bounded execution. Do not revert unrelated worktree changes.

**Goal:** 在图片库、模型 texture 参数、编辑/运行上下文和 YZJ 参数脚本之间建立完整的透明光晕方向箭头链路。

**Architecture:** 内置图片使用稳定逻辑 URI，统一解析到开发/生产 URL；外置脚本接收类型化运行时上下文；YZJ 自己创建并清理 `Ban.4` 子级箭头。保留现有单向伸长、顶升解耦和 Conveyor 辊筒克隆合同。

**Tech Stack:** React、TypeScript、Babylon.js、Vite、Electron、Playwright CLI。

---

### Task 1: 内置图片与 Inspector 拖放
- 生成透明青蓝发光单箭头 PNG，箭头基准指向图片右侧。
- 新增内置图片资产定义、逻辑引用校验及图片拖拽 MIME 编解码。
- 图片库启用方向箭头卡片；texture 参数显示缩略图和拖放目标，drop 后通过现有命令历史提交。

### Task 2: 共享贴图解析与外置脚本上下文
- 新增统一模型贴图 URL 解析器，支持内置逻辑 URI和模型包相对路径。
- SceneRuntime 声明式贴图与 ExternalModelScriptRuntime 参数注入复用同一解析器。
- 外置脚本上下文包含 edit/runtime 模式及最新 telemetry；运行开始、每帧快照和停止均同步清理。

### Task 3: YZJ 发光呼吸箭头
- 新增 `showDirectionArrow` 和 `directionArrowImage` 参数与三套 meta 契约。
- 在 `Ban.4` 顶面创建 Plane、透明发光材质和呼吸观察器。
- 编辑态按 outfeedSide；运行态按 movement_x 正反向，停止/无数据/故障隐藏。
- 资源完整释放，箭头不写 motionSourceNodeName；同步四份脚本与三份 meta。

### Task 4: 验证、文档与生产构建
- 反向更新当前“禁止箭头”的静态验证和文档。
- 增加图片库拖放、四向静态、MQTT 正反停/故障、Ban.4 跟随与停止恢复验证。
- 使用真实生产 Vite bundle 验证 hash PNG 和运行效果，保存开发/生产截图。
- 运行类型检查、构建、模型包扫描和差异检查；清理本次服务、浏览器及临时目录。