# 大屏按钮爆炸图：本地验收记录

日期：2026-11-12。范围为两个现有工作区的未提交修改：ZENDING 编辑器与 CentralDataPlatform。没有提交、推送、部署或执行真实数据库迁移。

## 项目 Runtime 跨大屏绑定补充验收

本次补充对应“按钮可能不在带 Runtime 的大屏中，需要绑定当前项目的 Runtime”。新字段 `digitalTwinRuntimeTarget={projectId,screenId,widgetId}` 精确匹配项目、大屏和组件，旧裸组件 ID 保持本屏/来源屏语义。目录读取当前项目全部大屏，支持普通按钮及按钮组子项；服务端校验实际归属，已有自屏保存使用本次待保存组件。

实际承载方式是“主大屏 A 加载 Runtime，按钮子屏 B 作为 A 中的引用内容页或设备浮层”。B 可没有 Runtime。独立标签页不共享实例，单独打开 B 不会自动加载 A；无中台宿主的 Viewer 内嵌大屏协议不在本轮范围。项目级选择与跨浏览器窗口控制不能混为一谈。

| 补充检查 | 实际结果 |
| --- | --- |
| 创建项目身份、克隆载荷、设计器服务载荷 | 3 文件 / 21 项通过，含字符串 Long 上限、拒绝数字及越界 ID、不从大屏 JSON 推导项目归属 |
| 项目 Runtime 与高模链路定向回归 | 最终补丁后 10 文件 / 206 项通过，0 失败；覆盖发布快照权威 `projectId` 解析、字符串分页、普通/组按钮、属性面板、remoteData、协调器、真实 hook/Runtime 组件生命周期、原 hostbridge、固定版本及详情重载。与其他批次重叠，不相加 |
| 中台前端全量单测 | 最终补丁后 `npm --prefix C:/projects/CentralDataPlatform/frontend run test:unit`：1411 项，1406 通过、5 失败、0 取消或跳过；耗时 385050ms。仍为下方记录的语言属性、旧 Runtime 提示、MQTT 两项及项目导入 UI 五项，没有新增失败项，不表述为全仓通过 |
| Java 保存、发布、克隆、项目关系与集成入口 | 最终补丁后 14 类 / 195 项通过，0 失败、错误或跳过；主线程读取全部 14 份 Surefire XML 复核。`ScreenRuntimeTargetTest` 36 项、`ProjectConfigRuntimeTargetTest` 5 项、`ScreenArchiveJsonSupportTest` 27 项，包含 H2 跨屏配置、反向引用保护、集成换绑与 Spring 事务回滚验证 |
| 启动模块及后端依赖 | `mvn -q -pl twin-admin-start -am -DskipTests compile -f C:/projects/CentralDataPlatform/backend/pom.xml` 通过 |
| 中台正式前端构建 | 最终补丁后 `UMI_PLUGINS=C:/temp/babylon-3d-plus/.claude/central-build-isolation.cjs npm --prefix C:/projects/CentralDataPlatform/frontend run build` 通过；Webpack 编译 1.54 分钟，postbuild 编码检查 2028 文件。保留原构建目标，原有 `src/.umi-production` 42 份文件哈希未变，独立 Umi 临时入口已清理 |
| 实际配置组件 | 无 Runtime 的子屏从项目目录选中主屏，三元组正确保存；高模固定映射及旧字段清理正常；空映射被拒绝；基础信息表单显示服务端具体校验原因；0 页面错误。API 使用隔离夹具 |
| 最终跨屏硬件 WebGL | 最终补丁后 `node .claude/inspection-button-e2e.mjs`：35 项通过、0 未捕获页面错误或越界请求。真实字段使用字符串分页，从第二页目录选第 101 条目标；增、复制、删除其他 Runtime 配置及删除副本后，A 保留原会话、一次握手和可见 iframe，原选中设备仍可从无 Runtime 子屏打开高模。固定版详情请求 1 次、模型 GET 4 次（含中断）；已展开和加载中重载均恢复至 100%，模型实际可见。仅挂载 A 一个 GPU 场景；12 条控制台日志均为既有 Vite HMR WebSocket 连接拒绝，未关闭安全策略 |
| 图文教程 | 已替换跨大屏配置截图；4 张图片内嵌，离线请求为 0，8 个锚点有效，示例 JSON 可下载；375px 无全页横向溢出，打印正常。应用内置浏览器正文、控制台及截图检查通过 |

本轮复核后的边界修复：

| 触发条件 | 修复与回归覆盖 |
| --- | --- |
| 增加、复制或删除其他 Runtime，使已就绪的 A 重建通信桥并停在 `resolving` | 注册回调稳定，仅身份变化的实例更新登记；真实 hook、Runtime 组件及 hostbridge 回归检查 A 原 iframe/会话继续可用，所属屏、项目或手工 URL 变化时旧目标、选择和迟到请求失效，卸载清除最新登记与订阅 |
| 真实项目目录返回字符串 `total`，前端只接受数字，导致目录无法加载 | 按后端 `JacksonLongToStringConfig` 的实际序列化契约接受规范非负安全整数计数，拒绝空白、小数、负数与溢出；项目及大屏 ID 不转数字。两页目录及浏览器夹具使用字符串 `total/pageNum/pageSize` |
| 通过项目差量保存按资源 ID 解绑带有明确 Runtime 目标的大屏，绕过原有保护 | 同一 `projectId + screenId` 查询先校验再删除。隔离 H2、真实服务/Mapper 与 Spring 事务证明解绑被拒绝且先前场景关系变更回滚；旧按钮仍可解绑，其他项目关系不受影响 |
| 克隆 A 时，未参与克隆的外部引用 B 被误用 A 的目标项目校验 | B 按自身来源项目正常校验；确认外部引用后只克隆 A，保留 B 的引用、原内容与项目关系。真正跨项目克隆带目标的 B 仍拒绝 |
| `TwinIntegrationAppService.updateScreen` 先校验后改绑导致新绑/换绑项目误拒 | `ScreenAppService.update` 支持按目标 `projectId` 校验后再原子绑定；覆盖未绑/换绑项目和无效目标场景 |
| 目标大屏删除、移除/降级 Runtime 或移出项目时缺少反向引用保护 | 删除目标屏、修改目标屏使其 Runtime 不可用、或解绑/换绑项目时扫描来源引用并拒绝；覆盖草稿、`PUBLISHED` 快照与项目差量保存 |
| 跨库归档或旧 JSON 迁移未拦截残留 `digitalTwinRuntimeTarget`，发布快照缺少权威 `projectId` | `rejectTransfer` 与归档引用校验拦截残留或未映射 `digitalTwinRuntimeTarget`；发布快照写入权威字符串 `projectId`，`Published` 页面优先读取并清理不可达分支 |
| 协议校验正则触发 ESLint `no-control-regex` 警告 | `src/player/digitalTwinInteractionProtocol.ts` 改用等价 ASCII 控制字符码检查，`npx eslint ... --max-warnings=0` 与协议/构建门禁通过 |

本轮 Java 定向命令：

```bash
mvn -q -f C:/projects/CentralDataPlatform/backend/pom.xml -pl twin-module-integration -am -Dtest=ScreenRuntimeTargetTest,ScreenInspectionReferenceServiceTest,ScreenAppServiceTest,ScreenPublishServiceTest,ScreenCloneAppServiceTest,ScreenArchiveJsonSupportTest,ScreenPublishArchiveContributorTest,ProjectAppServiceTest,ProjectTransferAppServiceTest,ProjectTransferArchiveImportExecutorTest,ProjectTransferArchivePayloadServiceTest,TwinIntegrationAppServiceTest,TwinIntegrationControllerTest,ProjectConfigRuntimeTargetTest -Dsurefire.failIfNoSpecifiedTests=false test
```

本轮项目 Runtime 前端定向命令（10 文件）：

```bash
node C:/projects/CentralDataPlatform/frontend/node_modules/tsx/dist/cli.mjs \
  --tsconfig C:/projects/CentralDataPlatform/frontend/tsconfig.json \
  --require C:/projects/CentralDataPlatform/frontend/src/test/setup.cjs \
  --test --test-concurrency=2 \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/modelVersionInspection.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/components/babylonInspectionSession.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/digitalTwinRuntimeInteraction.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/digitalTwinRuntimeHostBridge.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/useBigscreenDigitalTwinInteraction.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/inspectionAction.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/components/BigscreenWidgetRenderer.test.tsx \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/projectRuntimeTarget.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/components/PropertyPanel.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/widgetDataSchemaTip.test.ts
```

本轮创建载荷回归命令：

```bash
node C:/projects/CentralDataPlatform/frontend/node_modules/tsx/dist/cli.mjs --tsconfig C:/projects/CentralDataPlatform/frontend/tsconfig.json --require C:/projects/CentralDataPlatform/frontend/src/test/setup.cjs --test --test-concurrency=2 C:/projects/CentralDataPlatform/frontend/src/services/screenCreate.test.ts C:/projects/CentralDataPlatform/frontend/src/services/screenClone.test.ts C:/projects/CentralDataPlatform/frontend/src/services/bigscreenDesigner.test.ts
```

实际配置截图由 `CENTRAL_DATA_PLATFORM_ROOT=C:/projects/CentralDataPlatform node .claude/capture-inspection-platform-ui.mjs` 构建真实组件夹具，再由 `node .claude/capture-inspection-guide-images.mjs` 驱动本机 Edge；教程由 `node .claude/check-inspection-guide.mjs` 检查。没有连接真实 MySQL 或向真实接口写入大屏。本轮没有修改编辑器运行时代码或基础通信协议；下面保留此前高模主流程验收结果，各批次覆盖交叉，不累加计数。

## 高模主流程行为

- 模型管理区分 `SCENE` 低模与 `INSPECTION` 高模，完整 meta 入库并随模型版本冻结。
- 场景传递设备身份和真实 `deviceType`；普通按钮和按钮组按类型映射固定高模版本。
- 官方 Babylon Viewer 从当前中台受控文件路径加载平台版本，正确 ACK 后自动展开；旧场景本地高模绑定仍兼容。
- 大屏保存、发布、同库克隆和删除保护覆盖固定引用；跨库固定高模映射转移仍拒绝。
- 图文教程采用模型管理和大屏按钮配置流程，场景不要求填写高模零件 JSON。

## 已运行并通过

| 范围 | 命令或检查 | 结果 / 实际边界 |
| --- | --- | --- |
| 编辑器类型 | `npm run typecheck` | renderer 检查与 Electron 编译通过 |
| 纯模块类型 | `npm run typecheck:quality` | 通过 |
| 编辑器与 Viewer | `npm run build` | 正式构建通过 |
| 测试门禁 | `npm run test:entries`、`npm run format:check` | 通过；format 仅仓库规定的四份配置 |
| 清单 | `node scripts/generate-test-inventory.mjs`，随后 `--check` | 994 项、未分类 0；由生成器更新 |
| 高模领域 | `npm run test:inspection` | 38/38；含装配、旧绑定、平台版本、硬件策略，Node/NullEngine 不等于实际 GPU |
| 新协议与 Long 上限 | `node --experimental-strip-types --test tests/digitalTwin/inspectionModelVersion.test.ts tests/digitalTwin/digitalTwinInteractionProtocol.test.ts` | 17/17；中台构建目标不支持 BigInt 字面量，已改为等价十进制字符串比较 |
| 跨仓消息 | `CENTRAL_DATA_PLATFORM_ROOT=C:/projects/CentralDataPlatform npm run test:inspection:bridge` | 2/2；真实控制器、模拟窗口，覆盖新旧加载、清空、取消和迟到结果 |
| 设备上下文 | Viewer 点击 17 项、点击/场景往返 25 项、增量与索引 33 项及追加固定版本恢复用例 | 定向回归通过；后续修正两份旧测试，控制器及全局概览合跑 36/36 |
| Electron 发布 | `npm run test:click-events:integration` | 通过；隔离工程，保存/发布/重开后保留真实 deviceType/entityId，无旧 inspection 绑定也能上报与清空 |
| 真实详情 WebGL | `INSPECTION_FIXTURE_ORIGIN=http://127.0.0.1:5247 npm run test:inspection:webgl` | 通过；真实 Edge 硬件 WebGL，旧 manifest、新平台版本、自包含拒绝与恢复 |
| 中台构建 | `UMI_PLUGINS=C:/temp/babylon-3d-plus/.claude/central-build-isolation.cjs npm --prefix C:/projects/CentralDataPlatform/frontend run build` | 最终边界补丁后的正式 max build 与 postbuild 通过，编码检查 2018 个文件；只隔离 Umi 自动生成的临时入口，未改变构建目标 |
| 中台模型表单 | 模型 API、meta 解析、表单、详情与版本视图定向测试 | 第一组 26/26；校验残留错误修复后相关 14/14 |
| 中台大屏 | 按钮/属性面板/详情桥 167 项，配置/复制/JSON 批次 202 项，生命周期批次 45 项 | 各批次通过，存在重叠，不能相加为总用例数 |
| 中台后端编译 | `mvn -q -pl twin-admin-start -am -DskipTests compile -f C:/projects/CentralDataPlatform/backend/pom.xml` | 启动模块与全部依赖编译通过；没有启动真实服务 |
| 模型和项目后端 | `mvn -q -pl twin-module-model,twin-module-project -am '-Dtest=Model*Test,DeviceType*Test,ProjectTransfer*Test,BaseResourceUrlArchiveContributorTest,SharedAssetArchive*Test' -Dsurefire.failIfNoSpecifiedTests=false test -f C:/projects/CentralDataPlatform/backend/pom.xml` | 最终模型 17 类/144 项、项目 21 类/162 项，共 306 项，均 0 失败/错误/跳过；包含新增 11 项真实 Mapper + H2 持久化回归及隔离文件 |
| 引用保护后端 | 大屏保存/发布/克隆、模型删除、项目转移、旧资源指纹定向批次 | 最终 13 类/180 项通过；与其他批次有重叠。覆盖冻结子屏、所有保留快照、跨库提前拒绝 |
| 格式 | 两仓 `git diff --check` | 通过 |

## 实际界面与浏览器范围

使用仓库已安装的 Playwright 与本机 Edge，不下载浏览器，不使用软件 WebGL 回退。预览服务复用应用的 `preview_start` 管理进程。

- 模型用途、元数据编辑、无效 parts → 修正有效 parts → 校验通过并清除旧错误、按钮空映射提示：实际 React/Ant Design 组件，接口数据为隔离夹具。
- 大屏闭环：实际 `BigscreenWidgetRenderer`、交互 hook、hostbridge 与正式详情入口；通过页面按钮调用真实低模点击处理器，发送设备上下文，再真实点击爆炸图按钮、零件树和关闭。
- 固定版本接口和低模几何使用夹具。记录定位复用经过实际动作构造与 hook 的程序化调用；没有把弹窗遮挡下的底层表格点击表述为实际 UI 点击通过。
- 本机 GPU 为 Intel UHD Graphics 630 / ANGLE Direct3D11。硬件路径通过不代表业务高模性能预算达标。
- 高模主流程阶段的大屏闭环命令 `node .claude/inspection-button-e2e.mjs`：24 项通过、0 未捕获页面错误。固定版本详情 POST 始终一次；GLB GET 共四次，包含重载中断的旧请求；无外部或真实数据库请求。覆盖已展开后重载、挂起旧 GLB 响应时再次重载，两个恢复会话均在新加载 ACK 后展开至 100%，清除旧 partKey，重新选择零件正常。保留 Vite HMR WebSocket 被本机网络策略阻止的开发日志，未修改安全策略。

## 高模主流程阶段复核与边界修复

独立审查及反证确认四项问题，随后完成局部修复和回归：

| 原问题 | 修复与证据 |
| --- | --- |
| 同设备迟到聚焦回执递增选择代次，使高模请求成功后仍等到超时 | 完全相同且因果有效的聚焦保留代次；实际变化仍失效，覆盖 A→B→A、HTTP 等待、待 ACK 和已打开状态 |
| 详情 iframe 重载不重发加载，旧 Promise 还会污染新页面 | 加载发送绑定会话代次，新会话重新协商、加载与展开；清除旧 partKey；CPU 与真实硬件浏览器均覆盖已加载后重载及加载中重载 |
| 归档明确无 meta 覆盖时残留旧文件，当前记录与新快照不一致 | meta 三字段成组显式写 NULL；旧包未声明时保留，有源 meta 文件时保留解析后的 JSON；快照更新限定 ID、模型 ID 和预期版本号 |
| 三个导入入口的空 deviceType 未落库，但新快照已为空 | 局部显式更新空值，不改全局字段策略；真实 Mapper + H2 直接检查当前表和版本表 |

后端新增 `ModelImportPersistenceTest` 的 11 项：修复前 10 项失败，修复后全部通过；其中包含旧历史全部数据库列不变和不调用文件删除接口的断言。最终模型/项目定向批次 306 项通过，主线程读取 Surefire XML 复核计数。最终前端修复定向批次为 7 文件、131 项通过，包含 `modelVersionInspection`、`babylonInspectionSession`、协调器、桥接、hook、按钮配置及渲染器；各批次重叠，不累计为全仓总数。正式前端 build/postbuild 与后端启动模块及依赖 compile 已在补丁后再次通过。

前端最终定向批次实际命令：

```bash
node C:/projects/CentralDataPlatform/frontend/node_modules/tsx/dist/cli.mjs \
  --tsconfig C:/projects/CentralDataPlatform/frontend/tsconfig.json \
  --require C:/projects/CentralDataPlatform/frontend/src/test/setup.cjs \
  --test --test-concurrency=2 \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/modelVersionInspection.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/components/babylonInspectionSession.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/digitalTwinRuntimeInteraction.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/digitalTwinRuntimeHostBridge.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/useBigscreenDigitalTwinInteraction.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/utils/inspectionAction.test.ts \
  C:/projects/CentralDataPlatform/frontend/src/pages/BigscreenDesigner/components/BigscreenWidgetRenderer.test.tsx
```

## 图文教程验证

`node .claude/check-inspection-guide.mjs` 通过：以本机 Edge 直接打开 `docs/inspection-guide.html`，拦截并确认没有 HTTP(S) 外部请求；4 张内嵌图片解码成功，8 个内部链接目标有效，下载的 meta 为合法 4 零件 JSON。375px 视口没有页面横向溢出，打印隐藏操作按钮并显示折叠内容，无页面错误。下载的示例另经中台实际 `parseModelInspectionMetadata` 校验器验证，4 零件及米制单位通过。另在应用内置浏览器确认正文结构、控制台与截图。

## 全量回归的未通过项

### 编辑器 core

最后一次 `npm test`：前置提升机两批 43/43、33/33 通过；`test:digital-twin:unit` 为 **749 项，741 通过、7 失败、1 跳过**，core 在该入口失败后停止，后续 core 子入口没有因此执行。两个由本次设备上下文扩展引起的旧断言已修正并通过。

剩余失败为：

- `glbStandardPreview.test.ts`：标准预览色调映射基线断言。
- `playerStatusOverlayControls.test.ts`：状态层绑定源码模式断言。
- 实时阴影相关四项：均衡档缓存、投射物变换刷新、方向光变化刷新、手动阴影距离。
- `sceneSwitchPublishGuard.test.ts`：异步关闭会话后迟到 token，报“场景打开请求已失效，请重试。”。

未为本功能修改这些失败路径，不把 core 表述为通过。

### 编辑器 lint

`npx eslint src/player/digitalTwinInteractionProtocol.ts --max-warnings=0` 通过（0 errors、0 warnings）；此前全仓 `npm run lint` 仍有 **11 errors、129 warnings**，分布在历史回放、参数化工作台、SceneViewPanel、WebGPU 视口等现有路径，未以批量自动修复扩大本次范围。

### 单位 smoke

`npm run smoke:units`：米制基础契约、CAD、模型测量、阵列及字符串参数测试已执行，末尾外部模型参数验收失败：

```text
Error: 缺少外部模型根：C:\temp\3d-models\models。请设置对应 BABYLON_MODEL_ROOT / BABYLON_ASSET_MODEL_ROOT / BABYLON_ASSET_INDEX_PATH 后重试。
```

未用真实工程替换隔离夹具，也未把前半段通过表述为整个入口通过。

### 高模主流程阶段的中台全量前端单测

以下为项目 Runtime 跨大屏改造之前的结果；本轮最新全量结果见文首补充验收表。

高模主流程边界补丁后重跑 `npm --prefix C:/projects/CentralDataPlatform/frontend run test:unit`：**1394 项，1389 通过、5 失败、0 跳过**。失败仍为以下五项，没有新增失败项：

- `WidgetLanguageBindings.test.ts`：目标语言属性标签的源码/渲染断言。
- `babylonRuntimeUtils.test.ts`：旧发布 Runtime 初始化提示断言。
- `pages/DataFlow/MqttData/model.test.ts`：设备类型/编号空白清理期望。
- `pages/DataFlow/utils/mqttStorageConfig.test.ts`：身份与空间字段校验期望。
- `pages/Project/archiveTransferUi.test.ts`：项目导入 UI 提示文字期望。

完整前端类型检查没有独立通过证据：该仓库现有 TypeScript/React 类型依赖不完整；正式生产构建通过不能代替完整类型检查。

## 未执行的部署环境验收

- V95 在真实 MySQL 的迁移、升级回滚与并发删除/保存事务行为。
- 真实中台 HTTP、真实数据库持久化及实际身份映射。
- 业务高模的精度、节点结构、尺寸、单位与配置适用性。
- 目标硬件首开/缓存打开时间、帧率和内存预算。
- 安装包、Blender/Cycles 及无宿主离线高模按钮流程；新按钮本来就需要中台在线。
