# YZJ 一体式顶升移载参数化设计

## 目标

调整 `F:\3d-models\models\YZJ` 的参数化脚本，使 `chainLength` 表达为画面左侧固定、只向画面右侧单向伸长；同时保持宽度联动、顶升组件位置及物流入/出方向具备明确且可验证的业务语义，并保持 `YZJ.glb` 不变。

## 当前问题

1. 旧版说明曾把 `chainLength` 写成以主体中心平均分摊长度差；这与当前“画面左侧固定、画面右侧单向伸长”目标冲突。
2. `GT.3` 辊筒随 `chainLength` 一起拉长，导致顶升组件仍被整机长度污染。
3. `platformLength` 只控制 `Ban.4`，没有同步控制顶升辊筒长度。
4. 缺少顶升组件整体位置参数。
5. 入料侧、出料侧必须保留为可识别的业务元数据，但不能生成方向箭头或场景定位几何。

## 参数契约

### 既有参数

- `chainLength`：只改变主体 `ZT.2` 的长度；以画面左侧为固定锚点，局部 X 长度变化只向画面右侧单向伸长。
- `platformLength`：同时控制 `Ban.4` 与 `GT.3` 的局部 X 长度，缩放中心保持不变。
- `chainWidth`：控制主体宽度，并同步改变 `Ban.4` 宽度及 `GT.3` 辊筒阵列覆盖宽度。
- `chainHeight`：保持现有主体高度和顶升组件整体上移语义。
- `rollerPosition`：只表示辊筒相对顶升平台的局部 X 微调，不代替顶升组件整体位置。

### 新增参数

- `platformPosition`：顶升组件相对模型基线位置的局部 X 偏移，单位米；`Ban.4`、原始 `GT.3` 和所有辊筒克隆同步移动，并约束在当前主体有效长度内。
- `infeedSide`：入料侧，取值 `left/right/front/rear`。
- `outfeedSide`：出料侧，取值 `left/right/front/rear`。

方向以模型局部坐标为准：`left = X+`、`right = X-`、`front = Z-`、`rear = Z+`。模型整体旋转后，业务元数据仍按模型局部侧解释，不依赖世界轴。

## 几何实现

1. `ZT.2` 保留固定端和延伸端保护段；固定端支腿、端头不移动，中段链条/侧梁向画面右侧延展，延伸端按长度差移动，不改变支腿和端头厚度。
2. `Ban.4 + GT.3` 视为同一个顶升组件：整机 `chainLength` 变化时，两者尺寸和中心均保持基线；只有 `platformLength`、`chainWidth`、`chainHeight`、`platformPosition` 可以改变该组件。
3. `platformLength` 对 `Ban.4` 和 `GT.3` 均使用中心锚定，防止独立长度调整造成组件漂移。
4. `platformPosition` 在长度缩放后应用；辊筒自身的 `rollerPosition` 在组件偏移基础上叠加。

## 入出方向定位

脚本把归一化后的 `infeedSide/outfeedSide` 写入模型根节点、`Ban.4` 和 `GT.3` 的 `metadata.logisticsFlow`。定位能力只通过业务元数据表达，不生成方向箭头、标记 Mesh 或额外材质，避免污染模型外观和 Hierarchy。

## 兼容与边界

- 旧场景缺少新参数时使用默认值：`platformPosition = 0`、`infeedSide = left`、`outfeedSide = front`。
- 不修改 `YZJ.glb`。
- 源模型包、项目 `Assets/Models` 副本和视觉夹具三份 `yzj.model.ts/meta.json` 必须字节一致。
- 保留现有 `dataDriven.motion.lift` 和 `dataDriven.motion.roller` 节点声明，不改变 PLC/MQTT 动作字段。

## 验收标准

1. `chainLength: 1.828m → 3.1m` 时，画面左侧固定端漂移接近 `0m`，右侧承担约 `1.272m` 的全部长度增量；`Ban.4 + GT.3` 的中心和长度保持不变。
2. `chainWidth` 增大时，`Ban.4` 宽度和辊筒阵列覆盖宽度均明显增大。
3. `platformPosition: -0.20m → +0.35m` 时，`Ban.4` 与 `GT.3` 同向移动且相互中心差保持不变，实际中心差按 `0.55m` 验收；`platformPosition = -0.35m` 因默认顶升靠近左侧固定端，应被合法边界约束到约 `-0.237m`，只作为越界约束案例。
4. `platformLength` 单独变化时，`Ban.4` 与 `GT.3` 长度同步变化且中心不漂移。
5. 四侧入/出参数能按模型局部侧写入 metadata，且任何参数组合和模型旋转状态下方向可视节点数量均为 0。
6. TypeScript 转译、模型包扫描、类型检查、构建和浏览器视觉矩阵全部通过。
