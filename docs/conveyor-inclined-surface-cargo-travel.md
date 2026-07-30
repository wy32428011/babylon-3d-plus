# 输送线斜面货物走行实施方案

> **状态：未实施**（2026-07-30 记录，当前无斜面需求，未来有）
> 引用约定：只写文件与方法名，不写行号（行号随合并漂移）。

## 一、背景问题

输送线货物走行目前只支持水平带面。链条/滚筒本体没有这个问题——本体平移走节点父空间局部轴
（`conveyorDriver.translateConveyorNodesFromBaseline` + `createLocalAxis`），零件或实体怎么斜都跟着对。
问题全在货物侧，`conveyorDriver.resolveConveyorCargoTravelContext` 的三处水平假设：

| 环节 | 现状 | 斜面表现 |
|---|---|---|
| 货物行走轴 | `getHorizontalModelAxis` 强制 y=0（runtimeNodeGeometry） | 货物只走水平，低端插进带面、高端悬空，链/货脱节 |
| 行程跨度 | 运动节点包围盒投影到水平轴 | 投影长 < 斜面真实长，到端钳位位置不对 |
| 贴合法线 upAxis | `getModelAxis(root, 'y')` 恒竖直 | 货箱不贴斜面 |

货物姿态目前继承 `getNodeWorldRotation(model.root)`，实体整体倾斜时恰好是对的，零件级倾斜时也不对。

## 二、需求场景（按预期出现顺序）

1. **模型内部零件级倾斜**：参数化改件把载货斜面（如链条件的父组）转了角度，root 仍水平
2. **成组载物面**：无单一零件做载物面，如左右两条链条共同承载（右件常是左件的镜像/180° 旋转副本）
3. **实体整体倾斜**：编辑器里整台输送机实体转角（被场景 1/2 的方案天然覆盖）

**明确不做**：Z 形/多段折线带面（需路径点 + 弧长插值，且链条本体平移在折线面上同样失效，属于另一个量级的改造）。

## 三、方案：载物面节点组参照系

货物需要的全部几何量（行走轴、法线、姿态、行程）改为从**配置的载物面节点组**的世界矩阵推导，
不再从 `model.root` 推导。零件级、成组、实体级倾斜的世界矩阵天然都被包含。

### 配置（`dataDriven.motion.cargo` 增加一个字段）

```ts
cargo: {
  frontHasGoodsField: "front_has_goods",
  backHasGoodsField: "back_has_goods",
  // 载物面成员节点：货物行走轴/法线/姿态/行程全从它们的世界姿态推导。
  // 单零件写 1 个；左右双链条写 2 个；不配置时回退现状（root 水平行为）。
  surfaceNodes: ["A31", "A32"]
}
```

### 姿态：成员轴向平均（带符号对齐）

- 每个成员节点取世界空间局部 x（行走方向）与局部 y（带面法线）：
  `getModelAxis` 参数本就是任意 TransformNode，直接复用
- **符号对齐后再平均**：各成员轴向与 root 水平行走轴点积，反向先翻转——
  专治左右件镜像建模（-scale 镜像或 180° 旋转副本局部轴指向相反），
  对共面但建模角度略有偏差的件也有容错
- 平均后重新正交化（up 去掉沿 travel 的分量），由 (travel, up, 叉积第三轴) 构建货物旋转——
  不再读单个节点的 quaternion，单件/多件统一

### 行程：成员包围盒联合

跨度/中心用所有成员节点的**联合包围盒**在合成斜轴上投影（比单件更代表真实载物面范围），
行程钳位公式 `resolveConveyorCargoTravelHalfRange` 不动——
货箱随斜面转，沿斜面方向占位就是局部长度，`CONVEYOR_CARGO_SIZE[axis]` 无需改。

### 节点查找

复用 `conveyorDriver.findConfiguredConveyorMotionNodes` 那套：
精确名 + 参数化克隆 metadata（`motionSourceNodeName`/`sourceNodeName`），
参数化克隆出来的斜面件也能命中。

## 四、实施清单（到时候照着做）

1. `specializedModelAssets.ts`
   - `readConveyorMotionConfig` 或新增 `readConveyorCargoSurfaceNodeNames(model)`：
     读 `motion.cargo.surfaceNodes` 字符串数组（参照 `readConveyorCargoSignalFields` 的写法）
2. `conveyorDriver.ts`
   - `resolveConveyorCargoTravelContext`：
     - 解析 surfaceNodes → 节点数组（空则走现有 root 路径，行为逐帧不变）
     - travelAxis = 成员局部 x（按 translate config 的 axis 名）符号对齐平均，再按 translate config 的 axis 语义取用
     - upAxis = 成员局部 y 符号对齐平均，对 travel 正交化
     - 跨度/中心 = 成员联合包围盒（`getNodesWorldBounds`）投影到 travelAxis
     - travelContext 增加携带合成旋转（quaternion from basis）
   - `applyConveyorCargoMotion` 调 `setGeneratedCargoRootPose` 处：
     有 surfaceNodes 时用 context 里的合成旋转，否则维持 `getNodeWorldRotation(model.root)`
3. `Assets/Models/链条机/chain-conveyor.model.ts` + `meta.json`：镜像补 `surfaceNodes` 示例（出现首台斜面模型时填真实节点名）
4. Inspector：`formatSpecializedMotionEntry` 已支持字符串数组，cargo 行自动展示，无需改

## 五、兼容性与前提

- 不配 `surfaceNodes` 的所有现有场景行为逐帧不变（root 水平路径完整保留）
- 前提：同一台输送机的载物件轴向约定一致（同族模型成立）
- 符号对齐基准：root 水平行走轴——保证 front/back 刷出方向约定与现状一致
