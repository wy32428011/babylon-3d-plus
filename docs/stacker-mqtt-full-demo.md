# Stacker MQTT 库位驱动 Demo

## 1. 实现目标

本 Demo 不再由 MQTT 脚本直接指定第一段、第二段货叉距离，而是由场景中的虚拟定位框和运行时投影距离自动决定：

- 货叉行程由目标库位在货叉轴上的投影距离自动判断：距离超出第一段行程（`forkStageOneReach`）时自动启用第二段，否则仅用一段；
- MQTT 只发送目标库位号 `to_x/to_y/to_z`、Stacker 行走/升降编码和货叉伸缩编码；
- 目标库位不存在时，运行时禁止货叉继续伸出，避免错误库位号驱动设备。

当前 Stacker 模型默认第一段和第二段行程各为 `0.8m`，总行程最大 `1.6m`。

## 2. 库位编号规则

虚拟定位框资产编号使用：

```text
排-列-层
```

例如：

| 库位号 | 排 | 列 | 层 |
| --- | ---: | ---: | --- |
| `1-1-1` | 1 | 1 | 1 |
| `1-2-1` | 1 | 2 | 1 |
| `2-1-1` | 2 | 1 | 1 |
| `2-2-1` | 2 | 2 | 1 |

MQTT 的 `to_x/to_y/to_z` 会重新组成相同的库位号，例如 `to_x=1, to_y=2, to_z=1` 对应 `1-2-1`。

## 3. 场景库位参数

选中虚拟定位框后，Inspector 的"虚拟定位线框"区域包含：

- 资产编号；
- 长、宽、高；
- Transform 的 `position` 是 Locator 的绝对世界坐标，单位为米，不是相对 Stacker 原点的距离，也不是 MQTT 编码器值。

视觉颜色：

- 默认：青色线框；
- 当前选中：黄色线框。

## 4. Demo 文件

| 文件 | 作用 |
| --- | --- |
| `examples/scenes/stacker-mqtt-demo.scene.json` | 包含 Stacker、四组库位和 MQTT 配置的视觉场景。 |
| `examples/mqtt/stacker-full-demo-sequence.json` | 库位表、发布器内部行走/升降插值参数和任务顺序；这些内部参数不会写入 MQTT payload。 |
| `scripts/publish-stacker-full-demo.mjs` | 按库位任务自动发布 MQTT。 |
| `scripts/create-stacker-mqtt-demo-scene.mjs` | 重新生成演示场景。 |

## 5. 演示场景布局

当前场景提供四个库位：

| 库位 | Stacker 行走距离 | 载货台高度 |
| --- | ---: | ---: |
| `1-1-1` | 4m | 1.2m |
| `1-2-1` | 4m | 1.2m |
| `2-1-1` | 8m | 2.2m |
| `2-2-1` | 8m | 2.2m |

同一排的库位具有相同的 Stacker 行走位置和载货台高度，差别只在库位深度和货叉段数。这里的数值来自 Locator 的绝对世界坐标：`1-1-1` 的货叉中心验收目标接近 `z=4,y=1.2`，`2-1-1` 的货叉中心验收目标接近 `z=8,y=2.2`；运行时不会要求 MQTT payload 携带行走、升降或货叉编码器距离。

重新生成场景：

```bash
npm run demo:stacker:scene
```

## 6. 启动场景

### 浏览器开发模式

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:<端口>/?demo=stacker-mqtt
```

### Electron

```bash
npm run dev:electron
```

加载：

```text
examples/scenes/stacker-mqtt-demo.scene.json
```

## 7. MQTT 配置

场景默认：

| 配置 | 值 |
| --- | --- |
| 启用配置 | 开启 |
| 本地模拟 | 关闭 |
| 地址 | `ws://127.0.0.1:8083/mqtt` |
| Topic | `dt/factory/logistics/stacker/+/twindatadriven/joint` |
| Stacker 资产编号 | `DDJ2` |

打开场景后点击 Toolbar 的"运行"。状态显示"已连接"后再启动发布脚本。

## 8. 自动发送库位任务

运行全部库位：

```bash
npm run demo:stacker:mqtt
```

只演示前两个库位对比：

```bash
node scripts/publish-stacker-full-demo.mjs --locations 1-1-1,1-2-1
```

快速演示：

```bash
node scripts/publish-stacker-full-demo.mjs --locations 1-1-1,1-2-1 --speed 4
```

只打印数据，不连接 Broker：

```bash
node scripts/publish-stacker-full-demo.mjs --locations 1-1-1,1-2-1 --stdout --speed 20
```

修改 Broker：

```bash
node scripts/publish-stacker-full-demo.mjs --broker ws://192.168.1.20:8083/mqtt
```

Broker 需要认证：

```bash
node scripts/publish-stacker-full-demo.mjs --username demo --password your-password
```

## 9. MQTT 数据格式

脚本发送的关键数据：

```json
{
  "data": [
    { "e": "DDJ2", "p": "movement_x", "v": 0 },
    { "e": "DDJ2", "p": "movement_y", "v": 0 },
    { "e": "DDJ2", "p": "front_movement_z", "v": 1 },
    { "e": "DDJ2", "p": "to_x", "v": 1 },
    { "e": "DDJ2", "p": "to_y", "v": 2 },
    { "e": "DDJ2", "p": "to_z", "v": 1 },
    { "e": "DDJ2", "p": "message", "v": "库位 1-2-1：货叉叉出" }
  ]
}
```

注意：Demo payload 示例不得包含以下旧距离字段：

```text
distance_x
distance_y
front_distance_z
back_distance_z
```

运行时处理流程：

1. 根据 `to_x/to_y/to_z` 得到 `1-2-1`；
2. 查找资产编号为 `1-2-1` 的虚拟定位框；
3. 把定位框 `position` 作为绝对世界坐标读取，而不是把它当成相对位移；
4. 读取未伸出的一段货叉世界包围盒中心作为初始锚点，再把 Locator 世界坐标换算为 `travelOffset/liftOffset`；
5. 计算目标库位在货叉轴（X 轴）上的投影距离，若超出 `forkStageOneReach` 则启用两段货叉；
6. 读取 Stacker 第一段、第二段行程参数；
7. `front_movement_z=1` 时把货叉目标设为根据投影距离判断的行程；
8. `front_movement_z=2` 时把货叉目标设为 `0`；
9. 画面中第二段节点只在实际进入第二段行程后显示。

坐标换算规则：

```text
travelOffset = Locator 在 Stacker 行走轴上的世界坐标 - 初始货叉锚点在同一轴上的世界坐标
liftOffset   = max(0, Locator.worldY - 初始货叉锚点.worldY)
```

因此 Locator 的 `z=4` 表示货叉中心最终应到达世界坐标 `z=4`，并不表示从模型根节点再移动 `4m`。

## 10. 动作编码

| 字段 | 编码 | 含义 |
| --- | ---: | --- |
| `movement_x` | 0/1/2 | 静止/正向/反向 |
| `movement_y` | 0/1/2 | 静止/上升/下降 |
| `front_movement_z` | 0/1/2 | 静止/前叉伸出/前叉收回 |
| `back_movement_z` | 0/3/4 | 静止/后叉伸出/后叉收回 |

段数不由动作编码指定，而由目标库位到货叉参考点的投影距离自动判断：距离 ≤ stageOne 仅允许一段，距离 > stageOne 允许两段。

## 11. 修改库位与任务

编辑：

```text
examples/mqtt/stacker-full-demo-sequence.json
```

库位识别字段示例（只展示与目标位匹配相关的字段，完整任务配置以现有文件为准）：

```json
{
  "assetId": "1-2-1",
  "row": 1,
  "column": 2,
  "level": 1
}
```

发布器内部可以保留行走/升降插值参数来判断动作阶段，但这些参数不是 MQTT payload 字段；现场对接时只把目标位和动作编码发给运行时。

必须保证：

- `assetId` 与 `row-column-level` 一致；
- 场景内库位资产编号不能重复；重复时运行时会移除该库位目标绑定并在 Console 报告冲突；
- Stacker 模型资产编号、Topic 资产编号和 `data[].e` 一致。

## 12. 验收现象

执行：

```bash
node scripts/publish-stacker-full-demo.mjs --locations 1-1-1,1-2-1
```

应看到：

1. Stacker 移动到第一排并升到 1.2m，`1-1-1` 验收时货叉中心应接近 `z=4,y=1.2`；
2. 目标 `1-1-1` 投影距离较近时只伸第一段；
3. 第一段收回；
4. 目标切换为 `1-2-1`；
5. 投影距离较远时第一段先伸满，第二段继续伸出；
6. 继续执行第二排时，`2-1-1` 验收时货叉中心应接近 `z=8,y=2.2`；
7. 货叉收回后 Stacker 返回原点；
8. Console 中按顺序出现"库位 1-1-1：货叉叉出"和"库位 1-2-1：货叉叉出"。

## 13. 常见问题

### MQTT 已连接但模型不动

检查：

1. Toolbar 已点击"运行"；
2. 本地模拟已关闭；
3. 模型 `assetCode=DDJ2`；
4. Topic 中设备编号为 `DDJ2`；
5. `data[].e=DDJ2`；
6. 目标库位号在场景内存在。

### 货叉段数与预期不一致

检查：

- 目标库位的世界位置是否在货叉投影方向上超出 `forkStageOneReach`（默认 0.8m）；
- Stacker 参数 `forkStageTwoReach > 0`；
- 模型包已生成 `huocha.9_stage2` / `huocha2.10_stage2`；
- MQTT 的 `to_x/to_y/to_z` 能正确找到目标库位。

### 本机 Broker 返回 Not authorized

本机 `8083` 如果禁止匿名连接，需要提供正确用户名和密码，同时编辑器端也必须配置相同认证信息；否则可使用允许匿名访问的本地测试 Broker。

## 14. 停止与清理

发布器默认任务完成后自动关闭 MQTT 连接。手动中断时按 `Ctrl+C`。不要同时运行多个相同资产编号的发布器。
