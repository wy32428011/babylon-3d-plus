# MQTT 数据驱动指南

本文说明 Babylon Electron Unity-like Editor 的 MQTT 数据驱动机制：现场设备遥测经统一快照进入运行时，由按设备类型注册的专用驱动（当前内置 `stacker`、`conveyor`）转换为编辑器运行时的只读可视化运动，帮助联调人员确认模型、资产编号、字段映射和驱动行为是否正确。

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
| `data[].p` | 点位名称 | 作为标准字段名写入运行时 `fields`，供专用驱动按模型包 `dataDriven` 声明的字段名读取。 |
| `data[].v` | 点位值 | 保留数字、字符串或布尔语义；数值映射与单位换算由对应专用驱动处理。 |
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
- `fields` 的 key 是进入运行时快照的标准字段名，value 是 payload 中的 JSON Path。
- JSON Path 支持文档式 $.device.type 和兼容式 device.type；只允许点号、数组下标和对象自有属性，拒绝脚本表达式、递归路径与 __proto__/prototype/constructor。
- JSON Path 应保持简单、稳定、可读，优先使用对象字段和数组下标，避免把业务规则塞进路径表达式。
- 新接入协议前先用一条真实 payload 对照 `fields`，确认专用驱动需要的每个字段能读到非空值。

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

## 专用驱动与 dataDriven 声明

每种设备类型的运动语义由对应专用驱动实现，驱动所需的节点、字段、速度等配置全部声明在模型包 `.model.ts` 的 `dataDriven` 导出中，配置真源是模型包而不是场景文件。三类专用设备的约定：`motion` 声明本体部件动画（stacker 的 travel/lift/fork），`cargo` 声明货物相关参数。conveyor 本体无自主动画，只有 cargo：

```ts
export const dataDriven = {
  device: { devType: 'conveyor', defaultAssetCode: '1001' },
  cargo: {
    travel: {
      axis: 'x',                                   // 走行轴 x/z，缺省 x
      speed: 0.5,                                  // m/s，缺省 0.3
      nodes: ['Chain'],                            // 行程几何节点（精确名）
      fallbackPattern: '^Chain',                   // nodes 全不匹配时的兜底正则
      fields: ['movement_x'],                      // 方向来源字段，缺省 ['movement_x']
      actionMap: { '0': 0, '1': 1, '2': -1 },      // 字段值→方向倍数，缺省即此
    },
    frontHasGoodsField: 'front_hasGoods',          // 光电字段改名，缺省 front_has_goods/back_has_goods
    backHasGoodsField: 'back_hasGoods',
  },
};
```

stacker 的 `dataDriven` 则声明 `motion.travel/lift/fork` 的节点、速度、行程与限位，详见 `Assets/Models/Stacker/stacker.model.ts`；rgv 另以顶层 `cargo.frontNodes/backNodes` 声明载货台面节点、`fixedNodes` 声明固定轨道。

导入模型时，编辑器根据 `dataDriven.device.devType` 创建默认 `telemetryBinding`，并把 motion/cargo 原文透传到 `modelAsset.dataDrivenConfig.specializedMotion`/`cargo`，Inspector“数据驱动”区域以只读摘要分组展示。未声明专用 devType 的模型不显示“数据驱动”与“货箱生成器”区域。`deviceType` 真源是模型包 `dataDriven`，Inspector 只读展示；实体级可编辑字段仅有：

- `enabled`：关闭后该实例不再消费遥测。
- `sourceId`：指定数据源，默认 `default`。
- `assetCode 覆盖`：临时改绑现场资产；为空时使用 `modelAsset.assetCode`。
- `expected(ms)` 与 `stale(ms)`：定义期望消息间隔与 stale 判定阈值。

运动映射、节点选择和数值换算需要调整时，编辑模型包 `.model.ts`，不在场景内做实例级覆盖。

## 新增专用设备驱动

1. 在 `src/runtime/babylon/telemetry/specialized/` 新建 driver 文件，实现 `applyToModel(model, snapshot, deltaSeconds)`。
2. 在 `SpecializedTelemetryRuntime` 构造函数的驱动注册表追加一行：`{ deviceType, isCapable, apply }`；数组顺序即无实例绑定时的默认优先级。
3. 把新 devType 登记进 `src/editor/model/telemetryBinding.ts` 的 `SPECIALIZED_TELEMETRY_DEVICE_TYPES`，Inspector 只读展示与 `specializedMotion` 透传会自动生效。
4. 在模型包 `.model.ts` 声明 `dataDriven.device.devType` 与该驱动的 motion 配置。

## 单位与坐标

- 场景单位：编辑器约定 `1 scene unit = 1 m`。导入模型按 `meta.json.lengthUnit` 换算到米；专用驱动读取遥测字段后自行完成现场单位到米的换算（如 stacker 的 `rpmToMetersPerSecond`、`calibrationRate`）。
- 坐标语义：行走/升降/伸缩等轴向以模型包 `dataDriven` 声明的节点局部轴为准，模型整体旋转由场景 Transform 承载，二者不混用。

## stale、fault 与 conflict

- stale：`expectedIntervalMs` 表示期望上报间隔，`staleAfterMs` 是超时阈值。当前默认绑定以 `500ms` 为期望间隔，并使用至少 `2000ms` 的保守 stale 阈值。
- fault：通用规则以 `normal=false` 或非零 `errorCode` 判定故障；Stacker 额外兼容 `front_command=8` / `back_command=8` 急停。`message` 只用于诊断展示，不单独触发故障。fault 只影响运行时可视化和排查信息，不回写现场。
- conflict：两个专用模型若同时绑定同一 `sourceId + deviceType + assetCode`，运行时会同时停止它们并标记冲突。
- 缺字段：专用驱动读取字段缺失时跳过对应动作，不写入默认 0 来掩盖数据缺失。

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
4. 确认模型包 `dataDriven` 声明的 `deviceType` 与 topic 中 `<deviceType>` 一致，例如 `stacker` 或 `conveyor`。
5. 对照模型包 `.model.ts` 的 `dataDriven` 声明，检查驱动读取的字段名是否能在 payload 的 `data[].p` 或 JSON Path 映射字段中找到。
6. 检查 `dataDriven` 声明的 `nodes`/`fallbackPattern` 是否对应当前模型的真实节点。
7. 如果 Console 有 MQTT 日志但画面不动，优先排查 `sourceId + deviceType + assetCode` 主键和字段名，而不是模型名称。
8. 如果模型突然停止，检查 stale/fault 字段、broker 连接状态、订阅 topic 和是否切换过场景配置。

## 无 Broker Stacker 演示

加载 `examples/scenes/stacker-mqtt-demo.scene.json` 并保持 MQ 配置中的“启用配置”和“本地模拟”勾选。加载完成后点击 Toolbar “运行”；通过预检后，状态 badge 进入 `simulating`，本次运行态会生成同协议 Stacker 数据，不需要外部 broker。点击“停止”会断开本地模拟，清理运行时货物、快照和诊断，并恢复 Stacker 节点 Transform、Quaternion、enabled、骨骼和运行态状态，用于验证重复运行/停止不累计漂移且不回写 SceneDocument/history。
