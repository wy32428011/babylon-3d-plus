# POI 内置 EFF 特效设计

**日期：** 2026-07-15

## 1. 目标

在 Project 面板的 `POI库` 内置 16 个工业数字孪生 EFF 特效。用户可点击卡片在原点创建，也可拖入 Scene View 按地面落点创建；创建后作为标准场景实体参与 Hierarchy、选择、Transform、显隐、锁定、复制、粘贴、阵列、撤销/重做、保存和加载。

## 2. 内置特效

1. 报警脉冲光圈 `alarm-pulse`
2. 旋转警示灯 `warning-beacon`
3. 定位光柱 `locator-beam`
4. 雷达扫描圈 `radar-scan`
5. 火焰 `fire`
6. 烟雾 `smoke`
7. 火花飞溅 `sparks`
8. 蒸汽泄漏 `steam-leak`
9. 气体泄漏 `gas-leak`
10. 水流喷射 `water-jet`
11. 管线流动粒子 `pipeline-flow-particles`
12. 管线流动箭头 `pipeline-flow-arrows`
13. 移动双箭头 `moving-double-arrow`
14. 货物目标定位框 `cargo-target-frame`
15. 输送方向箭头 `conveyor-direction`
16. 疏散路线 `evacuation-route`

## 3. 数据模型

所有特效共用 `PoiEffectComponent`，只保存可序列化配置：

- `effectKind`：16 个稳定类型之一。
- `enabled`：是否播放并显示特效。
- `primaryColor`：主颜色。
- `secondaryColor`：辅助颜色。
- `intensity`：亮度、透明度和视觉强度，范围 `0.1–3`。
- `speed`：动画和粒子速度倍率，范围 `0.1–5`。
- `density`：粒子数、重复单元数量和视觉密度倍率，范围 `0.1–2`。

位置、方向和整体尺寸继续使用实体 `Transform`：

- Position 控制特效锚点。
- Rotation 控制喷射、管线和箭头方向。
- Scale 控制整体作用范围。

场景文档不保存 Babylon Mesh、粒子对象、材质、纹理、观察者或动画时间。

## 4. 编辑器交互

- POI 库中的 16 张卡片均可点击或拖拽创建。
- 特效实体显示在 Hierarchy 中，名称使用中文预设名称。
- Scene View 使用透明拾取壳选中特效，内部视觉节点不可独立拾取。
- Inspector 提供特效类型、启用状态、主/辅颜色、强度、速度和密度。
- 切换特效类型时应用新类型默认参数，避免旧类型参数产生异常表现。
- 编辑态持续播放，方便 WYSIWYG 调整；运行预览不改变 EFF 的基础播放语义。

## 5. 运行时架构

新增独立 `PoiEffectRuntime`：

- 维护 `entityId -> EffectRuntimeEntry` 映射。
- 一个运行时只注册一个 Babylon `onBeforeRenderObservable`，统一驱动全部效果。
- 每个实体拥有稳定 `TransformNode` 根节点和透明拾取壳。
- 组件签名变化时只重建该实体内部资源；Transform、显隐和选中变化热更新。
- 粒子系统使用运行时生成的透明径向纹理，不新增外部图片依赖。
- 几何类效果复用标准材质、Torus、Cylinder、Box、Sphere 和 LineSystem。
- 所有内部 Mesh 均不可拾取，只有拾取壳写入 `editorEntityId`。
- 删除实体、切换类型和销毁 SceneRuntime 时统一释放 Mesh、材质、粒子、纹理和观察者。

## 6. 性能边界

- 单个粒子效果容量按密度限制在可控范围，不允许无上限增长。
- 同步过程不得每帧重建资源；逐帧仅更新旋转、位移、缩放、透明度等轻量属性。
- 隐藏或禁用实体不执行对应动画更新。
- 流动粒子和箭头使用有限数量的重复几何体，不创建无限轨迹。
- 移动双箭头把每组 8 段 Box 预合并为 3 个动画 Mesh，默认 9 个、最大 18 个动画 Mesh，控制 draw call 与逐帧属性更新量。
- 不新增独立 GlowLayer，避免与现有网格 GlowLayer 叠加产生高成本后处理。

## 7. 兼容和失败处理

- 旧场景缺少 `poiEffect` 时行为不变。
- 未知 `effectKind`、非法颜色或非有限数值在反序列化时拒绝或归一化，禁止把异常值带入 Babylon。
- 复制、粘贴和阵列深拷贝特效配置，实例之间不共享可变对象。
- 文件夹仍禁止携带任何运行时组件，包括 `poiEffect`。

## 8. 验收标准

- POI 库显示并可创建全部 16 个特效。
- 点击和拖拽创建位置正确。
- 16 个效果在 Scene View 中具有可区分的动态视觉表现。
- Inspector 参数修改实时更新。
- 选择、Gizmo、显隐、锁定、复制、阵列、删除、撤销和重做不报错。
- 保存后重新加载，类型和参数保持一致。
- TypeScript 类型检查和生产构建通过。
