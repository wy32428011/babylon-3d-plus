# MQTT 快照 → 设备驱动 → 货箱渲染 全链路

> 阅读目标：10 分钟看懂「用户点运行到画面动起来」的完整链路。
> 引用约定：只写文件与方法名，不写行号（行号随合并漂移）。

## 一、全景图

```
┌────────────────────────────── 用户操作（编辑态） ──────────────────────────────┐
│ 导入模型包 → 拖入场景 → Inspector 配遥测绑定 → Inspector 配货箱生成器 → 点运行 │
└──────────────────────────────────────────┬───────────────────────────────────┘
                                           ▼ startRuntimePreview() 预检通过
                              editorStore.runtimeMode = 'preview'
                                           ▼ SceneViewPanel effect 侦听
        gizmo 脱手 → runtime.sync(冻结文档) → beginTelemetryPreview() → client.updateConfig()
                                           │
        ┌──────────────────────────────────┼──────────────────────────────────┐
        ▼ 数据源二选一                                                        │
  MqttTelemetryClient               Stacker/GenericTelemetrySimulator         │
  (broker / Electron 转发)           (无 broker 本地模拟)                        │
        └──────────────────────────────────┬──────────────────────────────────┘
                                           ▼ 'message' / tick
                        parseDeviceTelemetryMessage()  EPV 展开
                                           ▼
                        deviceTelemetryStore.upsert()  keyed 快照，乱序过滤
                                           ▼
        scene.onBeforeRenderObservable → applyDeviceTelemetryFrame()   ← 每帧
                                           │
        ┌───────────────────┬──────────────┴───────────────┐
        ▼ stacker           ▼ conveyor                     ▼ generic
  applyStackerTelemetry   applyConveyorTelemetry      GenericTelemetryMotion
  Frame()               Frame()                     Runtime.applyFrame()
        │                     │                          (motionBinding 编译结果)
        ▼                     ▼
  行走/升降/货叉          滚筒/链条 + 货物位移
  + 货叉货箱              + 输送货箱
        │                     │
        └──────────┬──────────┘
                   ▼ 货箱外观（两路共用）
        syncGeneratedCargoVisual()
          ├─ resolveCargoGeneratorForModel()     telemetryBinding.cargoGeneratorId
          ├─ resolveModelGeneratorTargetFromSnapshot()  规则匹配 → 目标模型
          ├─ syncModelGeneratorResolvedTarget()  签名比对 → 异步加载 GLB
          └─ ensureGeneratedCargoFallback()      无生成器/加载失败 → 内置 Box
                                           │
                                           ▼ 停止（再点运行按钮）
        client.dispose() → endTelemetryPreview() 恢复快照基线 → 回编辑态
```

## 二、用户操作行为全流程

| # | 用户操作 | 系统行为 | 关键代码 |
|---|---|---|---|
| 1 | 资源库导入模型包 | Electron IPC 扫描包目录（glb/gltf + meta.json + 可选 .model.ts + textures）→ 复制到 `Assets/Models` → 写 asset-index | `electron/ipc/modelPackageScanner.ts` |
| 2 | 拖入/点击创建实体 | 创建 `modelAsset` 组件实体 → SceneRuntime 异步加载 GLB → 单位换算到米 → 启动 .model.ts 脚本 | `SceneRuntime` / `ExternalModelScriptRuntime` |
| 3 | Inspector 配遥测绑定 | 填 `sourceId`/`deviceType`/`assetCode`（MQTT topic 身份），可选 `cargoGeneratorId`（货箱模板来源）、`upstreamAssetCode`（前置设备） | `TelemetryBindingInspector.tsx` |
| 4 | Inspector 配货箱生成器 | 生成器实体是纯模板库：`rules[]`（遥测字段匹配 → 目标模型）+ `defaultTarget` + 元数据 TTL | `ModelGeneratorInspector.tsx` |
| 5 | 点「运行」 | 预检 `validateRuntimePreviewConfig`：MQTT 未启用拦截；模拟器已启用直接放行；真实连接需 broker 地址 + ≥1 个有效订阅 topic + 协议合规（Electron 支持 mqtt/mqtts/ws/wss，浏览器仅 ws/wss）。CAD 导入中也拦截。通过后 `runtimeMode='preview'`，冻结全部编辑写入（`guardRuntimePreviewMutation`） | `editorStore.startRuntimePreview` / `mqttConfigUtils.ts` |
| 6 | 预览进行中 | SceneViewPanel effect：gizmo 脱手 → `runtime.sync()` 冻结文档（重建 Locator 索引与交接图）→ `beginTelemetryPreview()`（清阵列预览、脚本切 runtime 上下文、刷新生成器）→ `client.updateConfig(mqttConfig)`（连 broker 或起模拟器） | `SceneViewPanel.tsx` / `SceneRuntime.beginTelemetryPreview` |
| 7 | 再点「运行」停止 | `client.dispose()` 断连 → `endTelemetryPreview()` 按基线恢复设备姿态、销货箱 → 回编辑态恢复 sync | `editorStore.stopRuntimePreview` / `telemetryPreviewBaseline.ts` |

**注意**：设备匹配只认 `assetCode`（topic 中的资产编号），不认模型名称；生成器允许多实例，设备用 `cargoGeneratorId` 反向声明用哪台。

## 三、模型包与 .model.ts 组织形式

### 3.1 模型包目录

```
Assets/Models/<ModelName>/
├── <name>.glb|.gltf      # 几何（必需）
├── meta.json             # lengthUnit 单位 + modelParameters 参数 schema（必需）
├── <name>.model.ts       # 参数化/行为脚本（可选，经 editor-asset:// 授权加载）
└── textures/             # 贴图（可选，参数类型 texture 引用相对路径）
```

### 3.2 .model.ts 里的两类导出

```ts
// ① 参数声明组件：装饰器属性 → Inspector 表单，值存入场景文件
export class ParametricModelParamsComponent {
  @visibleAsNumber("长度 (m)", { min: 0.01, max: 100, step: 0.01 })
  public length: number = 0.32;
  constructor(public node: TransformNode) {}
}

// ② 运行组件：生命周期驱动实际几何/行为，属性会被注入已保存的参数值
export class ParametricModelRuntimeComponent {
  public length: number = 0.32;          // 与参数 key 同名即被注入
  onStart(): void { /* 缓存基线缩放/位置 */ }
  onUpdate(): void { /* 参数或遥测变化时调用 */ }
  onStop(): void { /* 恢复自建资源 */ }
}

// ③ 可选 dataDriven 导出：声明运动节点/遥测字段映射，供输送机/通用运动运行时消费
export const dataDriven = { motion: { ... } };
```

- 装饰器（`visibleAsNumber/String/Color/...`）来自 `babylonjs-editor-tools`，编译期由 `scripts/sync-model-parameters-from-scripts.mjs` 同步进 meta.json 的 `modelParameters`。
- 运行组件类名按 `default → ParametricModelRuntimeComponent → ModelRuntimeComponent → RuntimeComponent` 顺序识别。

### 3.3 脚本运行时生命周期（`ExternalModelScriptRuntime`）

| 时机 | 动作 |
|---|---|
| 模型加载完成 | TypeScript 转译 + import 重写（@babylonjs/core 命名空间注入）→ 按 `scriptAsset + assetRevision` 缓存编译产物 → 逐类实例化 → `assignParameterValues()` → `onStart()` |
| 参数编辑（编辑态） | `updateRuntimeContext({mode:'edit'})` → 重新注入参数 → `onUpdate()` |
| 遥测快照到达（预览态） | `updateModelExternalScriptRuntimeContext(model, 'runtime', telemetry)` → 注入参数 → `onUpdate()`，脚本只读 `telemetry.fields` |
| 模型删除/场景切换 | 逆序 `onStop()` → 清空实例 |

脚本不直接依赖 MQTT store，遥测以 `{deviceType, assetCode, faulted, fields}` 只读快照注入。

## 四、运行时链路分层

### 4.1 消息入口

| 文件 | 说明 |
|---|---|
| `src/runtime/mqtt/MqttTelemetryClient.ts` | 浏览器侧 MQTT over WebSocket |
| `src/runtime/mqtt/ElectronMqttTelemetryClient.ts` | Electron 主进程转发（桌面端） |
| `src/runtime/mqtt/StackerTelemetrySimulator.ts` / `GenericTelemetrySimulator.ts` | 无 broker 本地模拟，构造 EPV payload |
| `src/runtime/mqtt/MqttStackerTelemetryClient.ts` | 统一调度：`updateConfig()` 按 `simulatorEnabled`/`simulatorScenario` 选真实连接或模拟器 |

### 4.2 解析 → 快照（`src/runtime/mqtt/deviceTelemetry.ts`）

- `parseDeviceTelemetryMessage()` → `parseEpvTelemetryMessage()`：topic 正则提取 `deviceType`/`assetCode`；`payload.data[]` 按 `e/p/v` 展开为 fields。
- `DeviceTelemetryStore.upsert()`：按 `sourceId:deviceType:assetCode` 建 key，序列号乱序/重复过滤。

**`DeviceTelemetrySnapshot`**：`sourceId/topic/deviceType/assetCode`、`fields`（展开后遥测字段）、`sourceTimestamp/sequence/receivedAt`、`faulted`、`currentLocationKey/targetLocationKey`。

### 4.3 绑定解析（`src/runtime/babylon/telemetry/specializedTelemetryBinding.ts`）

| 方法 | 说明 |
|---|---|
| `resolveSpecializedTelemetryBinding()` | 合并实体覆盖与默认绑定，归一化 key |
| `resolveSpecializedTelemetrySnapshot()` | 按归一化 key 从 store 读快照 |
| `collectSpecializedTelemetryConflictKeys()` | 重复 key 检测，冲突即停止驱动（fail-fast） |

### 4.4 逐帧分发（`SceneRuntime`）

`applyDeviceTelemetryFrame()` 三路分流：

| 路 | 归类依据 | 驱动入口 |
|---|---|---|
| stacker | `telemetryBinding.deviceType` 或模型能力 `stackerCapable` | `applyStackerTelemetryFrame()` → `applyStackerTelemetryToModel()` |
| conveyor | 同上，`isConveyorRuntimeModel` | `applyConveyorTelemetryFrame()` → `applyConveyorTelemetryToModel()` |
| generic | 其余带运动绑定的模型 | `GenericTelemetryMotionRuntime.applyFrame()`（`motionBindingCompiler` 编译的绑定驱动 Transform/Joint/Animation） |

`resolveSpecializedTelemetryDeviceType()` 负责归类；模型首次被驱动的那一帧惰性捕获姿态基线（`captureModelTelemetryPreviewBaseline`），后续帧跳过不重复捕获，停止预览时按基线恢复。

### 4.5 堆垛机驱动

| 方法 | 说明 |
|---|---|
| `applyStackerTelemetryToModel()` | 解析 `to_x/to_y/to_z` → 匹配 Locator 定位框 → 计算行走/升降/货叉偏移 |
| `applyStackerRootMotion()` / `applyStackerLiftMotion()` / `applyStackerForkMotion()` | 分别驱动设备根、升降台、货叉 |
| `applyStackerCargoMotion()` | 读 `front/back_containerCode` + `front/back_command`（取货/放货命令字） |
| `applyStackerForkCargoMotion()` | 创建/获取货箱 → 定位叉尖 → 放货完成挂 Locator 支撑面 |
| `getOrCreateStackerCargo()` | 按 `assetCode:containerCode` 管理 `StackerCargoRuntimeEntry` |

### 4.6 输送机驱动

| 方法 | 说明 |
|---|---|
| `applyConveyorTelemetryToModel()` | 入口：运动 + 货物两路 |
| `applyConveyorMotion()` | 按脚本 `dataDriven.motion` 驱动滚筒旋转/链条平移 |
| `applyConveyorCargoMotion()` | 读 `containerCode`/`container_quantity` → 生成货箱 → `movement_x` 驱动位移 |
| `getOrCreateConveyorCargo()` | 按 `assetCode:containerCode` 管理 `ConveyorCargoRuntimeEntry` |

## 五、货箱生命周期与跨设备交接

### 5.1 外观生成（两路设备共用）

| 方法 | 说明 |
|---|---|
| `resolveCargoGeneratorForModel()` | 由 `telemetryBinding.cargoGeneratorId` 找生成器运行时；未绑定/已删除 → null |
| `syncGeneratedCargoVisual()` | 总入口：有生成器走模板解析，无生成器直接回退 |
| `resolveModelGeneratorTargetFromSnapshot()`（`modelGeneratorRuntime.ts`） | 以本设备当前快照逐条匹配 `rules[]`（attributeName/attributeValue），命中用规则目标，否则 `defaultTarget` |
| `syncModelGeneratorResolvedTarget()` | 目标签名比对：命中复用，未命中异步 `ImportMesh` 加载 GLB（含单位换算 + .model.ts 脚本）挂到货箱 root |
| `ensureGeneratedCargoFallback()` | 无生成器/加载失败 → `MeshBuilder.CreateBox` 内置立方体 |

模板缓存按生成器实例隔离，多生成器互不串扰。

### 5.2 前置设备交接（upstream 链）

每次场景同步（`runtime.sync()`，含进入预览时的那次）都会按各设备 `upstreamAssetCode` 重建交接图 `rebuildCargoHandoffGraph()` 并诊断（一次性日志）：

| 异常 | 处理 |
|---|---|
| upstream 指向自身 | 按入口设备处理 |
| upstream 在场景不存在 | 按入口设备处理 |
| 环（A→B→A） | 环上设备全部加入阻断集，停止货箱驱动 |

每帧行为：

| 方法 | 说明 |
|---|---|
| `isCargoHandoffBlocked()` | 阻断集成员直接销货箱并跳过驱动 |
| `resolveUpstreamCargoCode()` | 本设备无 `containerCode` 但有货（`container_quantity>0`）时，继承上游货箱条码，保证同货同码 |
| `disposeHandedOffCargo()` | 本设备生成货箱后，销毁上游被接管的同码货箱（视觉交接） |

无 upstream 的设备是入口设备，货物视作系统外进入；末端设备无货信号即销毁。

## 六、排障速查

| 现象 | 先查 |
|---|---|
| 设备完全不动 | topic `assetCode` 与绑定是否严格一致；`collectSpecializedTelemetryConflictKeys` 是否报冲突 |
| 货箱是立方体 | 设备未配 `cargoGeneratorId`，或生成器规则未命中且 `defaultTarget` 为空（Console 有一次性提示） |
| 交接断链 | Console 的 `upstream-missing` / 环检测日志；上游是否真的有货 |
| 停止后姿态没恢复 | `telemetryPreviewBaseline` 捕获/恢复路径 |
| 脚本参数不生效 | 运行组件属性名与参数 key 是否同名；meta.json 是否由 sync 脚本重新生成 |
