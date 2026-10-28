# 启动部署、维护风险与验收

[返回总览](README.md) · [三维架构](01-babylon-3d-plus.md) · [中台架构](02-central-data-platform.md) · [接口契约](03-integration-contracts.md)

本文记录代码中的运行入口、环境约束和建议验收步骤。所有命令仅作交接说明，本次未执行安装、构建、测试、服务启动、数据库迁移、发布或网络请求。风险优先级为工程建议，不是漏洞利用验证或正式安全审计结论。

## 首次运行前的条件

中台启动不是无副作用的探活。Flyway 会迁移数据库，启用的 Quartz 调度和已发布 MQTT/Socket 接收会恢复，Nginx runner 还可能同步脚本、启动进程。迁移中有启用的 MQTT 示例调度，因此应先选隔离数据库与网络，检查迁移和任务配置，再授权启动。不要使用配置中的开发回落值直接连接未知环境，也不要在生产库尝试通用 repair。

三维端需要支持的 Node、可用 GPU 及匹配的 Electron 运行环境。光照烘焙另需 Blender 4+，视频墙另需中台运行机上的 FFmpeg；Broker 需要为浏览器提供 WS/WSS listener。后端 POM 声明 Java 17 与 GraalVM polyglot 25.0.3，具体 JDK/依赖组合仍需真实构建验证，不能仅看声明就确认兼容。

依据：[Nginx 启动](../../../central-data-platform/backend/twin-module-system/src/main/java/com/centraldataplatform/twin/system/nginx/NginxStartupRunner.java#L50)、[调度恢复](../../../central-data-platform/backend/twin-module-dataflow/src/main/java/com/centraldataplatform/twin/dataflow/scheduler/app/service/DataFlowSchedulerService.java#L197)、[示例调度迁移](../../../central-data-platform/backend/twin-admin-start/src/main/resources/db/migration/V32__dataflow_mqtt_schedule_demo.sql#L109)、[依赖声明](../../../central-data-platform/backend/pom.xml#L36)。

## 开发与构建命令

下列命令分别在对应仓库根目录执行。依赖安装应先确定锁文件策略；中台前端同时存在 npm/yarn 锁文件，但配置使用 npm。本次没有修改依赖或验证安装命令。

| 仓库 | 命令 | 实际作用与限制 |
| --- | --- | --- |
| 三维 | `npm run dev` | Vite，127.0.0.1:5173，严格端口；不能替代全部桌面能力 |
| 三维 | `npm run dev:electron` | 自定义桌面开发启动器 |
| 三维 | `npm run build` | TypeScript、编辑器和 Viewer 构建 |
| 三维 | `npm run build:viewer` | 生成 dist-viewer-template |
| 三维 | `npm run typecheck` | 会生成/补充部分构建产物，不是纯只读检查 |
| 三维 | `npm test` / `npm run test:ci` | 默认 core 分组，不代表全量专项通过 |
| 三维 | `npm run pack:win` / `npm run dist:win` | release guard、构建、Windows x64 目录包或 NSIS |
| 中台 | `mvn -q test -f backend/pom.xml` | 后端测试入口；测试是否访问本机网络需看具体用例 |
| 中台 | `mvn -q -DskipTests package -f backend/pom.xml` | 聚合构建可执行 JAR；明确跳过测试 |
| 中台 | `npm --prefix frontend run dev` | Umi 管理端开发服务 |
| 中台 | `npm --prefix frontend run test:unit` | tsx + Node test runner |
| 中台 | `npm --prefix frontend run test:encoding` | 文本编码检查 |
| 中台 | `npm --prefix frontend run build` | Umi 构建，生命周期触发 postbuild 编码检查 |

后端在完成聚合打包、配置 local profile 和数据源环境变量后，可由 `java -jar backend/twin-admin-start/target/twin-admin-start-0.0.1-SNAPSHOT.jar` 启动。聚合根不是带主类的启动模块，直接切子模块也可能失去 sibling 依赖 reactor；交接中优先采用已打包 JAR 路径，不假定任意目录的 `spring-boot:run` 都可成功。中台前端没有默认 `test` 或 `lint` script。

依据：[三维脚本](../../package.json#L9)、[构建副作用](../../scripts/build-typescript.mjs#L55)、[中台前端脚本](../../../central-data-platform/frontend/package.json#L5)、[中台 JAR 配置](../../../central-data-platform/backend/twin-admin-start/pom.xml#L138)、[仓库操作说明](../../../central-data-platform/AGENTS.md#L69)。

## 配置交接表

只列键和用途，不复制当前环境的密码、Token、连接串凭据或私有服务地址。表中默认值来自源码，正式运行以环境变量、数据库配置和进程工作目录共同决定的有效配置为准。

| 配置组 | 关键键 | 交接要点 |
| --- | --- | --- |
| 数据库 | SPRING_PROFILES_ACTIVE、CDP_DATASOURCE_URL/USERNAME/PASSWORD | 优先隔离 local 环境，审查 dev 回落值 |
| 存储 | STORAGE_TYPE、STORAGE_LOCAL_ROOT | 实际资源根目录与服务账号权限；memory 不适合大资源持久化 |
| 数字孪生上传 | DIGITAL_TWIN_UPLOAD_TEMP_ROOT/SESSION_TTL_HOURS/CHUNK_SIZE | 暂存容量、清理周期、默认 24h/16MiB |
| 数字孪生静态站点 | DIGITAL_TWIN_NGINX_CURRENT_ROOT/RELEASE_ROOT/PUBLIC_BASE_URL | 稳定版、历史版及外部地址统一 |
| 旧 Editor | EDITOR_NGINX_CURRENT_ROOT/RELEASE_ROOT/PUBLIC_BASE_URL、EDITOR_BABYLON_IMPORT_ALLOWED_ROOT | 兼容部署目录及服务器路径导入边界 |
| Nginx 管理 | NGINX_MANAGEMENT_AUTO_START/SCRIPT_DIRECTORY/LISTEN_PORT/API_UPSTREAM/NGINX_HOME | 会调用本机脚本；关闭自启不等于所有脚本同步都关闭 |
| 浏览器来源 | WEB_CORS_ALLOWED_ORIGIN_PATTERNS | CORS 不是身份认证，不代替管理 API 权限 |
| 数据源出站 | DATAFLOW_DATASOURCE_ALLOWED_HOSTS | 当前不是严格仅名单可访问的语义，见风险章节 |
| 组件代理 | BIGSCREEN_COMPONENT_INTERFACE_ALLOWED_HOSTS/BLOCKED_HOSTS/ALLOW_LOCAL_ADDRESSES/ALLOW_LOOPBACK_ADDRESSES | 明确是否允许内网目标，不默认向不可信用户开放 |
| 视频墙 | BIGSCREEN_VIDEO_WALL_FFMPEG_PATH/WORK_DIR/MAX_ACTIVE_SESSIONS/SESSION_TTL_SECONDS | FFmpeg、磁盘和摄像头编码兼容性 |
| 视频库 | VIDEO_PUBLIC_BASE_URL、VIDEO_MAX_CONCURRENT_UPLOADS | 与 RTSP 视频墙是不同能力 |
| 项目归档 | PROJECT_TRANSFER_ARCHIVE_TEMP_ROOT/MAX_BYTES/MAX_EXPANDED_BYTES/SIGNING_SECRET/SIGNING_KEY_ID | 暂存容量；未配置 secret 时不能称归档已加密 |
| 运行日志 | APP_LOG_*、OPERATION_LOG_CONFIG_SECRET | 本地/数据库/ES 分开配置，ES 密码解密密钥独立保管 |
| MQTT 最新值 | DATAFLOW_MQTT_STORAGE_* | 本机缓冲、写入预算与延迟，不是历史库 |
| 开发代理 | API_TARGET | 仅 Umi 开发代理，生产仍为根相对 /api |

依据：[应用配置](../../../central-data-platform/backend/twin-admin-start/src/main/resources/application.yml)、[local 配置](../../../central-data-platform/backend/twin-admin-start/src/main/resources/application-local.yml)、[前端代理](../../../central-data-platform/frontend/config/config.ts#L4)。阅读这些文件时不要把实际配置值转贴到公共文档。

## 生产部署拓扑与文件约束

建议以同站点 Nginx 提供管理端、Viewer 静态目录和根 `/api` 反向代理。数字孪生包启动时访问根 `/api/v1/digital-twin/runtime-config/detail`，只复制 DIST 到无 API 的静态站点不足以完成当前集成。HTTPS 页面必须配套可用的 HTTPS API/WSS Broker，不能依赖浏览器放行混合内容。Viewer 不能靠双击 index.html 运行，需要 HTTP(S)、正确 MIME、Worker 资源、CSP 与文件路径支持。

Nginx 模板区分稳定版 no-cache 与历史 release 长期缓存，runtime-config、发布缓存 manifest/worker 等控制文件另行处理；静态资源缺失返回 404，不应误落管理 SPA。默认普通请求体限制 16m，但资产/归档/视频路径和分片路径有专门例外，不能据此推断所有上传统一限制 16m。默认数字孪生 publicBaseUrl 端口与 Nginx 管理/脚本端口存在差异，需显式对齐，不能拿默认字符串当运行成功地址。

后端 JAR 不自动安装 Nginx、不自动构建管理端，也不是系统服务安装器。脚本以所在仓库解析路径，Java 的相对 Path 则依赖 JVM 工作目录，服务化部署时应统一工作目录或显式使用绝对根目录。`publish-admin` 会清空管理静态目录后复制前端产物，不要在未确认目录时执行。

依据：[Nginx 模板](../../../central-data-platform/deploy/nginx/conf/nginx.conf.template#L71)、[Nginx 脚本](../../../central-data-platform/scripts/nginx.sh#L99)、[运行时脚本调用](../../../central-data-platform/backend/twin-module-system/src/main/java/com/centraldataplatform/twin/system/nginx/app/service/NginxRuntimeService.java#L160)、[DIST 配置](../../electron/ipc/digitalTwinDistPackage.ts#L220)。

## 存储、备份与恢复

必须同时保留 MySQL、STORAGE_LOCAL_ROOT、三维本地工程与固定资源、发布 current/release，以及必要的任务暂存与安全配置。仅部分小图片有数据库内容副本；模型、脚本、大图、视频和多数发布文件依赖磁盘。SOURCE 与 DIST 应按同一次发布保留，恢复后验证工程版本和线上版本一致，而不只检查网页能否打开。

项目完整 `.cdp-project` 归档与普通资源 ZIP 是不同机制。完整归档会处理引用闭包、ID/URL 重映射、共享资源冲突和预检；简单组合模型独立 ZIP 当前不含 GLB。归档是否加密取决于密钥配置，下载完成状态也不等于运维人员已可靠保存文件。密钥应与备份分离保管，丢失日志加密密钥会影响已保存 ES 密码的解密。

删除业务记录不必然回收所有物理文件；Conflicts 也不应当普通缓存直接清空。做清理前需核查项目引用、历史发布、资源版本、视频墓碑与待重试清理任务。不要以一次数据库导出或任一 ZIP 可打开宣称灾备可用。

依据：[文件内容存储](../../../central-data-platform/backend/twin-module-file/src/main/java/com/centraldataplatform/twin/file/app/service/FileAppService.java#L281)、[归档封装](../../../central-data-platform/backend/twin-module-project/src/main/java/com/centraldataplatform/twin/project/archive/ProjectTransferArchiveEnvelope.java#L54)、[组合模型独立导出](../../../central-data-platform/backend/twin-module-combo-model/src/main/java/com/centraldataplatform/twin/combomodel/app/service/ComboModelTransferAppService.java#L149)、[日志密钥](../../../central-data-platform/backend/twin-module-system/src/main/java/com/centraldataplatform/twin/system/operationlog/app/service/OperationLogSecretCipher.java#L48)。

## 优先风险与处置建议

### 上线前：管理访问与代码执行边界

源码事实：中台 AuthService 不校验传入密码，返回 anonymous/null token；同时后台实现资源修改、流程执行、HTTP 代理、Nginx 重载和日志清理。独立 DataFlow API Key 或外部网关可能另外保护某些入口，但不是当前应用完整 JWT/RBAC 实现。部署前应确认网络/网关访问控制，并把 Electron、Viewer、文件 inline、SOURCE 下载和 Broker 权限一起纳入授权设计，不只补管理端登录页。

模型 TS 以 `new Function` 在三维 renderer 执行，不能接受未经信任审查的模型脚本。中台 GraalJS 虽限制主机 IO，也存在普通脚本通用墙钟/堆预算不足的静态资源耗尽风险。数据源和发送通道拥有出站、本机文件/JDBC 等高权限能力，默认 allowed-hosts=*，部分所谓白名单函数并非严格阻断所有未匹配目标。以上是边界审查建议，本次没有做攻击或漏洞利用测试。

证据：[AuthService](../../../central-data-platform/backend/twin-module-system/src/main/java/com/centraldataplatform/twin/system/auth/AuthService.java#L13)、[模型脚本](../../src/runtime/babylon/ExternalModelScriptRuntime.ts#L419)、[GraalJS](../../../central-data-platform/backend/twin-module-dataflow/src/main/java/com/centraldataplatform/twin/dataflow/run/app/service/DataFlowJavaScriptTransformService.java#L128)、[数据源目标校验](../../../central-data-platform/backend/twin-module-dataflow/src/main/java/com/centraldataplatform/twin/dataflow/datasource/app/service/DataSourceAppService.java#L890)。

### 高：普通 Web 导出与数字孪生 DIST 清理不一致

已沿调用链复核：普通导出从 useDeploymentExport 序列化场景，经 deploymentExportIpc 和 deploymentExportScene 写入 `project/scene.json`，没有同等清空 fetchConfig.apiKey；数字孪生服务则在构建 DIST 前明确清空该字段。风险推断是填写了该键的普通导出可能带出编辑配置，不表示本次已经生成包或确认实际密钥泄露。应增加两条导出链的敏感字段回归测试，并单独管控 SOURCE 访问。

证据：[导出调用](../../src/editor/deployment/useDeploymentExport.ts#L279)、[导出 IPC](../../electron/ipc/deploymentExportIpc.ts#L189)、[场景准备](../../electron/ipc/deploymentExportScene.ts#L341)、[清理助手](../../electron/ipc/deploymentSceneSanitizer.ts#L1)、[数字孪生公开场景](../../electron/ipc/digitalTwinPublishService.ts#L792)。

### 高：资源快照与 prepare 响应 revision 校验不同步

服务端有 token 时校验引用资源，不要求整个项目 revision 不变；客户端在 confirmResourceBindings=false 时仍要求 prepare 响应 revision 等于请求值，true 时才允许增大。已确认两端校验规则不同；“capture 后仅未引用资源改变导致服务端接受、客户端拒绝”是待复现的条件性风险。建议明确 token 模式下 revision 的含义，并覆盖 prepare 已建任务但客户端断言失败的清理路径。

证据：[服务端 prepare](../../../central-data-platform/backend/twin-module-editor/src/main/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishAppService.java#L133)、[引用快照验证](../../../central-data-platform/backend/twin-module-editor/src/main/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinResourceSnapshotService.java#L52)、[客户端断言](../../electron/ipc/digitalTwinUploadClient.ts#L392)。

### 高：大屏旧草稿覆盖与发布部分完成

大屏 update 仍要求 updatedAt 可解析，但实际旧值比较和 SQL 时间戳条件被注释，当前更新主要按 id。双编辑者覆盖属于由源码推断的风险，尚未实测，应恢复并发控制并加入旧时间戳回归。

数字孪生 commit 在文件部署后才创建统一发布记录、完成线上 binding；部署前也会先更新 latestVersionId。任务 FAILED 不能保证静态目录或编辑版本均未变化。需验证部署后数据库失败、commit 超时重试和人工恢复流程；synchronized 只是本 JVM 互斥，不能视作多实例全局发布锁。

证据：[大屏 update](../../../central-data-platform/backend/twin-module-screen/src/main/java/com/centraldataplatform/twin/screen/app/service/ScreenAppService.java#L210)、[commit 编排](../../../central-data-platform/backend/twin-module-editor/src/main/java/com/centraldataplatform/twin/editor/app/service/DigitalTwinPublishAppService.java#L203)。

### 中：实时数据、单实例与可观察性

设备最新值在成功发送后异步入缓冲，再批量写 MySQL，查询看不到 pending。相同 namespace/deviceType/deviceNo 可以跨 flow 覆盖；启动 epoch 机制不等价于多活时序合并。MQTT 接收队列、下载票据、归档预检和 RTSP 会话都有本机状态，重启、负载均衡和多副本需要专门设计；不能直接扩容就声称唯一调度或 exactly-once。

发送默认 AUTO 幂等的 SUCCESS 记录无自动到期，相同周期 payload 可能持续跳过。rerun(logId) 运行当前草稿，不是带原参数的历史重放；stopRuntime 不等于关闭对外发布 API。日志存在异步有界队列和丢弃路径，操作者当前为匿名，不能作为强审计保证。

证据：[最新值服务](../../../central-data-platform/backend/twin-module-dataflow/src/main/java/com/centraldataplatform/twin/dataflow/mqttlatest/MqttLatestService.java#L198)、[幂等](../../../central-data-platform/backend/twin-module-dataflow/src/main/java/com/centraldataplatform/twin/dataflow/run/app/service/DataFlowSendService.java#L612)、[rerun](../../../central-data-platform/backend/twin-module-dataflow/src/main/java/com/centraldataplatform/twin/dataflow/run/app/service/DataFlowRunService.java#L399)、[停止运行](../../../central-data-platform/backend/twin-module-dataflow/src/main/java/com/centraldataplatform/twin/dataflow/flow/app/service/DataFlowAppService.java#L195)。

### 中：保存、等待和数据迁移

三维普通保存直接 writeFile，异常中断的原子保护不足；库存 Fetch 未见请求超时，在途请求长时间不结束可能阻塞后续同步。独立组合 ZIP 缺 GLB、模型批导入缺批次外层事务、部分按名称覆盖导入绕过项目 dirty 标记，都需要专项往返与失败恢复测试。RTSP 引用未 release 可能阻断 TTL 回收；含中文/空格的场景文件下载路径编码也需验证。这些是静态维护风险，不应直接统计为已发生生产故障。

证据：[普通保存](../../electron/ipc/projectIpc.ts#L194)、[库存请求](../../src/runtime/babylon/scene-runtime/SceneLocatorFetchController.ts#L350)、[模型导入](../../../central-data-platform/backend/twin-module-model/src/main/java/com/centraldataplatform/twin/model/app/service/ModelTransferAppService.java#L147)、[RTSP 清理](../../../central-data-platform/backend/twin-module-screen/src/main/java/com/centraldataplatform/twin/screen/app/service/VideoWallStreamService.java#L1042)。更多资源域边界见[中台架构](02-central-data-platform.md)。

## 受控验收矩阵

下表均为后续执行建议，未标注为本次测试通过。先冻结源码快照和有效配置，再在隔离环境执行；需要真实服务、外部发送或破坏性恢复的验证应由对应负责人授权。

| 验收面 | 最小场景 | 应保留的证据 |
| --- | --- | --- |
| 构建基线 | 两仓依赖解析、类型/单测、完整构建 | 提交/工作树摘要、工具版本、命令和退出码 |
| 数据库 | 空库迁移与旧库升级，检查种子任务 | Flyway 状态、迁移日志、任务停启状态 |
| 三维编辑 | 导入、参数、保存重开、预览停止、切场景 | 场景 diff、资源引用、设计基线恢复 |
| MQTT | EPV/json-path、重叠订阅、重复乱序、断线与延迟 SUBACK | Broker 日志、订阅/消息摘要、模型运动证据 |
| 数据流 | 草稿/发布、调用参数、幂等、非 2xx、队列满与数据库失败 | 内层 status、nodeResults、发送和存储计数 |
| 库存/特效 | 库位结构、长 ID、超时、公开包授权 | 脱敏请求响应与字段映射 |
| 发布 | 双包、缺片/重片/错 hash、会话超期、取消、commit 重试 | taskId、uploadId、包 hash、状态与目录比对 |
| 发布竞争 | 引用/非引用资源变更、并发新版本、forceOverwrite | 两侧 revision、错误码、遗留任务 |
| 版本治理 | 回滚、下线、历史地址、运行禁用 | SOURCE/DIST 版本和稳定/历史 URL 行为 |
| iframe | 同源/允许跨源/拒绝跨源、握手与聚焦 | source/origin/session、ready 和命令结果 |
| 大屏协作 | 两编辑者更新、发布和国际化 | 时间戳冲突结果与冻结快照 |
| 备份恢复 | 带 GLB/脚本/视频/组合/翻译的完整归档往返 | 资源 hash、ID 映射、缺文件和冲突决策 |
| GPU/烘焙 | 大场景、取消加载、循环切换、Blender 失败 | 帧时间、内存、资源计数和烘焙签名 |
| 部署安全 | 网关、文件访问、SOURCE、Broker ACL、脚本来源 | 明确的允许/拒绝结果，不保留真实密钥 |

## 维护文档的方式

修改跨仓契约时同步更新接口文档与两侧测试，尤其是场景版本、runtime-config 严格键集合、资源快照、长 ID 和 postMessage。不要复制旧文档中的“已通过”到新版本，测试记录应包含日期、源码基线和环境。中台当前 `.gitignore` 忽略 docs；文档落盘不代表进入版本控制，本次未修改 ignore、未暂存、未提交，团队需决定如何纳入管理。
