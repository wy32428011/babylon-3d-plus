# 工具栏移除已迁移创建按钮设计规格

## 背景

模型库已经新增立方体、球体、地面、方向光、点光源五个内置资源卡片，支持点击创建和拖拽到 Scene View 按落点创建。Toolbar 中仍保留对应五个创建按钮，会造成重复入口。用户确认移除这五个 Toolbar 创建按钮，并保留当前模型库未覆盖的半球光创建入口。

## 已确认需求

- 从 Toolbar 移除：创建立方体、创建球体、创建平面、创建方向光、创建点光源。
- 保留 Toolbar 的创建半球光按钮。
- 模型库五个内置资源卡片继续作为立方体、球体、地面、方向光、点光源的创建入口。
- 不改变 W/E/R、局部/全局、吸附、删除、撤销、重做、保存、加载等 Toolbar 功能。
- 同步更新 README，避免文档继续引导用户从 Toolbar 创建这些对象。

## 设计

### `Toolbar.tsx`

收缩 `ToolbarProps`：

- 删除 `onCreateCube`
- 删除 `onCreateSphere`
- 删除 `onCreatePlane`
- 删除 `onCreateDirectionalLight`
- 删除 `onCreatePointLight`
- 保留 `onCreateHemisphericLight`

删除 JSX 中对应五个按钮，只保留 `创建半球光`。

### `EditorLayout.tsx`

删除不再被 Toolbar 使用的 `createMesh` selector。

保留 `createLight` selector，用于向 Toolbar 传入：

```tsx
onCreateHemisphericLight={() => createLight('hemispheric')}
```

删除向 Toolbar 传递的五个已移除 props。

### `README.md`

更新“基础操作”：

- 删除“点击顶部工具栏创建立方体、球体、平面”的说明。
- 将灯光说明改为：半球光从 Toolbar 创建，方向光和点光源从模型库内置卡片创建。
- 保留模型库内置资源说明。
- 最近完成增加本次 Toolbar 去重记录。

## 验证计划

- `npm run typecheck` 通过。
- `git diff --check` 不出现 whitespace error。
- 浏览器验证：Toolbar 不再显示五个已迁移按钮，仍显示 `创建半球光`。
- 浏览器验证：模型库仍显示立方体、球体、地面、方向光、点光源五个内置卡片。

## 成功标准

- Toolbar 无 `创建立方体`、`创建球体`、`创建平面`、`创建方向光`、`创建点光源`。
- Toolbar 仍有 `创建半球光`。
- TypeScript 不存在未使用 props 或类型错误。
- README 与实际入口一致。
