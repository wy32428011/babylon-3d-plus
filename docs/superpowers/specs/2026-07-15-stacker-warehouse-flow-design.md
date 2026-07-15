# Stacker MQTT 仓储入库/出库联动设计

## 目标

在 `F:\3d-projects\Stacker MQTT Demo.scene.json` 中实现一条只读 MQTT 可视化仓储流程：

- 入库：1004 前端检测有货后，由模型生成器创建货物；1004 将货物从前端送到后端并完成顶升；DDJ2 取货后随载货台移动到 `to_x-to_y-to_z` 对应的虚拟定位框，再由货叉放入库位。
- 出库：DDJ2 根据取货命令从目标虚拟定位框取出同一货物，随载货台移动到 1005 后端；1005 托住货物、下降，并把货物从后端送到前端。
- MQTT 只驱动运行时内存与 Babylon 节点，不回写 PLC/WCS/WMS，不把货物实例写入 `.scene.json`。

## 协议依据

- `F:\软件文档\数字孪生系统接口定义_V4.6_20260114.xlsx.xlsx` / `输送机数据同步`：
  - `signalBits` 位 0：前端有货；位 3：后端有货；位 4：低位停准；位 5：高位停准。
  - `movement_x`：0 停止、1 正转、2 反转。
  - `movement_y`：0 原位、1 上升、2 下降。
  - `containerCode`：托盘/料箱条码。
- 同文件 / `输送机数据同步(http)`：`front_signalBits`、`back_signalBits` 非零分别表示前、后工位有货。
- 同文件 / `堆垛机数据同步`，以及 `F:\软件文档\双工堆垛机协议V5.2.xlsx`：
  - `front_command/back_command`：1 取货中、2 取货完成、3 放货中、4 请求卸货、5 放货完成、6 取货准备、8 急停。
  - `front_containerCode/back_containerCode`：对应货叉上的条码。
  - `movement_x/movement_y` 驱动行走和载货台；`front_movement_z/back_movement_z` 驱动货叉。
  - `to_x/to_y/to_z` 组合为虚拟库位编号。

## 方案选择

### 推荐：模型生成器声明配置 + 独立仓储协调器

1. `ModelGeneratorComponent` 新增可选 `warehouseFlow`，只引用三条既有 MQTT 绑定：入库输送机、DDJ2、出库输送机。
2. `WarehouseFlowCoordinator` 只维护业务阶段、条码、输送进度和一次性事件，不直接依赖 Babylon。
3. `SceneRuntime` 继续负责模型查找、世界坐标、货叉/输送机锚点和可视实例生命周期，通过协调器结果移动货物。
4. 同一 `containerCode` 始终只保留一个仓储货物可视实例；参与仓储流的设备不再创建旧的默认 Box 货物，避免重复。
5. 入库完成后把当前生成器输出从生成器根节点脱离并登记为已入库货物，生成器随后可接收下一件货物；因此支持多个已占用库位，而不是把整个场景限制为单件货物。

### 未采用

- 不把 `1004/1005/DDJ2` 写死到通用 `SceneRuntime`；资产编号来自场景绑定。
- 不让 YZJ/Stacker 外置模型脚本承担跨设备编排；脚本只负责设备自身几何和方向表现。
- 不依赖名称猜测设备；继续严格匹配 `sourceId + deviceType + assetCode`。

## 状态机

### 入库

1. `idle`：等待 1004 `front_has_goods=true`；真实条码若已存在于库位或出库流程，拒绝生成。
2. `inbound-front`：锁定 `containerCode`；无条码时生成运行时临时编号，真实条码出现后升级为真实编号，升级后仍做全局唯一性检查。
3. `inbound-transfer`：1004 `movement_x=1` 时从入料侧向出料侧推进；前后光电直接校准进度端点。
4. `inbound-lifting`：后端有货但未到高位时，货物跟随顶升面上升；高位字段明确为 false 时禁止 DDJ2 提前接管。
5. `inbound-pickup`：后端有货且高位到位后，DDJ2 某侧 `command=1/2` 接管同一条码，货物从 1004 后端切换到对应货叉。
6. `inbound-carrying`：货物跟随货叉、载货台和 DDJ2 行走/升降。
7. `inbound-storing`：`command=3/4/5` 且目标 locator 有效时，从货叉向目标框插值；`command=5` 锁存完成请求，直至实例成功登记。
8. `stored`：货物固定在 locator，生成器恢复待机；只有收到有效的 1004 前端光电清空帧后才允许下一件入库。

### 出库

1. `stored`：按 `containerCode` 优先、目标 locator 次优先找到已入库货物。
2. `outbound-retrieving`：DDJ2 `command=1`；货叉伸出时货物留在 locator，货叉回收时货物跟随货叉。
3. `outbound-carrying`：`command=2` 后货物跟随 DDJ2 载货台移动到 1005。
4. `outbound-handoff`：DDJ2 `command=3/4/5` 把货物从货叉送至 1005 后端；交接进度锁存，命令复位不会把货物拉回货叉。
5. `outbound-lowering`：1005 后端有货或条码一致时接管，顶升未到低位时货物固定在入料端并跟随实际顶面下降。
6. `outbound-transfer`：低位到位或现场已启动水平输送后，按 `movement_x=1` 从入料侧移动到出料侧。
7. `outbound-front`：1005 前端有货时停在前端；前端光电清空、条码清空、设备停止且顶升低位稳定后释放该运行时货物。

## 信号归一

通用遥测解析层为 conveyor 补充只读派生字段：

- `front_has_goods`
- `back_has_goods`
- `lift_at_low`
- `lift_at_high`

优先使用显式 `front_signalBits/back_signalBits`，否则读取 `signalBits` 位掩码；若 payload 已明确提供同名派生字段则不覆盖。

## 坐标与可视连续性

- 1004/1005 的入料、出料方向读取 YZJ `logisticsFlow` metadata；缺失时从参数值读取，仍不按设备名称猜测。
- 输送端点使用模型真实世界包围盒和 `infeedSide/outfeedSide` 计算；货物 Y 坐标使用 `Ban.4/GT.3` 顶面，因此自动跟随顶升。
- DDJ2 搬运时复用现有货叉节点、载货台、目标 locator 和两段货叉行程。
- 已入库货物保留原模型生成器输出，不替换成默认 Box；出库时移动同一实例。

## 冲突与恢复

- 绑定缺失、类型错误、资产编号不匹配：不启动流程并记录一次诊断。
- 同一活跃货物出现不同非空条码：冻结当前位置，不猜测归属；同条码已存在于库位或出库流程时拒绝第二个实例。
- DDJ2 前后叉同时活跃：优先按叉选择字段和条码消歧；无法唯一确定时冻结，不默认选择前叉。
- `DeviceTelemetryStore` 负责乱序和重复快照过滤；协调器阶段与完成事件保持幂等。
- stale 或故障：冻结货物，不销毁已入库实例；有效后继帧到达后从当前位置恢复。
- 入库前端信号持续不清：入库完成后等待一帧有效的前端清空再允许下一次触发，stale 不视为清空。
- 一个生成器同一时刻只处理一件入库和一件出库，但可保存多个已入库货物；需要并行入库通道时复制生成器并使用独立绑定。

## 场景配置

为目标场景新增 `1004 前端货物生成器`：

- 共享模板：内置立方体，可在 Inspector 中替换为项目货物模型。
- 1004、DDJ2、1005 模型实体分别保存显式 `telemetryBinding`，设备类型为 `conveyor/stacker/conveyor`，`sourceId=default`。
- 生成器绑定：`conveyor/1004`、`stacker/DDJ2`、`conveyor/1005`；`warehouseFlow` 分别引用上述三条稳定 binding ID。
- MQTT subscriptions 同时订阅 stacker 与 conveyor topic。

## 验证标准

- 场景 JSON 可序列化/反序列化，294 个 locator 编号保持唯一。
- 1004 前端有货时仅生成一个货物；相同条码不会在库位和 1004 同时出现；1004、DDJ2、1005 不再出现重复默认 Box。
- 1004 后端未到高位时 DDJ2 命令不能提前接管；到高位后才进入取货阶段。
- 入库 `command=5` 后货物留在目标 locator，随后新的 1004 前端清空/再触发可生成下一件。
- 出库从同一 locator 取回同一实例，经过 `outbound-handoff → outbound-lowering → outbound-transfer` 到达 1005 前端，并在信号清空时释放。
- DDJ2 双叉同时活跃且无法消歧时保持原位并输出一次诊断。
- `npm run typecheck`、`npm run build`、`git diff --check` 通过；不向现场 broker 发布验证数据。
