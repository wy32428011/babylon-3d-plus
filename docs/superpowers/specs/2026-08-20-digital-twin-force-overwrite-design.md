# 数字孪生发布强制覆盖设计

## 目标

数字孪生编辑器在本地基础版本落后于数据中台最新版本时，允许用户显式选择“强制覆盖”，将当前本地场景作为数据中台下一版本发布。该操作不删除或改写历史版本。

## 范围

- 编辑器发布弹窗在检测到版本冲突时展示单次有效的强制覆盖确认项。
- 编辑器通过 IPC 和数据中台发布 API 显式传递 `forceOverwrite`，不通过伪造 `baseVersionId` 隐式绕过冲突校验。
- 数据中台 prepare 阶段在 `forceOverwrite=true` 时，以当前远端最新版本作为发布任务的实际基线。
- 数据中台 commit 阶段继续执行 compare-and-swap 校验；prepare 后若又出现新版本，本次发布仍返回版本冲突。
- 项目资源修订冲突不受强制覆盖影响，仍要求同步资源并检查场景后重新发布。

## 非目标

- 不删除、替换或修改历史工程版本。
- 不绕过共享模型、环境模型、组合模型等项目资源修订校验。
- 不自动合并远端场景内容与本地场景内容。
- 不把强制覆盖保存为用户偏好或项目配置。

## 交互设计

发布上下文没有版本冲突时，发布流程和现有“覆盖目标项目当前数字孪生工程”确认保持不变。

发布上下文存在版本冲突时：

1. 弹窗不再永久禁用发布按钮。
2. 显示高风险确认项“强制使用本地版本覆盖远端最新版本”。
3. 辅助说明明确：本地内容将创建为下一版本，历史版本保留；项目资源修订仍会校验。
4. 用户未勾选时阻止提交并显示校验错误。
5. 强制覆盖只对当前弹窗中的本次发布有效；切换项目、关闭弹窗或重置后恢复为未选中。

现有 `overwriteExisting` 继续表示“目标业务项目已有数字孪生工程时允许沿用该 Editor 工程创建下一版本”。新增 `forceOverwrite` 专门表示“本地基础版本落后时允许基于远端最新版本发布”，两者职责不合并。

## 调用链与数据流

1. `DigitalTwinPublishDialog` 根据 `context.versionConflict` 展示并校验强制覆盖确认项。
2. `useDigitalTwinPublish` 将 `forceOverwrite` 写入 `DigitalTwinPublishRequest`。
3. Electron 主进程校验布尔值并传给 `DigitalTwinUploadClient.prepare`。
4. 数据中台 `DigitalTwinPublishPrepareDTO` 接收 `forceOverwrite`。
5. prepare 阶段：
   - 未冲突时沿用请求中的 `baseVersionId`；
   - 已冲突且未强制覆盖时返回 `DIGITAL_TWIN_VERSION_CONFLICT`；
   - 已冲突且已强制覆盖时，把服务端当前 `latestVersionId` 记录为任务 `baseVersionId`。
6. commit 阶段继续要求当前 `latestVersionId` 等于任务 `baseVersionId`，防止上传期间覆盖新的并发发布。
7. 发布成功后编辑器按现有逻辑刷新本地绑定到新版本。

## 错误处理

- 强制覆盖未确认：编辑器本地校验阻止发布。
- 服务端不支持或拒绝 `forceOverwrite`：按现有 API 错误展示，不做静默降级。
- prepare 前已有版本冲突且未强制覆盖：返回 `DIGITAL_TWIN_VERSION_CONFLICT`。
- prepare 后出现并发版本：commit 返回 `DIGITAL_TWIN_VERSION_CONFLICT`，并保留现有本地冲突包行为。
- 项目资源修订变化：无论是否强制覆盖，返回 `DIGITAL_TWIN_RESOURCE_REVISION_CONFLICT`。

## 兼容性

`forceOverwrite` 为可选布尔字段，缺省按 `false` 处理。旧编辑器和旧调用方行为不变；编辑器连接未升级的数据中台时不会伪造兼容行为，而是展示服务端返回的冲突或参数错误。

## 验证

- 编辑器单元或契约测试覆盖请求字段、冲突确认和普通发布不受影响。
- 编辑器发布集成测试覆盖强制覆盖成功、未确认仍冲突、资源修订冲突仍阻止、prepare 后并发版本仍阻止。
- 数据中台 validator/service 测试覆盖强制覆盖时采用远端最新基线及 commit 的并发保护。
- 分别执行编辑器定向测试与 `typecheck`、数据中台 editor 模块定向 Maven 测试。
