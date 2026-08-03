# RGV 遥测驱动设计

日期：2026-07-31
状态：设计方案（未实现）

## 1. 背景与目标

现有专用遥测驱动两类：`stacker`（堆垛机）与 `conveyor`（输送线）。现新增第三类：`rgv`（有轨穿梭车 / 异形环穿车，双工位：前叉工位 + 后叉工位）。

模型包：`Assets/Models/RGV/`（`拆分版RGV.glb` + `rgv.model.ts` + `meta.json`）。

与 stacker 的核心差异：

| | stacker | rgv |
|---|---|---|
| 目标位来源 | Locator 虚拟定位线框（`to_x/to_y/to_z` → 库位 box） | **列号 → 场景实例绑定**（`front_y/back_y` → 实体世界位姿投影） |
| 货箱交接 | 货叉伸缩（Z 向伸叉） | 滚筒/链条输送面侧向移入移出（车宽方向） |
| 工位 | 前叉/后叉（沿行走方向两侧货架） | 前工位/后工位（车上前后两个载位） |
| 完成信号 | command 有独立"完成"码（2/5） | 无完成码，靠 command 回落 0（待机）判定 |

目标：

1. MQTT 列信号（`front_y/back_y`）驱动 RGV 车体沿轨道行走到对应列。
2. 列实体相对车的位置决定货箱从哪一侧送入/送出。
3. `front_command/back_command` 驱动取货（列→车）/放货（车→列）动画，逻辑对齐 stacker 状态机。
4. 货箱外观复用现有货箱生成器绑定（`cargoGeneratorId`）。

## 2. 协议字段（依据 temp.log）

Topic 沿用现有约定：`dt/factory/logistics/rgv/{assetCode}/twindatadriven/joint`，EPV 协议（`data[].e/p/v`），解析层 `parseDeviceTelemetryMessage` 通用无需改动。

| 字段 | 类型 | 含义 | 驱动用途 |
|---|---|---|---|
| `deviceCode` | String | 设备号 | 仅诊断 |
| `mode` | Int | 0维修/1手动/2单机自动/3联机自动/4不明 | 诊断展示 |
| `front_command` | Int | 前叉状态：0待机/1取货中/2放货中/3取货准备/99不明 | **前工位货箱状态机** |
| `back_command` | Int | 后叉状态：同上 | **后工位货箱状态机** |
| `front_y` | Int | 前叉当前列 | **行走目标 + 前工位交接列** |
| `back_y` | Int | 后叉当前列 | **后工位交接列** |
| `front_task`/`back_task` | Int | 任务号 | 诊断展示；任务边沿辅助状态机纠错 |
| `front_containerCode`/`back_containerCode` | String | 托盘条码（空串=无货） | 仅诊断透传；**不参与任何逻辑判断**（现场数据不稳定） |
| `signalBits`/`front_signalBits`/`back_signalBits` | Int | 光电信号位 | 初版仅诊断；后续可用于精确定位交接时机 |
| `movement_x` | Int | 0静止/1前进/2后退 | 行走方向校验与动画表现参考 |
| `movement_y` | Int | 0原位/1上升/2下降 | 可选增强（顶升动画）；初版仅诊断 |
| `front_movement_z`/`back_movement_z` | Int | 0不转/1正转/2反转 | **交接动画唯一启动条件：0→非 0 边沿锁定交接列；正反转不区分出入方向（方向由 command 决定）** |
| `distance_y` | Float | 水平激光编码值 | 可选增强：行走位置校准 |
| `workingHours_x` | Float | 运行时长 | 仅诊断 |
| `normal` | Bool | true正常/false故障 | 故障态冻结驱动（同 stacker 的 faulted 语义） |
| `errorCode`/`message` | Int/String | 故障码/信息 | 诊断展示 |

命名注意：RGV 协议中 "y" 指**水平行走方向**的列号（与 stacker 协议的 x=列/y=层 不同），不要按 stacker 的轴向习惯误读。

## 3. 总体方案

新增 `rgv` 专用驱动，复用 SpecializedTelemetry 框架全部基础设施：绑定归一化、快照匹配、冲突检测、stale 断流、诊断上报、货箱生成器管线（`syncGeneratedCargoVisual` / `setGeneratedCargoRootPose` / `disposeGeneratedCargo`）。

注册点（与 stacker/conveyor 相同模式）：

1. `src/editor/model/telemetryBinding.ts:19` — `SPECIALIZED_TELEMETRY_DEVICE_TYPES` 追加 `'rgv'`。
2. `src/runtime/babylon/telemetry/specializedTelemetryBinding.ts:11` — `SpecializedTelemetryDeviceType` 联合类型追加 `'rgv'`。
3. `src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime.ts:54-65` — `drivers` 数组追加 `RgvTelemetryDriver` 注册项；`disposeAllCargo`/`disposeCargoForGenerator`/`disposeCargoForAssetCode` 同步接入 rgv 货箱表。
4. `SceneRuntime.ts` — 模型能力识别（参照 `stackerCapable` 的设置点，按模型包 `dataDriven.device.devType === 'rgv'` 置 `rgvCapable`）；`ModelRuntimeEntry` 增加 `rgvTelemetry` 运行态。

新文件：

- `src/runtime/babylon/telemetry/specialized/rgvDriver.ts` — `RgvTelemetryDriver`（行走定位 + 双工位货箱状态机），结构对齐 `stackerDriver.ts`。
- `src/runtime/mqtt/rgvTelemetrySimulator.ts` — 演示用模拟器（参照 `StackerTelemetrySimulator`）。

## 4. 核心概念：列绑定（列号 → 场景实例）

### 4.1 数据模型

`TelemetryBindingComponent`（`telemetryBinding.ts:26-35`）追加可选字段：

```ts
/** RGV 专用：列号(十进制字符串) → 场景实体 ID。仅 deviceType === 'rgv' 时有意义。 */
columnBindings?: Record<string, string>;
```

- 序列化：随 `telemetryBinding` 组件进入 `.scene.json` v3，无需迁移（可选字段，旧场景缺省为空）。
- 归一化：`normalizeTelemetryBindingComponent` 内处理——key 必须为正整数字符串、value 为非空实体 ID 字符串、去重、条目数受 `TELEMETRY_COLLECTION_MAX_ITEMS`(128) 限制；非法条目丢弃。
- 语义：列号是设备协议中的逻辑列（`front_y/back_y` 的值），实体是场景中代表该列接驳位（站台/接驳口/货架端头）的任意实体。货箱交接位 = 该实体的世界位姿。

选择挂在 `telemetryBinding` 而非新建组件的理由：与 `cargoGeneratorId` 同一先例（设备实例级绑定配置），归一化/undo/redo/序列化通道全部复用，侵入最小。

### 4.2 Inspector UI

`TelemetryBindingInspector.tsx` 内新增独立 fieldset「列绑定」，仅当 `binding.deviceType === 'rgv'` 时显示：

- 表格行：`列号(number input)` + `场景实体(下拉，列出场景全部实体，显示名称)` + 删除按钮；底部"添加列"。
- 校验提示：列号重复、实体已删除（参照 `CargoGeneratorInspector` 的 missing 提示模式）、未绑定任何列时提示运行时无法定位。
- 写入路径与现有 `commit()` 一致（clone → patch → `normalizeTelemetryBindingComponent` → `onChange`）。

### 4.3 运行时解析

`SpecializedTelemetryHost`（`types.ts:189-229`）新增：

```ts
/** 按实体 ID 解析列接驳位的世界位姿；实体不存在或未加载返回 null。 */
resolveColumnTargetPose(entityId: string): { position: Vector3; rotation: Quaternion } | null;
```

由 `SceneRuntime` 实现：查实体运行时节点的世界位姿（模型实体用 contentRoot/包围盒中心，普通实体用 root）。支撑位约定：**实体 root 世界位置 + root 朝向**；若实际站台需要高度偏移，后续在列绑定条目上扩展 per-column offset（初版不做）。

## 5. 坐标系与投影规则

### 5.1 模型局部坐标约定（来自 `rgv.model.ts` 头部注释）

GLB 源坐标厘米，`-90°X` 预旋转后：

- 车长 / 轨道长 = **局部 Z**（轨道 min-Z 锚定）
- 车宽 = **局部 X**（货箱移入移出方向）
- 轨道高 = **局部 Y**

### 5.2 行走定位（列号 → 车体目标位置）

```
axisWorld   = rgvRoot.getDirection(localZ)              // 行走轴世界方向（单位向量）
anchor      = rgvRoot 当前基线世界位置                    // 首次驱动帧捕获，同 stacker 基线机制
s_target    = dot(columnPose.position - anchor, axisWorld)   // 列实体在行走轴上的投影坐标
```

车体目标 = 保持垂直于轴的坐标不变，仅沿 `axisWorld` 移动到 `s_target - forkOffset`：

- 单工位活动时，`forkOffset` = 活动工位中心相对 root 的局部 Z 偏移（由车体包围盒或 `carLength` 推算，前工位取 `+carLength/4`、后工位取 `-carLength/4` 量级，实现时按实测调整）。
- 前后叉列号同时有效且不同（`front_y ≠ back_y`）：假设列间距 ≈ 工位间距，车体位置使两工位各对一列；实现上以**当前有 command 活动的一侧**列号为准，两侧均空闲时以 `front_y` 为准。
- 行走约束：参照 `StackerTravelConstraint`，用轨道节点（A45/A46）或 `trackLength` 参数计算 min/max 夹取，防止遥测把车推出轨道。
- 运动执行：恒定速度向目标移动（默认 0.8 m/s，对齐 `dataDriven.motion` 的 speed），到位停稳。`movement_x`（前进/后退）仅作方向一致性校验与诊断，不作为位置源；`distance_y` 校准列入可选增强。

### 5.3 侧向判定（货箱从哪一侧送入/送出）

```
sideSign = sign(dot(columnPose.position - rgvRoot.position, carRightWorld))
```

`carRightWorld` = 车局部 X 的世界方向。`sideSign > 0` 列在车右侧，货箱向右送出 / 从右侧取入；反之左侧。`|投影| < 阈值`（如 0.1m，列实体几乎在轨道正上方）判定为配置错误，诊断告警一次（复用 `reportedMissingTargets` 模式）。

## 6. 运行时状态机

### 6.1 运行态结构（`types.ts` 追加）

```ts
export type RgvForkSide = 'front' | 'back';

export type RgvModelTelemetryState = {
  rootBasePosition: Vector3;          // 行走基线锚点
  travelAxisWorld: Vector3 | null;    // 行走轴世界方向
  travelOffset: number;               // 当前沿轴偏移（米）
  travelTargetOffset: number | null;  // 列信号给出的目标偏移
  // 每工位货箱状态（front/back 对称）
  frontCargoKey: string | null;
  backCargoKey: string | null;
  frontCargoOnBoard: boolean;         // true=货箱在车位上随车；false=静止于列接驳位
  backCargoOnBoard: boolean;
  frontCargoHoldPosition: Vector3 | null;  // 列接驳位支撑位
  backCargoHoldPosition: Vector3 | null;
  frontCargoHoldRotation: Quaternion | null;
  backCargoHoldRotation: Quaternion | null;
  frontTransferProgress: number;      // 0=在列上, 1=在车上（移入移出插值）
  backTransferProgress: number;
  frontLastCommand: number | null;    // command 边沿检测
  backLastCommand: number | null;
  frontLastColumn: number | null;     // 列号边沿检测
  backLastColumn: number | null;
  frontTransferColumn: number | null; // movement_z 起转边沿锁定的交接列
  backTransferColumn: number | null;
  frontLastMovementZ: number | null;  // movement_z 边沿检测
  backLastMovementZ: number | null;
  nodeBaselines: Map<TransformNode, Vector3>;
};

export type RgvCargoRuntimeEntry = GeneratedCargoRuntimeEntry;  // 复用现有货箱管线
```

共享状态 `SpecializedTelemetrySharedState` 追加 `rgvCargoMeshes: Map<string, RgvCargoRuntimeEntry>`，key = `JSON.stringify([assetCode, side])`（同 stacker 键模式）。

### 6.2 车体行走

每帧（`applyToModel`）：

1. 读 `front_y/back_y`，按 §5.2 的优先级规则选定权威列号。
2. 列号边沿（值变化且非 0）：查 `columnBindings` → `host.resolveColumnTargetPose` → 投影得 `travelTargetOffset`；列号无绑定或实体缺失 → 诊断告警并保持原位。
3. `travelTargetOffset` 有效时按恒定速度逼近；到位后清除目标。
4. `normal === false`（故障）：冻结全部运动与状态机（对齐 stacker 的 `snapshot.faulted` 行为）。

行走与 command/交接**解耦**：`command` 为 1/2 期间车可能仍在行走，列信号持续生效、不受 command 门控；`onBoard` 状态的货箱每帧跟随车工位，随车一起移动。

### 6.3 单工位取/放货状态机（front/back 对称，对齐 stackerDriver.ts:544-776 的边沿模式）

时序原则：**command、行走、交接三者解耦**——

- `command` 为 1/2 期间 RGV 可能仍在行走（`front_y/back_y` 持续变化），行走逻辑（§6.2）不受 command 门控，全程跟随列信号。
- **交接动画的唯一启动条件是 `movement_z` 0→非 0 边沿**。只有起转时车才真实到达交接列，因此**交接列在起转边沿锁定**（取当时的 `front_y/back_y` 解析列绑定与支撑位）；command 边沿不锁列、不建仓。
- 出入方向由 `command` 决定：1=取货（列→车），2=放货（车→列）。`movement_z` 非 0 但 `command` 为 0 时不产生交接动画（方向未定义，忽略）。
- 交接的固定端点 = 锁定列实体的投影支撑位（对齐 stacker 伸叉到目标位的逻辑）。

**取货（列 → 车，入库方向，`command` = 1）**：

| 阶段 | 触发 | 动作 |
|---|---|---|
| 进入流程 | `command` 0→3（取货准备）或 0→1 边沿 | 仅标记工位进入取货流程；**不创建货箱**，车继续跟随列信号行走 |
| 起转锁列 | `command` 为 1 且 `movement_z` 0→非 0 边沿 | 锁定交接列，在列接驳位创建货箱（`getOrCreateRgvCargo`，外观由 `cargoGeneratorId` 绑定的生成器按默认模板渲染，不做条码规则匹配），`transferProgress=0`；列无绑定或实体缺失 → 诊断告警、不创建 |
| 移入 | `movement_z` 非 0 期间 | `transferProgress` 按速度递增，货箱位姿 = 列支撑位 → 车工位锚点沿侧向（§5.3）插值；`movement_z` 回 0 而 `command` 未回落时暂停插值、保持当前进度 |
| 完成 | `command` 1→0 边沿 | 兜底 `transferProgress=1`，`onBoard=true`，货箱之后每帧跟随车工位；若起转边沿从未出现（遥测稀疏跳过流程），按当前列补建并直接置上车态 |

**放货（车 → 列，出库方向，`command` = 2）**：

| 阶段 | 触发 | 动作 |
|---|---|---|
| 起始 | `command` 0→2 边沿 | 若车位无货箱（开机即放货）按生成器默认模板补建并置 `onBoard=true` 随车；车继续跟随列信号行走 |
| 起转锁列 | `command` 为 2 且 `movement_z` 0→非 0 边沿 | 锁定交接列并解析记录支撑位；列无绑定或实体缺失 → 诊断告警、中止移出 |
| 移出 | `movement_z` 非 0 期间 | `transferProgress` 按速度递减，货箱从车工位沿侧向插值到列支撑位；`movement_z` 回 0 而 `command` 未回落时暂停保持 |
| 完成 | `command` 2→0 边沿 | 兜底 `transferProgress=0`，`onBoard=false`，货箱留在列接驳位渲染并登记占用（若起转边沿从未出现，按当前列解析支撑位直接落货）；同列下次取货时先清理旧货箱再新建 |

**每帧位姿**（对齐 `updateStackerCargoPose`）：`onBoard` 时货箱位姿 = 车工位锚点世界位姿（root 位姿 × 工位局部偏移）；否则 = `holdPosition/holdRotation` 与插值结果。统一经 `host.setGeneratedCargoRootPose` 写入。

**停止预览**：`disposeAllCargo` 统一销毁 rgv 货箱，编辑态零污染（同现有约定）。

### 6.4 与 stacker 状态机的关键差异

- stacker 用"伸叉到位"作为绑定/解绑时机；rgv 用 `movement_z` 非 0 期间驱动插值（正反转不区分出入方向，方向由 `command` 决定），`command` 回落 0 作为完成兜底（协议无完成码）。
- stacker 的目标位由 `to_x/to_y/to_z` 预先给出（行走目标与交接时机解耦）；rgv 没有独立目标列字段，`front_y/back_y` 是**当前列**、行走中持续变化，因此交接列必须在 `movement_z` 起转边沿锁定，不能取 command 边沿时的瞬时值。
- stacker 放货完成即销毁或交还 locator fetch 渲染；rgv 的列实体是任意场景实例、无 fetch 接管机制，放货完成后**保留渲染**直至同列复用或预览停止。
- stacker 用托盘条码做货箱 identity 与生成器规则匹配；rgv **不依赖 `containerCode`**（现场数据不稳定）：货箱键 = `[assetCode, side]`，外观一律取生成器默认模板，有货状态完全由 command 状态机（边沿 + `onBoard`）维护。

## 7. 模型包改动（`Assets/Models/RGV/`）

`rgv.model.ts` 的 `dataDriven` 是旧模式残留，不修补、直接按本设计重新生成（已落地）：

```ts
export const dataDriven = {
	device: {
		devType: "rgv",               // 原 "shuttle"，与新增驱动类型一致
		defaultAssetCode: "RGV01",
		deviceIdField: "e",
		assetCodeField: "assetCode",
		interpolationMs: 200
	},
	motion: {
		travel: { fields: ["movement_x"], kind: "translate", axis: "z", speed: 0.8, nodes: [], ... },
		lift:   { fields: ["movement_y"], kind: "translate", axis: "y", speed: 0.3, nodes: [], ... },
	}
} as const;
```

- 轴向对齐模型约定：行走 = 局部 Z，升降 = 局部 Y。
- `nodes` 保持空数组：运动由专用驱动接管，motion 声明仅作 Inspector 只读摘要与能力识别数据源。
- 若后续要滚筒节点滚动动画，需在 GLB 节点（A3~A53 编号体系）中确认滚筒/链条节点名并补充 motion 声明；初版不做。

## 8. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/editor/model/telemetryBinding.ts` | 类型表加 `'rgv'`；`TelemetryBindingComponent` 加 `columnBindings`；归一化处理 |
| `src/runtime/babylon/telemetry/specializedTelemetryBinding.ts` | 联合类型加 `'rgv'` |
| `src/runtime/babylon/telemetry/specialized/types.ts` | `RgvModelTelemetryState`/`RgvCargoRuntimeEntry`/常量；shared state 加 `rgvCargoMeshes`；host 加 `resolveColumnTargetPose` |
| `src/runtime/babylon/telemetry/specialized/rgvDriver.ts` | **新增**：`RgvTelemetryDriver`（§5、§6） |
| `src/runtime/babylon/telemetry/specialized/SpecializedTelemetryRuntime.ts` | 注册驱动；货箱 dispose 三处接入 |
| `src/runtime/babylon/SceneRuntime.ts` | `rgvCapable` 识别；`ModelRuntimeEntry.rgvTelemetry`；实现 `resolveColumnTargetPose` |
| `src/editor/panels/TelemetryBindingInspector.tsx` | 「列绑定」编辑 UI（rgv 专属） |
| `Assets/Models/RGV/rgv.model.ts` | dataDriven 重新生成（§7，已落地） |
| `src/runtime/mqtt/rgvTelemetrySimulator.ts` | **新增**（可选，演示） |
| `examples/scenes/` + `package.json` demo 脚本 | rgv 演示场景与模拟器脚本（可选） |

无需改动：MQTT 解析层（EPV 通用）、`DeviceTelemetryStore`、货箱生成器管线、`SceneSerializer`（可选字段自动随组件序列化）。

## 9. 实施分期

**MVP**：驱动注册与识别、列绑定数据模型 + Inspector、行走定位（投影 + 轨道约束）、双工位取/放货状态机（movement_z 驱动插值）、货箱生成器复用、模型包 devType/motion 修正。

**增强**：`distance_y` 激光编码校准、`movement_y` 顶升动画、光电信号（signalBits）参与交接时机、滚筒节点滚动动画、rgv 模拟器与演示场景。

## 10. 待确认问题

1. **工位布局假设**：假设前/后叉 = 车上前后两个载位、列间距 ≈ 工位间距，需用真实现场布局验证 `front_y` 与 `back_y` 的关系（恒等还是恒差 1）。
2. **列实体形态**：列绑定目标实体的形态（接驳站台模型？货架端头？空节点？）决定支撑位是否直接可用 root 位姿，可能需要 per-column 高度/侧向偏移扩展。
3. **放货后货箱归属**：初版保留渲染直至同列复用；若列实体本身也是 conveyor 等受驱设备，后续需定义货箱交接（rgv → conveyor cargo）的转交协议。
