# 阅读覆盖与文档复核记录

[返回总览](README.md)

记录日期：2026-10-28。本页描述本次实际完成的阅读、校验及未执行事项；它不是测试报告，也不代表生产验收结论。

## 阅读范围

三维项目阅读覆盖依赖和构建配置、Electron 主进程与 preload、编辑状态与命令、场景序列化迁移、Babylon 场景生命周期、模型加载和脚本、设备遥测、货物/库位、CAD、光照、巡检漫游、平台资源同步、双包发布、Viewer 和页面桥，并查看对应测试与 CI 入口。采用入口和关键调用链抽样深入阅读，没有逐行审计所有驱动、面板和算法。

中台阅读覆盖 Maven 聚合及公共模块、管理端路由/请求、项目与资源、文件和归档、大屏与媒体、Editor 和发布、DataFlow 数据源/执行/调度/发送/接收/最新值，以及认证、日志和 Nginx 管理。数据库结论来自实体、Mapper 和 Flyway 文本，不来自真实数据库；测试结论来自源码和脚本定义，不来自执行结果。

跨项目同时核对了资源同步 URL、SOURCE 下载、数字孪生 Controller/DTO 与 Electron client、运行配置、MQTT adapter、HTTP 库存/特效入口以及大屏 postMessage 主协议。旧 Editor 格式、普通 RESOURCE 发布、数据流发布与当前三维 SOURCE/DIST 发布已在文档中分开。

## 独立复核的高影响结论

| 结论 | 二次复核结果 | 必须保留的限定 |
| --- | --- | --- |
| AuthService 返回匿名与 null token | 源码确认 | 不把单个认证服务结论推广为外部网关或独立 API Key 不存在 |
| 引用资源快照与客户端 revision 断言差异 | 两侧源码确认 | confirmResourceBindings=false 要求相等，true 允许增大；故障未动态复现 |
| 普通 Web 与数字孪生 DIST 的 apiKey 清理不同 | 序列化→准备→写出链确认 | SOURCE 保留编辑配置；未生成实际包、未确认真实泄露 |
| commit 非文件系统/数据库全局事务 | 调用顺序确认 | latestVersionId 有部署前更新，统一记录与最终线上绑定在部署后 |
| 大屏 updatedAt 并发判断被注释 | Service 与 SQL 条件确认 | 旧稿覆盖是风险推断，不是本次复现结果 |
| 最新值来自 MQTT_SEND 成功后 | 发送、缓冲与订阅代码确认 | 还需启用 storage 且通过校验；异步提交不等于已落库 |

对应证据：[AuthService](../../../central-data-platform/backend/twin-module-system/src/main/java/com/centraldataplatform/twin/system/auth/AuthService.java#L13)、[prepare/commit](../../../central-data-platform/backend/twin-module-editor/src/main/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishAppService.java#L133)、[客户端断言](../../electron/ipc/digitalTwinUploadClient.ts#L392)、[公开场景清理](../../electron/ipc/digitalTwinPublishService.ts#L792)、[大屏更新](../../../central-data-platform/backend/twin-module-screen/src/main/java/com/centraldataplatform/twin/screen/app/service/ScreenAppService.java#L210)、[成功发送后的最新值](../../../central-data-platform/backend/twin-module-dataflow/src/main/java/com/centraldataplatform/twin/dataflow/run/app/service/DataFlowSendService.java#L274)。

## 文档静态检查

对交付 Markdown 的相对链接进行了程序校验，检查最终目录下目标存在性，并检查 `#L` 起止行号未超出对应文件长度。整理过程中纠正了三处三维源码目录定位及一处迁移文件末行引用。链接存在与行号合法只是引用质量检查，不能代替代码语义复核，也不能保证其他阅读器支持跳转行号。

检查了 Markdown 代码围栏闭合、文档间导航、UTF-8 内容及两仓导航关系。共七张 Mermaid 图由源码结论整理并人工核对结构，未使用 Mermaid 渲染器做图片或浏览器渲染验收；不支持 Mermaid 的阅读器会显示代码块，图文说明仍可独立阅读。

新增文件写入独立 `docs/technical-handover/` 目录，未覆盖已有文档。正式主文档只保留一套，中台目录放置导航入口，避免跨仓完整复制产生版本漂移。写入后比对草稿与交付文件字节内容，并重新检查最终位置链接。中台 docs 被当前 ignore 规则忽略，三维文档目录未被同项检查忽略；本次没有修改 ignore 或执行暂存、提交。

## 未执行范围

本次没有安装依赖、运行项目脚本、类型检查、单元/集成/E2E 测试、构建或安装包，没有启动后端、Nginx、Electron 或 Viewer，没有执行数据库迁移、连接数据库/Broker/摄像头，也没有进行上传发布、回滚、删除或清理。文档中命令和验收矩阵均用于后续操作，不表示本次已执行。

未读取 node_modules、构建产物或模型等大二进制进行功能验证；锁文件的依赖节点是文本信息，不等于实际安装目录。没有对生产配置、真实网络 ACL、网关策略、现有数据和性能目标作确认。没有输出真实凭据，也没有主动探测或利用安全风险。

Git HEAD 仅提供源码定位参考，工作树有大量差异，并非冻结快照。阅读期间亦有文件集合变化迹象，因此这里不能提供可复现的“特定提交全部行为证明”。正式验收应冻结两仓版本和有效配置后重跑相关测试，并更新本页日期及证据。

## 后续维护

场景版本、runtime-config、资源快照和 postMessage 变更时，先更新[跨项目契约](03-integration-contracts.md)，同步两侧测试；改变部署或认证时更新[运行维护](04-operations-and-risks.md)。一般模块实现变化更新对应架构章节即可，不要把全部历史调试过程堆入总览。

需要真正证明功能可用时，应另建运行验收记录，包含源码基线、环境、命令、退出码、脱敏日志与复现结果。不能以本文的“已静态核对”代替“测试通过”，也不应把风险清单当作已完成整改清单。
