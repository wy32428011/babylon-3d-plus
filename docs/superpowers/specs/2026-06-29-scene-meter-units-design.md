# Scene Meter Units Design

## 背景

当前编辑器基于 Babylon.js 渲染与编辑 3D 场景，Transform 数值直接使用 Babylon/editor scene unit。用户明确要求：场景单位按照“米”为单位。为了避免后续模型导入、吸附、网格、Inspector 与场景文件之间产生单位歧义，本设计将第一版单位系统定义为“米制底座”：只启用米，不提供多单位切换，但集中声明单位语义并在新保存的场景文件中写入单位元数据。

## 目标

- 明确约定 `1 editor/Babylon scene unit = 1 米`。
- 为长度单位建立集中定义，避免 UI、运行时和序列化逻辑分散硬编码单位文案。
- 在 Inspector 与 Toolbar 中清晰标注长度相关输入的单位。
- 在地面网格实现中明确每小格为 `1 m`，整体网格尺寸以米解释。
- 新保存的 `.scene.json` 写入长度单位元数据。
- 保持旧版 `{ version: 1, scene }` 场景文件可加载，并默认按米解释。

## 非目标

- 不提供 `m/cm/mm/km` 等显示单位切换。
- 不改变 Transform 的底层数值，不做任何长度换算。
- 不修改 `scale` 的语义；`scale` 仍是无量纲缩放比例。
- 不修改 `rotation` 的语义；旋转仍沿用现有角度/弧度处理链路。
- 不引入模型导入缩放策略、测距工具、单位设置面板或项目设置系统。

## 架构

本次采用轻量集中式单位定义：新增一个单位模块，作为当前编辑器长度单位的唯一来源。运行时、UI 和序列化逻辑都引用该模块表达“米”语义。

建议模块位置：

```text
src/editor/model/sceneUnits.ts
```

建议导出内容：

```ts
export const SCENE_LENGTH_UNIT = 'meter';
export const SCENE_LENGTH_UNIT_SYMBOL = 'm';
export const SCENE_LENGTH_UNIT_LABEL = '米';
```

如实现阶段需要更严格类型，可额外导出：

```ts
export type SceneLengthUnit = typeof SCENE_LENGTH_UNIT;
```

该模块暂不承担换算职责，因为第一版只支持米。未来如果增加 cm/mm 显示，可在该模块附近扩展格式化、解析与换算函数。

## UI 设计

### Inspector

`InspectorPanel` 当前以 `position`、`rotation`、`scale` 三个 fieldset 展示 Transform。第一版只对长度字段增加单位标注：

- `position` 显示为 `position (m)` 或等价的中文标签 `位置 (m)`。
- `rotation` 不显示米单位。
- `scale` 不显示米单位，因为它是缩放比例而不是长度。

输入值不做换算。用户输入 `10`，Transform 中仍保存数字 `10`，含义为 `10 m`。

### Toolbar

`Toolbar` 当前提供位置、旋转、缩放三类吸附步长输入。第一版只对位置吸附增加单位标注：

- `位置` 改为 `位置 (m)` 或 `位置步长 (m)`。
- 默认位置吸附值 `0.5` 的语义为 `0.5 m`。
- `旋转` 不显示米单位。
- `缩放` 不显示米单位。

## Babylon 地面网格

`createEngine.ts` 当前地面网格参数为：

- `GRID_SIZE = 240`
- `GRID_SUBDIVISIONS = 240`
- `GRID_SPACING = 1`

设计语义为：

- 地面网格可视范围约为 `240 m × 240 m`。
- 每个小格为 `1 m`。
- 网格跟随相机重定位时，按 `1 m` 间距对齐世界坐标。

实现阶段可通过命名和中文注释让语义更明确，例如将相关常量命名为 `GRID_SIZE_METERS`、`GRID_SPACING_METERS`。视觉效果不需要改变。

## 场景文件格式

### 新保存格式

新保存的 `.scene.json` 应写入单位元数据：

```json
{
  "version": 1,
  "units": {
    "length": "meter"
  },
  "scene": {}
}
```

`units.length` 表示场景中长度相关 Transform 数值的单位。第一版唯一合法值为 `meter`。

### 旧文件兼容

旧版文件只有：

```json
{
  "version": 1,
  "scene": {}
}
```

加载旧版文件时，如果缺少 `units` 字段，应默认按 `meter` 处理，而不是拒绝加载。

### 非法单位处理

如果场景文件包含 `units`，但不满足以下结构，应拒绝加载：

```json
{
  "units": {
    "length": "meter"
  }
}
```

拒绝加载的例子包括：

- `units.length = "centimeter"`
- `units.length = "inch"`
- `units.length` 缺失
- `units` 不是普通对象

拒绝理由：静默加载未知单位文件会造成尺寸误读，例如把厘米文件当成米文件。

## 数据流

1. 用户在 Inspector 输入 `position.x = 10`。
2. `InspectorPanel` 将数字 `10` 原样写入 editor store。
3. editor store 更新 `SceneDocument.entities[*].components.transform.position.x`。
4. `SceneRuntime` 将该值同步到 Babylon mesh/light 的 position。
5. Babylon 中该值仍为 `10`，编辑器语义解释为 `10 m`。
6. 保存场景时，`SceneSerializer.serializeScene` 输出 `units.length = "meter"`。
7. 加载场景时，`SceneSerializer.deserializeScene` 校验单位；缺省单位按 `meter` 兼容。

## 错误处理

- UI 输入非法数字时，沿用当前逻辑忽略该输入，不额外引入单位错误。
- 位置吸附非法步长时，沿用当前 store 的正数兜底逻辑。
- 场景文件单位非法时，沿用当前 `场景文件格式不受支持。` 错误路径，避免暴露多套错误文案。
- 旧文件缺少 `units` 不视为错误。

## 文档更新

README 需要同步说明：

- 当前编辑器长度单位为米，`1 scene unit = 1 m`。
- Inspector 的 `position` 输入按米解释。
- Toolbar 的位置吸附步长按米解释。
- 地面网格每小格为 `1 m`。
- 新保存的 `.scene.json` 会写入 `units.length = "meter"`。
- 旧版没有 `units` 的场景文件会按米兼容加载。

## 验证策略

根据用户全局指令，本任务不主动执行完整测试。实现阶段至少进行静态自查：

- 单位常量只定义在集中模块中，避免多个文件各自硬编码 `meter` 或 `m`。
- Inspector 只给 `position` 增加米单位，不给 `scale` 增加米单位。
- Toolbar 只给位置吸附增加米单位，不给旋转和缩放增加米单位。
- Serializer 能保存新格式，也能加载旧格式。
- 包含未知单位的场景文件会被拒绝。
- README 覆盖单位约定与场景文件兼容策略。

如实现过程中出现 TypeScript 类型风险，可在用户授权或必要时运行最低成本的 `npm run typecheck`；默认不运行完整测试。

## 未来扩展

该设计为未来多单位系统预留以下方向：

- 在单位模块中增加显示单位与存储单位分离。
- 将 Inspector 输入从“原样数值”扩展为“显示单位解析后换算到米”。
- 在项目设置中保存显示单位偏好。
- 为模型导入增加单位检测与缩放策略。
- 增加测距工具或标尺组件，复用同一套单位格式化逻辑。
