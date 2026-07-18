# 模型生成器 Fetch 数据源与 ThinInstance 合批渲染实施计划

日期：2026-07-18

## 步骤

1. 工具栏新增 fetch 配置入口：点击弹出面板，输入 fetch 基础 URL，存入场景级配置（SceneSettings）。
2. `ModelGeneratorComponent` 新增 `dataSource` 字段（`'mqtt' | 'fetch'`，默认 `'mqtt'`），同步更新 `sanitizeModelGeneratorComponent`、`createDefaultModelGeneratorComponent` 和序列化。
3. `ModelGeneratorInspector` 顶部新增数据源 Switch，fetch 模式下显示提示文案。
4. 实现 fetch → 仓储同步链路：读取工具栏 URL + 事件参数 → 拼接 → 发起请求 → 解析响应 → 规则匹配 → 写入 `warehouseCargos`。
5. 新建 `ModelGeneratorFetchRuntime`：监听仓储货物状态，按 target model 分组，管理 thinInstance batch 的生命周期。
6. `SceneRuntime` 集成：fetch 模式生成器跳过 `applyDeviceTelemetryFrame`，新增事件入口方法。
7. 新增 IPC 暴露事件入口给 renderer。
8. typecheck + build 验证。

## 验证顺序

1. `npm run typecheck`
2. `npm run build`
3. 编辑器测试：工具栏配置 URL → 创建 fetch 模式生成器 → 绑定 Locator assetId → 触发事件 → 验证 thinInstance 货物渲染位置
