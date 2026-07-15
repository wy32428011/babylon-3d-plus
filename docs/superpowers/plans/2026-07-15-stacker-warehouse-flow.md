# Stacker Warehouse Flow Implementation Plan

> **For agentic workers:** 仓储流基础能力和目标场景已存在；本计划用于补强现有实现，不得重复创建、覆盖或重置工作区中的其它未提交功能。

**Goal:** 让 1004、DDJ2、虚拟库位和 1005 严格按现场 MQTT 顺序完成可连续复用的入库/出库流转，并保证同一条码只有一个运行时可视实例。

**Architecture:** `DeviceTelemetryStore` 负责严格主键、乱序和重复快照过滤；`WarehouseFlowCoordinator` 维护纯业务阶段与幂等事件；`SceneRuntime` 负责三设备唯一匹配、世界锚点、货物实例和资源释放。全部行为只修改运行时内存，不写回场景占用或外部系统。

**Tech Stack:** TypeScript, Babylon.js, React/Zustand, Vite SSR 只读 smoke, Electron MQTT IPC.

---

## 当前基线

- `ModelGeneratorComponent.warehouseFlow`、Inspector、sanitize 和 SceneSerializer 已存在。
- `deviceTelemetry.ts` 已派生 Conveyor 前后有货与顶升高/低位字段。
- `WarehouseFlowCoordinator.ts` 与 `SceneRuntime.ts` 已接入基础入库/出库流程。
- `F:\3d-projects\Stacker MQTT Demo.scene.json` 已包含 301 个实体、294 个唯一 locator、1004/DDJ2/1005 严格绑定、一个仓储生成器和两类 MQTT subscription。

## Task 1: 补强纯状态协调器

**Files:**
- Modify: `src/runtime/babylon/warehouse/WarehouseFlowCoordinator.ts`

- [x] 增加 `inbound-lifting`，只有 1004 后端有货且顶升高位就绪后才允许 DDJ2 接管。
- [x] 增加 `outbound-handoff` 与 `outbound-lowering`，覆盖 DDJ2 放到 1005 后端、1005 托住并下降、再水平输出的机械顺序。
- [x] 在真实条码启动和临时条码升级两个边界检查已入库/正在出库条码，拒绝第二个可视实例。
- [x] 出库占用 DDJ2 时，新的入库货物只允许停在 1004，不消费同一堆垛机帧。
- [x] 锁存入库 `command=5` 和出库交接进度，重复帧保持幂等，命令复位不回退状态。
- [x] 入库完成后只接受有效前端光电清空帧解除重触发门，stale 不视为清空。

## Task 2: 补强 SceneRuntime 接力与诊断

**Files:**
- Modify: `src/runtime/babylon/SceneRuntime.ts`

- [x] Conveyor 帧向协调器传递 `movement_y/lift_at_low/lift_at_high`。
- [x] DDJ2 双叉同时活跃时按叉选择字段、当前条码、已入库条码和唯一命令侧消歧；仍不唯一时冻结并诊断。
- [x] 仓储可视阶段覆盖 1004 顶升、DDJ2→1005 交接、1005 下降和水平输送。
- [x] 1005 首次接管时把输送进度重置为后端 0 点，避免沿用 DDJ2 交接进度造成跳到前端。
- [x] 仓储设备模型缺失或重复时 fail-closed，不按名称或唯一数量猜测。
- [x] 视觉读取同样遵守 TTL；停止预览、切场景和删除生成器继续释放活动/已存货物与派生资源。

## Task 3: 保持场景配置闭环

**Files:**
- Verify: `F:\3d-projects\Stacker MQTT Demo.scene.json`

- [x] 1004、DDJ2、1005 分别保存 `conveyor/stacker/conveyor` telemetryBinding，`sourceId=default`。
- [x] `1004 前端货物生成器` 使用三条稳定 binding ID 并启用 `warehouseFlow`。
- [x] 同时订阅 stacker 与 conveyor wildcard topic。
- [x] 保持 294 个 locator ID 唯一，未改动既有 locator 编号、模型参数和其它实体。

## Task 4: 文档与验证

**Files:**
- Modify: `README.md`
- Modify: `docs/stacker-warehouse-flow.md`
- Modify: `docs/superpowers/specs/2026-07-15-stacker-warehouse-flow-design.md`

- [x] 文档写明高位接管、后端交接、低位下降、双叉消歧、重复条码和 stale/幂等规则。
- [x] `npm run typecheck`：退出码 0。
- [x] 纯内存协调器 smoke：覆盖完整入库/出库阶段和重复条码拒绝，不连接 broker。
- [x] Vite SSR 场景反序列化 smoke：301 个实体、294 个唯一 locator、1 个仓储生成器、3 台设备和 2 个 subscription 均通过。
- [x] `npm run build`：退出码 0；仅保留 Vite 大 chunk 警告。
- [x] `git diff --check`：仓储相关 tracked/untracked 文件均无空白错误，仅有 LF/CRLF 提示。
- [x] 独立审查原 P1/P2 已收口；架构审查的低位完成条件已补强，双叉冲突由 SceneRuntime 显式冻结。
- [x] 已关闭子代理并确认无本任务 `node --input-type=module`、Vite middleware 或相关浏览器残留；用户已有服务未终止。
