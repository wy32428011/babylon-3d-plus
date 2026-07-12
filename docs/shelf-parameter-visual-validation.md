# Shelf 参数语义与视觉校验

## 目标

Shelf 参数脚本以 `Shelf.glb` 的真实节点结构为基准，保持 GLB 文件不变，只通过 `shelf.model.ts` 调整节点变换和运行态克隆。本轮调整解决两个问题：

1. 底部支架腿高度与货架高度分离，Inspector 新增 `supportLegHeight`。
2. 层数不再重复整套底部基座；第一层保留完整基座，后续层只增加上方黄色框架和两侧三角支架。

## 节点分组

| 结构 | GLB 节点 | 层数行为 |
| --- | --- | --- |
| 立柱 | `Box004`、`Box001`、`Box002`、`Box003` | 保留一组，按整架总高度向上延伸 |
| 底脚 | `Jiao001` ~ `Jiao004` | 始终贴地，只保留一组 |
| 贴地深向支撑 | `Box005`、`Box006` | 第一层基座，只保留一次 |
| 下方黄色横梁 | `Box032`、`Box031` | 第一层基座，只保留一次；高度由 `supportLegHeight` 控制 |
| 两侧三角支架 | `Box008`、`Box007` | 第一层保留原件，每增加一层增加一组 |
| 上方黄色框架 | `Box023`、`Box021`、`Box020`、`Box022` | 每层一组 |

脚本同时兼容对应的匿名节点别名 `node1` ~ `node35`。

## 高度参数契约

- `cellHeight`：显示名为“货架高度”，保留旧参数键和默认值 `4.525m`，避免旧场景参数丢失。
- `supportLegHeight`：显示名为“底部支架腿高度”，默认值 `0.904m`，范围 `0.4m ~ 5m`。
- 兼容层跨度：

```text
layerSpan = max(0.001, cellHeight - 0.904)
```

- 整架高度：

```text
totalHeight = supportLegHeight + layerSpan * layerCount
```

因此默认一层仍为 `4.525m`；默认两层为 `8.146m`；默认三层为 `11.767m`。底腿升高或降低时，贴地深向支撑和底脚保持原位，下方黄色横梁移动到目标高度，三角支架以模型底部为锚点缩放，立柱和上方框架同步适配。

## 层复制契约

单列、单深位下的结构数量：

```text
贴地深向支撑 = 2
下方黄色横梁 = 2
上方黄色框架 = 4 * layerCount
两侧三角支架 = 2 * layerCount
立柱 = 4
底脚 = 4
```

`layerCount > 1` 时禁止复制贴地深向支撑、下方黄色横梁、立柱和底脚。列复制仍共享起始侧支撑；双深复制仍使用 `cellDepth + deepSlotGap`，并只对第二深位应用 `deepSlotLift`。

## 视觉校验入口

- 底腿与层结构专项：`output/playwright/shelf-height-visual-check.html`
- 全参数矩阵：`output/playwright/shelf-visual-check.html`
- 底腿/层结构截图：`output/playwright/shelf-support-leg-layer-visual.png`
- 全参数矩阵截图：`output/playwright/shelf-parameter-matrix-visual.png`

专项页会对底部件数量、上方框架数量、三角支架数量、下横梁中心高度和整架高度执行断言；全参数页覆盖默认值、宽度、深度、立柱宽度、货架高度、列数、层数、双深间隔、深位提升和旋转组合。

## 本轮视觉结果

| 场景 | 结果 |
| --- | --- |
| 默认底腿 `0.904m` / 1 层 | 下横梁中心 `0.904m`，上方框架 4，三角支架 2，总高 `4.525m` |
| 低底腿 `0.45m` / 1 层 | 下横梁中心 `0.45m`，总高 `4.071m` |
| 高底腿 `1.40m` / 1 层 | 下横梁中心 `1.40m`，总高 `5.021m` |
| 默认底腿 / 2 层 | 底部件仍为 2/2，上方框架 8，三角支架 4，总高 `8.146m` |
| 默认底腿 / 3 层 | 底部件仍为 2/2，上方框架 12，三角支架 6，总高 `11.767m` |
| `cellWidth=1.25` | 宽度变为 `1.25m` |
| `cellDepth=1.8` | 深度变为 `1.8m` |
| `cellHeight=6.8` | 单层总高变为 `6.8m` |
| `columnCount=4` | 连续 4 列，总宽约 `2.728m` |
| 双深间隔 `0.4m` | 总深约 `2.766m` |
| 双深提升 `0.35m` | 第二深位抬升，整体高度约 `4.875m` |

## 同步要求

以下脚本和元数据必须字节一致：

- `F:\3d-models\models\Shelf\shelf.model.ts`
- `F:\3d-models\models\Assets\Models\Shelf\shelf.model.ts`
- `output/playwright/shelf-assets/shelf.model.ts`
- `output/playwright/shelf-assets/shelf.model.txt`

以及：

- `F:\3d-models\models\Shelf\meta.json`
- `F:\3d-models\models\Assets\Models\Shelf\meta.json`
- `output/playwright/shelf-assets/meta.json`

`Shelf.glb` 不允许修改；源包、资产副本和视觉夹具的 GLB 哈希必须一致。
