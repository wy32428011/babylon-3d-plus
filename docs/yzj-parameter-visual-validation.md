# YZJ 一体式顶升移载参数化、方向箭头与视觉验证

## 目标与边界

本轮交付同时覆盖 YZJ 一体式顶升移载的参数化几何、图片库贴图拖放、编辑态方向展示和 MQTT 运行态方向联动：

- `chainLength` 继续保持画面左侧固定，只向画面右侧单向伸长。
- 整机长度变化不拉伸、不平移 `Ban.4 + GT.3` 顶升组件。
- `chainWidth` 同步带动 `Ban.4` 和辊筒阵列变宽。
- `platformPosition` 沿模型局部 X 移动完整顶升组件，并做主体边界约束。
- `infeedSide/outfeedSide` 按模型局部坐标标识入料侧与出料侧。
- `frontSide/backSide` 独立标识 MQTT 前端与后端，使前后光电不再依赖入/出料方向猜测。
- GLB 本体不写入箭头；方向箭头由参数脚本运行时创建，不进入编辑器 Hierarchy，也不参与拾取和 Gizmo。

## 模型包与文件一致性

- 源模型包：`F:\3d-models\models\YZJ`
- 项目资产副本：`F:\3d-models\models\Assets\Models\YZJ`
- 浏览器视觉夹具：`F:\3d-babylon-editor\output\playwright\yzj-assets`
- 原始模型：`YZJ.glb`
- 参数脚本：`yzj.model.ts`
- 参数元数据：`meta.json`

最终指纹：

| 资源 | SHA256 |
| --- | --- |
| 四份 `yzj.model.ts/.txt` | `ceb2e07d2921ac9e6e70d12b521024ced93414e1b8a6181fd6338a4dc104adc9` |
| 三份 `meta.json` | `28436aa9f10121342943a0f7dcae4d88cbba731dcf568b459abfcc613188d166` |
| `YZJ.glb` | `5c400bb95afa24a035662e30ba21bca76cf5f7723fa6aceabe23aaee3c951ccb` |
| 内置方向箭头 PNG | `ae0e1b104306dc67c9222ebe3501866dade42e681a0b750ea94bb5540083d3f8` |

四份脚本保持字节一致，三份元数据保持字节一致，GLB 未修改。

## 参数语义

| 参数 | 语义 |
| --- | --- |
| `chainLength` | 只改变 `ZT.2` 主体局部 X 长度；左侧固定，增量全部向右侧单向伸长。 |
| `platformLength` | 同倍率改变 `Ban.4` 与 `GT.3` 自身长度，不受整机 `chainLength` 污染。 |
| `platformPosition` | 沿模型局部 X 移动 `Ban.4`、原始 `GT.3` 和全部辊筒克隆，越界自动约束。 |
| `chainWidth` | 改变主体局部 Z 宽度，并同步改变 `Ban.4` 宽度和辊筒阵列覆盖宽度。 |
| `chainHeight` | 改变主体高度并同步上移平台和辊筒。 |
| `rollerWidth` | 改变单根辊筒厚度。 |
| `rollerPosition` | 辊筒相对平台的局部 X 微调。 |
| `rollerDensity` | 沿局部 Z 生成辊筒阵列；克隆通过 `motionSourceNodeName = "GT.3"` 继承运行态运动。 |
| `infeedSide` | 入料侧：`left/right/front/rear`。 |
| `outfeedSide` | 出料侧：`left/right/front/rear`。 |
| `frontSide` | MQTT 前端方向，默认 `right`（局部 X-）；对应 `front_signalBits/front_has_goods`。 |
| `backSide` | MQTT 后端方向，默认 `left`（局部 X+）；对应 `back_signalBits/back_has_goods`。 |
| `showDirectionArrow` | 控制运行时是否创建并显示方向箭头。 |
| `directionArrowImage` | `texture` 参数；默认保存内置图片逻辑引用。 |

局部侧映射为：`left = X+`、`right = X-`、`front = Z-`、`rear = Z+`。`infeedSide/outfeedSide/frontSide/backSide` 的归一化结果写入模型内容根、`Ban.4` 和 `GT.3` 的 `metadata.logisticsFlow`。

## MQTT 前后端映射合同

- 入料/出料描述物流角色；前端/后端描述 PLC/MQTT 光电的物理端点，两套参数不得互相覆盖。
- 当前 1004 与 1005 的物理映射均为 `frontSide = right`、`backSide = left`：1004 的入料/出料是 `right → left`，1005 的入料/出料是 `left → right`。
- `SceneRuntime` 发现显式前后端后，入库货物按 MQTT 前端 → 后端插值，出库货物按 MQTT 后端 → 前端插值；输送进度跨度也取前后端真实世界距离。
- 老模型包没有 `frontSide/backSide` 时继续使用既有 `infeedSide → outfeedSide` 路径，不改变旧场景。
- 新模型包只提供一端、使用非法值或把两端配置到同一侧时，端点解析返回失败，仓储流不会按名称、唯一模型或相反方向做猜测。
- 新参数属于模型包 schema；已保存场景需要重新导入/刷新 YZJ 模型包后，Inspector 才会合并并显示两个 enum 字段。

## 图片库与 Inspector 拖放合同

- 内置逻辑引用：`editor-image://builtin/direction-arrow-glow`
- 拖放 MIME：`application/x-babylon-editor-image-asset`
- PNG：`512 × 512`、RGBA、透明角像素 alpha 为 `0`。
- 场景参数只保存逻辑引用；开发构建解析为 `/src/assets/images/direction-arrow-glow.png`，生产构建解析为带 hash 的 `/assets/direction-arrow-glow-*.png`。
- 拖放解码后会回查内置图片登记表，拒绝伪造引用、网络 URL 或未登记载荷。
- Inspector 的 `texture` 参数显示缩略图、逻辑引用和拖放提示；拖入后通过现有命令历史提交，可撤销。

真实编辑器 UI 验证中，先把 `directionArrowImage` 改为 `textures/custom.png`，再把图片库“方向箭头发光贴图”拖入 Inspector。最终参数恢复为 `editor-image://builtin/direction-arrow-glow`，命令历史可撤销，Console 记录“更新模型参数”。

## 方向箭头运行时实现

方向箭头由 YZJ 外置参数脚本在 `Ban.4` 顶面创建单个双面 Plane：

- 父级固定为 `Ban.4`，跟随顶升位置、宽度和遥测升降。
- `isPickable = false`，不进入业务 Hierarchy。
- 材质使用透明贴图、自发光、`disableDepthWrite = true`、`depthFunction = Constants.ALWAYS`。
- `renderingGroupId = 2` 且 `alphaIndex = Number.MAX_SAFE_INTEGER`，保证在设备透明材质之后绘制。
- 呼吸周期约 `1800ms`，alpha 在 `0.55..0.92` 间变化，缩放在 `1..1.03` 间变化。
- metadata 只包含 `generatedByParametricRuntime` 与 `directionArrowVisual`，不会伪装成 `GT.3` 运动克隆。
- `onStop/dispose` 会移除 observer，并释放 Plane、Material 和 Texture。

### 编辑态与 MQTT 运行态规则

| 状态 | 箭头行为 |
| --- | --- |
| 编辑态 | 按 `outfeedSide` 指向出料侧。 |
| `movement_x = 1` 或正值 | 指向 `outfeedSide`。 |
| `movement_x = 2` 或负值 | 指向 `outfeedSide` 的反方向。 |
| `movement_x = 0` | 隐藏。 |
| 无遥测快照 | 隐藏。 |
| `faulted = true` | 隐藏。 |
| 停止运行预览 | 清理运行态并恢复编辑态 `outfeedSide` 箭头。 |

四方向局部 yaw：`left = 0`、`right = π`、`front = π/2`、`rear = -π/2`。

## 浏览器验证入口

开发服务器示例：

```bash
npm run dev -- --port 4311 --strictPort
```

验证页：

- 实际编辑器 UI：`http://127.0.0.1:4311/`
- 图片库拖入 texture：`/output/playwright/image-library-texture-drop-check.html`
- 四方向、贴图、父级与呼吸：`/output/playwright/yzj-direction-arrow-check.html`
- 入/出侧 metadata、方向与清理：`/output/playwright/yzj-flow-direction-check.html`
- 参数矩阵：`/output/playwright/yzj-visual-check.html`
- Conveyor/MQTT 正反向、停止、故障、无数据、恢复与顶升跟随：`/output/playwright/yzj-conveyor-runtime-check.html`

生产视觉产物：

```bash
npm run build:yzj:visual
```

输出目录：`output/playwright/yzj-production-dist`。最终生产构建包含：

- `output/playwright/image-library-texture-drop-check.html`
- `output/playwright/yzj-direction-arrow-check.html`
- `output/playwright/yzj-conveyor-runtime-check.html`
- `assets/direction-arrow-glow-BtV93S9t.png`，大小 `28407` 字节。

## 2026-07-12 最终验证结果

### 静态、类型与构建

以下命令均以退出码 `0` 完成：

```bash
node output/playwright/validate-yzj-static.mjs
npx tsc -p tsconfig.json --noEmit --incremental false
npm run build
npm run build:yzj:visual
```

静态校验结果：`ok = true`、`failures = []`、`transpileErrors = []`、`directionVisualsEnabled = true`。

### 几何参数

- `chainLength: 1.828m → 3.1m` 时，左侧固定端漂移 `0`，右侧增长约 `1.272m`，主体中心右移约 `0.636m`。
- 整机长度变化时，`Ban.4` 与 `GT.3` 中心和长度保持不变。
- `chainWidth: 1.194m → 1.8m` 时，`Ban.4` Z 宽度约 `0.919m → 1.385m`，辊筒阵列覆盖约 `1.194m → 1.8m`。
- `platformPosition: -0.20m → +0.35m` 时，平台和辊筒阵列同步移动 `0.55m`。
- `0°/45°` 同参数案例最大局部几何差为 `0`，旋转后仍沿模型局部轴解释。

### 图片库与四方向

- 实际编辑器 Project 图片库显示透明青蓝发光箭头卡片。
- 实际 Inspector `directionArrowImage` texture 区接收拖放并显示缩略图。
- 开发与生产拖放报告均为 `failures = []`；生产载荷 URL 为 `/assets/direction-arrow-glow-BtV93S9t.png`。
- 四方向生产报告生成 `4` 个显示态箭头，父级全部为 `Ban.4`，贴图存在、呼吸动画变化成立，`showDirectionArrow = false` 不生成箭头。

### Conveyor/MQTT 运行态

最终生产运行报告：

- motion 配置：`2`。
- 原始 `GT.3` + 参数化克隆：`5` 根。
- 运行态 ready：`true`。
- 升降约 `0.147m`，旋转约 `132°`。
- 克隆最大升降差：`0`；最大旋转差：`0`。
- 箭头跟随 `Ban.4` 的世界高度差约 `6.9e-9m`。
- 呼吸采样：`12` 帧，alpha 范围约 `0.255`，缩放范围约 `0.021`。
- `movement_x = 1` 正向可见；`movement_x = 2` 反向可见；停止、故障、无数据均隐藏。
- 停止预览后位置恢复差 `0`，旋转恢复差约 `2.98e-8rad`，编辑态箭头恢复。
- 进入最终连续正向状态 `8s` 后，箭头仍保持可见、贴图就绪、父级为 `Ban.4`。

## 2026-07-15 MQTT 前后端增量验证

本次不修改 GLB 几何、方向箭头材质或浏览器视觉布局，验证集中在参数契约和运行时锚点：

- 三份 `yzj.model.ts` 与浏览器加载镜像 `yzj.model.txt` 的 SHA-256 均为 `ceb2e07d2921ac9e6e70d12b521024ced93414e1b8a6181fd6338a4dc104adc9`。
- 三份 `meta.json` SHA-256 均为 `28436aa9f10121342943a0f7dcae4d88cbba731dcf568b459abfcc613188d166`。
- `parameterScripts.fields`、`parameterScripts.values`、`modelParameters.parameters` 均包含默认 `frontSide = right`、`backSide = left`，四向 options 完全一致。
- 当前项目资产索引 YZJ 条目已刷新为 `assetRevision = mrlma85i-6b59c380-1357-427b-97b8-e76004155311`，脚本 metadata 与参数 schema 和资产副本一致。
- YZJ 外置脚本 `typescript.transpileModule` diagnostics 为 `0`；更新后的 `validate-yzj-static.mjs` 覆盖新参数与 `.txt` 浏览器入口；仓库 `npm run typecheck` 通过。
- 运行时保留旧包 fallback，同时对显式前后端缺失、非法或重合配置 fail-closed。
- 静态校验器直接执行端点纯逻辑样例：新包入库 `front → back`、出库 `back → front`，旧包 `infeed → outfeed`，partial/invalid/same-side 均返回失败。

## 最终视觉产物

- 实际编辑器图片库 → texture：`output/playwright/dev-editor-image-library-to-texture.png`
- 生产图片库拖放：`output/playwright/prod-image-library-texture-drop.png`
- 生产四方向箭头：`output/playwright/prod-yzj-direction-arrows.png`
- 生产 MQTT 运行态：`output/playwright/prod-yzj-conveyor-runtime.png`
- 开发参数矩阵：`output/playwright/dev-yzj-parameter-matrix.png`
- 开发入/出侧方向：`output/playwright/dev-yzj-flow-directions.png`

视觉复核结论：透明背景无矩形光晕伪影；四方向可辨；最终 MQTT 运行态箭头完整显示在移动面上；参数矩阵继续保持单向伸长、宽度联动、顶升位置和旋转局部轴语义。