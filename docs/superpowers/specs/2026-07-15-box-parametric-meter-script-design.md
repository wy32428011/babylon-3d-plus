# Box 模型米制参数化脚本设计

## 背景

`F:\3d-models\models\box` 当前只有 `box.glb`，没有 `*.model.ts` 或 `meta.json`。GLB 的有效世界包围尺寸约为：

- X：18.0016
- Y：18.0040
- Z：31.9991

Box 模型包通过 `meta.json.lengthUnit = "centimeter"` 明确声明源 GLB 使用厘米建模；编辑器不根据上述包围尺寸或参数脚本推断单位。目标场景仍遵循既有契约：`1 scene unit = 1 m`。

## 目标

- 为 Box 模型增加外置参数化脚本。
- Inspector 暴露长度、宽度、高度三个参数，全部使用米。
- 默认成品尺寸为 `0.32 m × 0.18 m × 0.18 m`。
- 参数变化后实时调整模型尺寸，保持底面位于实体原点地面。
- Inspector 的实际尺寸由编辑器原生测量；删除参数脚本后，只要保留厘米单位声明，仍显示约 `0.18 × 0.18 × 0.32 m`。
- 同步源模型包与当前项目 `Assets/Models/box` 副本。

## 非目标

- 不修改 `box.glb` 顶点、材质或贴图。
- 不增加颜色、开合动画、数量阵列或 MQTT 数据驱动。
- 不改变编辑器场景格式、用户 `Transform.scale` 或模型脚本运行框架。
- 不把源 GLB 的厘米坐标错误声明成米。
- 不让参数脚本承担源单位判断、基础米制换算或 Inspector 实际尺寸计算。

## 单位与轴向契约

- 源模型坐标：厘米，`lengthUnit = "centimeter"`，运行时基准换算为 `0.01`。
- Inspector 参数：米，字段标签和参数定义均显式标记 `m`。
- 模型轴向：
  - 世界 X 对应宽度，默认 `0.18 m`。
  - 世界 Y 对应高度，默认 `0.18 m`。
  - 世界 Z 对应长度，默认 `0.32 m`。
- 参数范围：`0.01 m` 到 `100 m`，步长 `0.01 m`。
- `unitScaleToMeters = 0.01` 始终由 `lengthUnit` 标准映射重建；脚本字段、默认参数和 GLB 包围盒不参与单位解析。

## 实现设计

### 1. 模型元数据

新增 `meta.json`：

- 注册 `box.model.ts`。
- 参数脚本类使用 `ParametricModelParamsComponent`。
- 运行脚本类使用 `ParametricModelRuntimeComponent`。
- `modelParameters` 只声明 `length`、`width`、`height`，单位为米。
- 保留模型标识、设备类型、设备名称和参数说明元数据，用于模型库展示与后续维护。

### 2. 参数脚本

`ParametricModelParamsComponent` 仅声明 Inspector 字段和默认值，不直接修改 Babylon 节点。

### 3. 运行脚本

`ParametricModelRuntimeComponent` 在启动时同时保存 `contentRoot.scaling` 与 `contentRoot.position` 基线。缩放基线已包含源厘米到米的 `0.01` 换算，位置基线包含模型底部中心归一化产生的微小补偿。每次更新按以下比例设置缩放：

```text
X = 基线 X × (宽度米 / 0.18)
Y = 基线 Y × (高度米 / 0.18)
Z = 基线 Z × (长度米 / 0.32)
```

直接从基线重算而不是在当前值上累乘，避免多次修改产生累计误差。位置 X/Y/Z 同时分别乘以宽/高/长比例，使归一化前的底部中心偏移与几何缩放同比变化，从而在极端尺寸下也保持底部中心严格位于实体原点。运行时每次更新都会重申目标缩放和位置，以兼容编辑器同步流程重新写入单位基准缩放的行为。停止脚本时恢复原始缩放与位置基线。

### 4. 落地与 Transform 边界

编辑器在启动脚本前已通过内容根节点 position 补偿，使模型底部中心与实体根节点原点重合。脚本只调整内容根节点的 scaling，并按同一比例补偿内容根节点 position，因此高度、宽度或长度变化仍以底部中心为锚点；实体根节点的 position、rotation、scale 不被脚本改写。

### 5. 编辑器原生实际尺寸

Box 与其它普通导入模型共用编辑器测量工具。工具读取 `contentRoot` 下有效 Mesh 的世界包围盒角点，并投影到实体根自身 X/Y/Z 轴，因此默认显示约 `X=0.18 m、Y=0.18 m、Z=0.32 m`。源厘米换算、脚本对内容根的参数化缩放和用户非均匀 `Transform.scale` 都会进入结果；实体旋转或平移不会造成尺寸跳变。测量快照仅存在于编辑器运行时状态，不写入场景文件。

参数脚本只提供长度、宽度、高度三个附加可编辑参数。脚本缺失时模型仍按 `lengthUnit = "centimeter"` 换算并测量；若 `lengthUnit` 也缺失，则按全局兼容规则视为 `meter / 1`，编辑器不会根据 Box 外形反推厘米。

## 错误处理

- 非有限数、零和负数回退到对应默认米制尺寸。
- `meta.json` 同时通过 min/max 限制 Inspector 输入。
- 脚本不依赖具体匿名 Mesh 名，避免 GLB 节点重命名后失效。

## 文件同步

以下两组文件必须保持逐字节一致：

- `F:\3d-models\models\box\box.model.ts`
- `F:\3d-models\models\Assets\Models\box\box.model.ts`
- `F:\3d-models\models\box\meta.json`
- `F:\3d-models\models\Assets\Models\box\meta.json`

## 当前项目资产索引刷新

当前项目 `F:\3d-models\models\.babylon-editor\asset-index.json` 中原有 Box 条目仍是无脚本的 `meter / 1` 旧快照。同步文件后必须只替换该 Box 条目：

- 使用当前扫描器重新读取 `Assets/Models/box`。
- 写入 `box.model.ts`、参数元数据、`centimeter / 0.01` 和 `Box 纸箱` 展示名。
- 生成新的 `assetRevision`，让编辑器重新加载同路径资产。
- 保留索引中的其它模型和环境条目，不改动其顺序与内容。
## 验证

按用户要求不执行完整测试套件，只做最小工程验证：

- TypeScript 转译校验外置脚本语法。
- 模型包扫描确认脚本资产、显式厘米源单位、`0.01` 换算和米制参数；移除脚本时单位结果保持不变。
- `npm run smoke:units` 验证默认尺寸、参数变化、旋转不变、非均匀 scale 和测量快照不序列化。
- 脚本生命周期校验默认值与自定义值缩放结果。
- 源包与 Assets 副本 SHA-256 一致。
- `npm run typecheck`、`npm run build` 和目标文件 `git diff --check`。
