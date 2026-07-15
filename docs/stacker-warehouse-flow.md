# Stacker MQTT 1004 → DDJ2 → 库位 → 1005 仓储流

## 1. 适用场景

目标场景：

```text
F:\3d-projects\Stacker MQTT Demo.scene.json
```

场景内关键资产：

| 角色 | deviceType | assetCode |
| --- | --- | --- |
| 入库一体式顶升移载 | `conveyor` | `1004` |
| 双工堆垛机 | `stacker` | `DDJ2` |
| 出库一体式顶升移载 | `conveyor` | `1005` |
| 场景级模型生成器 | - | `1004 前端货物生成器` |

POI 库仍保留“模型生成器”卡片，可点击或拖到场景任意位置。该实体的 Transform 只控制编辑态青色配置标记，不是 1004 前端或任何货物的生成坐标；仓储货物位置只来自 1004/1005 输送面、DDJ2 货叉、locator 和仓储协调器状态。场景中仅 `entityIds` 第一个生成器作为全局自动模型管理器生效，旧场景若有多个生成器，其余只保留编辑标记。共享模板默认是内置立方体；选中生效生成器后，可从模型库把真实托盘、料箱或纸箱模型拖入“共享生成模板”替换默认立方体，仓储流程和三设备绑定不变。

## 2. MQTT 订阅

场景同时订阅：

```text
dt/factory/logistics/stacker/+/twindatadriven/joint
dt/factory/logistics/conveyor/+/twindatadriven/joint
```

运行时继续严格匹配：

```text
sourceId + deviceType + assetCode
```

1004、DDJ2、1005 模型实体均保存显式 `telemetryBinding`，生效模型生成器中的 `warehouseFlow` 再引用三条稳定 binding ID。任一引用缺失、设备类型错误或同一完整主键命中多个模型时，仓储流停止驱动，不按模型名称猜测。

## 3. 输送机字段

协议来源：`F:\软件文档\数字孪生系统接口定义_V4.6_20260114.xlsx.xlsx`。

| 字段 | 语义 |
| --- | --- |
| `signalBits` 位 0 | 前端有货 |
| `signalBits` 位 3 | 后端有货 |
| `signalBits` 位 4 | 顶升低位停准 |
| `signalBits` 位 5 | 顶升高位停准 |
| `front_signalBits != 0` | 前工位有货，优先于总位掩码 |
| `back_signalBits != 0` | 后工位有货，优先于总位掩码 |
| `movement_x` | `0` 停止，`1` 正转，`2` 反转 |
| `movement_y` | `0` 原位，`1` 上升，`2` 下降 |
| `containerCode` | 托盘/料箱条码；空字符串表示无条码 |

解析器会补充以下只读派生字段，便于模型生成器规则和仓储协调器共用：

```text
front_has_goods
back_has_goods
lift_at_low
lift_at_high
```

若 payload 已直接提供同名字段，运行时不会覆盖。

YZJ 模型参数另外保存 `frontSide/backSide`，用于把上述 MQTT 前/后端字段映射到模型局部 `left/right/front/rear`。它们与 `infeedSide/outfeedSide` 独立：当前 1004、1005 均使用 `frontSide=right`、`backSide=left`，但 1004 入料→出料为 `right → left`，1005 入料→出料为 `left → right`。显式端点缺失一侧、值非法或两端重合时，仓储可视锚点解析失败并停止驱动，不自动猜测。旧模型包没有前后端字段时继续兼容原入料→出料路径。

## 4. DDJ2 字段

协议来源：`数字孪生系统接口定义 / 堆垛机数据同步` 和 `双工堆垛机协议V5.2.xlsx`。

| 字段 | 编码 | 语义 |
| --- | ---: | --- |
| `front_command/back_command` | 1 | 取货中 |
|  | 2 | 取货完成 |
|  | 3 | 放货中 |
|  | 4 | 请求卸货/申请卸货 |
|  | 5 | 放货完成 |
|  | 6 | 取货准备 |
|  | 8 | 急停 |
| `front_containerCode/back_containerCode` | 字符串 | 对应货叉上的条码 |
| `movement_x` | 0/1/2 | 静止/前进/后退 |
| `movement_y` | 0/1/2 | 原位/上升/下降 |
| `front_movement_z/back_movement_z` | 0..4 | 货叉停止、伸出、回收方向 |
| `to_x/to_y/to_z` | 整数 | 组合为 locator 编号 `x-y-z` |

## 5. 入库流程

1. 1004 `front_has_goods=true`：生效的场景级生成器按当前快照解析规则/共享模板，创建运行时货物实例并锁定 `containerCode`；相同真实条码若已在库位或出库流程中，直接拒绝重复生成。若没有可用模板，仓储流 fail-closed，不创建仓储货物。
2. 1004 `movement_x=1`：显式映射存在时，货物按 YZJ `frontSide → backSide` 从 MQTT 前端向后端移动；前后光电直接校准端点。旧模型包才回退 `infeedSide → outfeedSide`。
3. 货物到达后端后进入 `inbound-lifting`：`Ban.4/GT.3` 顶升，货物 Y 坐标读取实际顶面并随平台上升。
4. 只有后端有货且 `lift_at_high=true`；若高位字段缺失则要求 `movement_y=0`，DDJ2 才允许接管。低位或仍在升降时，即使提前收到取货命令也保持等待。
5. DDJ2 某侧 `command=1/2`：对应货叉接管同一条码；货物随后跟随货叉、载货台和堆垛机行走/升降。
6. DDJ2 `command=3/4/5` 且 `to_x-to_y-to_z` 命中 locator：货物从货叉插值进入库位。
7. `command=5` 会锁存“放货完成”事件；即使生成模型仍在异步加载或后续命令复位，运行时仍会重试登记，成功后把当前输出脱离活动输出根节点并固定在 locator。

入库完成后必须观察到一次 1004 前端光电清空，才允许下一次生成，避免同一持续信号重复创建。

## 6. 出库流程

1. DDJ2 `command=1/2`：优先按货叉条码查找已入库实例；条码暂缺时按目标 locator 查找。
2. `outbound-retrieving`：货叉伸出时货物留在 locator，货叉回收或 `command=2` 后货物跟随货叉。
3. `outbound-carrying`：DDJ2 行走/升降到 1005 后端，货物继续跟随实际货叉和载货台。
4. `command=3/4/5` 进入 `outbound-handoff`，按 45% / 85% / 100% 的锁存交接进度把货物从货叉送到 1005 入料端；重复 MQTT 帧不会重复创建或回退货物。
5. 1005 后端有货或 `containerCode` 一致后接管同一实例，并把输送进度重置为后端 0 点，避免沿用 DDJ2 交接进度。
6. 若 `lift_at_low=false` 且水平输送尚未启动，进入 `outbound-lowering`；货物固定在 1005 后端并跟随实际顶升面下降。
7. 低位到位、低位状态未知但升降已停止，或现场已启动 `movement_x` 后进入 `outbound-transfer`；显式映射存在时按 `backSide → frontSide` 从 MQTT 后端移到前端，旧模型包才回退 `infeedSide → outfeedSide`。
8. 前端光电清空、条码清空、设备停止且顶升低位稳定超过短暂窗口后，运行时释放该货物实例。

## 7. 可视实例与并发边界

- 同一 `containerCode` 只保留一个仓储可视实例；条码在临时编号升级后若撞到已入库/正在出库货物，会取消新实例并冻结冲突帧。
- 1004、DDJ2、1005 由仓储流托管后，旧的 Conveyor/Stacker 默认 Box 货物关闭，避免重复。
- 生效的场景级生成器同一时刻最多处理一件入库和一件出库；已入库货物可同时保存在多个 locator。
- 同一 DDJ2 同时只能执行一条货叉作业；若出库占用 DDJ2，新的入库货物可停在 1004 后端，等待堆垛机释放。
- DDJ2 前后叉同时有活动证据时，依次用 `to_choose_fork/choose_fork`、当前活动条码、已入库条码和唯一命令侧消歧；仍无法唯一确定时不默认选择前叉，而是冻结并记录诊断。
- 新建、复制、粘贴或阵列都不会产生第二个有效模型生成器；需要多条独立入库线时，应在后续设计中扩展生成器内部的多流配置，而不是复制生成器实体。

## 8. stale、故障和冲突

- `DeviceTelemetryStore` 先按 `sequence/sourceTimestamp/receivedAt` 拒绝乱序帧，并对同内容重复帧保持幂等；协调器的一次性事件还会由状态锁存，避免重复 `command=5` 反复创建货物。
- stale 或故障时冻结货物当前位置，不销毁已入库实例；入库完成后的重新触发门只有在收到一帧有效且 1004 前端光电为 false 时才解除，stale 不视为清空。
- 活跃货物出现两个不同非空条码时冻结并写入 Console，不自动猜测哪个条码正确。
- locator 已有运行时货物时拒绝覆盖。
- 停止运行预览、删除生效生成器、切换场景或销毁 SceneRuntime 时，统一释放活动输出、已入库货物根节点、模型容器、材质、贴图和脚本。普通 Conveyor/Stacker 的旧默认 Box 仅作为无生成器、无模板或模板最终加载失败的降级可视化；warehouseFlow 无模板时始终拒绝启动货物。
- 全部行为仅存在运行时内存，不修改 scene 的 locator 占用状态，也不向 broker/PLC/WCS/WMS 发布命令。

## 9. 排障顺序

1. Toolbar 已点击“运行”，MQTT 状态不是 disabled/error。
2. subscriptions 同时包含 stacker 与 conveyor topic。
3. 1004、DDJ2、1005 的 `modelAsset.assetCode` 和 `telemetryBinding.deviceType` 正确。
4. payload `data[].e` 与 topic 资产编号一致。
5. 1004 是否出现 `front_has_goods=true`，`entityIds` 第一个模型生成器是否配置共享模板或可命中的规则目标。
6. DDJ2 的条码是否与 1004 相同，`to_x/to_y/to_z` 是否能找到唯一 locator。
7. 1005 是否先出现后端有货，再出现前端有货。
8. Console 是否报告绑定缺失、模型冲突、条码冲突、库位占用或目标模板缺失。
