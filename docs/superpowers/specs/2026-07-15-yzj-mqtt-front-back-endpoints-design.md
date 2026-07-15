# YZJ MQTT 前后端方向参数设计

## 目标

为 `F:\3d-models\models\YZJ` 一体式顶升移载模型增加可配置的 MQTT 前端、后端方向，使 `front_signalBits`、`back_signalBits`、`front_has_goods`、`back_has_goods` 能与模型局部真实端点一一对应，同时保留现有入料侧、出料侧和方向箭头语义。

## 当前问题

- YZJ 目前只暴露 `infeedSide` 与 `outfeedSide`。
- MQTT 协议使用独立的“前端/后端”光电语义；前端不一定等于入料侧，后端也不一定等于出料侧。
- 当前仓储场景中 1004 是“前端入料、后端出料”，1005 是“后端入料、前端出料”，证明不能用统一的入/出料别名替代前/后端。
- 若继续按入/出料侧推断，模型旋转或场景物流角色切换后，MQTT 光电可能对应到错误的空间端点。

## 方案比较

### 方案 A：把入料侧/出料侧重命名为前端/后端

优点：字段少。

缺点：破坏现有方向箭头和物流流向语义，无法表达 1005“后端入料、前端出料”，不采用。

### 方案 B：新增独立 MQTT 前端/后端方向参数（采用）

新增 `frontSide`、`backSide`，与 `infeedSide`、`outfeedSide` 并存。参数脚本把四种方向写入 `metadata.logisticsFlow`，运行时用前/后端方向解释 MQTT 光电，用入/出料侧继续处理物流流向和方向箭头。

优点：语义清晰、兼容现有场景、可覆盖 1004/1005 相反物流角色；不引入场景格式升级。

### 方案 C：在 MQTT 全局配置中增加端点映射

优点：不修改模型包。

缺点：映射属于模型实例的局部坐标契约，放到全局 MQTT 配置会导致同型号不同旋转/摆放难以维护，不采用。

## 参数契约

新增两个 enum 参数：

- `frontSide`：标签 `MQTT 前端方向`，默认 `right`，表示局部 X-。
- `backSide`：标签 `MQTT 后端方向`，默认 `left`，表示局部 X+。

可选值继续复用现有四向：

- `left`：局部 X+
- `right`：局部 X-
- `front`：局部 Z-
- `rear`：局部 Z+

默认值依据当前 1004/1005 场景的实体参数：两台 YZJ 的物理 MQTT 前端均位于 `right`，后端均位于 `left`；两台设备仅入/出料角色相反。

## 元数据契约

参数脚本在模型根节点、`Ban.4` 和 `GT.3` 写入：

```ts
metadata.logisticsFlow = {
  infeedSide,
  outfeedSide,
  frontSide,
  backSide,
  coordinateSpace: 'model-local',
  sideAxes: { left: 'x+', right: 'x-', front: 'z-', rear: 'z+' },
};
```

`frontSide === backSide` 属于无效端点映射。更新后的运行时不得猜测另一端，而应让依赖前后端锚点的仓储货物联动停止，避免把 MQTT 前后光电映射到同一个位置。

## 运行时数据流

1. `deviceTelemetry.ts` 继续把 `signalBits` 或 `front_signalBits/back_signalBits` 归一为 `front_has_goods/back_has_goods`，不修改协议解析。
2. YZJ 参数脚本把前后端局部方向写入 `logisticsFlow`。
3. `SceneRuntime` 读取显式 `frontSide/backSide` 并计算世界锚点：
   - 入库输送机货物按 MQTT 前端 → MQTT 后端移动。
   - 出库输送机货物按 MQTT 后端 → MQTT 前端移动。
4. `infeedSide/outfeedSide` 继续供编辑态方向箭头、物流入口/出口和旧模型包兼容使用。
5. 老模型包没有 `frontSide/backSide` 时，维持原有 `infeed → outfeed` 仓储可视路径，不改变既有行为。

## 同步范围

- 源模型包：`F:\3d-models\models\YZJ\yzj.model.ts`、`meta.json`
- 当前项目副本：`F:\3d-models\models\Assets\Models\YZJ\...`
- YZJ 浏览器夹具：`F:\3d-babylon-editor\output\playwright\yzj-assets\yzj.model.ts`、`yzj.model.txt`、`meta.json`
- 项目资产索引：`F:\3d-models\models\.babylon-editor\asset-index.json`
- 编辑器运行时：`src/runtime/babylon/SceneRuntime.ts`
- 文档：`README.md`、`docs/yzj-parameter-visual-validation.md`

## 验证标准

- 三份 `.ts`、浏览器加载镜像 `.txt` 和三份元数据 SHA-256 一致。
- 三份 `meta.json` 的 `parameterScripts.fields`、`parameterScripts.values`、`modelParameters.parameters` 均包含 `frontSide/backSide`。
- YZJ 脚本可被 TypeScript 转译，仓库 `npm run typecheck` 通过。
- `SceneRuntime` 在显式映射存在时按前后端锚点工作；旧包缺少映射时仍走旧的入料到出料路径。
- `git diff --check` 无空白错误。
