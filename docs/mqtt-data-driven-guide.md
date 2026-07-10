# MQTT 数据驱动框架指南

本文说明 Babylon Electron Unity-like Editor 当前的通用 MQTT 数据驱动框架。该框架用于把现场设备遥测转换为编辑器运行时的只读可视化运动，帮助联调人员确认模型、资产编号、字段映射和动画绑定是否正确。

## 边界

- 只读可视化：MQTT 数据只进入运行时内存快照，不写入 `.scene.json`，不进入撤销/重做历史，也不回写 PLC、WMS、WCS 或 broker。
- 绑定优先安全：运行时必须同时匹配 `sourceId`、`deviceType` 和 `assetCode`；匹配失败时宁可不驱动模型，也不按名称、Hierarchy 文本或脚本文件名猜测绑定。
- 模型实例隔离：每个导入模型实例使用 `modelAsset.assetCode` 作为现场资产编号，复制、粘贴和阵列后的实例应使用独立编号。
- 编辑/运行分离：Inspector 中的 `telemetryBinding` 是场景配置；MQTT 最新帧、stale 状态、fault 状态和冲突提示属于运行时状态。
- 无收益或控制承诺：该框架只展示现场状态，不承担设备控制、调度优化或业务决策。

## 编辑器 MQTT 运行预览

- 保存或启用 MQTT 配置只更新场景配置，不会自动连接 broker，也不会自动启动本地模拟。
- Toolbar “运行/停止”是唯一运行入口；点击“运行”并通过预检后，才会连接 broker 或启动本地模拟。无效配置会打开 MQTT 配置弹窗，要求先修正地址、topic 或模拟参数。
- 连接状态 badge 显示 disabled、simulating、connecting、connected、disconnected 或 error；断线或错误不会自动退出运行态，用户可修正网络或配置后重连。
- 运行态仍允许相机浏览、Scene 选择、Hierarchy 搜索/展开、网格开关、运行时诊断和 Console 查看。
- 运行态禁止 Gizmo、Inspector 修改、Hierarchy 变更、资源创建/导入、保存加载、undo/redo 和 MQTT 配置，避免把预览状态混入编辑历史。
- 点击“停止”会断开本次 transport，清理遥测快照、诊断状态、运行时货物和本次遥测触发的动画，并恢复节点 Transform、Quaternion、enabled、骨骼以及 Stacker/Conveyor 运行态状态。
- 停止恢复只作用于 Babylon 运行时，不回写 SceneDocument，不写入 history；重复运行和重复停止不应累计姿态漂移。

## Topic 与 EPV payload

默认 topic 形态为：

```text
dt/factory/logistics/<deviceType>/<assetCode>/twindatadriven/joint
```

示例：

```text
dt/factory/logistics/stacker/DDJ2/twindatadriven/joint
dt/factory/logistics/conveyor/1001/twindatadriven/joint
```

默认适配器为 EPV，即 payload 使用 `data[]` 数组承载点位：

```json
{
  "ts": 1720000000000,
  "seq": 1024,
  "data": [
    { "e": "DDJ2", "p": "movement_x", "v": 1 },
    { "e": "DDJ2", "p": "distance_x", "v": 12.5 },
    { "e": "DDJ2", "p": "normal", "v": true }
  ]
}
```

| 字段 | 含义 | 运行时处理 |
| --- | --- | --- |
| `data[].e` | 点位所属资产编号 | 为空时兼容接收；非空且与 topic 中 `assetCode` 不一致时忽略该点位。 |
| `data[].p` | 点位名称 | 作为标准字段名写入运行时 `fields`，供 `motion.fields` 或 `telemetryBinding.channelOverrides.<channel>.fields` 读取。 |
| `data[].v` | 点位值 | 保留数字、字符串或布尔语义；运动通道会再按 `scale`、`offset`、`invert`、`min`、`max` 映射。 |
| `ts` | 源时间戳 | 可用于排查消息时间；缺失时仍按接收时间驱动。 |
| `seq` / `sequence` | 源序号 | 同一设备有序号时只接受更大序号；无序号时按源时间戳或接收时间排序，并拒绝内容重复的快照。 |

## JSON Path 适配器

非 EPV payload 可使用 `json-path` 适配器把任意 JSON 字段映射到统一遥测快照。当前场景配置类型支持：

```json
{
  "topic": "site/a/robot/+",
  "qos": 0,
  "adapter": {
    "kind": "json-path",
    "sourceId": "site-a",
    "deviceTypePath": "$.device.type",
    "assetCodePath": "$.device.code",
    "timestampPath": "$.time",
    "sequencePath": "$.seq",
    "fields": {
      "pos_x": "$.pose.x",
      "pos_y": "$.pose.y",
      "state": "$.state"
    }
  }
}
```

约定：

- `deviceTypePath` 和 `assetCodePath` 必须都能从 payload 中读取非空值；任一缺失或解析失败时整条 JSON Path 消息会被忽略，不会退回 topic 猜测绑定。
- `fields` 的 key 是进入运动通道的标准字段名，value 是 payload 中的 JSON Path。
- JSON Path 支持文档式 $.device.type 和兼容式 device.type；只允许点号、数组下标和对象自有属性，拒绝脚本表达式、递归路径与 __proto__/prototype/constructor。
- JSON Path 应保持简单、稳定、可读，优先使用对象字段和数组下标，避免把业务规则塞进路径表达式。
- 新接入协议前先用一条真实 payload 对照 `fields`，确认每个通道能读到非空值。

## 多订阅、QoS 与 sourceId

场景级 `mqttConfig.subscriptions` 可保存多个订阅：

```json
{
  "enabled": true,
  "address": "wss://mqtt.example.com/mqtt",
  "subscriptions": [
    {
      "topic": "dt/factory/logistics/+/+/twindatadriven/joint",
      "qos": 0,
      "adapter": { "kind": "epv", "sourceId": "default" }
    },
    {
      "topic": "site/a/robot/+",
      "qos": 1,
      "adapter": { "kind": "json-path", "sourceId": "site-a", "fields": { "pos_x": "$.pose.x" } }
    }
  ]
}
```

- `sourceId` 区分数据来源，例如 `default`、`site-a`、`test-broker`。同一 `assetCode` 来自不同 broker 或协议时必须使用不同 `sourceId`。
- `deviceType` 来自 topic 或适配器解析结果，必须与模型 `dataDriven.device.devType` 或 Inspector `telemetryBinding.deviceType` 一致。
- `assetCode` 默认来自 topic 或适配器解析结果，必须与模型实例 `modelAsset.assetCode` 一致；Inspector 的 `assetCode 覆盖` 可用于临时联调。
- QoS 当前场景类型保存 `0` 或 `1`；除非现场 broker 明确要求确认投递，默认使用 `0`，降低可视化延迟。
- 多订阅同时命中同一模型时，运行时主键为 `sourceId + deviceType + assetCode`；不要让两个订阅写入同一个主键，否则最新帧会互相覆盖。

## dataDriven 默认与 telemetryBinding 覆盖

模型包可以在 `meta.json` 或同包模型脚本元数据中提供默认 `dataDriven`：

```json
{
  "device": {
    "devType": "generic-machine",
    "defaultAssetCode": "GEN-A",
    "interpolationMs": 200
  },
  "motion": {
    "travelX": {
      "channel": "travelX",
      "fields": ["distance_x"],
      "mode": "absolute",
      "target": { "kind": "root" },
      "property": "position",
      "axis": "x",
      "space": "world",
      "scale": 1,
      "offset": 0,
      "invert": false,
      "smoothing": { "kind": "linear", "durationMs": 200 }
    }
  },
  "fixedNodes": []
}
```

导入模型时，编辑器会根据 `dataDriven.device.devType` 创建默认 `telemetryBinding`。Inspector 的“数据驱动”区域用于做实体级覆盖：

- `enabled`：关闭后该实例不再消费遥测。
- `sourceId`：指定数据源，默认 `default`。
- `deviceType`：覆盖设备类型，必须与订阅解析出的类型一致。
- `assetCode 覆盖`：临时改绑现场资产；为空时使用 `modelAsset.assetCode`。
- `expected(ms)` 与 `stale(ms)`：定义期望消息间隔与 stale 判定阈值。
- `channelOverrides`：覆盖或新增通道；覆盖优先级高于模型包 `dataDriven.motion`。

合并顺序为：脚本 fallback `dataDriven` → 模型资产 `modelAsset.dataDrivenConfig` → 实体 `telemetryBinding.channelOverrides`。因此，通用模型默认行为应写在 `dataDriven`，现场单实例差异应写在 `telemetryBinding`。

## Transform、Joint、Animation 示例

### Transform：按编码器移动根节点

```json
{
  "channel": "travelX",
  "fields": ["distance_x", "pos_x"],
  "mode": "absolute",
  "target": { "kind": "root" },
  "property": "position",
  "axis": "x",
  "space": "world",
  "scale": 1,
  "offset": 0,
  "invert": false,
  "min": -50,
  "max": 50,
  "smoothing": { "kind": "linear", "durationMs": 200 }
}
```

用途：把现场米制位置写到模型根节点世界 X 轴；`min/max` 防止异常值把模型推离视口。

### Joint：按字段驱动指定节点或骨骼

```json
{
  "channel": "forkExtend",
  "fields": ["front_distance_z"],
  "mode": "absolute",
  "target": { "kind": "node", "selector": "FrontFork" },
  "property": "position",
  "axis": "z",
  "space": "local",
  "scale": 0.001,
  "offset": 0,
  "invert": false,
  "smoothing": { "kind": "ema", "alpha": 0.35 }
}
```

用途：把毫米编码器换算成米后驱动局部 Z 轴。若目标是骨骼，可把 `target.kind` 改为 `bone`，并让 `selector` 对应骨骼名称。

### Animation：按状态码触发动画组

```json
{
  "channel": "doorState",
  "fields": ["door_state"],
  "mode": "state",
  "target": { "kind": "animation", "selector": "DoorOpen" },
  "scale": 1,
  "offset": 0,
  "invert": false,
  "actionMap": {
    "0": "stop",
    "1": "play",
    "2": "reverse"
  },
  "animation": {
    "loop": false,
    "speed": 1,
    "blend": 0.2
  }
}
```

用途：把离散 PLC 状态映射为动画动作。当前运行时支持 `play`、`pause`、`stop`、`reverse`；`blend` 保留为配置兼容，不能假定已有复杂混合逻辑。

## 单位、坐标与平滑

- 场景单位：编辑器约定 `1 scene unit = 1 m`。导入模型会按 `meta.json.lengthUnit` 换算到米，遥测字段也应在通道中明确 `scale`。
- 角度单位：通用旋转通道把映射后的数值视为度，再在 Babylon 写入边界转换为 Quaternion/弧度。现场是度时通常 `scale: 1`；现场是弧度时可用 `scale: 180 / Math.PI` 的数值常量先换算为度。
- 坐标空间：`space: "world"` 适合现场绝对坐标；`space: "local"` 适合货叉、门、关节等相对模型自身的部件运动。
- 轴向语义：`axis` 必须以模型当前局部轴或世界轴为准。模型旋转后，局部 X/Y/Z 与世界 X/Y/Z 不再等价。
- 平滑策略：`step` 用于离散状态；`linear` 用于位置过渡；`ema` 用于抑制噪声。平滑只改变可视化表现，不代表真实设备轨迹。
- 限幅保护：连续数值通道建议配置 `min/max`，避免异常遥测导致模型不可见或穿越场景。

## stale、fault 与 conflict

- stale：`expectedIntervalMs` 表示期望上报间隔，`staleAfterMs` 是超时阈值。当前默认绑定以 `500ms` 为期望间隔，并使用至少 `2000ms` 的保守 stale 阈值。
- fault：通用规则以 `normal=false` 或非零 `errorCode` 判定故障；Stacker 额外兼容 `front_command=8` / `back_command=8` 急停。`message` 只用于诊断展示，不单独触发故障。fault 只影响运行时可视化和排查信息，不回写现场。
- conflict：两个通用模型若同时绑定同一 `sourceId + deviceType + assetCode`，运行时会同时停止它们并标记冲突。单通道命中父子节点时还会过滤子目标，避免同一偏移被父子层级重复叠加。
- 缺字段：通道按 `fields` 顺序读取第一个非空值；全部缺失时该通道跳过本帧，不应写入默认 0 来掩盖数据缺失。
- 异常值：非有限数值会被忽略；已映射数值再经过 `min/max` 夹紧。

## Electron wss 安全建议

- 生产现场优先使用 `wss://`，避免在受控网络外暴露明文 `ws://`。
- broker 证书应由系统信任链或企业根证书签发，不建议在 Electron 中关闭证书校验。
- 不要把 MQTT 用户名、密码、token 写入场景文件或 README；如后续需要鉴权，应通过受控主进程 IPC、系统凭据或部署配置注入。
- Electron 主进程已有受控 MQTT IPC 路径；renderer 只通过 preload 暴露的 `editorApi.mqttConfigure`、`mqttDisconnect`、`mqttGetStatus` 和 `onMqttEvent` 使用连接能力。
- `contextIsolation` 保持开启，`nodeIntegration` 保持关闭；不要为了 MQTT 调试把 Node 能力暴露给 renderer。
- topic 范围应尽量收窄。联调可用 `dt/factory/logistics/+/+/twindatadriven/joint`，上线场景建议按产线、设备类型或资产编号分组订阅。

## 编辑器运行时诊断

- 模型 Inspector 的“运行时诊断”卡片只读显示 online/stale/fault/conflict、`sourceId/deviceType/assetCode`、最后接收时间、匹配 topic、sequence、源时间戳、标准化 fields、设备 message 和映射错误；这些内容来自运行时外部 store，不写入场景文件或撤销历史。
- Toolbar 连接状态 badge 和 MQTT 配置弹窗会显示浏览器/Electron transport 的 `disabled/simulating/connecting/connected/disconnected/error` 状态和最近错误；状态来自运行预览，不表示保存配置时已经自动连接。
- “样例 payload 解析预览”可选择订阅、填写具体 Topic 并粘贴 payload；解析调用与真实消息相同的 EPV/JSON Path 适配器，但不会写入 `deviceTelemetryStore`，更不会向 PLC 或 broker 发布命令。
- EPV 订阅含 `+/#` 通配符时，弹窗会为预览生成一个具体示例 Topic；真实订阅表达式本身不会被修改。

## Inspector 排障清单

1. 选中模型实例，确认 `Model Asset > 资产编号` 与 topic 中 `<assetCode>` 完全一致。
2. 在“数据驱动”区域确认 `启用绑定` 已勾选。
3. 确认 `sourceId` 与订阅适配器 `adapter.sourceId` 一致；不填时默认按 `default` 理解。
4. 确认 `deviceType` 与 topic 中 `<deviceType>` 一致，例如 `stacker` 或 `conveyor`。
5. 检查每个通道的 `fields` 是否能在 payload 的 `data[].p` 或 JSON Path 映射字段中找到。
6. 检查 `target.kind`、`selector`、`property`、`axis` 和 `space` 是否对应真实模型节点、骨骼或动画组。
7. 检查 `scale` 是否完成毫米、厘米、角度或编码器脉冲到米/弧度/状态值的换算。
8. 如果 Console 有 MQTT 日志但画面不动，优先排查 `sourceId + deviceType + assetCode` 主键和字段名，而不是模型名称。
9. 如果模型跳变或抖动，先增加 `smoothing`，再检查现场数据频率、单位和是否存在多个订阅写同一主键。
10. 如果模型突然停止，检查 stale/fault 字段、broker 连接状态、订阅 topic 和是否切换过场景配置。

## 无 Broker 演示说明

### 通用双机演示

- 场景：`examples/scenes/generic-mqtt-motion-demo.scene.json`
- 模型包：`examples/model-packages/GenericMqttMotionDemo`
- 生成脚本：`scripts/create-generic-mqtt-motion-demo.mjs`
- 自动加载参数：`?demo=mqtt-generic`

```bash
npm run demo:mqtt:generic:scene
npm run dev
```

开发服务器启动后访问 `http://127.0.0.1:<port>/?demo=mqtt-generic`。场景已配置 `enabled=true`、`simulatorEnabled=true`、`simulatorScenario=generic`，但加载场景不会自动启动模拟；点击 Toolbar “运行”并通过预检后，状态 badge 进入 `simulating`，不会连接 broker，`simulatorAssetCode=GEN-A,GEN-B` 会生成两台 `generic-machine` 的 EPV 快照。点击“停止”用于验证模型 Transform、Quaternion、enabled、骨骼/动画状态和运行时快照可以恢复，重复运行不会累计漂移。

20 秒循环如下：

1. `0-5s forward`：两台模型沿相反方向移动，`AccentPanel` 关节反向旋转，`DoorPulse` 分别执行 play/reverse。
2. `5-9s reverse`：平移和关节方向反转，动画动作发生边沿切换。
3. `9-12s fault`：发送 `normal=false`、`errorCode=5001`，Transform/Joint 冻结，但故障状态动画仍可执行。
4. `12-16s stale`：连续 4 秒不写快照；超过 `staleAfterMs=2000` 后模型标记 stale，持续动画暂停并冻结最后可信姿态。
5. `16-20s recovery`：恢复上报，模型从冻结姿态平滑接入新目标并重新驱动动画。

模型包提供三个默认通道：`position_x` 驱动根节点平移、`joint_angle_deg` 驱动 `AccentPanel` 旋转、`operation_state` 驱动真实 glTF AnimationGroup `DoorPulse`。场景通过两个不同 `assetCode` 验证严格绑定，不会把一台设备的数据同时驱动两台模型。

### Stacker 演示

加载 `examples/scenes/stacker-mqtt-demo.scene.json` 并保持 MQ 配置中的“启用配置”和“本地模拟”勾选。加载完成后点击 Toolbar “运行”；通过预检后，状态 badge 进入 `simulating`，本次运行态会生成同协议 Stacker 数据，不需要外部 broker。点击“停止”会断开本地模拟，清理运行时货物、快照和诊断，并恢复 Stacker 节点 Transform、Quaternion、enabled、骨骼和运行态状态，用于验证重复运行/停止不累计漂移且不回写 SceneDocument/history。
