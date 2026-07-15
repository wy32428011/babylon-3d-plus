# 模型库 Box 米制拖拽设计

## 背景

编辑器已约定 `1 scene unit = 1 m`，内置 Box 对应 `cube`，Babylon 运行时通过 `MeshBuilder.CreateBox(..., { size: 1 })` 创建。当前数值事实上已经是 1 米基准，但资源卡片和 Inspector 没有把 Box 的尺寸语义显式暴露；拖拽落点又直接使用 `y = 0` 作为 Box 中心，导致 1 米 Box 有一半位于地面以下。

## 目标

- 模型库内置 Box 明确显示默认尺寸 `1 m × 1 m × 1 m`。
- Box 拖入 Scene View 后，底面落在鼠标命中的地面位置。
- 选中 Box 时，Inspector 的 X/Y/Z 缩放值以 `size (m)` 表达实际米制尺寸。
- 保持 `Transform.scale` 的内部无量纲契约、场景格式和旧场景兼容性不变。

## 方案比较

1. **只给 scale 增加 m 单位**：改动最少，但会错误影响球体、地面和导入模型，违背 scale 无量纲约定。
2. **新增 Box 尺寸组件并迁移序列化**：语义最完整，但需要新增命令、序列化兼容和运行时重建，超出本次需求。
3. **1 米基准 Box 的 UI 边界映射（采用）**：Box 基础几何固定为 1 米，因此 `scale.x/y/z` 数值与 Box 的实际边长米数一一对应；只在 Box UI 上显示 `size (m)`，底层仍保存 scale。

## 设计

新增集中常量 `BUILT_IN_BOX_SIZE_METERS = 1`，由运行时建模、资源卡片和拖拽落地偏移共同引用。Scene View 处理内置 cube drop 时，将地面交点的 Y 增加 `0.5 m`，使 Box 中心位于半高位置。Inspector 仅在 `meshRenderer.meshKind === 'cube'` 时把 scale legend 改成 `size (m)`，其它实体继续显示无量纲 `scale`。

## 边界

- 点击 Box 卡片仍沿用原点快捷创建行为；本次只调整用户明确指出的拖拽入场路径。
- 球体、地面、导入 GLB、定位线框和环境模型行为不变。
- 不新增依赖，不迁移场景文件，不修改 Babylon Transform 语义。

## 验证

按用户要求不执行完整测试；完成后运行 TypeScript 类型检查、构建和目标文件 `git diff --check`，并审查 Box/非 Box 的单位显示分支。
