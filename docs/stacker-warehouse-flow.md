# Stacker MQTT 1004 → DDJ2 → 库位 → 1005 货物交接

## 1. 适用场景

目标场景：

```text
F:\3d-projects\Stacker MQTT Demo.scene.json
```

场景内关键资产：

| 角色 | deviceType | assetCode | 前置设备 |
| --- | --- | --- | --- |
| 入库一体式顶升移载 | `conveyor` | `1004` | 无（入口设备） |
| 双工堆垛机 | `stacker` | `DDJ2` | `1004` |
| 出库一体式顶升移载 | `conveyor` | `1005` | `DDJ2` |

v2 起不再有“场景级唯一生成器 + 仓储流协调器”。模型生成器是纯货箱模板库，可创建多个；货物生命周期由每台设备各自的遥测驱动，设备之间通过**前置设备资产编号**串成交接链：

- 每台设备的 `telemetryBinding.cargoGeneratorId` 选择场景内任一模型生成器实体作为货箱模板来源；缺省回退内置立方体。
- 每台设备的 `telemetryBinding.upstreamAssetCode` 声明前置设备的资产编号；留空表示入口设备，货物从系统外进入。
- 模板只影响货物外观，不影响交接逻辑；未命中规则的货物使用生成器共享模板，生成器未绑定或模板为空时回退内置 Box。

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

1004、DDJ2、1005 模型实体均保存显式 `telemetryBinding`；交接链按 `telemetryBinding.assetCode ?? modelAsset.assetCode` 匹配，不按模型名称猜测。`upstreamAssetCode` 指向自身、指向不存在的设备或形成环时，Console 给出警告：自引用/缺失按入口设备处理，环上的所有设备停止货箱驱动。

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
| `container_quantity` | 无条码时的载货数量，`> 0` 表示有货 |

解析器会补充以下只读派生字段，便于模型生成器规则匹配：

```text
front_has_goods
back_has_goods
lift_at_low
lift_at_high
```

若 payload 已直接提供同名字段，运行时不会覆盖。

YZJ 模型参数另外保存 `frontSide/backSide`，用于把上述 MQTT 前/后端字段映射到模型局部 `left/right/front/rear`。

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

## 5. 货物生成与条码继承

每台设备独立根据自身遥测生成货物，没有中央协调器：

1. 输送机 `containerCode` 非空：按条码创建/复用本机货物，外观取 `cargoGeneratorId` 绑定的生成器按当前快照解析的模板。
2. 输送机无 `containerCode` 但 `container_quantity > 0`（匿名货）：先尝试继承前置设备当前持有的条码——前置输送机取 `containerCode`，前置堆垛机要求仅单侧货叉有码；前置快照 stale、缺码或多码时回退匿名占位编号，不阻塞本机显示。
3. 堆垛机 `front/back_containerCode` 非空：对应货叉创建/复用货物，放货命令（`command=3/4/5`）期间条码清空仍沿用上一帧编号完成落位。
4. 条码切换时本机旧条码货物立即释放；条码清空且无放货命令时本机货物释放。

## 6. 交接流程

下游设备开始持有某条码时，运行时释放上游设备的同码货物，完成视觉上的交接：

1. 1004 持货 → DDJ2 货叉上报同一条码：1004 的货物被释放，货物改随 DDJ2 货叉运动。
2. DDJ2 `command=3/4/5` 且 `to_x-to_y-to_z` 命中 locator：货物按 45% / 85% / 100% 进度从货叉插值进入库位，完成后登记 `placedLocatorKey` 并清空货叉条码。
3. DDJ2 再次上报同一条码（从库位取回）：复用同一货物实例并清除 `placedLocatorKey`，货物重新随货叉运动。
4. DDJ2 持货 → 1005 上报同一 `containerCode`（或匿名继承到该码）：DDJ2 的未落位货物被释放，货物改随 1005 输送面运动。
5. 1005 `containerCode` 清空且 `container_quantity=0`：货物释放，流出系统。

交接释放有两条保护：

- 上游设备自身仍在上报该条码时（`containerCode` 或对应货叉码一致），不释放其货物，避免重复帧误删。
- 已入库（`placedLocatorKey` 非空）的货物不受交接影响，只被明确取回或停止预览释放。

## 7. 多生成器与模板解析

- 可创建多个模型生成器实体；创建、复制、粘贴、阵列均不再去重，名称自动编号。
- 生成器在 MQTT 模式下不产生自身输出，仅为绑定它的设备提供模板：`defaultTarget` 共享模板 + `rules` 按货物快照字段条件覆盖。
- 删除生成器时，编辑器在同一撤销命令内清空所有指向它的 `cargoGeneratorId`；运行时按生成器实体 ID 释放以其为模板的货物。
- 生成器配置（模板/规则/TTL）变化时，释放全部以它为模板的货物，后续遥测帧按新配置重建。

## 8. stale、故障和冲突

- `DeviceTelemetryStore` 先按 `sequence/sourceTimestamp/receivedAt` 拒绝乱序帧，并对同内容重复帧保持幂等。
- stale 或故障时货物冻结当前位置，不销毁；恢复后继续驱动。
- 前置设备快照 stale 时匿名货不再继承其条码，使用匿名占位编号；前置链断裂不会阻塞本机货物显示。
- 前置链成环时环上所有设备停止货箱驱动，并按签名只写一次 Console。
- 全部行为仅存在运行时内存，不修改 scene 的 locator 占用状态，也不向 broker/PLC/WCS/WMS 发布命令。

## 9. 排障顺序

1. Toolbar 已点击“运行”，MQTT 状态不是 disabled/error。
2. subscriptions 同时包含 stacker 与 conveyor topic。
3. 1004、DDJ2、1005 的 `modelAsset.assetCode` 和 `telemetryBinding.deviceType` 正确。
4. payload `data[].e` 与 topic 资产编号一致。
5. 各设备的 `cargoGeneratorId` 是否指向存在的生成器，生成器是否配置共享模板或可命中的规则目标。
6. 各设备的 `upstreamAssetCode` 是否构成 1004 → DDJ2 → 1005 链，Console 是否有自引用/缺失/成环警告。
7. DDJ2 的条码是否与 1004 相同，`to_x/to_y/to_z` 是否能找到唯一 locator。
8. 1005 是否先出现 `container_quantity > 0` 或 `containerCode` 与 DDJ2 一致。
9. Console 是否报告绑定缺失、模型冲突、库位占用或目标模板加载失败。

## 10. 从 v1 场景迁移

打开 version 1 场景文件时自动迁移并写回 version 2：

- 旧生成器 `bindings[]` 反转为各设备 `telemetryBinding.cargoGeneratorId`（按 assetCode + deviceType 唯一匹配，匹配不到或多重匹配则跳过并警告）。
- 旧 `warehouseFlow` 三设备链转为 `upstreamAssetCode`：堆垛机 ← 入库输送机，出库输送机 ← 堆垛机。
- 迁移结果通过 Console 输出摘要与警告，确认无误后保存场景即固化。
